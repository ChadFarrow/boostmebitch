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

import type { Episode, Podcast, Boostagram, ValueBlock, ValueTimeSplit } from '@/lib/types';
import { useApp } from '@/lib/store';
import { storage, subscribeStreamRate as onStoredRateChange } from '@/lib/storage';
import { createObservable } from '@/lib/pubsub';
// DEFAULT_SENDER_NAME lives in lib/util.ts, NOT in the boost modal that owns
// the "From" field — importing it from `components/` here would invert the v4v
// swap-out boundary and pull a 'use client' React module into the engine.
import { getErrorMessage, hasValueRecipients, DEFAULT_SENDER_NAME } from '@/lib/util';
import { isLiveStreamId } from '@/lib/nostr/live-streams';
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
  settleBatch,
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

/** The split covering a playback position, if any. */
function splitAt(splits: Map<string, ValueTimeSplit>, positionSec: number): ValueTimeSplit | null {
  for (const s of splits.values()) {
    if (positionSec >= s.startTime && positionSec < s.startTime + s.duration) return s;
  }
  return null;
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
  /** Resolved rate for the current item, sats/min. 0 = off / not eligible. */
  ratePerMin: number;
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
  /** Sats settled this session, across items. */
  sessionSentSats: number;
}

export function streamingStatus(): StreamingStatus {
  const now = Date.now();
  const currentKey = itemKeyOfCurrent();
  const isStopped = !!disabledKey && disabledKey === currentKey;
  return {
    active: !!ctx && !!ledger,
    ratePerMin: ctx?.ratePerMin ?? 0,
    accruedSats: ledger ? accruedSats(ledger) : 0,
    msUntilSettle: ledger ? msUntilSettle(ledger, now) : 0,
    settling: pendingSettles > 0,
    // Scoped to the item it happened on, exactly like `stopped` below.
    lastError: lastErrorKey && lastErrorKey === currentKey ? lastError : null,
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
  ].join('|');
  if (sig === lastSig) return;
  lastSig = sig;
  observable.notify();
}

/** Key a per-show rate override is stored under. */
export function streamShowKey(podcast: Podcast): string {
  return podcast.podcastGuid || String(podcast.id);
}

/**
 * The rate that applies to a show: the per-show override when one exists —
 * INCLUDING an explicit 0, which means "never stream this show" and has to
 * outrank the global rate — otherwise the global rate, otherwise off.
 */
export function resolveStreamRate(podcast: Podcast | null | undefined): number {
  if (!podcast) return 0;
  const show = storage.streamRate.getShow(streamShowKey(podcast));
  if (show !== null) return show;
  return storage.streamRate.get() ?? 0;
}

/**
 * Same answer as resolveStreamRate, memoized for the 1 Hz tick.
 *
 * Invalidated from `onRateChange`, which every setter in `storage.streamRate`
 * notifies — so this is exact, not merely fresh-enough. (Known, pre-existing:
 * nothing in the app listens for cross-tab `storage` events, so a rate changed
 * in another tab isn't seen live here either way.)
 */
let rateCache: { showKey: string; rate: number } | null = null;

function cachedStreamRate(podcast: Podcast): number {
  const showKey = streamShowKey(podcast);
  if (rateCache && rateCache.showKey === showKey) return rateCache.rate;
  const rate = resolveStreamRate(podcast);
  rateCache = { showKey, rate };
  return rate;
}

function itemKey(episode: Episode, podcast: Podcast): string {
  return `${podcast.podcastGuid || podcast.id}::${episode.guid || episode.id}`;
}

