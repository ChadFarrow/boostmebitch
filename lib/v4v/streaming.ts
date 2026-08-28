'use client';

// Streaming sats — the third Podcasting 2.0 payment mode, alongside the boost
// button and per-track boost-all.
//
// This is a ledger + a clock on top of the existing engine, NOT a new payment
// path: settlement calls the same `sendBoost()` every boost goes through, with
// `action: 'auto'` on the boostagram (a field lib/types.ts and
// lib/v4v/boostbox.ts already carry). Nothing about rails, splits, TLV or the
// lnaddress→keysend upgrade changes here. See buildBoostagram for why 'auto'
// and not 'stream'.
//
// The arithmetic lives in ./stream-ledger.ts so `npm run check:stream` can pin
// it from plain Node. What lives HERE is the part that talks to the store, the
// wallet and the clock — and its own rules, each of which is about the one
// property that makes this feature different from every other payment in the
// app: **it spends money unattended, on a timer, with no confirmation step.**
//
//   - Settlement is SERIALIZED and the ledger is debited BEFORE the await.
//   - Two consecutive failures stop the engine for that item rather than
//     accruing a debt against a wallet that plainly can't pay it — and a rail
//     that provably CANNOT pay this value block stops after one, because a
//     retry is guaranteed to fail the same way. Connecting a wallet or changing
//     the rate is the way back; both clear the give-up state.
//   - Teardown does NOT settle. <Player>'s cleanup runs on every Fast Refresh,
//     and a payment fired from a teardown can't be observed — see
//     releaseContext.
//   - The observable notifies only when something the UI renders changed, not
//     once a second. <FullscreenPlayer> is always mounted, so an unconditional
//     notify re-rendered the meter 60×/min for people who never opened it.
//   - Nothing is published to Nostr and nothing plays a sound. Streaming is
//     ambient; a note per settle would spam the user's feed and a ping every
//     ten minutes would be hostile.
//
// `valueTimeSplits` ARE covered: the ledger accrues into per-track buckets that
// settle independently against their own value blocks, so a music show pays the
// artist whose track is playing rather than paying a whole ten-minute batch to
// whoever happened to be on when the timer fired. Boost-all remains the way to
// pay every track at once, on purpose.

import type { Episode, Podcast, Boostagram, BoostResult, ValueBlock, ValueTimeSplit } from '@/lib/types';
import { useApp } from '@/lib/store';
import { storage, subscribeStreamRate as onStoredRateChange, type StreamMode } from '@/lib/storage';
import { createObservable } from '@/lib/pubsub';
// DEFAULT_SENDER_NAME lives in lib/brand.ts, NOT in the boost modal that owns
// the "From" field — importing it from `components/` here would invert the v4v
// swap-out boundary and pull a 'use client' React module into the engine.
import { getErrorMessage, hasValueRecipients, payableValue, splitAtPosition, showStorageKey, randomId } from '@/lib/util';
import { BRAND, DEFAULT_SENDER_NAME } from '@/lib/brand';
import { isLiveStreamId } from '@/lib/nostr/live-streams';
import { canSignUnattended } from '@/lib/nostr/signer';
import { resolvePublishRelays } from '@/lib/nostr/relays';
import { publishValuePlaybackReceipt, queueSummaryUpdate } from '@/lib/nostr/value-playback';
import { sendBoost, pickRail, paidAny } from './boost';
import { subscribeNwc } from './nwc';
import { subscribeSpark } from './spark';
import { subscribeWebln } from './webln';
import { liveTargetSnapshot, subscribeLiveTarget, type LiveTarget } from './live-value';
import {
  accrue,
  accruedSats,
  allocationTrackBucket,
  createLedger,
  HOST_BUCKET,
  isStaleLedger,
  msUntilSettle,
  clearCreditedRun,
  creditFixed,
  settleBatch,
  STREAM_TRACK_CREDIT_DEBOUNCE_MS,
  STREAM_TRACK_MIN_PLAY_MS,
  trackBucket,
  type StreamAllocation,
  type StreamLedger,
} from './stream-ledger';

const TICK_MS = 1_000;
/** How often the ledger is mirrored to localStorage while simply accruing.
 *  Edges (settle, pause, item change, page hide) persist immediately. */
const PERSIST_EVERY_MS = 10_000;
/** Consecutive failed settles before streaming stops for the current item. */
const MAX_CONSECUTIVE_FAILURES = 2;

/** Everything the current item is being streamed against. */
interface StreamContext {
  key: string;
  episode: Episode;
  podcast: Podcast;
  value: ValueBlock;
  ratePerMin: number;
  /**
   * Resolved `<podcast:valueTimeSplit>` windows for this item, indexed by
   * bucket key. Empty for an ordinary podcast; populated for a music show
   * whose payment target changes track by track.
   */
  splits: Map<string, ValueTimeSplit>;
  /**
   * Track being credited as of the last tick — `undefined` until the first one,
   * so opening a context can't read as a boundary. `null` means the host.
   */
  lastTrack?: string | null;
  /**
   * Live shows only: the bucket the live-value watcher says is playing right
   * now, or null for the show's own block. A live stream has no position to
   * meter a `<podcast:valueTimeSplit>` window against, so the target is pushed
   * in rather than looked up — but it lands in the SAME `splits` map under the
   * same kind of bucket key, so the ledger, the settle edge and the boostagram
   * shape are all the valueTimeSplit ones, unchanged.
   */
  liveBucket?: string | null;
  /**
   * Split Kit correlation ids, PER BUCKET, captured when that bucket was
   * adopted.
   *
   * Not read from the watcher's live snapshot at settle time, which is what it
   * looked like it could be: a track boundary is a settle edge, and the boundary
   * is detected AFTER `adoptLiveTarget` has already moved `liveBucket` to the
   * incoming track — so a snapshot read would attach the incoming block's ids to
   * the outgoing track's payment, or (with a `liveBucket === bucket` guard)
   * attach none at all to the one settle these ids exist for.
   */
  liveEvents?: Map<string, LiveEventIds>;
  /** What the number means: sats per minute, or a fixed sum per track. */
  mode: StreamMode;
  /** Sats credited per track when `mode === 'track'`. */
  amountPerTrack: number;
  /**
   * The current uninterrupted run of one bucket being the credited target.
   *
   * Per-track mode fires 30 s in, not on the change itself, so "has this run
   * already paid?" cannot be answered by a time window — a five-minute song
   * would clear any window and be credited again. It needs an explicit
   * once-per-run flag, which is what `credited` is.
   */
  run?: { bucket: string; sinceMs: number; credited: boolean };
  /**
   * Opaque id grouping every settle of ONE listen, for the `session` tag on a
   * kind:3369 receipt. Stamped by openContext rather than by the caller: `next`
   * is rebuilt on every 1 Hz tick and only the literal that actually reaches
   * openContext becomes the context, so generating it at the call site would
   * burn a UUID a second and still hand over the wrong one.
   *
   * Deliberately NOT persisted with the ledger. A session is one uninterrupted
   * listen; a reload is a new one, and claiming otherwise would tell a consumer
   * two runs were contiguous when a gap of any length sits between them.
   */
  sessionId?: string;
  /**
   * Feed guids a receipt was actually PUBLISHED for during this listen, for the
   * kind:33369 summary pass at release.
   *
   * Populated in `maybePublishReceipt` rather than wherever a payment happens,
   * and only past every one of its refusals, because a summary is derived from
   * receipts — an id whose receipt was never published has nothing to summarize
   * and would cost a pair of relay reads to confirm it.
   */
  summarizedFeeds?: Map<string, string | undefined>;
}

/** The ids Split Kit uses to tie a payment back to the block that earned it. */
type LiveEventIds = NonNullable<LiveTarget['event']>;

/**
 * Resolved splits per episode, so an episode replayed (or resumed after a skip
 * away and back) doesn't re-fetch. `null` records "asked, nothing usable" so a
 * show without splits doesn't re-ask every time it starts.
 *
 * Keyed on `feedId:episodeId`, not the bare episode id: RSS-derived episodes
 * get `-fnvHash(guid)` ids, and fnvHash is 31-bit, so two episodes from
 * different feeds can collide. A collision here doesn't render wrong — it pays
 * ANOTHER SHOW'S ARTISTS. One extra field on a money path.
 */
const splitCache = new Map<string, Map<string, ValueTimeSplit> | null>();

