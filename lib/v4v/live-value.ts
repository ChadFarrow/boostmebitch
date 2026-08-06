'use client';

// Live value switching — following the artist during a live music show.
//
// A live V4V show plays a different artist every few minutes and the payment
// target is meant to follow. There is no tag for this: <podcast:valueTimeSplit>
// is anchored to startTime/duration offsets into a finished enclosure, and a
// live stream has no absolute time base to sync those to. The convention that
// ships is that the publisher REWRITES the live item mid-broadcast, so the only
// thing an app can do is re-read it on a timer. See resolveLiveSplit in
// lib/pi.ts for how the three RSS shapes are told apart.
//
// This module is the timer. It owns no payment logic: it resolves "who is
// playing right now" and publishes it, and the two payment paths pick it up —
// boosts through `episode.value` in the store, streaming sats through a ledger
// bucket in streaming.ts.

import type { Episode, Podcast, ValueBlock, ValueTimeSplit } from '../types';
import { useApp } from '../store';
import { createObservable } from '../pubsub';
import { hasValueRecipients, fnvHash } from '../util';

const POLL_MS = 20_000;
/** Overlapping triggers (interval + focus + visibilitychange) debounce to this. */
const POLL_MIN_MS = 15_000;
/**
 * How many consecutive failed polls before we stop believing the last target.
 *
 * A network blip is not evidence that the track ended, so a single failure must
 * NOT drop back to the host — that would pay the show for a song the artist
 * earned. But believing a target forever is worse in the other direction: a
 * broadcast that ended forty minutes ago would keep paying whoever was on last.
 * Three polls is about a minute, which is under half a song either way.
 */
const MAX_FAILURES = 3;

export interface LiveTarget {
  /** The live item's guid. Every consumer re-checks this before acting. */
  guid: string;
  /**
   * The now-playing split, or null to mean "pay the show's own block". Shaped
   * as a ValueTimeSplit so the streaming engine can treat a live track and a
   * valueTimeSplit track as the same kind of thing — see trackBucket().
   */
  split: ValueTimeSplit | null;
  signal: 'remote-item' | 'value-time-split' | 'value' | 'none';
  /**
   * The show's OWN block, as it was before any swap.
   *
   * Load-bearing: `applyToStore` overwrites `episode.value` with the artist's
   * block so boosts follow, and the streaming engine derives its HOST bucket
   * target from `episode.value ?? podcast.value`. Without this the host's own
   * share would be paid to whichever artist happened to be playing when the
   * context opened.
   */
  hostValue: ValueBlock | null;
}

const observable = createObservable();
export const subscribeLiveTarget = observable.subscribe;

let timer: ReturnType<typeof setInterval> | null = null;
let lastPollMs = 0;
let inFlight = false;
let target: LiveTarget | null = null;

/** Per-item state, reset whenever the live item being watched changes. */
let watching: {
  guid: string;
  feedId: number;
  /** The value block the episode had when we attached — what we restore to. */
  baseValue: ValueBlock | null;
  /** First-observed fingerprint of the live item's own <podcast:value>. */
  baselineSig: string | null;
  /** Set once that block has been seen to CHANGE. See the comment below. */
  valueIsLive: boolean;
  failures: number;
} | null = null;

export function liveTargetSnapshot(): LiveTarget | null {
  return target;
}

/** Stable fingerprint of a value block: changes exactly when the payees do. */
function valueSig(value: ValueBlock | null | undefined): string {
  if (!hasValueRecipients(value)) return '';
  const parts = value!.recipients
    .map((r) => `${r.type}:${r.address}:${r.split}:${r.customKey ?? ''}:${r.customValue ?? ''}`)
    .sort();
  return String(fnvHash(parts.join('|')));
}

function isWatchable(cur: { episode: Episode; podcast: Podcast } | null): boolean {
  // 'pending' is scheduled, not broadcasting — there is nothing playing to
  // follow, and polling it would be a request per 20s for hours.
  return !!cur && cur.episode.liveStatus === 'live' && !!cur.episode.guid && cur.episode.feedId > 0;
}

function setTarget(next: LiveTarget | null) {
  const sig = next ? `${next.guid}|${next.signal}|${valueSig(next.split?.value)}` : '';
  const prev = target ? `${target.guid}|${target.signal}|${valueSig(target.split?.value)}` : '';
  if (sig === prev) return;
  target = next;
  observable.notify();
}

