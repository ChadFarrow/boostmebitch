# Shuffle the favorite singles

**Date:** 2026-11-12

## Intent

Chad opens `/favorites`, presses SINGLES, and sees his hearted music tracks: 232 of them on
2026-11-12. He wants one press of SHUFFLE to play **all the tracks that are there** in random
order — his words: *"open my favorites, click on tracks and hit shuffle and have it shuffle that
list"*, and, with a screenshot of the SINGLES view, *"shuffle all the tracks that are here"*.

Today the only way to hear them is one at a time: a row opens the episode page, and the track
stops at its end, because the album queue that auto-advances belongs to whichever show was opened.

**Terms.** A *single* is a favorited item whose parent feed is `music` — the `items` half of the
`music` medium on `/favorites` (`itemNoun('music')` is "single"). The *album queue* is the store's
`episodeQueue`. *Up Next* is the store's `listenQueue`. The *shuffle list* is the new thing this
design adds.

## Goals

- A **⤮ SHUFFLE** control on every section of favorite singles plays every playable row of that
  section in a random order. "Every row" means the section's filtered rows, not the revealed slice:
  with an empty filter and 232 singles, the shuffle has up to 232 tracks.
- ⏭, ⏮, the end of a track and the lock-screen next/previous all move through the shuffle list.
  (The keyboard has no track keys — `use-player-hotkeys.ts` maps only play and the two seeks — and
  adding them would change the player for everyone, so it is out of scope.)
- Each track shows its own album's title and art, and pays its own feed's value block.
- The shuffle continues while the listener browses other albums and shows.

## Non-goals

- No shuffle for albums, playlists, podcast episodes or Up Next. No shuffle toggle in the player.
- No repeat. The shuffle stops after its last track.
- Tracks of favorited ALBUMS are not included. Only hearted singles are.
- No change to how Up Next and the album queue interact.
- The shuffle does not survive a reload (see "Calls made by the designer").

## Anti-goals

Any one of these makes the feature a failure even if songs play in a random order:

- **A listener who never presses SHUFFLE sees a change.** `npm run e2e:queue` and
  `npm run e2e:playlist` must pass unchanged. This is the same acceptance test the listen queue was
  held to (`docs/ui.md`, "The listen queue").
- **A track pays anyone but its own feed.** The shuffle must never carry a value block it read from a
  cache. `payableValue` reads `episode.value` first, so a stale block would outrank the feed.
- **Opening an album changes what the shuffle plays next.** `<EpisodeList>` rewrites `episodeQueue`
  whenever a show is open. That is why the shuffle cannot live in `episodeQueue`.
- **The shuffle writes anything.** No kind:10333 change, no new `bmb:*` key, no Up Next change.

## Constraints

- `lib/store.ts` is not strip-types loadable, so pure rules go in `lib/util.ts`, which must keep
  type-only imports (`check:vts` and `check:musicl` load it under plain Node).
- `<Player>` reloads the source only when `episode.id` changes (`[episode.id, videoMode]`). A stored
  `FavoriteEpisode` has no Podcast Index episode id, so a track built from it alone would not load.
  The shuffle must use real episode records.
- Every place that sets `current` must reset `videoMode: false` and use `savedStartSec` (the six
  sites listed in `docs/ui.md`, "The four motions"). The shuffle adds sites.
- Touch targets clear 24×24 CSS px (WCAG 2.5.8), measured under CDP device emulation.

## Approaches

| | Approach | Trade-off |
|---|---|---|
| A | SHUFFLE replaces Up Next with up to 50 random singles | Least new code, but `LISTEN_QUEUE_CAP` is 50, so most of a 232-track list never plays, and it deletes what the listener queued. |
| **B (chosen)** | A separate shuffle list in the store, consulted between Up Next and the album queue | Plays the whole list and leaves Up Next alone. Adds a third source for "what plays next" in the most guarded code in the player. |
| C | Put the shuffled tracks in `episodeQueue` | Rejected: `<EpisodeList>` overwrites it when any show opens, and its step carries the current track's show to the next track, which names the wrong album. |

Chad chose B on 2026-11-12 by asking for all the tracks on the screen.