function splitCacheKey(episode: Episode): string {
  return `${episode.feedId}:${episode.id}`;
}

/**
 * Fetch and index this episode's time splits.
 *
 * Only splits that RESOLVED to a real value block are kept. An unresolved one
 * (a stale feedGuid, a feed Podcast Index has never crawled — the same ~50%
 * coverage gap that forced the RSS fallback in resolveValueTimeSplits) falls
 * back to the host's value block rather than being dropped, because its
 * window's sats have already been accrued from the listener. That is also the
 * spec-correct default: a valueTimeSplit *redirects* part of the show's value
 * for a window, so anything that can't be redirected is still the show's.
 */
async function loadSplits(episode: Episode): Promise<Map<string, ValueTimeSplit>> {
  const cacheKey = splitCacheKey(episode);
  const cached = splitCache.get(cacheKey);
  if (cached !== undefined) return cached ?? new Map();
  if (!episode.valueTimeSplits?.length) {
    splitCache.set(cacheKey, null);
    return new Map();
  }
  try {
    const res = await fetch(`/api/value-splits?feedId=${episode.feedId}&episodeId=${episode.id}`);
    const data = await res.json();
    const map = new Map<string, ValueTimeSplit>();
    for (const s of (data.splits as ValueTimeSplit[]) ?? []) {
      if (hasValueRecipients(s.value)) map.set(trackBucket(s), s);
    }
    splitCache.set(cacheKey, map.size ? map : null);
    return map;
  } catch {
    // Not cached as a miss: a network blip must not pin the whole episode to
    // the host block for the rest of the session.
    return new Map();
  }
}

/**
 * Adopt a live "now playing" target into a context.
 *
 * `splits` is APPEND-ONLY here — the outgoing track's entry stays. A bucket
 * that carried under the per-bucket floor still has to resolve to its OWN
 * artist whenever it finally clears, and deleting it would route that artist's
 * dust to the host through targetFor's fallback.
 */
function adoptLiveTarget(c: StreamContext, t: LiveTarget | null) {
  if (!t || t.guid !== c.episode.guid) {
    c.liveBucket = null;
    return;
  }
  if (!t.split || !hasValueRecipients(t.split.value)) {
    c.liveBucket = null;
    return;
  }
  // The watcher's own key, not trackBucket(t.split) — a Split Kit block that
  // names no feed has no remoteItem to derive one from, and inventing a guid to
  // put there would ship it as `remote_feed_guid`. See LiveTarget.bucketKey.
  const bucket = t.bucketKey || trackBucket(t.split);
  c.splits.set(bucket, t.split);
  // Recorded against the bucket while we still know which block it was. The
  // settle that pays this track happens at the NEXT track's boundary, by which
  // time the watcher's snapshot names a different block.
  if (t.event && (t.event.eventGuid || t.event.blockGuid || t.event.eventAPI)) {
    (c.liveEvents ??= new Map()).set(bucket, t.event);
  }
  c.liveBucket = bucket;
}

/**
 * Per-track mode: the current target earns the fixed amount, once, after it has
 * actually been on for `STREAM_TRACK_MIN_PLAY_MS`.
 *
 * **Every kind of block earns** — songs and the host's own segments alike. The
 * listener chose an amount for this show, and a promo or a shoutout is the show.
 * (A filter on Split Kit's `type` was built and removed; the kind is still
 * carried for diagnostics but does not gate payment.) What the minimum stops is
 * a target nobody spent any time on: a real broadcast flicked through two shared
 * photos 16 seconds apart and fired two full payments.
 *
 * Because the credit fires MID-RUN rather than on the change, "has this already
 * paid?" needs an explicit per-run marker — a time window alone would let a
 * five-minute song clear it and be credited twice. There are two markers and
 * they do different jobs:
 *
 * - `ledger.creditedRun` — paid for the run in progress. Cleared the moment a
 *   different target is current, so a genuine replay later earns again.
 * - `ledger.creditedAt` — when each bucket last paid, across runs. Catches a
 *   *slow* socket flap, which legitimately ends the run.
 *
 * **Both live on the LEDGER, not this context**, because the ledger is what
 * survives a reload. They started here, and a refresh mid-song therefore wiped
 * "already paid" while the balance was restored — charging the same track again
 * thirty seconds later.
 *
 * A no-op outside track mode, so `tick()` calls it unconditionally.
 */
function applyTrackCredit(
  c: StreamContext,
  l: StreamLedger,
  args: { track: string | null; allocation: StreamAllocation[]; nowMs: number; playing: boolean },
): StreamLedger {
  const { track, allocation, nowMs, playing } = args;
  if (c.mode !== 'track') return l;

  // Drop the credited marker as soon as a different target is current.
  let ledgerNext = clearCreditedRun(l, track);

  if (!track) {
    // Back to the host block with nothing current — end the run rather than
    // letting it resume its clock if the same bucket returns later.
    c.run = undefined;
    return ledgerNext;
  }
  if (!playing) return ledgerNext;

  if (c.run?.bucket !== track) c.run = { bucket: track, sinceMs: nowMs, credited: false };
  const run = c.run;
  const lastPaidMs = ledgerNext.creditedAt?.[track] ?? -Infinity;
  const due =
    !run.credited
    && ledgerNext.creditedRun !== track
    && nowMs - run.sinceMs >= STREAM_TRACK_MIN_PLAY_MS
    && nowMs - lastPaidMs >= STREAM_TRACK_CREDIT_DEBOUNCE_MS;
  if (!due) return ledgerNext;

  run.credited = true;
  // Through the same allocation a tick uses, so a block with remotePercentage
  // below 100 splits the fixed sum between track and host on exactly the rate
  // path's rule.
  ledgerNext = creditFixed(ledgerNext, {
    msat: c.amountPerTrack * 1000,
    allocation,
    bucket: track,
    nowMs,
  });
  // The credit is money; don't wait for the 10 s persist cadence to record that
  // it happened, or a reload inside that gap pays it twice.
  persist(ledgerNext);
  return ledgerNext;
}

/**
 * The split covering a playback position, if any.
 *
 * The window arithmetic itself lives in `lib/util.ts:splitAtPosition`, shared
 * with the boost modal so the two can't drift: the engine credits accrual by
 * this rule and the modal picks a payment target by it, and a one-second
 * disagreement at a boundary pays one artist while crediting another for the
 * same moment. This wrapper only adapts the bucket map to a list.
 */
function splitAt(splits: Map<string, ValueTimeSplit>, positionSec: number): ValueTimeSplit | null {
  return splitAtPosition([...splits.values()], positionSec);
}

/**
 * Where the current second's sats belong.
 *
 * `remotePercentage` is the share the publisher redirected to the track; the
 * remainder stays with the show. The host's share is accrued into ONE bucket
 * across every track rather than a per-track host leg (which is what
 * BoostAllModal does) — a boost needs per-track correlation because it's a
 * discrete event, whereas a streamed host share is the same recipient for the
 * whole episode, and paying it once per batch instead of once per track is the
 * difference between one Lightning payment and a dozen.
 */
function allocationAt(c: StreamContext, positionSec: number): StreamAllocation[] {
  // Live shows resolve their target by polling the feed, not by position, so
  // this branch sits ABOVE splitAt — a live split carries duration 0 and would
  // never match a window. An unresolvable live bucket falls back to the host
  // block rather than to nothing: those sats have already been accrued from the
  // listener, and an unresolved redirect is still the show's value.
  if (c.liveBucket) {
    const live = c.splits.get(c.liveBucket);
    if (!live || !hasValueRecipients(live.value)) return [{ bucket: HOST_BUCKET, fraction: 1 }];
    const livePct = Math.min(100, Math.max(0, live.remotePercentage ?? 100));
    return [
      { bucket: c.liveBucket, fraction: livePct / 100 },
      { bucket: HOST_BUCKET, fraction: 1 - livePct / 100 },
    ];
  }
  const split = c.splits.size ? splitAt(c.splits, positionSec) : null;
  if (!split) return [{ bucket: HOST_BUCKET, fraction: 1 }];
  const pct = Math.min(100, Math.max(0, split.remotePercentage ?? 100));
  return [
    { bucket: trackBucket(split), fraction: pct / 100 },
    { bucket: HOST_BUCKET, fraction: 1 - pct / 100 },
  ];
}

