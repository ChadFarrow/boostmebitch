# Shuffle the Favorite Singles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ⤮ SHUFFLE control on each SINGLES section of `/favorites` plays every playable row of that section in a random order, through a shuffle list the player steps through.

**Architecture:** Pure helpers (order, insertion, identity, the track/show shape) go in `lib/util.ts`, pinned by `check:queue`. The store gains `shuffle` state, three actions, and a shuffle branch that `stepTo`, `handlePlaybackEnded` and `<TransportControls>` ask before the listen queue. A client loader reads the episode cache synchronously so the first track starts inside the press, then fetches the misses. The full-screen player lists the shuffle while it owns `current`.

**Tech Stack:** Next.js (app router), React, Zustand, TypeScript strict, `node --experimental-strip-types` check scripts, headless Chrome over CDP (`scripts/cdp.mjs`).

**Spec:** `docs/superpowers/specs/2026-11-12-favorites-shuffle-design.md`

## Global Constraints

- `lib/util.ts` keeps type-only imports (`check:vts`, `check:musicl`, `check:queue` load it under plain Node).
- Every site that sets `current` sets `videoMode: false` and `positionSec: savedStartSec(episode, podcast)`.
- A shuffle track carries no value block: `episodeWithoutValue` before it is stored, so `valueNotRead` is true.
- A shuffle track's show is an allowlist: `id`, `podcastGuid`, `title`, `image`, `artwork`, `medium: 'music'`. Nothing else.
- The press does no network work before `current` is set when at least one record is cached.
- No per-track `/api/episode-by-guid` GET from the shuffle. Misses go through `warmEpisodeCache` only.
- With `shuffle` null, every existing branch is reached exactly as before (`e2e:queue`, `e2e:playlist`, `e2e:favbuttons` unchanged).
- No new `bmb:*` key; the shuffle is memory only.
- `play`, `cue`, `playFromQueue`, `revealQueue` set `shuffle: null`.
- Up Next items wait during a shuffle (Chad, 2026-11-12).
- Touch targets ≥ 24×24 CSS px; no horizontal overflow at 320, 390, 1280.
- The heading stays a direct `section > button[aria-expanded]` child (e2e:favbuttons selects it that way).

## Review Focus

1. **A second SHUFFLE press while the first press's misses still load.** The late answer must not add tracks to the new shuffle. → Task 2 `extendShuffle` takes the shuffle's `id`; Task 4 e2e section 6 presses twice during a delayed batch and asserts no duplicate keys.
2. **A single that is also in Up Next.** Reaching it in the shuffle must not drain it from Up Next. → Task 4 e2e section 4.
3. **The batch route answers 429.** No per-track GET; the skipped count shows. → Task 4 e2e section 6.
4. **An album opened mid-shuffle.** `<EpisodeList>` rewrites `episodeQueue`; the next track must still be the shuffle's. → Task 4 e2e section 3.
5. **A filter typed before the press.** The shuffle holds only the filtered rows. → Task 4 e2e section 5.

---

### Task 1: Pure helpers and their check

**Files:**
- Modify: `lib/util.ts` (next to `queueShowFor` / `trimForQueue`)
- Modify: `scripts/check-queue.mjs` (new vectors, new naives, header paragraph)

**Interfaces:**
- Produces (all exported from `lib/util.ts`):
  - `shuffleOrder<T>(items: readonly T[], random?: () => number): T[]` — Fisher–Yates on a copy; `random` defaults to `Math.random`.
  - `insertShuffled<T>(list: readonly T[], after: number, more: readonly T[], random?: () => number): T[]` — each item of `more` goes at a random index in `(after, end]`; `list[0..after]` unchanged.
  - `shuffleIndexOf(shuffle: readonly QueueItem[] | null, episode: Pick<Episode, 'guid' | 'feedId' | 'id'>): number` — `-1` for null/empty (length short-circuit before `epKey`), else `findIndex` by `epKey`.
  - `shuffleTrackFor(fav: FavoriteEpisode, episode: Episode): QueueItem | null` — `null` unless `isPlayableRow(episode)`; episode is `trimForQueue(episodeWithoutValue(episode))`; podcast is the allowlist: `id: episode.feedId ?? fav.feedId ?? 0`, `podcastGuid: fav.feedGuid ?? episode.podcastGuid`, `title: episode.feedTitle ?? fav.podcastTitle ?? ''`, `image`/`artwork: episode.feedImage ?? fav.image`, `medium: 'music'`.

