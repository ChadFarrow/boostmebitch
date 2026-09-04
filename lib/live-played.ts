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
// **It records, it does not pay.** Nothing here gates a payment, invents an
// identifier or writes to the favorites list; a row is favoritable exactly when
// `<FavTrackHeart>` says it is, off the same `remoteItem` the boostagram uses.
// The one thing it does decide is whether a row may offer that heart YET — a
// socket block reaches this module with no parent-feed verdict on it, and the
// verdict is the difference between a favorite and an entry no app can open.
// See `PlayedTrack.parentResolved` and `enrichRow`.
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
   * arrives. Nothing renders it today — see {@link isNotPlayed} for which
   * blocks it keeps out and why the test is never the type alone — and a
   * surface that later wants to LABEL a host segment rather than drop it needs
   * the type to have been kept from the start.
   */
  blockType?: string;
  /** When the block went on air, by this device's clock. There is no playback
   *  position to timestamp against on a live stream. */
  atMs: number;
  /**
   * Whether `split.parentFeedGuid` carries a verdict yet — the gate on whether
   * a row may offer a heart at all.
   *
   * Every RSS live signal arrives already resolved, because `/api/live-value`
   * runs it through `resolveOneSplit`. A SOCKET block does not: it is built
   * client-side from the websocket payload, so its `parentFeedGuid` starts as
   * `undefined` — which reads as "nothing learned, the wire guid stands" and is
   * indistinguishable from a host who pointed `feedGuid` at a publisher feed.
   * Favoriting that writes an entry no app can open, to a shared list with no
   * undo, so the heart waits for `enrichRow` to answer.
   *
   * **False means "not yet", never "no".** A lookup that fails — PI down, the
   * device offline — still flips this to `true` and leaves `parentFeedGuid`
   * `undefined`, because over-blocking is its own regression: withholding the
   * control until PI has crawled the album hides it on exactly the independent
   * releases this app exists to pay.
   */
  parentResolved: boolean;
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

/**
 * How long a key must be gone before the same key means a REPLAY.
 *
 * Under this, a repeat is the target flapping without the music changing — a
 * dropped socket hands ownership to the RSS poller and the reconnect hands it
 * back — and the first sighting must stand, or the row jumps to the top of the
 * list while the same song keeps playing. Over it, the DJ really did play the
 * track again, and the row moves to the end with a fresh clock time: otherwise
 * `● on air now` lands on a row buried hours down a newest-first list, beside a
 * timestamp from the first play, with nothing at the top.
 *
 * Deliberately a local constant rather than an import of the ledger's
 * `STREAM_TRACK_CREDIT_DEBOUNCE_MS`, which is the same 60 s for the same
 * reason: this module keeps its back to `lib/v4v/` (see the header).
 */
const REPLAY_AFTER_MS = 60_000;

const observable = createObservable();
export const subscribeLivePlayed = observable.subscribe;

/** The live item the log belongs to. One broadcast at a time — see below. */
let logGuid: string | null = null;
/**
 * Split Kit's event guid for the broadcast the log holds, when it published
 * one. A live item's `<guid>` names the SLOT, not the airing, so a station that
 * broadcasts nightly under one guid would otherwise append tonight's set to
 * last night's. The event guid is what tells the two apart; an RSS-only show
 * publishes none, and then the guid alone is all there is to go on.
 */
let logEventGuid: string | undefined;
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
 * The shape `recordLivePlay` and `livePlayedKey` read off a live target.
 *
 * Structural rather than a `LiveTarget` import so this module keeps its back to
 * `lib/v4v/` (see the header); every field is one a `LiveTarget` already
 * carries.
 */
export interface LiveTargetShape {
  guid: string;
  split: ValueTimeSplit | null;
  bucketKey: string;
  blockType?: string;
  signal?: string;
  event?: { eventGuid?: string };
  /** The feed guid of the show being listened to. See `recordLivePlay`. */
  showFeedGuid?: string;
}

/**
 * The identity of a row, and the ONE definition of it.
 *
 * Exported because two callers need the same answer and cannot be allowed to
 * derive it separately: this log decides which blocks are the same song, and
 * `<LivePlayedTracks>` decides which row is on air by comparing the current
 * target against it. A second copy is how the marker comes to sit on no row at
 * all.
 *
 * It starts from `LiveTarget.bucketKey`, the key the streaming ledger accrues
 * into, so a row and a bucket agree about which two blocks were one song.
 * **The one place it must NOT agree is a block naming a feed and no item.**
 * `trackBucket` answers `t:<feedGuid>:` for every such block, and Split Kit's
 * `itemGuid` is independently optional, so a DJ playing three tracks off one
 * album feed produces one key for all three. The ledger is right to pool them —
 * they pay the same recipients — but a list of what played must keep them
 * apart, or two of the three songs are simply missing with nothing on screen
 * saying so. The title separates them, here and nowhere else.
 */