const observable = createObservable();
/** UI subscription — fires on accrual, settle, failure and eligibility changes. */
export const subscribeStreaming = observable.subscribe;

let timer: ReturnType<typeof setInterval> | null = null;
let ctx: StreamContext | null = null;
let ledger: StreamLedger | null = null;
let lastPersistMs = 0;
let lastPlaying = false;

// Settles run one at a time. Same reasoning as the promise `chain` in
// lib/nostr/follows.ts: a track change landing mid-payment must queue behind
// the in-flight one rather than race it.
let chain: Promise<void> = Promise.resolve();
/** Queued + in-flight settles. A count, not a flag: with two queued, the first
 *  one finishing would otherwise clear the meter's "sending…" while the second
 *  is still moving money. */
let pendingSettles = 0;
/** Failures in a row FOR THE CURRENT ITEM — reset on every item change, or a
 *  single failure on item A plus a single failure on item B would give up on B
 *  after one. */
let consecutiveFailures = 0;
/** Item key streaming has given up on. */
let disabledKey: string | null = null;
let stoppedReason: StreamStoppedReason = null;
let lastError: string | null = null;
/** Item `lastError` belongs to. Without it a failure on one episode paints its
 *  warning on every episode after it for the rest of the page session. */
let lastErrorKey: string | null = null;
let sessionSentSats = 0;

/**
 * Sats confirmed sent by the settle batch currently running.
 *
 * A force settle (`maybeSettle(…, force)`) returns a `runs` array, not one run:
 * on a music show, turning streaming off flushes every accrued track bucket in
 * a single batch, chained sequentially. So "this settle failed" and "no sats
 * left the wallet" are DIFFERENT claims — bucket 1 can pay and bucket 2 fail,
 * and `lastError` then describes only the last one. The readout used to say
 * "nothing was sent" over exactly that, which is a false statement about money
 * the user has already spent.
 *
 * Reset in chain order rather than at enqueue time, so a batch queued behind a
 * still-running one doesn't zero the count the earlier batch is accumulating.
 */
let batchSentSats = 0;
/** `batchSentSats` at the moment `lastError` was recorded — what the failing
 *  batch had ALREADY paid before it hit the failure the meter is showing. */
let lastErrorSentSats = 0;
/**
 * The failing settle may in fact have paid.
 *
 * A NIP-47 reply timeout is not a refusal (CLAUDE.md's `NwcIndeterminateError`
 * rule): the request was published and the wallet may have settled it. The
 * ENGINE deliberately keeps treating that as a failure — the safe direction for
 * an unattended payer, and the ledger was already debited — but the READOUT
 * must not turn it into "nothing was sent", which is the same false ✗ the boost
 * modal is forbidden from rendering.
 */
let lastErrorIndeterminate = false;

/**
 * Why streaming gave up — which decides what the UI can honestly offer as a fix.
 *
 * `'failures'` is a wallet that couldn't pay right now, so retrying is
 * meaningful. `'rail-cannot-pay'` is a capability gap (Spark can't keysend, and
 * this show pays node pubkeys) — retrying is guaranteed to fail identically, so
 * telling the user to change the rate just loops them.
 */
export type StreamStoppedReason = 'failures' | 'rail-cannot-pay' | null;

export interface StreamingStatus {
  /** Streaming is on and accruing for whatever is playing right now. */
  active: boolean;
  /**
   * Resolved rate for the current item, sats/min. **0 means streaming is OFF
   * for what is playing** — for this show, or globally — and stays the ON
   * signal in track mode (see resolveStreamPlan).
   *
   * Read from the live context while one exists and from the show's settings
   * when one doesn't, so it does not collapse to 0 the moment streaming gives
   * up on an item. `active` is what says whether anything is accruing right
   * now; this says what the user asked for.
   */
  ratePerMin: number;
  /** What the number means. */
  mode: StreamMode;
  /** Sats per track, meaningful only when `mode === 'track'`. */
  amountPerTrack: number;
  /**
   * True when this item is in track mode but has no tracks to pay for, so
   * nothing will ever be sent.
   *
   * Surfaced rather than left implicit because it is the same obligation the
   * global streaming switch carries: a readout that lets a user believe money
   * is moving when it isn't is the failure this area keeps producing. An
   * ordinary podcast has no `valueTimeSplit` windows and no live blocks, so
   * per-track mode has nothing to trigger on.
   */
  trackModeIdle: boolean;
  accruedSats: number;
  msUntilSettle: number;
  settling: boolean;
  /** Last settle failure for the item now playing, cleared by the next success. */
  lastError: string | null;
  /** True once streaming gave up on this item. See stoppedReason for the way back. */
  stopped: boolean;
  stoppedReason: StreamStoppedReason;
  /** Title of the `<podcast:valueTimeSplit>` track currently being credited,
   *  or null when the show's own value block is. */
  currentTrack: string | null;
  /**
   * True when what's accruing settles at the next BLOCK CHANGE rather than on
   * `msUntilSettle`.
   *
   * A live Split Kit show pays out when the host moves to the next track — the
   * boundary force-settles — which on a music show is minutes sooner than the
   * ten-minute interval. The countdown is still technically running underneath,
   * but showing it is a readout answering "when does my money move?" with a
   * number that is almost never the answer. Same obligation as the global
   * streaming switch: a settings surface must not state a confident wrong
   * figure about spending.
   */
  settlesOnBlockChange: boolean;
  /** Cover art for the live block being credited, when it ships one. Null for
   *  everything else, so no other surface changes. */
  blockImage: string | null;
  /** Sats settled this session, across items. */
  sessionSentSats: number;
  /**
   * Sats the batch that ended in `lastError` had ALREADY paid before it failed.
   *
   * Scoped to the current item exactly like `lastError`, and 0 whenever there
   * is no error to describe. Non-zero means a partial send: the failure is real
   * and so is the spend, so no surface may say "nothing was sent".
   */
  lastErrorSentSats: number;
  /**
   * `lastError` came from a wallet that never answered, so the sats it names may
   * or may not have gone out. Distinct from `lastErrorSentSats`: that one is
   * about OTHER buckets that definitely paid, this one is about this bucket
   * being unknowable. Either is enough to make "nothing was sent" a lie.
   */
  lastErrorIndeterminate: boolean;
}

export function streamingStatus(): StreamingStatus {
  const cur = useApp.getState().current;
  const currentKey = cur ? itemKey(cur.episode, cur.podcast) : null;
  const isStopped = !!disabledKey && disabledKey === currentKey;
  // With no live context the SETTINGS are still the honest answer to "what is
  // this show streaming?", and this is precisely when the meter is on screen:
  // it renders for a failed settle long after the context that ran it is gone
  // (give-up tears one down, and so does turning streaming off — which is
  // itself a settle edge for the time already listened). Reading the rate off
  // the torn-down context reported `streaming 0 sats/min` over the error, which
  // is false twice: it claims to be streaming, and it names a rate nobody set.
  // Worse, it reported the same 0 for a show still streaming at 10 as for one
  // that is genuinely off, so the readout could not distinguish "paused, and
  // fixing your wallet resumes it" from "off, nothing more will be tried".
  // Memoized by show, so this is at most one localStorage read per show.
  const plan = ctx ? null : cur ? cachedStreamPlan(cur.podcast) : null;
  return {
    active: !!ctx && !!ledger,
    ratePerMin: ctx?.ratePerMin ?? plan?.ratePerMin ?? 0,
    mode: ctx?.mode ?? plan?.mode ?? 'rate',
    amountPerTrack: ctx?.amountPerTrack ?? plan?.amountPerTrack ?? 0,
    // No live block and no resolved valueTimeSplits means no track will ever
    // become current, so the fixed amount has nothing to attach to.
    trackModeIdle: ctx?.mode === 'track' && !ctx.liveBucket && ctx.splits.size === 0,
    accruedSats: ledger ? accruedSats(ledger) : 0,
    msUntilSettle: ledger ? msUntilSettle(ledger) : 0,
    settling: pendingSettles > 0,
    // Scoped to the item it happened on, exactly like `stopped` below.
    lastError: lastErrorKey && lastErrorKey === currentKey ? lastError : null,
    // Same scoping as `lastError` itself — they describe one event, so a
    // partial-send figure must never outlive the error it qualifies and land
    // beside a different item's failure.
    lastErrorSentSats: lastErrorKey && lastErrorKey === currentKey ? lastErrorSentSats : 0,
    lastErrorIndeterminate:
      lastErrorKey && lastErrorKey === currentKey ? lastErrorIndeterminate : false,
    stopped: isStopped,
    stoppedReason: isStopped ? stoppedReason : null,
    // A live show's target comes from the watcher, not from a position window.
    // This line is the only visible proof the redirect is being followed at
    // all — without it, streaming looks identical whether the artist is being
    // paid or not.
    currentTrack: ctx?.liveBucket
      ? ctx.splits.get(ctx.liveBucket)?.title ?? null
      : ctx?.splits.size
        ? splitAt(ctx.splits, useApp.getState().positionSec)?.title ?? null
        : null,
    settlesOnBlockChange: !!ctx?.liveBucket,
    blockImage: (ctx?.liveBucket && ctx.splits.get(ctx.liveBucket)?.image) || null,
    sessionSentSats,
  };
}

