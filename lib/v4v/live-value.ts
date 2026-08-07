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
import { trackBucket } from './stream-ledger';
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
  /**
   * The ledger bucket this target's sats accrue into — computed HERE, so the
   * identity of a track never has to be reconstructed from the wire fields.
   *
   * A Split Kit block often names no feed at all, and a rewritten
   * `<podcast:value>` never does, so both need an invented key. That key must
   * NOT be smuggled into `split.remoteItem.feedGuid` to get it here: both
   * boostagram builders copy that field straight into `remote_feed_guid`, which
   * is specified as an RSS `<podcast:guid>` — a recipient's aggregator would be
   * handed `sk:ed6adf33-…` in a UUID field. A guid we invented never leaves the
   * device; it lives on this field instead. Empty when `split` is null.
   */
  bucketKey: string;
  /**
   * Split Kit's block kind — `'music'` for a song, `'chapter'` for a host
   * segment (a promo, a photo, a phone number), `'podcast'` for the show's
   * default block. Undefined for every other signal.
   *
   * **Diagnostics only — it does NOT gate payment.** Per-track streaming credits
   * every kind of block, because the listener chose an amount for the show and a
   * promo is the show. A music-only filter was built and removed; see
   * `STREAM_TRACK_MIN_PLAY_MS` in `stream-ledger.ts` for what actually stops a
   * target nobody spent time on. Surfaced as `bmbLive().target.blockType`, which
   * is how "why did that block earn?" gets answered in one line.
   */
  blockType?: string;
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
/** Disposer for the vanilla store subscription — see onCurrentItemChange. */
let unsubStore: (() => void) | null = null;
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

/**
 * Why this item is or isn't being watched.
 *
 * Returned as a reason rather than a boolean because every one of these
 * conditions fails SILENTLY and looks identical from the outside: the target
 * just never moves. Mid-broadcast, "which of the four is it" is the only
 * question worth being able to answer instantly — see `window.bmbLive()`.
 */
function watchableReason(cur: { episode: Episode; podcast: Podcast } | null): string | null {
  if (!cur) return 'nothing playing';
  // 'pending' is scheduled, not broadcasting — there is nothing playing to
  // follow, and polling it would be a request per 20s for hours.
  if (cur.episode.liveStatus !== 'live') {
    return `liveStatus is ${cur.episode.liveStatus ?? 'unset'}, not "live"`;
  }
  if (!cur.episode.guid) return 'live item has no <guid>';
  if (!(cur.episode.feedId > 0)) return `feedId is ${cur.episode.feedId}`;
  return null;
}

function isWatchable(cur: { episode: Episode; podcast: Podcast } | null): boolean {
  return watchableReason(cur) === null;
}

/**
 * What makes one target DIFFERENT from another.
 *
 * The payees alone are not enough, and the gap is not theoretical on a live
 * music show: an artist playing two tracks back to back pushes two blocks with
 * identical destinations. Keyed on payees only, the second block reads as "no
 * change", `setTarget` returns early and the OLD split stays current — so the
 * meter and the boost modal name the previous track, `trackBucket` doesn't move
 * so there is no settle edge, and the settled boostagram credits the wrong
 * item guid. The bucket key and the title are what tell the two apart.
 */
function targetSig(t: LiveTarget | null): string {
  if (!t) return '';
  return `${t.guid}|${t.signal}|${t.bucketKey}|${t.blockType ?? ''}|${t.split?.title ?? ''}|${valueSig(t.split?.value)}`;
}

