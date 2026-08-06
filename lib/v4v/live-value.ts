'use client';

// Live value switching — following the artist during a live music show.
//
// A live V4V show plays a different artist every few minutes and the payment
// target is meant to follow. `<podcast:valueTimeSplit>` cannot express that —
// it is anchored to startTime/duration offsets into a finished enclosure, and a
// live stream has no absolute time base to sync those to.
//
// Two mechanisms exist, and this module runs both:
//
//   PUSH (what the shows actually use) — `<podcast:liveValue uri protocol>`
//   inside the live item names a socket the show broadcasts its current target
//   on. The Split Kit publishes this; see live-block.ts. Sub-second, and the
//   only signal that carries the host's own track metadata.
//
//   POLL (the fallback) — the publisher rewrites the live item per track and
//   we re-read it. See resolveLiveSplit in lib/pi.ts for how the three RSS
//   shapes are told apart.
//
// The push channel wins whenever it is delivering: it is what the host is
// actively driving, where re-reading XML is inference. This module owns no
// payment logic — it resolves "who is playing right now" and publishes it, and
// the two payment paths pick it up: boosts through `episode.value` in the
// store, streaming sats through a ledger bucket in streaming.ts.

import type { Episode, Podcast, ValueBlock, ValueTimeSplit } from '../types';
import { useApp } from '../store';
import { createObservable } from '../pubsub';
import { hasValueRecipients, fnvHash } from '../util';
import { connectLiveValue, type LiveBlock } from './live-block';

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
  signal: 'live-value' | 'remote-item' | 'value-time-split' | 'value' | 'none';
  /** Split Kit correlation ids, when the target came off a liveValue socket.
   *  Passed through onto the boostagram so the host's own tooling can tie a
   *  payment to the block that earned it. */
  event?: { eventGuid?: string; blockGuid?: string; eventAPI?: string };
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
  /** Disposer for a <podcast:liveValue> socket, when the show publishes one. */
  closeSocket?: () => void;
  /** True once the socket has delivered a block. The RSS poll stops writing a
   *  target while this holds: a push channel the show is actively driving is
   *  strictly better evidence than anything we can infer from re-reading XML,
   *  and letting a poll land on top would flip the target back and forth. */
  socketOwns: boolean;
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
  if (watching) {
    watching.closeSocket?.();
    applyToStore(watching.guid, watching.baseValue);
  }
  watching = null;
  setTarget(null);
}

/**
 * A block pushed over the show's <podcast:liveValue> channel.
 *
 * Shaped into the same synthetic ValueTimeSplit as every other signal, so the
 * streaming engine's bucket, settle edge and boostagram all treat a Split Kit
 * block exactly like a valueTimeSplit track. The bucket key prefers the
 * block's own feed/item guids and falls back to its blockGuid — a Split Kit
 * block for a track that isn't in any feed still needs a stable identity, or
 * every push would mint a new bucket and strand the last one's accrual.
 */
function onLiveBlock(w: NonNullable<typeof watching>, block: LiveBlock | null) {
  if (watching !== w) return;
  if (!block) {
    // Not "pay the host": a dropped socket is not evidence the set ended. Let
    // the RSS fallback and the failure counter decide, exactly as for a failed
    // poll — so hand ownership back rather than clearing the target.
    w.socketOwns = false;
    return;
  }
  w.socketOwns = true;
  setTarget({
    guid: w.guid,
    signal: 'live-value',
    hostValue: w.baseValue,
    event: { eventGuid: block.eventGuid, blockGuid: block.blockGuid, eventAPI: block.eventAPI },
    split: {
      startTime: 0,
      duration: 0,
      value: block.value,
      title: block.title,
      image: block.image,
      remotePercentage: block.remotePercentage,
      remoteItem: block.feedGuid
        ? { feedGuid: block.feedGuid, itemGuid: block.itemGuid }
        : { feedGuid: `sk:${block.blockGuid ?? fnvHash(JSON.stringify(block.value))}` },
    },
  });
  applyToStore(w.guid, block.value);
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
      socketOwns: false,
    };
    // The push channel, when the show publishes one. Opened once per item.
    const lv = episode.liveValue;
    if (lv && lv.protocol === 'socket.io') {
      const w0 = watching;
      w0.closeSocket = connectLiveValue(lv.uri, (block) => onLiveBlock(w0, block));
    }
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
    // A live socket outranks anything re-reading the feed can tell us. Keep
    // polling (it is how we notice the broadcast ending) but don't write.
    if (w.socketOwns) return;

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
    if (w.failures >= MAX_FAILURES && !w.socketOwns) {
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