/**
 * Notify the UI only when something it renders actually changed.
 *
 * The engine ticks at 1 Hz and `streamingStatus()` returns a fresh object every
 * time, so an unconditional notify re-rendered every subscriber 60×/min. That
 * is not theoretical: `<FullscreenPlayer>` is ALWAYS mounted (translated
 * off-screen when collapsed), so `<StreamMeter>` re-rendered a minute at a time
 * for users who never opened it. The countdown is compared in whole minutes
 * because that is the resolution the meter displays.
 */
let lastSig = '';
function notifyIfChanged() {
  const s = streamingStatus();
  const sig = [
    s.active, s.ratePerMin, s.accruedSats, s.settling, s.stopped, s.stoppedReason,
    s.lastError, s.currentTrack, s.sessionSentSats, Math.ceil(s.msUntilSettle / 60_000),
    // Both are rendered, so both have to be able to wake a subscriber. Art in
    // particular changes on its own schedule: two blocks can share a title
    // (a re-run interstitial) while carrying different covers.
    s.settlesOnBlockChange, s.blockImage,
    // The unit and the amount are both rendered, and `trackModeIdle` is the
    // "nothing will ever be sent" warning — none of them may go stale.
    s.mode, s.amountPerTrack, s.trackModeIdle,
    // Both qualify the error line's copy, and neither is implied by
    // `s.lastError`: a batch can fail twice with the identical message while
    // the sats-already-sent figure changes underneath it.
    s.lastErrorSentSats, s.lastErrorIndeterminate,
  ].join('|');
  if (sig === lastSig) return;
  lastSig = sig;
  observable.notify();
}

/**
 * Key a per-show rate override is stored under.
 *
 * Delegates to `showStorageKey` (`lib/util.ts`) now that the episode-order
 * toggle keys off the same value. Kept as a re-export under this name so every
 * `storage.streaming.*Show*` call site reads the same way it always has, and so
 * a reader here does not have to know the helper moved.
 */
export const streamShowKey = showStorageKey;

/**
 * The rate that applies to a show: the per-show override when one exists —
 * INCLUDING an explicit 0, which means "never stream this show" and has to
 * outrank the global rate — otherwise the global rate, otherwise off.
 *
 * Module-local: `resolveStreamPlan` supersedes it as the public answer, since
 * the rate alone no longer describes what a show is streaming.
 */
function resolveStreamRate(podcast: Podcast | null | undefined): number {
  if (!podcast) return 0;
  const show = storage.streaming.getShow(streamShowKey(podcast));
  if (show !== null) return show;
  return storage.streaming.get() ?? 0;
}

/**
 * What a show is streaming, and in which unit.
 *
 * `ratePerMin` keeps its existing meaning throughout — including as the ON
 * signal (`> 0` means streaming is enabled for this show, `0` means off, and an
 * explicit per-show 0 still outranks a global rate). That stays true in track
 * mode: the rate is seeded and remembered independently of the unit, so it is
 * still a valid non-zero number, it just isn't what gets charged.
 *
 * Keeping one on/off signal rather than a per-mode one is deliberate — two
 * switches that could disagree about whether a show is streaming is precisely
 * the ambiguity the tri-state rules in `lib/storage.ts` exist to prevent.
 */
export interface StreamPlan {
  ratePerMin: number;
  mode: StreamMode;
  /** Sats per track, meaningful only when `mode === 'track'`. */
  amountPerTrack: number;
}

export function resolveStreamPlan(podcast: Podcast | null | undefined): StreamPlan {
  const ratePerMin = resolveStreamRate(podcast);
  const showKey = podcast ? streamShowKey(podcast) : null;
  return {
    ratePerMin,
    mode: storage.streaming.getEffectiveMode(showKey),
    amountPerTrack: storage.streaming.getEffectiveAmount(showKey),
  };
}

/**
 * Same answer as resolveStreamRate, memoized for the 1 Hz tick.
 *
 * Invalidated from `onRateChange`, which every setter in `storage.streaming`
 * notifies — so this is exact, not merely fresh-enough. (Known, pre-existing:
 * nothing in the app listens for cross-tab `storage` events, so a rate changed
 * in another tab isn't seen live here either way.)
 */
let rateCache: { showKey: string; plan: StreamPlan } | null = null;

function cachedStreamPlan(podcast: Podcast): StreamPlan {
  const showKey = streamShowKey(podcast);
  if (rateCache && rateCache.showKey === showKey) return rateCache.plan;
  const plan = resolveStreamPlan(podcast);
  rateCache = { showKey, plan };
  return plan;
}

function itemKey(episode: Episode, podcast: Podcast): string {
  return `${podcast.podcastGuid || podcast.id}::${episode.guid || episode.id}`;
}

function persist(l: StreamLedger) {
  storage.streamPending.set(l);
  lastPersistMs = Date.now();
}

/**
 * Who the payment says it's from. Reads the SAME anonymity signal as the boost
 * modal (`shareNostr` + `shareNostrAs === 'site'`), because a user who chose
 * Anonymous there has been told their pubkey doesn't go out with their
 * payments — and a background payment that leaks `sender_id` anyway is the
 * exact failure the boost-flow notes in CLAUDE.md describe, just without a
 * screen in front of it to notice on.
 */
function streamingIsAnonymous(): boolean {
  return storage.shareNostr.get() && storage.shareNostrAs.get() === 'site';
}

/**
 * May a playback receipt or summary be published under the user's own key?
 *
 * **This is NOT `!streamingIsAnonymous()`, and reusing that predicate here is a
 * privacy inversion.** `streamingIsAnonymous` answers a question about
 * ATTRIBUTION — does `sender_id` ride along — and it is written the way
 * `useSharePicker` writes it, so it is true only for the specific pair
 * (`shareNostr` on, posting as the site). "Don't post" writes `shareNostr =
 * false` and leaves `shareNostrAs` alone, which makes `streamingIsAnonymous`
 * FALSE — so gating a publish on its negation starts publishing signed, public,
 * timestamped records for the user who just chose to publish less, and takes the
 * on-screen notice explaining the suppression away at the same moment.
 *
 * The publish question is its own: the user must be posting to Nostr at all, and
 * posting AS THEMSELVES. Both other choices refuse.
 */
function streamingMayPublish(): boolean {
  return storage.shareNostr.get() && storage.shareNostrAs.get() !== 'site';
}

function senderFields(): { sender_name: string; sender_id: string | undefined } {
  const identity = useApp.getState().identity;
  const anonymous = streamingIsAnonymous();
  const typed = anonymous
    ? ''
    : storage.senderName.get(identity?.npub)
      || identity?.profile?.display_name
      || identity?.profile?.name
      || '';
  return {
    sender_name: typed.trim() || DEFAULT_SENDER_NAME,
    sender_id: anonymous ? undefined : identity?.pubkey,
  };
}

/**
 * WHAT this bucket's payment is for, as a feed guid and an item guid.
 *
 * One function because two wire formats carry these same two values and MUST
 * agree: the boostagram's `remote_feed_guid`/`remote_item_guid`, and the NIP-73
 * `i` tags on the kind:3369 receipt. The entire use of a receipt is that a
 * consumer can filter `#i` and find the payment it describes — two independent
 * derivations is how a track's receipt comes to name the playlist while the
 * boostagram names the song, with nothing on either side saying so.
 *
 * A track bucket resolves to its `<podcast:valueTimeSplit>` remote item; the
 * host bucket resolves to the show and the episode. Note the receipt uses the
 * SAME pair the boostagram puts in `remote_*` rather than the boostagram's
 * primary `podcast`/`episode` fields: those name the playlist the listener
 * chose, and the receipt is about who got paid.
 */