function setTarget(next: LiveTarget | null) {
  const sig = targetSig(next);
  const prev = targetSig(target);
  if (sig === prev) return;
  target = next;
  if (process.env.NODE_ENV !== 'production') {
    const n = next?.split?.value?.recipients?.length ?? 0;
    console.debug(
      `[live-value] target → ${next?.split ? next.split.title ?? '(untitled)' : 'the show\'s own block'}`
      + ` (signal: ${next?.signal ?? 'none'}, ${n} recipient${n === 1 ? '' : 's'})`,
    );
  }
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
 * block exactly like a valueTimeSplit track.
 *
 * `remoteItem` is set ONLY when the block names a real feed — it is what both
 * boostagram builders emit as `remote_feed_guid`, so an invented identity must
 * never be parked there. The bucket identity goes on `bucketKey` instead, and
 * falls back to the blockGuid (then to a fingerprint of title + payees): a
 * Split Kit block for a track that isn't in any feed still needs a stable key,
 * or every push mints a new bucket and strands the last one's accrual.
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
  const split: ValueTimeSplit = {
    startTime: 0,
    duration: 0,
    value: block.value,
    title: block.title,
    image: block.image,
    remotePercentage: block.remotePercentage,
    ...(block.feedGuid
      ? { remoteItem: { feedGuid: block.feedGuid, itemGuid: block.itemGuid } }
      : {}),
  };
  setTarget({
    guid: w.guid,
    signal: 'live-value',
    hostValue: w.baseValue,
    blockType: block.type,
    event: { eventGuid: block.eventGuid, blockGuid: block.blockGuid, eventAPI: block.eventAPI },
    split,
    // The title is in the fingerprint on purpose: two tracks by one artist push
    // identical payees, and a key derived from the payees alone would hold them
    // in a single bucket under the first track's name.
    bucketKey: trackBucket(
      split,
      `sk:${block.blockGuid ?? fnvHash(`${block.title ?? ''}|${valueSig(block.value)}`)}`,
    ),
  });
  applyToStore(w.guid, block.value);
}

/**
 * Open the show's push channel, if it publishes one and we don't already hold it.
 *
 * Idempotent and called on every poll rather than only when the watched item
 * changes, because `stopLiveValueWatcher` closes the socket while KEEPING
 * `watching` (it must — see there). Attaching only on an item change would
 * leave the reattached session permanently on the RSS fallback.
 */