## Design

### The control

- `<Section>` on `/favorites` gains an optional control on its heading row, right of the count:
  **⤮ SHUFFLE**. It renders only for a section whose `mediumKey` is `music` and whose half is
  `items`, and only when that section has at least two rows. This covers the SINGLES quick button,
  the `music` tab and the mixed (`all`) view's SINGLES section.
- The rows are that section's `rows` (filtered, sorted, not sliced). A filter narrows the shuffle
  to what the filter shows.
- While the tracks load, the control reads **⤮ SHUFFLING…** and is disabled.
- A second press starts a new shuffle with a new order.

### Loading the tracks

**The first track starts inside the press.** iOS ties `play()` to the user gesture, and an `await`
over real I/O can lose it (`components/player.tsx`, the comment above `localKeyFor`): the listener
would see ▶ and have to press twice. So the press does no network work before `current` is set.

1. Take each row's `(feedGuid, itemGuid)`. A row with no `feedGuid` is skipped.
2. **Synchronously**, read each ref's record from the episode cache (`episodeMem`, then
   `storage.episodeMeta` — `bmb:epmeta`, which the favorites hydrator normally fills). Every hit
   that is playable becomes a track. Shuffle them and start the first one in the same handler.
3. The misses load afterwards: `warmEpisodeCache(misses)` (chunks of 100 to
   `/api/episode-by-guid/batch`), then a **cache-only** read of each one. Never
   `resolveEpisodeByGuid`'s per-track GET as a fallback: after a failed batch (the route allows 30
   requests a minute per IP, and `warmEpisodeCache` stops at the first failed chunk) that is up to
   one request per track. The loaded tracks are inserted at random places after the current one.
4. Only if step 2 found no track at all does the press wait for step 3 before it starts. That is a
   cold device; there the first track may need a second ▶ on iOS, and that is accepted.