function paymentIds(
  c: StreamContext,
  bucket: string,
): { feedGuid?: string; itemGuid?: string } {
  const split = bucket === HOST_BUCKET ? null : c.splits.get(bucket);
  if (split) {
    // THREE STATES, exactly as `<FavTrackHeart>` reads them (components/fav-heart.tsx).
    // A host may point a `<podcast:valueTimeSplit>` at a PUBLISHER feed, whose
    // `<podcast:remoteItem>` entries name the real albums — so the wire guid is
    // not always the album, and `resolveOneSplit` records what it learned:
    // `undefined` means nothing was learned (the wire value stands), a string is
    // a recovered album guid that OUTRANKS the wire, and `null` means known
    // unresolvable.
    //
    // `??` alone would be wrong in both directions, and here the cost is
    // permanent: an `i` tag and a kind:33369 `d` address are published, and the
    // summary is monotonic, so an address no client can resolve to an album can
    // never be rewritten downward. On `null` we withhold the id rather than
    // publish one we have already established nobody can open.
    const feedGuid =
      split.parentFeedGuid === null
        ? undefined
        : split.parentFeedGuid ?? split.remoteItem?.feedGuid;
    return { feedGuid, itemGuid: split.remoteItem?.itemGuid };
  }
  // THE CONTAINER IS NOT ALWAYS THE PARENT, and `Episode.podcastGuid` is the
  // only thing that can say so. On every feed whose items are its own the two
  // are the same value, so this is a no-op there. On a `<podcast:medium>musicL`
  // PLAYLIST they are not: the item is a track resolved out of some other
  // artist's album, and `c.podcast` is the curated list the listener opened.
  //
  // Taking the container's guid there names a feed that does not contain the
  // item — an `i` tag and a kind:33369 `d` address no consumer can resolve back
  // to anything. The summary is MONOTONIC, so a wrong address is permanent: it
  // can never be rewritten downward or withdrawn. And it is the exact mistake
  // the split branch above spends twenty lines avoiding, arriving through the
  // one path that has no split to consult.
  return {
    feedGuid: c.episode.podcastGuid ?? c.podcast.podcastGuid,
    itemGuid: c.episode.guid,
  };
}

/**
 * The boostagram for one bucket's payment.
 *
 * For a TRACK bucket this mirrors BoostAllModal exactly: primary fields
 * describe the HOST episode (the playlist the listener actually chose), and
 * `remote_feed_guid`/`remote_item_guid` identify the track. The receiving
 * artist sees the listener's real context rather than their own track
 * mangled into the podcast field, and the host's Helipad can correlate which
 * track earned the payment. Don't "simplify" it by putting the track in the
 * primary fields.
 *
 * `action` is **'auto'**, not 'stream'. Both are Podcasting 2.0 values for an
 * unattended payment, and the distinction receivers draw is cadence: 'stream'
 * means the per-minute drip, one payment per minute per recipient. We batch on
 * a ten-minute timer (SETTLE_INTERVAL_MS) precisely because a per-minute LNURL
 * invoice per leg is unaffordable on a BOLT11-only rail — so what arrives at
 * the recipient is a periodic lump for time already listened, which is what
 * 'auto' describes. Tagging it 'stream' made the ten-minute batch read as one
 * minute's worth of listening in the receiver's stats.
 *
 * This does NOT make it a boost: 'boost' stays reserved for the button, so
 * the deliberate, one-tap payments a host actually reads stay separable from
 * the ambient ones. Confirmed against a real Helipad: 'auto' lands in the
 * Stream tab carrying an AutoBoost marker, so these stay out of the host's
 * boost feed while still reading as distinct from a per-minute drip.
 */
function buildBoostagram(
  c: StreamContext,
  bucket: string,
  sats: number,
  atPositionSec: number,
): Boostagram {
  const { episode, podcast } = c;
  const { feedGuid, itemGuid } = paymentIds(c, bucket);
  return {
    app_name: BRAND.wireName,
    app_version: '0.1.0',
    podcast: podcast.title,
    feedID: podcast.id,
    url: podcast.url,
    ts: Math.max(0, Math.floor(atPositionSec)),
    value_msat_total: sats * 1000,
    action: 'auto',
    uuid: randomId(),
    episode: episode.title,
    itemID: episode.id,
    episode_guid: episode.guid,
    remote_feed_guid: feedGuid,
    remote_item_guid: itemGuid,
    // Split Kit correlation for THIS bucket's block — recorded when the bucket
    // was adopted, because by the time a track's sats settle the watcher has
    // usually moved on. Absent for every other kind of payment, and
    // JSON.stringify drops undefined keys, so those stay byte-identical.
    ...(bucket !== HOST_BUCKET ? c.liveEvents?.get(bucket) ?? {} : {}),
    ...senderFields(),
  };
}

/** The value block a bucket pays into, and a label for the log. */
function targetFor(c: StreamContext, bucket: string): { value: ValueBlock; label?: string } {
  const split = bucket === HOST_BUCKET ? null : c.splits.get(bucket);
  // A bucket whose split vanished (cache cleared mid-episode) falls back to the
  // host block rather than stranding sats that were already accrued.
  if (!split || !hasValueRecipients(split.value)) return { value: c.value };
  return { value: split.value!, label: split.title };
}

/**
 * Give unsent sats back after a failed run.
 *
 * The live ledger when the item is still playing; otherwise straight back to
 * `bmb:stream_pending` under the item's own key. The second path matters: a
 * settle can still be in flight when the context is torn down (engine stop,
 * Fast Refresh), and the earlier version — which only ever credited the live
 * ledger — silently dropped those sats.
 *
 * What does NOT change: a refund never lands in a DIFFERENT item's accrual.
 * That would invent a cross-item debt surfacing during some unrelated show
 * later, which is worse than dropping. Dropping errs toward not spending the
 * user's money, the correct direction for a mistake we can't fully avoid.
 */
function refund(c: StreamContext, bucket: string, sats: number) {
  const credit = (l: StreamLedger): StreamLedger => ({
    ...l,
    buckets: { ...l.buckets, [bucket]: (l.buckets[bucket] ?? 0) + sats * 1000 },
  });
  if (ctx?.key === c.key && ledger) {
    ledger = credit(ledger);
    persist(ledger);
    return;
  }
  const pending = storage.streamPending.get();
  if (pending && pending.key === c.key) storage.streamPending.set(credit(pending));
}

/**
 * Record a failed settle against the item it happened on.
 *
 * `indeterminate` is carried separately from `message` because the two answer
 * different questions: the message says what went wrong, this says whether the
 * sats may have moved anyway. Defaulted to false so the non-payment failures
 * above (no wallet, rail can't pay) keep their honest "nothing was sent" — a
 * settle that never reached a wallet definitively didn't spend anything.
 */
function noteFailure(
  c: StreamContext,
  message: string,
  reason: StreamStoppedReason,
  indeterminate = false,
) {
  lastError = message;
  lastErrorKey = c.key;
  lastErrorSentSats = batchSentSats;
  lastErrorIndeterminate = indeterminate;
  consecutiveFailures++;
  // 'rail-cannot-pay' gives up immediately: it's a capability gap, not a bad
  // moment, so a second attempt is guaranteed to fail identically.
  const giveUp =
    reason === 'rail-cannot-pay' || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
  if (!giveUp) return;
  disabledKey = c.key;
  stoppedReason = reason;
  // One entry per item, not per attempt — a broken wallet must not fill a
  // capped log with noise, but "why did nothing send?" has to be answerable.
  storage.streamed.add(useApp.getState().identity?.npub, {
    ts: Date.now(),
    sats: 0,
    podcastTitle: c.podcast.title,
    podcastGuid: c.podcast.podcastGuid,
    episodeTitle: c.episode.title,
    ok: false,
    error: message,
  });
}

