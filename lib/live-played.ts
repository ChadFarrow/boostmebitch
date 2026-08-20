'use client';

// What a live show has PLAYED so far — the log behind the favorite hearts on a
// live broadcast.
//
// A pre-recorded episode publishes its whole timeline up front, so
// `<EpisodeContents>` can list every `<podcast:valueTimeSplit>` window and hang
// a heart on each one. A live show has no timeline: the target arrives one
// block at a time over the show's `<podcast:liveValue>` socket (or is inferred
// from a re-read of the RSS — see `lib/v4v/live-value.ts`), and once the DJ
// moves on, the song that just played is gone from every surface in the app.
// So the only moment a listener could favorite a live track was the moment it
// was on air, and only if they were looking. This module remembers the blocks
// as they go by so the heart outlives the song.
//
// **It records, it does not decide.** Nothing here gates a payment, invents an
// identifier or writes to the favorites list; a row is favoritable exactly when
// `<FavTrackHeart>` says it is, off the same `remoteItem` the boostagram uses.
//
// **It lives here rather than in `lib/v4v/` on purpose.** That directory is the
// wallet/signer swap-out boundary, and a log of what was on the radio is not a
// wallet concern — the same argument that moved `DEFAULT_SENDER_NAME` out of a
// component and into `lib/util.ts`. `live-value.ts` imports THIS, so the arrow
// keeps pointing away from the payment engine, and a surface that only wants to
// list songs never has to reach into it.
//
// **In memory, deliberately.** A reload starts a fresh log. Persisting would
// mean a `bmb:*` key that is neither a setting nor a cache: `safeSet` may evict
// a cache because the network can rebuild it, and nothing can rebuild a socket
// broadcast that already happened. Rather than add an un-evictable blob to the
// tightest storage quota in the wild (see the `safeSet` notes in CLAUDE.md),
// the log is session-scoped and the favorites a listener already made are the
// part that persists — which is the part that matters.

import type { ValueTimeSplit } from './types';
import { createObservable } from './pubsub';

/** One block this broadcast put on air. */
export interface PlayedTrack {
  /**
   * The identity of the track — `LiveTarget.bucketKey`, the same key the
   * streaming ledger accrues into. Reused rather than re-derived so a row in
   * this list and a bucket in the ledger can never disagree about which two
   * blocks were the same song. It is a key we may have INVENTED (a Split Kit
   * block often names no feed), so it stays on this side of the wire — exactly
   * as `bucketKey` does. Nothing here ever ships it.
   */
  key: string;
  /** The block itself, in the synthetic `ValueTimeSplit` shape every live
   *  signal is normalized into. `<FavTrackHeart>` reads its `remoteItem`. */
  split: ValueTimeSplit;
  /**
   * Split Kit's block kind — `'music'` for a song, `'chapter'` for a host
   * segment, `'podcast'` for the show's own default block.
   *
   * Recorded per row rather than only consulted, because it cannot be recovered
   * afterwards: the target that carried it is gone the moment the next one
   * arrives. Nothing renders it today — see `recordLivePlay` for why it filters
   * one kind and keeps the rest — and a surface that later wants to label or
   * hide host segments needs it to have been kept from the start.
   */
  blockType?: string;
  /** When the block went on air, by this device's clock. There is no playback
   *  position to timestamp against on a live stream. */
  atMs: number;
}

/**
 * How many blocks one broadcast may remember.
 *
 * A three-hour DJ set is well under this; the cap is only here so a show that
 * flaps its target for hours can't grow the list without bound. The OLDEST go
 * first, which is the right end to lose: the newest rows are the songs still
 * fresh enough for someone to want.
 */
const MAX_TRACKS = 200;

const observable = createObservable();
export const subscribeLivePlayed = observable.subscribe;

/** The live item the log belongs to. One broadcast at a time — see below. */
let logGuid: string | null = null;
let log: PlayedTrack[] = [];

/**
 * What this live item has played, oldest first.
 *
 * **Guid-scoped, and the caller has to name the item.** Returning the log to
 * whoever asks would let a surface still mounted for the last show render the
 * next one's tracks, and every row would carry a working heart — so a listener
 * would favorite a song that was never on. An empty array is the answer for a
 * guid that isn't the one being logged, including `undefined`.
 *
 * The array is replaced, never mutated, so a `useState` snapshot compares by
 * identity and a React consumer re-renders exactly when a block is added.
 */
export function livePlayedSnapshot(guid?: string): PlayedTrack[] {
  if (!guid || guid !== logGuid) return [];
  return log;
}

/**
 * Record the block a live show just moved to.
 *
 * Called from `setTarget` in `lib/v4v/live-value.ts`, which is the ONE place
 * that sees every target change from every signal. The parameter is structural
 * rather than a `LiveTarget` import so this module keeps its back to
 * `lib/v4v/`; the fields are exactly the ones a `LiveTarget` already carries.
 *
 * Four rules, and each of them decides whether a row can appear at all:
 *
 * - **A different item resets the log.** One broadcast at a time: last night's
 *   set is not this one's, and keeping both would need per-guid pruning to stop
 *   a long session accumulating shows it will never render.
 * - **A null target records nothing and keeps the log.** `setTarget(null)` is
 *   "the watcher detached" — the user paused, or the tab went to the background
 *   — not "the show ended and its songs never happened". Clearing here would
 *   delete the list at exactly the moment a listener stops to look at it.
 * - **A block needs a name or an identifier.** The weakest RSS signal is a bare
 *   rewritten `<podcast:value>`: payees and nothing else. It is a real payment
 *   target and a useless row — no title to read, no `remoteItem` to favorite.
 * - **The show's own default block is not a song.** Split Kit stamps it
 *   `'podcast'`, and it is what a host returns to BETWEEN tracks, so listing it
 *   would put "back to the show" between every pair of songs.
 *
 * **`'chapter'` blocks are kept, and that is the deliberate half.** They are the
 * host's own segments — a promo, a photo, a phone number — so they are usually
 * noise in this list. But the type is the host's typing, not a fact, and the
 * cost of the two mistakes is not symmetric: an unwanted row is a row someone
 * ignores, while a mistyped song is a song with no heart anywhere in the app
 * and no way to tell that one is missing. Most of them carry no `remoteItem`
 * and so render without a heart of their own. This mirrors the same call
 * `lib/v4v/streaming.ts` made when a block-type filter was built and removed.
 */
export function recordLivePlay(t: {
  guid: string;
  split: ValueTimeSplit | null;
  bucketKey: string;
  blockType?: string;
} | null): void {
  if (!t) return;
  if (t.guid !== logGuid) {
    logGuid = t.guid;
    log = [];
    observable.notify();
  }
  const split = t.split;
  if (!split) return;
  if (t.blockType === 'podcast') return;
  if (!split.title && !split.remoteItem?.itemGuid) return;
  const key = t.bucketKey || split.remoteItem?.itemGuid;
  if (!key) return;
  // The same key twice is the same song. It happens without the music changing:
  // a dropped socket hands the target to the RSS poller and the reconnect hands
  // it back, which is the flap `STREAM_TRACK_CREDIT_DEBOUNCE_MS` exists for one
  // layer down. Keeping the FIRST sighting holds the row in the order it was
  // heard, and a genuine second play of the same track is the same favorite
  // anyway — there is nothing a duplicate row would let anyone do.
  if (log.some((p) => p.key === key)) return;
  const next = [...log, { key, split, blockType: t.blockType, atMs: Date.now() }];
  log = next.length > MAX_TRACKS ? next.slice(next.length - MAX_TRACKS) : next;
  observable.notify();
}
