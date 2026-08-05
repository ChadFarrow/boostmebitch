'use client';

// Streaming sats — the third Podcasting 2.0 payment mode, alongside the boost
// button and per-track boost-all.
//
// This is a ledger + a clock on top of the existing engine, NOT a new payment
// path: settlement calls the same `sendBoost()` every boost goes through, with
// `action: 'stream'` on the boostagram (a field lib/types.ts and
// lib/v4v/boostbox.ts already carry). Nothing about rails, splits, TLV or the
// lnaddress→keysend upgrade changes here.
//
// The arithmetic lives in ./stream-ledger.ts so `npm run check:stream` can pin
// it from plain Node. What lives HERE is the part that talks to the store, the
// wallet and the clock — and its own rules, each of which is about the one
// property that makes this feature different from every other payment in the
// app: **it spends money unattended, on a timer, with no confirmation step.**
//
//   - Settlement is SERIALIZED and the ledger is debited BEFORE the await.
//   - Two consecutive failures stop the engine for that item rather than
//     accruing a debt against a wallet that plainly can't pay it.
//   - Nothing is published to Nostr and nothing plays a sound. Streaming is
//     ambient; a note per settle would spam the user's feed and a ping every
//     ten minutes would be hostile.
//
// Not covered (deliberate, v1): `valueTimeSplits`. Streaming targets
// `episode.value ?? podcast.value`, so a music album streams to the feed's
// block rather than to each track's own artists. Boost-all remains the way to
// pay per-track.

import type { Episode, Podcast, Boostagram, ValueBlock, ValueTimeSplit } from '@/lib/types';
import { useApp } from '@/lib/store';
import { storage, subscribeStreamRate as onStoredRateChange } from '@/lib/storage';
import { createObservable } from '@/lib/pubsub';
import { getErrorMessage, hasValueRecipients } from '@/lib/util';
import { isLiveStreamId } from '@/lib/nostr/live-streams';
import { DEFAULT_SENDER_NAME } from '@/components/boost-modal/sender-name';
import { sendBoost, pickRail, paidAny } from './boost';
import {
  accrue,
  accruedSats,
  createLedger,
  fundedBuckets,
  HOST_BUCKET,
  isStaleLedger,
  msUntilSettle,
  settlePlan,
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
}

/**
 * Resolved splits per episode id, so an episode replayed (or resumed after a
 * skip away and back) doesn't re-fetch. `null` records "asked, nothing usable"
 * so a show without splits doesn't re-ask every time it starts.
 */
const splitCache = new Map<number, Map<string, ValueTimeSplit> | null>();

/** Stable key for a track across replays. */
function trackBucket(split: ValueTimeSplit): string {
  return `t:${split.remoteItem?.feedGuid ?? ''}:${split.remoteItem?.itemGuid ?? ''}`;
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
  const cached = splitCache.get(episode.id);
  if (cached !== undefined) return cached ?? new Map();
  if (!episode.valueTimeSplits?.length) {
    splitCache.set(episode.id, null);
    return new Map();
  }
  try {
    const res = await fetch(`/api/value-splits?feedId=${episode.feedId}&episodeId=${episode.id}`);
    const data = await res.json();
    const map = new Map<string, ValueTimeSplit>();
    for (const s of (data.splits as ValueTimeSplit[]) ?? []) {
      if (hasValueRecipients(s.value)) map.set(trackBucket(s), s);
    }
    splitCache.set(episode.id, map.size ? map : null);
    return map;
  } catch {
    // Not cached as a miss: a network blip must not pin the whole episode to
    // the host block for the rest of the session.
    return new Map();
  }
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
let consecutiveFailures = 0;
/** Item key streaming has given up on after repeated failures. */
let disabledKey: string | null = null;
let lastError: string | null = null;
let sessionSentSats = 0;

export interface StreamingStatus {
  /** Streaming is on and accruing for whatever is playing right now. */
  active: boolean;
  /** Resolved rate for the current item, sats/min. 0 = off / not eligible. */
  ratePerMin: number;
  accruedSats: number;
  msUntilSettle: number;
  settling: boolean;
  /** Last settle failure, cleared by the next success. */
  lastError: string | null;
  /** True once streaming gave up on this item — needs a rate change to resume. */
  stopped: boolean;
  /** Title of the `<podcast:valueTimeSplit>` track currently being credited,
   *  or null when the show's own value block is. */
  currentTrack: string | null;
  /** Sats settled this session, across items. */
  sessionSentSats: number;
}

export function streamingStatus(): StreamingStatus {
  const now = Date.now();
  return {
    active: !!ctx && !!ledger,
    ratePerMin: ctx?.ratePerMin ?? 0,
    accruedSats: ledger ? accruedSats(ledger) : 0,
    msUntilSettle: ledger ? msUntilSettle(ledger, now) : 0,
    settling: pendingSettles > 0,
    lastError,
    stopped: !!disabledKey && disabledKey === itemKeyOfCurrent(),
    currentTrack: ctx?.splits.size
      ? splitAt(ctx.splits, useApp.getState().positionSec)?.title ?? null
      : null,
    sessionSentSats,
  };
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
    action: 'stream',
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
 * Give unsent sats back to the live ledger after a failed run.
 *
 * Only when the failure belongs to the item still playing — a refund into an
 * item the user has left has nowhere to go, and inventing a cross-item debt
 * that surfaces during some unrelated show later is worse than dropping it.
 * Dropping errs toward not spending the user's money, which is the correct
 * direction for the mistake we can't avoid making here.
 */
function refund(c: StreamContext, bucket: string, sats: number) {
  if (ctx?.key === c.key && ledger) {
    ledger = {
      ...ledger,
      buckets: { ...ledger.buckets, [bucket]: (ledger.buckets[bucket] ?? 0) + sats * 1000 },
    };
    persist(ledger);
  }
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
    lastError = 'no wallet connected';
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) disabledKey = c.key;
    return;
  }
  const { value, label } = targetFor(c, bucket);
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
    lastError = getErrorMessage(e, 'streaming payment failed');
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) disabledKey = c.key;
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
  let next = l;
  // Each recipient clears its own floor independently. A track that only got
  // 40 seconds of play stays below it and CARRIES — across the rest of the
  // episode and across replays, since the bucket key is the track's guid — so
  // a short track eventually gets paid instead of being rounded away every
  // time, and no artist is paid dust at a full routing fee.
  for (const bucket of fundedBuckets(next)) {
    const { value } = targetFor(c, bucket);
    const plan = settlePlan(next, {
      bucket,
      nowMs: Date.now(),
      recipientCount: value.recipients.length,
      force,
    });
    if (!plan) continue;
    next = plan.nextLedger;
    persist(next);
    pendingSettles++;
    const atPositionSec = next.lastPositionSec;
    chain = chain
      .then(() => runSettle(c, bucket, plan.sats, atPositionSec))
      .finally(() => {
        pendingSettles--;
        observable.notify();
      });
  }
  return next;
}