export function livePlayedKey(t: LiveTargetShape): string {
  const split = t.split;
  if (!split) return '';
  const remote = split.remoteItem;
  if (remote?.feedGuid && !remote.itemGuid) return `${t.bucketKey}|${split.title ?? ''}`;
  return t.bucketKey || remote?.itemGuid || '';
}

/**
 * Record the block a live show just moved to.
 *
 * Called from `setTarget` in `lib/v4v/live-value.ts`, which is the ONE place
 * that sees every target change from every signal. See {@link LiveTargetShape}
 * for why the parameter is structural.
 *
 * Four rules, and each of them decides whether a row can appear at all:
 *
 * - **A different BROADCAST resets the log.** One at a time: last night's set is
 *   not this one's, and keeping both would need per-guid pruning to stop a long
 *   session accumulating shows it will never render. A different `guid` is the
 *   obvious case; a different Split Kit `eventGuid` under the SAME guid is the
 *   one that is easy to miss, because a live item's `<guid>` names the slot in
 *   the feed rather than the airing, and a nightly show reuses it. Neither is
 *   the same thing as the watcher stopping — `stopLiveValueWatcher` runs on
 *   every Fast Refresh — so nothing resets on a detach.
 * - **A null target records nothing and keeps the log.** `setTarget(null)` is
 *   "the watcher detached" — the user paused, or the tab went to the background
 *   — not "the show ended and its songs never happened". Clearing here would
 *   delete the list at exactly the moment a listener stops to look at it.
 * - **A block needs a name or an identifier.** The weakest RSS signal is a bare
 *   rewritten `<podcast:value>`: payees and nothing else. It is a real payment
 *   target and a useless row — no title to read, no `remoteItem` to favorite.
 * - **The show's own furniture is not something the listener heard.** Its
 *   default block between tracks, and its own segments — see
 *   {@link isNotPlayed}, which decides both on the block's IDENTIFIERS rather
 *   than on its type, because the type is the host's typing and each of Split
 *   Kit's two non-music types covers two different things.
 */
/**
 * Is this block something the listener HEARD, or the show's own furniture?
 *
 * **Filter on identity, never on `blockType` alone.** The type is the host's
 * typing rather than a fact, and both of Split Kit's non-music types carry two
 * different things:
 *
 * - **`'chapter'`** is a host segment — a promo, a phone number, a PayPal QR.
 *   Homegrown Hits 147 pushed six, every one of them paying the show's own
 *   three recipients with no `remoteItem` at all, against six songs: half the
 *   list was rows that could never carry a heart. **They are dropped on the
 *   MISSING IDENTIFIER, not on the type**, and that is what makes it safe:
 *   `<FavTrackHeart>` needs an `itemGuid`, so a block without one is
 *   unfavoritable by construction and this can only remove a row that never had
 *   a heart. A mistyped SONG — the case the keep-`chapter` rule exists for —
 *   still names its track and still gets its row.
 * - **`'podcast'`** is the show's own default block, what a host returns to
 *   between tracks... except when it is an episode of a DIFFERENT podcast the
 *   hosts put on air. Of the three HGH 147 pushed, only one was its own; the
 *   others were `Rollz Radio` and `ABS n' a 6-Pack`, each with a full
 *   `feedGuid`/`itemGuid` pair that resolves. Skipping every `'podcast'` block
 *   made those unfavoritable, which is the bug this feature exists to fix,
 *   pointed at a podcast instead of a song. So the show's OWN feed is skipped
 *   and everyone else's is kept.
 */
function isNotPlayed(t: LiveTargetShape, split: ValueTimeSplit): boolean {
  if (t.blockType === 'chapter' && !split.remoteItem?.itemGuid) return true;
  if (t.blockType === 'podcast') {
    // No `showFeedGuid` means we can't tell whose episode it is. Keep the old
    // behaviour there — a wrongly-kept default block is a row between every
    // pair of songs, which is the noise this function exists to remove.
    if (!t.showFeedGuid) return true;
    return split.remoteItem?.feedGuid === t.showFeedGuid;
  }
  return false;
}