/**
 * Publish the kind:3369 value-playback receipt for a settle that PAID.
 *
 * Called from runSettle's success branch and nowhere else, so it sits behind
 * the same `paidAny(results)` gate the local streamed log does. That placement
 * is the load-bearing part: a receipt is an assertion that money moved, and a
 * NIP-47 reply timeout means the wallet was asked and never answered. Invariant
 * 11 in CLAUDE.md forbids rendering that as a failure; it forbids rendering it
 * as a success just as hard, and a receipt is a permanent public one.
 *
 * Four reasons to publish nothing, and they are answers about the LISTENER
 * rather than about the event, which is why they live here rather than in
 * lib/nostr/value-playback.ts:
 *
 *  1. **The setting is off**, which is its default. `bmb:stream_receipts` is
 *     deliberately not folded into `bmb:share_nostr`: that one consented to a
 *     note per button press, and this is a continuous timestamped record of
 *     what was played and when.
 *  2. **Anonymous is set.** A listener who chose it has been told their pubkey
 *     does not ride along with their payments. Publishing a receipt with no
 *     `name` would honour the letter and break the promise, because the
 *     SIGNATURE is the pubkey — so the answer is no event at all, not a
 *     quieter one.
 *  3. **The signer would prompt or hang** (`canSignUnattended`). Amber puts an
 *     approval sheet in front of the user for every signature and a settle
 *     fires six times an hour; a bunker is a network round trip that can hang.
 *  4. **Nothing actually settled.** A batch can be reported as paid on one leg
 *     while others failed, so the amount is summed over legs that really moved
 *     sats rather than taken from the bucket total.
 *
 * Never awaited. The settle `chain` serializes PAYMENTS, and parking a relay
 * round trip in it would delay the next one. `publishValuePlaybackReceipt`
 * resolves either way, so the bare `void` cannot strand a rejection — and a
 * failure here must never reach `noteFailure`, because two failed settles stop
 * the engine and a relay outage is not a failed settle.
 */
function maybePublishReceipt(
  c: StreamContext,
  bucket: string,
  results: BoostResult[],
  windowStartMs: number,
  atPositionSec: number,
) {
  // TOTAL BY CONSTRUCTION, and this is not defensive habit — it is the one
  // thing standing between a bookkeeping bug and a money bug. The call site is
  // inside runSettle's `try`, whose `catch` refunds the bucket and calls
  // noteFailure. So a synchronous throw from anywhere in here would credit the
  // ledger with sats that HAVE ALREADY LEFT THE WALLET (the next settle then
  // spends them again — the double-spend this whole file is ordered to prevent)
  // and count a successful payment as a failure, two of which stop the engine
  // for the item. Catching at the function rather than at the call site is
  // deliberate: a second caller added later inherits the guarantee instead of
  // having to remember it.
  try {
    if (!storage.streamReceipts.get()) return;
    if (!streamingMayPublish()) return;
    if (!canSignUnattended()) return;
    const identity = useApp.getState().identity;
    if (!identity) return;
    const settledMsat = results.reduce(
      (n, r) => (r.ok && r.sats > 0 ? n + r.sats * 1000 : n),
      0,
    );
    if (settledMsat <= 0) return;
    const { feedGuid, itemGuid } = paymentIds(c, bucket);
    // A receipt that names NEITHER is unpublishable, not merely thin.
    //
    // `Podcast.podcastGuid` is optional, a Split Kit live block may name no feed,
    // and `paymentIds` now withholds a guid it knows to be unresolvable — so all
    // three ids can be absent at once. `buildValuePlaybackReceipt` skips both tag
    // blocks in that case and the event goes out with an amount and no NIP-73
    // identifier: a permanent, signed, public assertion that sats moved, naming
    // nothing. It cannot be found by the `#i` filter that is the whole point of
    // the kind, cannot be summarized, and cannot be edited or withdrawn.
    //
    // Publishing less is the cheap direction here: the payment still happened and
    // the local log still records it.
    if (!feedGuid && !itemGuid) return;
    // Only past every refusal above: a feed with no receipt has nothing to
    // summarize. `label` is the track/episode title the log already resolved,
    // used for the summary's human-readable `alt`.
    if (feedGuid) {
      if (!c.summarizedFeeds) c.summarizedFeeds = new Map();
      if (!c.summarizedFeeds.has(feedGuid)) {
        // The label names the FEED, never the track. `targetFor(...).label` is
        // the song for a track bucket, and this address aggregates every track
        // on that feed — so using it makes a kind:33369 for a whole album
        // permanently advertise one song's name as the album's total, and
        // `if (!has(feedGuid))` means the first song of the listen wins and
        // sticks. `ValueTimeSplit.feedTitle` is documented as "the album the
        // track belongs to, not the show playing it", which is exactly this.
        const split = bucket === HOST_BUCKET ? null : c.splits.get(bucket);
        c.summarizedFeeds.set(feedGuid, split?.feedTitle ?? c.podcast.title);
      }
    }
    void publishValuePlaybackReceipt({
      feedGuid,
      itemGuid,
      msat: settledMsat,
      action: 'auto',
      startSec: Math.floor(windowStartMs / 1000),
      endSec: Math.floor(Date.now() / 1000),
      positionSec: Math.max(0, Math.floor(atPositionSec)),
      session: c.sessionId,
      label: targetFor(c, bucket).label ?? c.episode.title,
      relays: resolvePublishRelays(identity),
    });
  } catch (e) {
    console.warn('[3369] receipt skipped', e);
  }
}

async function runSettle(
  c: StreamContext,
  bucket: string,
  sats: number,
  atPositionSec: number,
  /** Wall-clock ms this billing window opened — the receipt's `start`. */
  windowStartMs: number,
) {
  const rail = pickRail();
  if (!rail) {
    refund(c, bucket, sats);
    noteFailure(c, 'no wallet connected', 'failures');
    return;
  }
  const { value, label } = targetFor(c, bucket);
  // Spark is BOLT11-only, so a value block of nothing but node pubkeys can
  // never be paid from it — no amount of retrying changes that, and telling the
  // user to change the rate just loops them through the same failure.
  if (rail === 'spark' && value.recipients.every((r) => r.type === 'node')) {
    refund(c, bucket, sats);
    noteFailure(
      c,
      "this show pays Lightning nodes directly, which the Spark wallet can't send",
      'rail-cannot-pay',
    );
    return;
  }
  // Set before the throw below so the catch can tell a wallet that REFUSED from
  // one that never answered. It can't be recovered from the Error — the two
  // arrive as the same string — and `results` is out of scope by then.
  let indeterminate = false;
  try {
    const results = await sendBoost({
      value,
      totalSats: sats,
      boostagram: buildBoostagram(c, bucket, sats, atPositionSec),
      rail,
    });
    if (!paidAny(results)) {
      indeterminate = results.some((r) => r.indeterminate);
      throw new Error(results.find((r) => r.error)?.error || 'no recipient could be paid');
    }
    consecutiveFailures = 0;
    lastError = null;
    lastErrorKey = null;
    lastErrorSentSats = 0;
    lastErrorIndeterminate = false;
    sessionSentSats += sats;
    batchSentSats += sats;
    storage.streamed.add(useApp.getState().identity?.npub, {
      ts: Date.now(),
      sats,
      podcastTitle: c.podcast.title,
      podcastGuid: c.podcast.podcastGuid,
      // The track title when a valueTimeSplit earned it, so the log says who
      // was actually paid rather than crediting everything to the playlist.
      episodeTitle: label ?? c.episode.title,
      ok: true,
    });
    // Inside the paidAny() gate on purpose — see maybePublishReceipt, which
    // swallows everything precisely because this sits inside a try whose catch
    // refunds the bucket. Last in the branch so the local log is already
    // written whatever happens here.
    maybePublishReceipt(c, bucket, results, windowStartMs, atPositionSec);
  } catch (e) {
    // A partial failure never lands here — paidAny() means money moved, and
    // re-sending the whole batch to recover one failed leg would pay the
    // others twice.
    refund(c, bucket, sats);
    noteFailure(c, getErrorMessage(e, 'streaming payment failed'), 'failures', indeterminate);
  }
}

/**
 * Settle if the plan says to, then queue the payment.
 *
 * **The ledger is debited synchronously, before the payment is awaited.** This
 * is the ordering rule of the whole file: crediting the deduction after the
 * await leaves the same sats sitting in the ledger for the next tick to spend
 * again — a real double-spend, not a rounding error. The cost of this
 * direction is that a payment which fails has to be refunded (above), and one
 * that dies with the tab is simply lost. Losing sats is recoverable; sending
 * them twice from someone's wallet is not.
 */