function itemKeyOfCurrent(): string | null {
  const cur = useApp.getState().current;
  return cur ? itemKey(cur.episode, cur.podcast) : null;
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
function senderFields(): { sender_name: string; sender_id: string | undefined } {
  const identity = useApp.getState().identity;
  const anonymous = storage.shareNostr.get() && storage.shareNostrAs.get() === 'site';
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
  const split = bucket === HOST_BUCKET ? null : c.splits.get(bucket);
  return {
    app_name: 'BoostMeBitch',
    app_version: '0.1.0',
    podcast: podcast.title,
    feedID: podcast.id,
    url: podcast.url,
    ts: Math.max(0, Math.floor(atPositionSec)),
    value_msat_total: sats * 1000,
    action: 'auto',
    uuid: crypto.randomUUID(),
    episode: episode.title,
    itemID: episode.id,
    episode_guid: episode.guid,
    ...(split
      ? {
          remote_feed_guid: split.remoteItem?.feedGuid,
          remote_item_guid: split.remoteItem?.itemGuid,
        }
      : {
          remote_feed_guid: podcast.podcastGuid,
          remote_item_guid: episode.guid,
        }),
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

/** Record a failed settle against the item it happened on. */
function noteFailure(c: StreamContext, message: string, reason: StreamStoppedReason) {
  lastError = message;
  lastErrorKey = c.key;
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

async function runSettle(
  c: StreamContext,
  bucket: string,
  sats: number,
  atPositionSec: number,
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
  try {
    const results = await sendBoost({
      value,
      totalSats: sats,
      boostagram: buildBoostagram(c, bucket, sats, atPositionSec),
      rail,
    });
    if (!paidAny(results)) {
      throw new Error(results.find((r) => r.error)?.error || 'no recipient could be paid');
    }
    consecutiveFailures = 0;
    lastError = null;
    lastErrorKey = null;
    sessionSentSats += sats;
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
  } catch (e) {
    // A partial failure never lands here — paidAny() means money moved, and
    // re-sending the whole batch to recover one failed leg would pay the
    // others twice.
    refund(c, bucket, sats);
    noteFailure(c, getErrorMessage(e, 'streaming payment failed'), 'failures');
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
  for (const { bucket, sats } of runs) {
    pendingSettles++;
    chain = chain
      .then(() => runSettle(c, bucket, sats, atPositionSec))
      .finally(() => {
        pendingSettles--;
        notifyIfChanged();
      });
  }
  return nextLedger;
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
    // Re-stamp the clocks: the gap since the tab closed is neither listening
    // time nor a settle interval the user waited through.
    ledger = { ...pending, lastTickMs: now, lastPositionSec: useApp.getState().positionSec, lastSettleMs: now };
  } else {
    if (pending) storage.streamPending.clear();
    ledger = { ...createLedger(c.key, now), lastPositionSec: useApp.getState().positionSec };
  }
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
      : cur.episode.value ?? cur.podcast.value;
    const rate = cachedStreamRate(cur.podcast);
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
  // Rate can change mid-listen; keep the context's copy live so the meter and
  // the accrual agree.
  if (ctx) ctx.ratePerMin = next.ratePerMin;
  else openContext(next);
  if (!ctx || !ledger) return;

  // Adopted per tick rather than on the watcher's callback: the context may not
  // exist when a target lands, and re-reading here is what makes the two
  // independent timers agree without either owning the other.
  adoptLiveTarget(ctx, liveTarget);

  const now = Date.now();
  const allocation = allocationAt(ctx, st.positionSec);
  ledger = accrue(ledger, {
    nowMs: now,
    positionSec: st.positionSec,
    playing: st.isPlaying,
    ratePerMin: ctx.ratePerMin,
    allocation,
  });

  // A valueTimeSplit boundary is a settle edge too: the track the money was
  // accruing for has ended, and holding its bucket until an unrelated ten-minute
  // mark is what splits one track's payment into two. Evaluated AFTER accrue, so
  // the straddling tick lands on the incoming track first (the pinned boundary
  // rule) and the outgoing bucket is complete when it pays.
  const track = allocationTrackBucket(allocation);
  const trackChanged = ctx.lastTrack !== undefined && ctx.lastTrack !== track;
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