- [ ] **Step 1: Write the failing vectors in `scripts/check-queue.mjs`**, as recorded calls like the existing ones:
  - `shuffleOrder` with a seeded random (e.g. a fixed sequence) returns a permutation: same length, same multiset; with `() => 0` on `[a,b,c,d]` the result is `[b,c,d,a]` (Fisher–Yates from the end with j=0 each time); input array not mutated. Naive: `items.slice().sort(() => random() - 0.5)` fails the exact-order vector.
  - `insertShuffled([a,b,c], 0, [x,y], () => 0)` keeps `a` at 0 and never places `x`/`y` at index ≤ 0; `after = -1` places anywhere. Naive: append at end.
  - `shuffleIndexOf(null, ep) === -1`, `shuffleIndexOf([], ep) === -1`, finds by guid, `<guid></guid>` falls back to `feedId:id`.
  - `shuffleTrackFor`: empty enclosure → `null`; result has no `value`, no `valueTimeSplits`, no `description`; podcast keys are exactly `['artwork','id','image','medium','podcastGuid','title']`; `medium === 'music'`; podcast has no `funding`/`nostrNpubs` even when the episode record carries feed facts. Naive: `{ episode, podcast: { ...fav, medium: 'music' } }`.
- [ ] **Step 2: Run** `npm run check:queue`. Expected: FAIL — the imports do not exist.
- [ ] **Step 3: Implement the four helpers** in `lib/util.ts`, each with a short doc comment naming its reason (the spec's Constraints and Design → Loading).
- [ ] **Step 4: Run** `npm run check:queue && npm run check:musicl && npm run check:vts && npm run typecheck`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat(shuffle): pure helpers for the favorites shuffle, pinned by check:queue`.

### Task 2: The store, the transport and the cache reader

**Files:**
- Modify: `lib/store.ts` (state, actions, `stepTo`, `handlePlaybackEnded`, `play`, `cue`, `playFromQueue`, `revealQueue`)
- Modify: `components/transport-controls.tsx:83-142`
- Modify: `lib/podcast-meta.ts` (one sync reader)

**Interfaces:**
- Consumes: Task 1's `shuffleIndexOf`, `insertShuffled`.
- Produces:
  - Store state `shuffle: { id: number; items: QueueItem[] } | null` (initial `null`).
  - `startShuffle(items: QueueItem[]): number | null` — `null` and no change for an empty list; else a new id (`Date.now()` or a module counter), `current = items[0]`, `isPlaying: true`, `positionSec: savedStartSec(...)`, `videoMode: false`.
  - `extendShuffle(id: number, more: QueueItem[]): void` — no-op unless `shuffle?.id === id` and `more.length`; dedupes by `epKey` against the list; `insertShuffled` after the current index (or `-1` when `current` is not in it).
  - `playFromShuffle(index: number): void` — as `playFromQueue`, from `shuffle.items`, does not clear.
  - `cachedEpisodeByGuid(feedGuid: string, itemGuid: string): Episode | null | undefined` in `lib/podcast-meta.ts` — `episodeMem` hit (incl. `null`), else `storage.episodeMeta.get` promoted into `episodeMem`, else `undefined`. No fetch.

- [ ] **Step 1: Add the state and the three actions.** `shuffleIndex(s)` helper beside `queueIndexOf` returns `shuffleIndexOf(s.shuffle?.items ?? null, s.current.episode)` (or `-1` with no `current`).
- [ ] **Step 2: `stepTo`:** before `queueIndexOf`, if `shuffleIndex(s) >= 0`, step with `nextPlayableIndexBy(items, idx, step, queuedEpisode)`; return `null` at either end; never drain.
- [ ] **Step 3: `handlePlaybackEnded`:** first, if the shuffle owns `current`: next playable index → set it (`isPlaying: true`, start rule, `videoMode: false`) and return `true`; at the end → `set({ isPlaying: false })`, return `true`. Then the existing listen-queue code, unchanged.
- [ ] **Step 4: Clearing:** add `shuffle: null` to the patches of `play`, `cue`, `playFromQueue` (only when it changes `current`) and `revealQueue` (only when it changes `current`).
- [ ] **Step 5: `<TransportControls>`:** select `shuffle`; compute `sIdx`; when `sIdx >= 0` the owner list is `shuffle.items` with index `sIdx`, else the listen queue as now. `inQueue` is true for either owner. Labels: `'Previous in shuffle'` / `'Next in shuffle'` when the shuffle owns it.
- [ ] **Step 6: `cachedEpisodeByGuid`** in `lib/podcast-meta.ts`.
- [ ] **Step 7: Run** `npm run typecheck && npm run lint`. Expected: PASS.
- [ ] **Step 8: Commit** `feat(shuffle): a shuffle list the player steps through before Up Next`.

### Task 3: The SHUFFLE control and the full-screen panel

**Files:**
- Create: `lib/favorites-shuffle.ts` (client loader)
- Create: `components/favorites-shuffle-button.tsx`
- Modify: `components/favorites-page.tsx` (`Section` gains `action?: React.ReactNode` and `relative`; item sections whose `mediumKey === 'music'` and `rows.length >= 2` pass `<FavoritesShuffleButton rows={sec.rows} />`)
- Modify: `components/fullscreen-player.tsx:1454` (shuffle panel)

**Interfaces:**
- Consumes: Task 1 `shuffleOrder`, `shuffleTrackFor`; Task 2 store actions and `cachedEpisodeByGuid`; `warmEpisodeCache`.
- Produces:
  - `readShuffleTracks(rows: FavoriteEpisode[]): { tracks: QueueItem[]; pending: FavoriteEpisode[]; skipped: number }` — synchronous; a row without `feedGuid` is skipped; `undefined` from the cache → `pending`; `null` or unplayable → skipped.
  - `loadPendingShuffleTracks(pending: FavoriteEpisode[]): Promise<{ tracks: QueueItem[]; skipped: number }>` — `warmEpisodeCache(refs)` then `cachedEpisodeByGuid` only; anything still not an `Episode` is skipped.
  - `<FavoritesShuffleButton rows={FavoriteEpisode[]} />`.

- [ ] **Step 1: Loader** (`lib/favorites-shuffle.ts`) with the two functions above.
- [ ] **Step 2: Button.** On press: `readShuffleTracks` → `shuffleOrder(tracks)` → if any, `startShuffle` **synchronously in the handler**; then, if `pending.length`, set busy, `await loadPendingShuffleTracks`, then `extendShuffle(id, shuffleOrder(more))` — or, when nothing started, `startShuffle(shuffleOrder(more))`. Busy label `⤮ SHUFFLING…` (disabled); idle label `⤮ SHUFFLE`. `aria-label="Shuffle these N singles"`. A `role="status"` line under the heading: `No playable tracks in this list` when nothing plays, else `N tracks could not be loaded` when skipped > 0, else nothing. The button sits absolutely on the heading row, left of the ▾ (`absolute right-7 top-3`, height of the heading), `.btn-mini`-style, ≥ 24×24.
- [ ] **Step 3: Wire it into `Section`** for music item sections only. The heading stays a direct child of `<section>`.
- [ ] **Step 4: Full-screen panel.** Select `shuffle`; when `shuffleIndexOf(shuffle?.items ?? null, episode) >= 0`, render `Shuffle · {n} tracks` in place of the album panel: each row shows the track title and, muted, `item.podcast.title`; the active row uses the album panel's highlight and `❚❚`; a tap is `togglePlay()` on the active row, else `playFromShuffle(i)`. Keys are `epKey(item.episode)`. Otherwise the album panel is unchanged.
- [ ] **Step 5: Run** `npm run typecheck && npm run lint`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(shuffle): SHUFFLE on the favorite singles, and the shuffle in the now-playing screen`.

### Task 4: The browser test

**Files:**
- Create: `scripts/e2e-shuffle.mjs`
- Modify: `package.json` (`"e2e:shuffle": "node scripts/e2e-shuffle.mjs"`)

Signed out (`:guest`), `launchChrome({ name: 'shuffle', autoplay: true })`. Fixture: N singles in `bmb:favepisodes:guest` (medium `music`, `feedGuid`/`itemGuid` per row, no `feedId`), each with a `bmb:epmeta:<feedGuid>:<itemGuid>` cell `{ t: Date.now(), v: Episode }` whose `id` is unique, `guid` = itemGuid, `podcastGuid` = feedGuid, `feedTitle` set, and `enclosureUrl: ${APP}/boost.mp3?n=<i>`. Count `/api/episode-by-guid` requests with a `fetch` wrapper installed before the press.

- [ ] **Step 1: Write the sections:**
  1. SHUFFLE shows on SINGLES (music items) and not on ALBUMS/SHOWS/EPISODES; with 1 single there is no button.
  2. Press with every record cached: no `/api/episode-by-guid` request; the `<audio>` src is one of the fixtures within 2 s; the panel reads `shuffle · N tracks` and its rows are a permutation of the fixtures; ⏭ moves to the panel's next row, ⏮ back; a real `ended` (seek to `duration - 0.2`) advances; at the last row an `ended` stops (`audio.paused`) and ⏭ is disabled.
  3. Mid-shuffle, open a favorite album (a real music feed, Homegrown Hits `ac746d09-7c3b-5bcd-b28a-f12d6456ca8f`, its PI id fetched from `/api/by-guid` in the test) by its row; after its episode list loads, `ended` still lands on the shuffle's next row. (Skip with a printed reason if PI does not answer.)
  4. One single also queued in Up Next (`bmb:listen_queue:guest` seeded): reaching it in the shuffle and passing it leaves `bmb:listen_queue:guest` byte-identical.
  5. Type a filter matching 3 rows, press: the panel lists exactly those 3.
  6. Cold cache for half the rows, `/api/episode-by-guid/batch` fulfilled with 429 via the `Fetch` domain: the first track starts from the cached half, no `/api/episode-by-guid?` GET is sent, and the status line reads `N tracks could not be loaded`. Then with the batch delayed 1.5 s, press twice: no duplicate keys in the panel.
  7. A tap on a feed row's ▶ elsewhere (or `play` from the episode page) ends the shuffle: the panel no longer shows.
  8. At 320, 390 (mobile emulation) and 1280: no horizontal overflow; the button ≥ 24×24, its word unclipped, not overlapping the heading label.
- [ ] **Step 2: Run** `npm run dev` (port 3019) then `APP_URL=http://127.0.0.1:3019 npm run e2e:shuffle`. Expected: all PASS. Fix the code, never the expectation, on a failure.
- [ ] **Step 3: Run** `e2e:queue`, `e2e:playlist`, `e2e:favbuttons` against the same server. Expected: PASS, unchanged.
- [ ] **Step 4: Commit** `test(shuffle): e2e:shuffle drives the favorites shuffle in a real browser`.

### Task 5: Docs and the full gate

**Files:**
- Modify: `docs/ui.md` (new `#### The favorites shuffle` under "The listen queue", plus one paragraph on the favorites page section)
- Modify: `CLAUDE.md` (the `check:queue` row's Pins cell names the shuffle helpers; `npm run check:claudemd` must pass)

- [ ] **Step 1: Write the ui.md section**: why a third list (not `episodeQueue`, not Up Next), the precedence (shuffle first for its own tracks), what clears it, why the press reads the cache synchronously, no per-track GET, memory only, Up Next waits (Chad, 2026-11-12), and how it is verified.
- [ ] **Step 2: Run** `npm run typecheck && npm run lint && npm run check && npm run build` (stop the dev server first; `rm -rf .next` before any later `dev`). Expected: all PASS.
- [ ] **Step 3: Commit** `docs(shuffle): the favorites shuffle in ui.md and CLAUDE.md`.