/** Tear down the current item, settling whatever it owes first. */
function releaseContext() {
  if (ctx && ledger) ledger = maybeSettle(ctx, ledger, true);
  if (ledger) persist(ledger);
  ctx = null;
  ledger = null;
  // The meter subscribes to this observable and tick() only notifies while a
  // context is live — without this, going inactive would leave the last
  // accrual painted on screen forever.
  observable.notify();
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
  if (cur && key && key !== disabledKey) {
    const value = cur.episode.value ?? cur.podcast.value;
    const rate = resolveStreamRate(cur.podcast);
    // Live streams are the NIP-57 zap path (see the boost modal's live branch);
    // they have no finite position to meter against and their value block is
    // synthesized per-viewer.
    const eligible =
      rate > 0 && !isLiveStreamId(cur.episode.guid) && hasValueRecipients(value);
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
        splits: splitCache.get(cur.episode.id) ?? new Map(),
      };
    }
  }

  // Item changed, streaming was turned off, or playback stopped — settle the
  // old item under its OWN metadata before anything else happens.
  if (ctx && (!next || next.key !== ctx.key)) releaseContext();
  if (!next) {
    lastPlaying = st.isPlaying;
    return;
  }
  // Rate can change mid-listen; keep the context's copy live so the meter and
  // the accrual agree.
  if (ctx) ctx.ratePerMin = next.ratePerMin;
  else openContext(next);
  if (!ctx || !ledger) return;

  const now = Date.now();
  ledger = accrue(ledger, {
    nowMs: now,
    positionSec: st.positionSec,
    playing: st.isPlaying,
    ratePerMin: ctx.ratePerMin,
    allocation: allocationAt(ctx, st.positionSec),
  });

  // Pause is a settle edge: the listener has stopped, so pay for what they
  // heard instead of holding it until they come back. Below the minimum this
  // is a no-op that just carries — see settlePlan.
  const pausedNow = lastPlaying && !st.isPlaying;
  lastPlaying = st.isPlaying;

  ledger = maybeSettle(ctx, ledger, pausedNow);

  if (pausedNow || now - lastPersistMs >= PERSIST_EVERY_MS) persist(ledger);
  observable.notify();
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

/** Rate change is also the user's "try again" — clear the give-up state. */
function onRateChange() {
  disabledKey = null;
  consecutiveFailures = 0;
  lastError = null;
  observable.notify();
}

let unsubRate: (() => void) | null = null;

/** Started once from <Player>'s mount effect. Idempotent. */
export function startStreamingEngine() {
  if (timer || typeof window === 'undefined') return;
  lastPlaying = useApp.getState().isPlaying;
  timer = setInterval(tick, TICK_MS);
  unsubRate = onStoredRateChange(onRateChange);
  window.addEventListener('pagehide', onPageHide);
}

export function stopStreamingEngine() {
  if (timer) { clearInterval(timer); timer = null; }
  if (unsubRate) { unsubRate(); unsubRate = null; }
  if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
  releaseContext();
  observable.notify();
}