export function recordLivePlay(t: LiveTargetShape | null): void {
  if (!t) return;
  const eventGuid = t.event?.eventGuid;
  if (t.guid !== logGuid || eventGuid !== logEventGuid) {
    logGuid = t.guid;
    logEventGuid = eventGuid;
    log = [];
    observable.notify();
  }
  const split = t.split;
  if (!split) return;
  if (isNotPlayed(t, split)) return;
  if (!split.title && !split.remoteItem?.itemGuid) return;
  const key = livePlayedKey(t);
  if (!key) return;
  const now = Date.now();
  const seen = log.find((p) => p.key === key);
  if (seen) {
    // Inside the flap window this is the same song and the first sighting
    // stands — it holds the row in the order it was heard. Past it the DJ has
    // played the track again, so the row moves to the end and takes a new clock
    // time rather than leaving `● on air now` on a buried row. Either way there
    // is one row per song: a duplicate would offer a second heart writing the
    // identical favorite.
    if (now - seen.atMs < REPLAY_AFTER_MS) return;
    // The ROW is carried over, not rebuilt from the new block. Same key is the
    // same song, so the only thing that changed is when it was last heard —
    // and adopting the new split would throw away a `parentFeedGuid` already
    // resolved for it, handing the row a heart against an unverified guid.
    log = [...log.filter((p) => p !== seen), { ...seen, atMs: now }];
    observable.notify();
    return;
  }
  const row: PlayedTrack = {
    key,
    split,
    blockType: t.blockType,
    atMs: now,
    // Only the socket builds a split this side of the wire. Everything else
    // came back from /api/live-value already carrying its verdict.
    parentResolved: t.signal !== 'live-value',
  };
  const next = [...log, row];
  log = next.length > MAX_TRACKS ? next.slice(next.length - MAX_TRACKS) : next;
  observable.notify();
  // Two reasons to ask, and a row can have either or both. A socket block needs
  // its parent-feed verdict before it may offer a heart; EVERY block needs a
  // second lookup for the artist, because Podcast Index carries `author` on the
  // feed record and not on the episode one. One call answers both.
  if (!row.parentResolved || !split.artist) void enrichRow(logGuid, key, split);
}

/**
 * Ask `/api/remote-item` what the row's parent feed is, and who made the track.
 *
 * Fire-and-forget on purpose: the target has already been set and the payment
 * is already routed off the block's own recipients. Nothing here can change
 * where sats go — it decides one thing, whether this row may write a favorite,
 * and adds one label beside it.
 *
 * **The two halves are not the same kind of answer, and the patch keeps them
 * apart.** The verdict is written ONCE, on a row that does not have one yet: an
 * RSS split reached `/api/live-value` and was resolved there, so overwriting it
 * from here would let a second, later lookup — a PI miss, a rate limit — take a
 * settled verdict back to `undefined` and hand the row a heart against an
 * unverified guid. The artist is only ever filled in where there is none.
 *
 * The row is patched only while the log still belongs to the same broadcast and
 * still holds that key, so an answer arriving after the DJ moved on, or after
 * the listener switched shows, lands nowhere.
 */
async function enrichRow(guid: string | null, key: string, split: ValueTimeSplit) {
  const feedGuid = split.remoteItem?.feedGuid;
  const itemGuid = split.remoteItem?.itemGuid;
  let parent: { parentFeedGuid?: string | null; feedTitle?: string; artist?: string } = {};
  if (feedGuid && itemGuid) {
    try {
      const res = await fetch(
        `/api/remote-item?feedGuid=${encodeURIComponent(feedGuid)}`
        + `&itemGuid=${encodeURIComponent(itemGuid)}`,
      );
      // A miss is a 404 and answers `undefined`, the same as a throw: PI not
      // having crawled the album is the ordinary, self-healing state, and it is
      // not evidence the guid is wrong.
      if (res.ok) parent = await res.json();
    } catch { /* leave the verdict undefined — see PlayedTrack.parentResolved */ }
  }
  if (guid !== logGuid) return;
  const i = log.findIndex((p) => p.key === key);
  if (i < 0) return;
  const row = log[i];
  const artist = row.split.artist ?? parent.artist;
  // A row that already had its verdict and learned no name is left alone, so a
  // failed lookup costs no re-render.
  if (row.parentResolved && artist === row.split.artist) return;
  const next = [...log];
  next[i] = {
    ...row,
    split: {
      ...row.split,
      // See above: written only where the row is still waiting for one.
      ...(row.parentResolved ? {} : { parentFeedGuid: parent.parentFeedGuid }),
      // The album's title, for the favorite record. Never over an existing one:
      // the host's own block is the more current name for what is on air.
      feedTitle: row.split.feedTitle ?? parent.feedTitle,
      artist,
    },
    parentResolved: true,
  };
  log = next;
  observable.notify();
}