/**
 * Push the resolved target into the store so every `episode.value` reader —
 * the boost modal, the value-split disclosure, the mini-bar's BOOST gate —
 * follows it with no plumbing of their own.
 *
 * Deliberately NOT `play()`: that force-sets `isPlaying: true` and resets
 * `positionSec` and `videoMode`, so using it here would un-pause a paused
 * listener and drop them out of video every time the DJ changed track.
 */
function applyToStore(guid: string, value: ValueBlock | null) {
  useApp.getState().syncCurrentValue(guid, value);
}

function detach() {
  if (watching) applyToStore(watching.guid, watching.baseValue);
  watching = null;
  setTarget(null);
}

async function poll(force = false) {
  const now = Date.now();
  if (inFlight) return;
  if (!force && now - lastPollMs < POLL_MIN_MS) return;
  if (typeof document !== 'undefined' && document.hidden) return;

  const cur = useApp.getState().current;
  if (!isWatchable(cur)) {
    if (watching) detach();
    return;
  }
  const episode = cur!.episode;
  const guid = episode.guid!;

  if (watching?.guid !== guid) {
    if (watching) detach();
    watching = {
      guid,
      feedId: episode.feedId,
      baseValue: episode.value ?? null,
      baselineSig: null,
      valueIsLive: false,
      failures: 0,
    };
  }
  const w = watching;

  lastPollMs = now;
  inFlight = true;
  try {
    const res = await fetch(
      `/api/live-value?feedId=${w.feedId}&guid=${encodeURIComponent(guid)}`,
    );
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json() as {
      split: ValueTimeSplit | null;
      signal: LiveTarget['signal'];
      value: ValueBlock | null;
    };
    // The user may have moved on during the round trip.
    if (watching !== w || useApp.getState().current?.episode.guid !== guid) return;
    w.failures = 0;

    if (data.split && hasValueRecipients(data.split.value)) {
      setTarget({ guid, split: data.split, signal: data.signal, hostValue: w.baseValue });
      applyToStore(guid, data.split.value!);
      return;
    }

    // Signal (3): the live item's own <podcast:value>, rewritten in place.
    //
    // This one is only a signal once it has been observed to CHANGE. A static
    // block inside a live item is indistinguishable from a show that simply has
    // a value block and never touches it — which is most live shows — so
    // treating it as "now playing" from the first poll would relabel every
    // ordinary live broadcast as a track and mint a bucket per show. The
    // distinction can only be drawn across polls, which is why it is drawn
    // here and not in the route.
    const sig = valueSig(data.value);
    if (w.baselineSig === null) w.baselineSig = sig;
    else if (sig && sig !== w.baselineSig) w.valueIsLive = true;

    if (w.valueIsLive && hasValueRecipients(data.value)) {
      setTarget({
        guid,
        signal: 'value',
        hostValue: w.baseValue,
        split: {
          startTime: 0,
          duration: 0,
          value: data.value,
          // No remote item to name, so the bucket is derived from the payees
          // themselves — it changes exactly when they do, which is the settle
          // edge we need, and is stable across a replay of the same set.
          remoteItem: { feedGuid: `live:${sig}` },
        },
      });
      applyToStore(guid, data.value);
      return;
    }

    setTarget({ guid, split: null, signal: data.signal, hostValue: w.baseValue });
    applyToStore(guid, data.value ?? w.baseValue);
  } catch {
    if (watching !== w) return;
    w.failures += 1;
    // Keep paying the last known artist until we've genuinely lost the feed.
    if (w.failures >= MAX_FAILURES) {
      setTarget({ guid, split: null, signal: 'none', hostValue: w.baseValue });
      applyToStore(guid, w.baseValue);
    }
  } finally {
    inFlight = false;
  }
}

function onVisibility() {
  // Coming back from the background has almost certainly missed a track.
  if (typeof document !== 'undefined' && !document.hidden) void poll();
}

export function startLiveValueWatcher() {
  if (timer) return;
  timer = setInterval(() => { void poll(); }, POLL_MS);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);
  }
  void poll(true);
}

export function stopLiveValueWatcher() {
  if (timer) clearInterval(timer);
  timer = null;
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onVisibility);
  }
  // Deliberately does NOT restore the base value: <Player>'s cleanup effect
  // runs on every Fast Refresh, and rewriting the store there would fight the
  // watcher that the next mount immediately starts.
}