function maybeSettle(c: StreamContext, l: StreamLedger, force: boolean): StreamLedger {
  // The settle interval belongs to the BATCH and each bucket's floor belongs to
  // the BUCKET — settleBatch enforces both, and the split is deliberate. This
  // used to be a loop over settlePlan here, which failed the interval gate for
  // every bucket after the first; see the note on settleBatch.
  //
  // A track that only got 40 seconds of play stays under its floor and CARRIES,
  // across the rest of the episode and across replays (the bucket key is the
  // track's guid), so a short track eventually gets paid rather than being
  // rounded away every batch — and no artist is paid dust at a full routing fee.
  const { runs, nextLedger } = settleBatch(l, {
    nowMs: Date.now(),
    force,
    recipientCountFor: (bucket) => targetFor(c, bucket).value.recipients.length,
  });
  if (!runs.length) return l;
  // Debited and persisted synchronously, BEFORE any payment is awaited. The
  // chain callbacks below can only run on a later microtask, so there is no
  // window in which the same sats are both owed and in flight.
  persist(nextLedger);
  const atPositionSec = nextLedger.lastPositionSec;
  // Captured from the ledger BEFORE settleBatch stamped the new one, so the
  // receipt's `start`/`end` describe the window that was just billed rather
  // than a zero-length one. Read here rather than inside runSettle: by the time
  // a chained settle runs, `ledger` has moved on.
  const windowStartMs = l.lastSettleMs;
  // "How much did THIS batch already pay before it failed" — so it resets at the
  // batch boundary, and does so as a link in `chain` rather than here. Enqueue
  // order is not run order: a batch queued while an earlier one is still
  // settling would otherwise zero the count mid-flight and the meter would
  // under-report what the earlier batch had sent.
  chain = chain.then(() => {
    batchSentSats = 0;
  });
  for (const { bucket, sats } of runs) {
    pendingSettles++;
    chain = chain
      .then(() => runSettle(c, bucket, sats, atPositionSec, windowStartMs))
      .finally(() => {
        pendingSettles--;
        notifyIfChanged();
      });
  }
  return nextLedger;
}


/**
 * Hand this listen's feed ids to the kind:33369 summary queue.
 *
 * The guards are `maybePublishReceipt`'s, plus one: **summaries require
 * receipts.** A summary is derived from receipts, so with receipts off there is
 * nothing new to derive from and the only effect would be republishing an
 * unchanged total — which the predicate refuses anyway, after paying for two
 * relay reads to find out.
 *
 * Re-read here rather than captured when the receipt was published, because a
 * listener may turn either switch off mid-listen and the honest reading of that
 * is "stop", not "finish what was queued".
 *
 * Total by construction, for the same reason `maybePublishReceipt` is — and the
 * reason is now stronger. `releaseContext` queues this as a link in the settle
 * `chain` rather than calling it on the tick, so a throw would reject `chain`
 * and take every later settle down with it, not just the current tick.
 */
function maybeQueueSummaries(c: StreamContext) {
  try {
    const feeds = c.summarizedFeeds;
    if (!feeds?.size) return;
    if (!storage.streamReceipts.get()) return;
    if (!storage.streamSummaries.get()) return;
    if (!streamingMayPublish()) return;
    if (!canSignUnattended()) return;
    const identity = useApp.getState().identity;
    if (!identity?.pubkey) return;
    queueSummaryUpdate({
      ids: Array.from(feeds, ([id, label]) => ({
        id: `podcast:guid:${id}`,
        idKind: 'podcast:guid',
        label,
      })),
      pubkey: identity.pubkey,
      relays: resolvePublishRelays(identity),
    });
  } catch (e) {
    console.warn('[33369] summaries not queued', e);
  }
}

/**
 * Tear down the current item.
 *
 * `settle: true` for the real edges — item change, streaming turned off,
 * playback no longer eligible — where the listener has finished with this item
 * and what they owe should go out under its own metadata.
 *
 * `settle: false` for engine shutdown, and that is not a detail. `<Player>`'s
 * cleanup runs on every Fast Refresh, so a settling teardown means editing a
 * comment fires a real Lightning payment. It is the same argument onPageHide
 * already makes: a payment started while we're being torn down can't be
 * observed, and one sent without its deduction recorded is the double-spend
 * this whole file is ordered to prevent. Nothing is lost — the accrual persists
 * to bmb:stream_pending and is re-adopted next time the item plays.
 */
function releaseContext(settle: boolean) {
  if (settle && ctx && ledger) ledger = maybeSettle(ctx, ledger, true);
  // Queue the kind:33369 summaries for the feeds this listen actually paid.
  //
  // **Gated on `settle` for the same reason the settle itself is.** The
  // `settle: false` path is engine shutdown, and <Player>'s cleanup runs on
  // every Fast Refresh — a summary pass there means editing a comment fires a
  // signature request and a pair of relay writes, which is the dev-loop
  // version of the bug that makes teardown non-settling.
  //
  // Queued as a LINK IN `chain`, after the settles above, not on this tick.
  //
  // `summarizedFeeds` is written inside `maybePublishReceipt`, which runs inside
  // `runSettle` — and `maybeSettle` only ENQUEUES that. Reading the map here
  // synchronously therefore misses the release settle's feeds, and when the
  // release settle is the listen's ONLY settle the map is still empty, so
  // `maybeQueueSummaries` hits `if (!feeds?.size) return` and queues nothing at
  // all. That is not an edge case: STREAM_SETTLE_INTERVAL_MS is ten minutes of
  // billed playback, so every listen shorter than that has exactly one settle.
  // The map is per-context and starts empty each time, so "the next listen picks
  // it up" does not rescue it either — a listener who works in short sessions
  // would never publish a summary at all.
  //
  // Chaining is enough, and does not need the publish to have landed: the
  // `summarizedFeeds.set` is synchronous inside `maybePublishReceipt`, ahead of
  // the fire-and-forget relay write. `ctx` is captured because it is nulled
  // below, before the callback runs. `maybeQueueSummaries` is total by
  // construction, which matters more here than it did on the tick: a throw would
  // now reject `chain` and take every later settle with it.
  if (settle && ctx) {
    const summarized = ctx;
    chain = chain.then(() => maybeQueueSummaries(summarized));
  }
  if (ledger) persist(ledger);
  ctx = null;
  ledger = null;
  // Per-item state dies with the item: a single failure here plus a single
  // failure on the next item must not add up to a give-up on the next item.
  consecutiveFailures = 0;
  // The meter subscribes to this observable and tick() only notifies while a
  // context is live — without this, going inactive would leave the last
  // accrual painted on screen forever.
  notifyIfChanged();
}

/**
 * Adopt the on-disk accrual when it belongs to the item now starting.
 *
 * A pending ledger for a DIFFERENT item is dropped rather than carried: it can
 * only ever be a sub-threshold remainder (anything payable was force-settled
 * when that item ended), and settling it would need metadata — title, guid,
 * value block — this session no longer has.
 */
function openContext(c: StreamContext) {
  const now = Date.now();
  // Fire-and-forget: the first ticks accrue to the host while this resolves,
  // which is the right default and costs at most a second or two of a long
  // episode. Guarded on identity so a resolve landing after the user has
  // skipped away can't retarget the item now playing.
  if (c.episode.valueTimeSplits?.length) {
    void loadSplits(c.episode).then((map) => {
      if (ctx?.key === c.key) ctx.splits = map;
    });
  }
  const pending = storage.streamPending.get();
  if (pending && pending.key === c.key && !isStaleLedger(pending, now)) {
    // Re-stamp the tick clocks: the gap since the tab closed is not listening
    // time, and a stale lastTickMs would bill it as one giant catch-up tick.
    // `billedMs` is deliberately NOT reset — it is the listener's progress
    // toward the next payout and it pairs with the sats already sitting in
    // `buckets`. Zeroing it would restart the countdown while the balance
    // stayed, so a reload nine minutes in would pay 200 twenty minutes later
    // instead of 100 in one.
    ledger = { ...pending, lastTickMs: now, lastPositionSec: useApp.getState().positionSec, lastSettleMs: now };
  } else {
    if (pending) storage.streamPending.clear();
    ledger = { ...createLedger(c.key, now), lastPositionSec: useApp.getState().positionSec };
  }
  // `randomId`, not `crypto.randomUUID`: this runs from the bare
  // `setInterval(tick)` callback with no `try` above it, and `randomUUID` is
  // secure-context-only. Over `http://<LAN-IP>` a bare call throws before
  // `ctx = c`, so every later tick fails the same way and the engine accrues
  // nothing, pays nothing and says nothing.
  c.sessionId = randomId().slice(0, 8);
  ctx = c;
  persist(ledger);
}