5. Keep only rows that `isPlayableRow` accepts (a non-empty `enclosureUrl`).
6. For each episode: `episodeWithoutValue` (so `valueNotRead` is true and `<Player>` reads the payee
   from the track's own feed when it starts, as it does for playlist rows), then `trimForQueue`.
7. Build each track's show as an **allowlist**, never a spread: `id` (`episode.feedId` else the
   favorite's `feedId`), `podcastGuid` (the favorite's `feedGuid`), `title`
   (`episode.feedTitle` else `podcastTitle`), `image`/`artwork` (`episode.feedImage` else the
   favorite's `image`), and `medium: 'music'`. No `value`, no `funding`, no `nostrNpubs`.
8. The random order is Fisher–Yates.

If no track is playable, the control shows a short line under the heading
("No playable tracks in this list") and nothing plays. If some rows were skipped — no feed guid,
not in Podcast Index, a failed load, no enclosure — the line says how many ("12 tracks could not
be loaded"). Nothing is hidden silently.

### The store

- New state: `shuffle: QueueItem[] | null`. Memory only.
- `startShuffle(items)`: sets `shuffle`, and sets `current` to `items[0]` with `isPlaying: true`,
  `positionSec: savedStartSec(...)`, `videoMode: false`.
- `playFromShuffle(index)`: the same, for a row tapped in the shuffle panel.
- `shuffleIndexOf(s)`: `-1` when `shuffle` is null or empty, or when `current` is not in it
  (compared by `epKey`). The `.length` short-circuit comes first, as in `queueIndexOf`.
- **The shuffle is asked FIRST when it owns `current`**, before the listen queue, in `stepTo`,
  `handlePlaybackEnded` and `<TransportControls>`. A hearted single can also sit in Up Next; if Up
  Next were asked first, reaching that track would drain it from Up Next and leave the shuffle (and
  at Up Next's last item, stop with shuffle tracks left). With the shuffle first, a shuffle never
  touches Up Next. With no shuffle, `shuffleIndexOf` is `-1` and every existing branch is reached
  exactly as before.
- `stepTo`'s shuffle branch steps with `nextPlayableIndexBy`. It **does not drain**: the list is a
  list, and ⏮ can go back.
- `handlePlaybackEnded`: if the shuffle owns `current`, it steps to the next track, or at the last
  track sets `isPlaying: false` and returns `true`, so the end never falls through to whatever
  `episodeQueue` holds. (Up Next items wait: see "Up Next during a shuffle".)
- **Every action that sets `current` from outside the shuffle clears it:** `play`, `cue`,
  `playFromQueue` and `revealQueue`. They are how the listener picks something else, and a stale list
  must not wake up later when one of its tracks plays again. The shuffle's own actions
  (`startShuffle`, `playFromShuffle`, its steps) set `current` directly and never call these.

### The transport

`<TransportControls>` computes ⏮/⏭ from an enabled chapter override first, then the listen queue,
then `episodeQueue` (`queueTakesPrev`/`queueTakesNext`). The shuffle goes ahead of the listen queue,
with the same `nextPlayableIndexBy` walk, so a button is never lit over a step `stepTo` refuses.
Music has no chapter override (`chapterUrlFor` returns `''` for `music`), so for a shuffle track the
shuffle decides. The lock screen (`use-media-session.ts`) already calls `playNext`/`playPrev` and needs
no change.

### The full-screen player

The "Album · N tracks" panel reads `episodeQueue`. During a shuffle that is the last album the
listener opened. When `current` is in the shuffle, the panel is replaced by **Shuffle · N tracks**:
each row shows the track title and its album title, the active row is highlighted, and a tap calls
`playFromShuffle(i)` (or `togglePlay` on the active row). Outside a shuffle the panel is unchanged.

## Calls made by the designer (Chad can override)

- **Memory only.** A reload ends the shuffle. The now-playing track restores paused, as today, and ⏭
  follows the old rules. Persisting 232 trimmed episodes would need a new `bmb:*` key and a size
  rule in `docs/storage.md`; one press of SHUFFLE restarts it.
- **Stop at the end.** No repeat and no reshuffle.
- **No indicator in the mini-player.** The full-screen panel is the indicator.
- **Start from the cache, load the rest behind it.** Every track is loaded long before the first one
  ends, so no track end waits on the network (iOS can refuse a start with the screen locked), and the
  press itself does no network work (iOS can refuse that too).
- **The shuffle goes ahead of Up Next for its own tracks**, and every play from outside it ends it.

## Up Next during a shuffle

**Decided by Chad on 2026-11-12: it waits.** A track added to Up Next while a shuffle plays does not
interrupt it. The shuffle plays to its end and stops; Up Next plays when the listener starts it from
the Listen tab. This is what an album does today, so no existing rule changes.

The alternative — Up Next plays next and the shuffle resumes after it — was declined. It needed a
saved place in the shuffle list and a new rule in `handlePlaybackEnded`.

## Left to the builder

- The names of the helpers and the shape of the pure functions in `lib/util.ts`.
- The shuffle panel's exact markup, following the album panel's.
- The wording of the skipped-tracks line.

## Verification

- `npm run check:queue` (or a new `check:shuffle`) pins the pure helpers: the Fisher–Yates order
  with an injected random source, the show allowlist, and the step rule.
- A new `scripts/e2e-shuffle.mjs` (`npm run e2e:shuffle`) in headless Chrome over CDP: seed
  favorites, press SINGLES, press SHUFFLE; check that `current` is a favorite and the order is a
  permutation; ⏭, ⏮ and an `ended` event move through the list; the last track stops; opening an
  album mid-shuffle does not change the next track; the panel shows the shuffle; a `play` from a feed
  row and a tap on an Up Next row each end it; a filter narrows it; a single that is also in Up Next
  is not drained from Up Next; with every record cached, `current` is set in the press with no
  request; with the batch route failing (429), no per-track GET is sent and the skipped count shows.
- `npm run e2e:queue`, `npm run e2e:playlist` and `npm run e2e:favbuttons` pass unchanged.
- The control is measured at 390, 320 and 1280 px under `Emulation.setDeviceMetricsOverride` with
  `mobile: true`: no horizontal overflow, target at least 24×24.
- `docs/ui.md` gains a section next to "The listen queue", and `CLAUDE.md`'s table row for ui.md
  is checked.