function attachSocket(w: NonNullable<typeof watching>, episode: Episode) {
  if (w.closeSocket) return;
  const lv = episode.liveValue;
  if (!lv || lv.protocol !== 'socket.io') return;
  w.closeSocket = connectLiveValue(lv.uri, (block) => onLiveBlock(w, block));
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
  }
  const w = watching;
  attachSocket(w, episode);

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
      // A resolved RSS signal always names a real remote item, so the fallback
      // id is only ever a belt-and-braces guard against a malformed one.
      setTarget({
        guid,
        split: data.split,
        signal: data.signal,
        hostValue: w.baseValue,
        bucketKey: trackBucket(data.split, `live:${valueSig(data.split.value)}`),
      });
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
        split: { startTime: 0, duration: 0, value: data.value },
        // No remote item to name — and none is invented, because that field
        // ships as `remote_feed_guid`. The bucket is derived from the payees
        // themselves: it turns over exactly when they do, which is the settle
        // edge we need, and is stable across a replay of the same set.
        bucketKey: `live:${sig}`,
      });
      applyToStore(guid, data.value);
      return;
    }

    setTarget({ guid, split: null, signal: data.signal, hostValue: w.baseValue, bucketKey: '' });
    applyToStore(guid, data.value ?? w.baseValue);
  } catch {
    if (watching !== w) return;
    w.failures += 1;
    // Keep paying the last known artist until we've genuinely lost the feed.
    if (w.failures >= MAX_FAILURES && !w.socketOwns) {
      setTarget({ guid, split: null, signal: 'none', hostValue: w.baseValue, bucketKey: '' });
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

/**
 * Poll the moment a different item starts playing.
 *
 * Without this the watcher's only triggers are its own 20 s timer, `focus` and
 * `visibilitychange` — and **pressing play is none of those**. So hitting play
 * on a live show left the Split Kit socket unopened for up to a full poll
 * interval, during which the RSS fallback answered "the show's own block" and
 * payment went to the host while an artist was on. Visible in the console as
 * `target → the show's own block` landing well before `socket connected`.
 *
 * A VANILLA store subscription, not a hook: this runs outside React and renders
 * nothing, so it doesn't touch `<Player>`'s render path — the same reason the
 * watcher isn't a hook in the first place. The listener fires on every store
 * write (including the 1 Hz position tick), so its body must stay a guid
 * comparison and nothing more.
 */
function onCurrentItemChange(
  s: { current: { episode: Episode } | null },
  prev: { current: { episode: Episode } | null },
) {
  if (s.current?.episode.guid === prev.current?.episode.guid) return;
  // Forced: the whole point is not to wait out the interval.
  void poll(true);
}

/**
 * Devtools diagnostic: `bmbLive()`.
 *
 * Follows the repo's existing `window.bmbCleanFavorites()` convention. It
 * exists because every way this feature can fail is silent and looks the same
 * from the outside — the payment target simply never moves. This says which
 * one it is in one line, which is the difference between fixing a live show
 * mid-broadcast and guessing at it.
 */
function installDiagnostic() {
  if (typeof window === 'undefined') return;
  (window as any).bmbLive = () => {
    const cur = useApp.getState().current;
    const lv = cur?.episode.liveValue;
    return {
      notWatchingBecause: watchableReason(cur),
      episode: cur ? {
        title: cur.episode.title,
        guid: cur.episode.guid,
        feedId: cur.episode.feedId,
        liveStatus: cur.episode.liveStatus,
      } : null,
      // Absent here means the feed carries no <podcast:liveValue> — or it does
      // and the uri failed the httpUrl allowlist at parse time.
      liveValueTag: lv ?? null,
      socket: watching
        ? { opened: !!watching.closeSocket, delivering: watching.socketOwns }
        : null,
      pollFailures: watching?.failures ?? 0,
      target: target ? {
        signal: target.signal,
        payingTitle: target.split?.title ?? null,
        // The ledger bucket these sats land in. If this does NOT change when
        // the DJ changes track, the settle edge won't fire and both tracks pay
        // into one bucket — the first thing to check if a track looks skipped.
        bucketKey: target.bucketKey,
        // Why a block did or didn't earn a per-track credit: only 'music' (or
        // no type at all) does. 'chapter' is a host segment — a promo, a photo,
        // a phone number — and earns nothing in per-track mode.
        blockType: target.blockType ?? null,
        recipients: target.split?.value?.recipients?.map((r) => `${r.type} ${r.split} ${r.address}`) ?? null,
        remotePercentage: target.split?.remotePercentage ?? null,
        event: target.event ?? null,
      } : null,
      // Force a poll now instead of waiting out the interval.
      poll: () => { void poll(true); },
    };
  };
}

export function startLiveValueWatcher() {
  if (timer) return;
  installDiagnostic();
  timer = setInterval(() => { void poll(); }, POLL_MS);
  unsubStore = useApp.subscribe(onCurrentItemChange);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);
  }
  void poll(true);
}

export function stopLiveValueWatcher() {
  if (timer) clearInterval(timer);
  timer = null;
  if (unsubStore) { unsubStore(); unsubStore = null; }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onVisibility);
  }
  // Close the socket, but KEEP `watching`.
  //
  // Two halves, and they pull in opposite directions. The socket must close:
  // <Player>'s cleanup runs on every Fast Refresh, and leaving it open orphans
  // a connection the next poll would never reopen, since `watching.guid` still
  // matches. But `watching` must survive, because `baseValue` is the show's own
  // block captured BEFORE the first swap — rebuilding it from `episode.value`
  // after a restart would read back whatever artist was playing and pay the
  // host's share to them for the rest of the broadcast. `attachSocket` is what
  // reconnects on the next poll.
  //
  // For the same reason this does NOT restore the base value into the store:
  // rewriting it here would fight the watcher the next mount immediately starts.
  if (watching?.closeSocket) {
    watching.closeSocket();
    watching.closeSocket = undefined;
    // Ownership went with the socket. Leaving this set would keep the RSS
    // fallback muted for an item that no longer has a push channel.
    watching.socketOwns = false;
  }
}