function tick() {
  const st = useApp.getState();
  const cur = st.current;
  const key = cur ? itemKey(cur.episode, cur.podcast) : null;

  // Whatever the current item is, decide whether it's streamable at all.
  let next: StreamContext | null = null;
  const liveTarget = liveTargetSnapshot();
  if (cur && key && key !== disabledKey) {
    // On a live show the watcher has overwritten `episode.value` with the
    // artist's block so boosts follow it — so the HOST bucket's own target has
    // to come from the pre-swap block it kept, or the show's share would be
    // paid to whichever artist was on when the context opened.
    const value = liveTarget && liveTarget.guid === cur.episode.guid
      ? liveTarget.hostValue ?? cur.podcast.value
      // `payableValue`, never `episode.value ?? podcast.value`: on a PLAYLIST the
      // container's block belongs to the CURATOR, and this payer spends on a
      // timer with no confirmation step in front of it — so the wrong-payee
      // mistake the boost modal would at least render to somebody would here be
      // made six times an hour with nobody looking.
      : payableValue(cur.episode, cur.podcast);
    const plan = cachedStreamPlan(cur.podcast);
    const rate = plan.ratePerMin;
    // Live streams are the NIP-57 zap path (see the boost modal's live branch);
    // they have no finite position to meter against and their value block is
    // synthesized per-viewer.
    // A 'pending' live item is scheduled, not broadcasting — there is nothing
    // playing, so metering it would bill wall-clock against silence.
    const eligible =
      rate > 0
      && !isLiveStreamId(cur.episode.guid)
      && cur.episode.liveStatus !== 'pending'
      && hasValueRecipients(value);
    if (eligible) {
      next = {
        key,
        episode: cur.episode,
        podcast: cur.podcast,
        value: value!,
        ratePerMin: rate,
        mode: plan.mode,
        amountPerTrack: plan.amountPerTrack,
        // Populated asynchronously below. Until it lands, ticks accrue to the
        // host — correct rather than merely convenient: with no resolved
        // redirect, the show's own value block IS the target.
        splits: splitCache.get(splitCacheKey(cur.episode)) ?? new Map(),
      };
    }
  }

  // Item changed, streaming was turned off, or playback stopped — settle the
  // old item under its OWN metadata before anything else happens.
  if (ctx && (!next || next.key !== ctx.key)) releaseContext(true);
  if (!next) {
    lastPlaying = st.isPlaying;
    return;
  }
  // Rate, unit and amount can all change mid-listen; keep the context's copies
  // live so the meter and the accrual agree.
  if (ctx) {
    ctx.ratePerMin = next.ratePerMin;
    ctx.mode = next.mode;
    ctx.amountPerTrack = next.amountPerTrack;
  } else openContext(next);
  if (!ctx || !ledger) return;

  // Adopted per tick rather than on the watcher's callback: the context may not
  // exist when a target lands, and re-reading here is what makes the two
  // independent timers agree without either owning the other.
  adoptLiveTarget(ctx, liveTarget);

  const now = Date.now();
  const allocation = allocationAt(ctx, st.positionSec);
  // In per-track mode nothing accrues by time — but `accrue` still runs, with a
  // rate of 0, because it is what stamps `lastTickMs`/`lastPositionSec` and
  // clears the carry. Skipping it would leave the clock fields stale, and
  // switching the unit back to per-minute mid-show would bill one enormous
  // catch-up tick for every minute spent in track mode.
  ledger = accrue(ledger, {
    nowMs: now,
    positionSec: st.positionSec,
    playing: st.isPlaying,
    ratePerMin: ctx.mode === 'track' ? 0 : ctx.ratePerMin,
    allocation,
  });

  // A valueTimeSplit boundary is a settle edge too: the track the money was
  // accruing for has ended, and holding its bucket until an unrelated ten-minute
  // mark is what splits one track's payment into two. Evaluated AFTER accrue, so
  // the straddling tick lands on the incoming track first (the pinned boundary
  // rule) and the outgoing bucket is complete when it pays.
  const track = allocationTrackBucket(allocation);
  const trackChanged = ctx.lastTrack !== undefined && ctx.lastTrack !== track;

  ledger = applyTrackCredit(ctx, ledger, {
    track,
    allocation,
    nowMs: now,
    playing: st.isPlaying,
  });
  ctx.lastTrack = track;

  // Pause is a settle edge: the listener has stopped, so pay for what they
  // heard instead of holding it until they come back. Below the minimum this
  // is a no-op that just carries — see settlePlan.
  const pausedNow = lastPlaying && !st.isPlaying;
  lastPlaying = st.isPlaying;

  ledger = maybeSettle(ctx, ledger, pausedNow || trackChanged);

  if (pausedNow || now - lastPersistMs >= PERSIST_EVERY_MS) persist(ledger);
  notifyIfChanged();
}

/**
 * Persist on the way out. Deliberately does NOT try to settle: a payment
 * started here cannot finish, and firing one we can't observe is how a
 * settlement gets sent without the deduction ever being recorded. The accrual
 * survives on disk and is picked up when the item plays again.
 */
function onPageHide() {
  if (ledger) persist(ledger);
}

/** Drop the give-up state so the current item can be attempted again. */
function clearGiveUp() {
  disabledKey = null;
  stoppedReason = null;
  consecutiveFailures = 0;
  lastError = null;
  lastErrorKey = null;
  // Cleared with the error they qualify. Leaving them set would caption the
  // NEXT failure with the previous one's partial-send figure.
  lastErrorSentSats = 0;
  lastErrorIndeterminate = false;
  notifyIfChanged();
}

/** A rate change is one of the user's two "try again" gestures. */
function onRateChange() {
  rateCache = null;
  clearGiveUp();
}

/**
 * Connecting a wallet is the OTHER one, and the more important of the two.
 *
 * The commonest first failure by far is 'no wallet connected', so the natural
 * fix — go and connect one — left streaming disabled for that item with no
 * visible way back. Gated on pickRail() so a DISCONNECT notification doesn't
 * pointlessly re-arm an engine that still has nothing to pay with.
 */
function onWalletChange() {
  if (pickRail()) clearGiveUp();
}

let unsubRate: (() => void) | null = null;
let unsubWallets: Array<() => void> = [];
let unsubLive: (() => void) | null = null;

/** Started once from <Player>'s mount effect. Idempotent. */
export function startStreamingEngine() {
  if (timer || typeof window === 'undefined') return;
  lastPlaying = useApp.getState().isPlaying;
  rateCache = null;
  timer = setInterval(tick, TICK_MS);
  // A live switch repaints the meter's track line on the watcher's schedule
  // rather than waiting up to a second for the next tick. The tick is still
  // what adopts it — this only notifies.
  unsubLive = subscribeLiveTarget(notifyIfChanged);
  unsubRate = onStoredRateChange(onRateChange);
  unsubWallets = [
    subscribeNwc(onWalletChange),
    subscribeSpark(onWalletChange),
    subscribeWebln(onWalletChange),
  ];
  window.addEventListener('pagehide', onPageHide);
}

/**
 * Stop the clock and drop the current item WITHOUT settling — see
 * releaseContext. Module state that outlives this (`chain`, `pendingSettles`,
 * `disabledKey`, `sessionSentSats`) is deliberate: `chain` is what keeps
 * settles serialized across a remount, and `pendingSettles` is what keeps the
 * meter honest about money still in flight. Only a true HMR swap of this module
 * resets them, which is dev-only.
 */
export function stopStreamingEngine() {
  if (timer) { clearInterval(timer); timer = null; }
  if (unsubRate) { unsubRate(); unsubRate = null; }
  if (unsubLive) { unsubLive(); unsubLive = null; }
  for (const un of unsubWallets) un();
  unsubWallets = [];
  if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
  releaseContext(false);
  // Force: releaseContext already notified through the signature check, but a
  // stop must always reach subscribers so a mounted meter can clear itself.
  lastSig = '';
  observable.notify();
}
