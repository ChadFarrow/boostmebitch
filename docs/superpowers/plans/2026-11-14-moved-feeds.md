# Moved Feeds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A favorite whose feed sits on a closed host (RSS Blue) follows a live same-guid copy automatically, and offers a REPLACE for a same-title-and-artist copy on a new guid.

**Architecture:** One import-free leaf (`lib/moved-feeds.ts`) holds every decision as a pure function, pinned by `check:moved`. `lib/pi.ts` applies the same-guid switch to raw Podcast Index records before they are built, so every guid resolver (direct, batch, index, value split) gets it. A new `/api/moved` route lists new-guid candidates; `<MovedOffer>` renders them under a favorites row and swaps through the store actions a heart uses.

**Tech Stack:** Next.js 15 app router, TypeScript, zustand store, Podcast Index API, `node --experimental-strip-types` check scripts, CDP e2e (`scripts/cdp.mjs`).

**Spec:** `docs/superpowers/specs/2026-11-14-moved-feeds-design.md`

## Global Constraints

- `CLOSED_HOSTS = [{ name: 'RSS Blue', hosts: ['feeds.rssblue.com', 'media.rssblue.com'], since: '2026-11-14' }]`.
- `lib/moved-feeds.ts` has NO imports, not even `import type` (`scripts/import-free.mjs`).
- A same-guid twin needs: same `podcastGuid`, different `id`, `closedService(url) === null`, `dead !== 1`, same `normAuthor`. Tie-break: newest `lastCrawlTime`, then highest `id`.
- A new-guid candidate needs: different `podcastGuid`, not closed, same `normTitle(title)` AND same `normTitle(author)`. At most 3.
- PI miss (400/404) → `null` in the wrapper; 429/408 rethrow; a failed twin search is "no answer" and is NOT cached.
- Fan-out through `mapLimit(…, PI_FANOUT, …)`, never a bare `Promise.all` over a list.
- Store order in a swap: every add BEFORE every remove (`markClearedIfEmpty` runs on each write).
- One `requestFavoritesSync(identity)` per swap.
- Payment follows the switch (Chad, 2026-11-14): no gate on the value paths.
- Touch target ≥ 24×24 CSS px (WCAG 2.5.8); no horizontal overflow at 390×844.

## Review Focus

- A healthy feed must cost zero extra PI requests (assert in Task 2's curl check by timing/console count, and by `closedService` returning null before any search).
- A lookalike host (`media.rssblue.com.evil.example`, `rssblue.com.example`) must not count as closed (Task 1 test).
- A favorite list with ONE entry that is swapped must never pass through an empty store (Task 5: adds before removes; e2e asserts the published event still has entries).
- A track with no title match stays on the list under its old guid (Task 1 `planSwap` test + Task 6 e2e).
- A carried row gets no REPLACE button and is never in a swap plan (Task 1 test + Task 5 render rule).

---

### Task 1: The pure leaf and `check:moved`

**Files:**
- Create: `lib/moved-feeds.ts`
- Create: `scripts/check-moved.mjs`
- Modify: `package.json` (add `"check:moved": "node --experimental-strip-types scripts/check-moved.mjs"`)

**Interfaces — Produces:**
- `CLOSED_HOSTS: readonly { name: string; hosts: readonly string[]; since: string }[]`
- `closedService(url: string | null | undefined): string | null` — the service name.
- `normTitle(s: string | null | undefined): string` — lower-case, `&`→`and`, strip every non-alphanumeric, collapse spaces, trim.
- `pickLiveTwin<F extends RawFeed>(dead: RawFeed, feeds: readonly F[]): F | null`
- `movedCandidates<F extends RawFeed>(dead: RawFeed, feeds: readonly F[]): F[]`
- `matchTracks(oldItems: readonly { itemGuid: string; title?: string }[], newItems: readonly { guid: string; title?: string }[]): { moves: { oldItemGuid: string; newItemGuid: string }[]; unmatched: string[] }`
- `planSwap(input: SwapInput): SwapPlan` with
  `SwapInput = { scope: 'feed' | { itemGuid: string }; feedFav: { carried?: boolean } | null; newFeedIsFav: boolean; oldItems: readonly { itemGuid: string; title?: string; carried?: boolean }[]; newItems: readonly { guid: string; title?: string }[]; favItemGuids: ReadonlySet<string> }`
  `SwapPlan = { removeFeed: boolean; addFeed: boolean; moves: { oldItemGuid: string; newItemGuid: string; addNew: boolean }[]; unmatched: string[] }`
- `mergeResolvedRow<T extends { addedAt: number; medium?: string; carried?: boolean }>(prev: T | undefined, fresh: T): T` — fresh row, `medium` falls back to `prev.medium`, `addedAt` from `prev` when `prev.addedAt` is truthy, `carried` from `prev`.
- `RawFeed = { id?: number; podcastGuid?: string; url?: string; title?: string; author?: string; dead?: number; lastCrawlTime?: number }` (local structural type).

- [ ] **Step 1: Write `scripts/check-moved.mjs`** in the shape of `scripts/check-gif.mjs` (`check(label, actual, expected)`, failure count, `importFreeProblems('lib/moved-feeds.ts')`, exit 1 on any failure). Assertions:
  - `closedService('https://feeds.rssblue.com/worried')` → `'RSS Blue'`; `'https://op3.dev/e,pg=7153bbb0-b8c4-521f-80c0-cef62d8ef67b/media.rssblue.com/podcasts/worried/x.mp3'` → `'RSS Blue'`; `'https://dts.podtrac.com/redirect.mp3/media.rssblue.com/a.mp3'` → `'RSS Blue'`; `'https://media.rssblue.com.evil.example/a.jpg'` → `null`; `'https://feeds.fountain.fm/aCFEYwJijoBbZSUP32JA'` → `null`; `'not a url'`, `''`, `undefined` → `null`.
  - `normTitle('Mr. Videoman')` === `normTitle('Mr Videoman')`; `normTitle('  Rock & Roll ')` → `'rock and roll'`.
  - `pickLiveTwin` with dead `{id:7101864, podcastGuid:G, url:'https://feeds.rssblue.com/worried', author:'Suzanne Santo'}` and feeds `[dead, {id:7520866, podcastGuid:G, url:'https://feeds.fountain.fm/x', author:'Suzanne Santo', lastCrawlTime:1783936530}]` → the 7520866 feed; with the twin's author `'Copycat FM'` → `null`; with twin `dead: 1` → `null`; with two live twins, the newer `lastCrawlTime` wins, then the higher id.
  - `movedCandidates` for dead `{title:'Mr. Videoman', author:'Prosperous Soul', podcastGuid:'f842…'}` over `[{id:7854985, title:'Mr Videoman', author:'Prosperous Soul', podcastGuid:'9b20…', url:'https://feeds.fountain.fm/q'}, {id:6813307, title:'Mr. Videoman', author:'Prosperous Soul', podcastGuid:'a6eb…', url:'https://wavlake.com/feed/music/6f43'}, {id:7401947, title:'Runaway Train', author:'Josephus', …}, {id:1, title:'Mr. Videoman', author:'Someone Else', …}, {id:2, title:'Mr. Videoman', author:'Prosperous Soul', url:'https://feeds.rssblue.com/x', …}]` → ids `[7854985, 6813307]`; never more than 3.
  - `matchTracks([{itemGuid:'a', title:'Mr. Videoman'}, {itemGuid:'b', title:'Lost'}], [{guid:'n1', title:'Mr Videoman'}])` → `{ moves:[{oldItemGuid:'a', newItemGuid:'n1'}], unmatched:['b'] }`; two old items with one matching new item → one move, one unmatched; an old item with no title → unmatched.
  - `planSwap` scope `'feed'`, `feedFav:{}`, two old items (one matches): `removeFeed:true, addFeed:true`, one move with `addNew:true`, one unmatched. With `newFeedIsFav:true` → `addFeed:false`. A carried old item never appears in `moves` or `unmatched`. `feedFav:{carried:true}` → `removeFeed:false, addFeed:false`. Scope `{itemGuid:'a'}` → only item `a` considered, `removeFeed:false, addFeed:false`. A matched new guid already in `favItemGuids` → `addNew:false`.
  - `mergeResolvedRow({addedAt:5, medium:'music', carried:true}, {addedAt:99, title:'x'})` → `{addedAt:5, title:'x', medium:'music', carried:true}`; `mergeResolvedRow({addedAt:0}, {addedAt:99})` → `addedAt:99`, `carried: undefined`.

- [ ] **Step 2: Run `npm run check:moved`** — Expected: FAIL (module not found).
- [ ] **Step 3: Implement `lib/moved-feeds.ts`.** `closedService`: parse with `new URL` in try/catch; match `hostname` exactly against each host, or any `pathname` segment exactly equal to a host. Header comment carries the measurement (410 on feeds + media, PI `dead:0`/200, the four moved albums) and why a host list beats a probe (crawl ages).
- [ ] **Step 4: Run `npm run check:moved`** — Expected: every line `ok`, exit 0.
- [ ] **Step 5: Commit** `feat(moved): closed-host list and the pure decisions for moved feeds`.

### Task 2: Same-guid switch in the server resolvers

**Files:**
- Modify: `lib/pi.ts` (`getPodcastByGuid` ~434, `getEpisodeByGuid` ~1937, `resolveOneSplit` ~1975)
- Modify: `lib/pi-batch.ts` (`batchPodcasts`, `batchEpisodes` index branches)

**Interfaces:**
- Consumes: `closedService`, `pickLiveTwin` (Task 1).
- Produces (exported from `lib/pi.ts`): `preferLiveTwin(raw: any): Promise<any>` — returns `raw` untouched (NO request) when `closedService(raw?.url)` is null; else the twin's raw record or `raw`. `liveFeedForGuid(feedGuid: string): Promise<any | null>` — raw byguid record after `preferLiveTwin`. `twinEpisode(raw: any, feedGuid: string, itemGuid: string): Promise<any>` — when `closedService(raw?.enclosureUrl) ?? closedService(raw?.feedImage)` is set, asks `/episodes/byguid?guid=<item>&feedid=<twin id>` and returns that episode, else `raw`.
- Cache: `const twinCache = createBoundedCache<{ twin: any | null }>({ maxAgeMs: 24 * 3600_000, maxEntries: 2000 })`, key = guid. Store only definite answers; a thrown search is not cached and yields `raw`.
- Search: `pi<any>('/search/bytitle?q=' + encodeURIComponent(raw.title) + '&max=50&similar')`.

- [ ] **Step 1: Start the dev server** (worktree, `.env.local` copied, `node_modules` linked) and record the failing baseline with curl:
  - `curl -s 'localhost:3000/api/by-guid?guid=7153bbb0-b8c4-521f-80c0-cef62d8ef67b' | jq .podcast.id` → today `7101864` (want `7520866`).
  - `curl -s 'localhost:3000/api/episode-by-guid?feedGuid=7153bbb0-b8c4-521f-80c0-cef62d8ef67b&itemGuid=405be9f7-684f-54b8-9035-009111f1933f' | jq -r .episode.enclosureUrl` → today an `rssblue` URL (want `feeds.fountain.fm`).
  - `curl -s 'localhost:3000/api/by-guid/batch?guids=7153bbb0-b8c4-521f-80c0-cef62d8ef67b,ac746d09-7c3b-5bcd-b28a-f12d6456ca8f' | jq '.podcasts|map_values(.id)'` → Worried `7101864` today; Homegrown Hits unchanged.
- [ ] **Step 2: Implement** `preferLiveTwin`, `liveFeedForGuid`, `twinEpisode`; use them in `getPodcastByGuid` (`podcastFromPiFeed(await preferLiveTwin(feed))`), `getEpisodeByGuid` (`twinEpisode` on the answer before `buildEpisode`), `resolveOneSplit` (its raw byguid read → `preferLiveTwin`), and in both index branches of `lib/pi-batch.ts` (records with a closed URL / closed enclosure only, through `mapLimit(…, PI_FANOUT, …)`).
- [ ] **Step 3: Re-run the three curls** — Expected: `7520866`; a `feeds.fountain.fm` enclosure; batch Worried `7520866`, Homegrown Hits same id as before. Also `curl` a healthy guid twice and confirm the dev log shows no `/search/bytitle` call (add a temporary `console.log` in `preferLiveTwin`'s search arm, remove it before commit).
- [ ] **Step 4: `npm run typecheck`** — Expected: 0 errors.
- [ ] **Step 5: Commit** `feat(pi): a closed-host feed resolves to its live same-guid copy`.

### Task 3: `/api/moved` — candidates on a new guid

**Files:**
- Create: `app/api/moved/route.ts`
- Modify: `lib/pi.ts` (add `findMovedCandidates`)

**Interfaces:**
- Consumes: `closedService`, `movedCandidates` (Task 1), `preferLiveTwin` (Task 2), `getEpisodes`, `episodeWithoutValue`.
- Produces: `findMovedCandidates(guid: string): Promise<MovedAnswer | null>` (null = PI has no record); `MovedAnswer = { service: string | null; candidates: { podcast: Podcast; items: Episode[] }[] }` — type in `lib/types.ts`. Route `GET /api/moved?guid=<feed guid>` → 200 `MovedAnswer`, 400 missing/`>120` chars, 404 PI miss; `rateLimit(req, 'moved', 120)`; `Cache-Control: public, s-maxage=86400, stale-while-revalidate=86400` on 200; errors through `withErrorHandling(…, 'lookup failed')`.
- Behaviour: not closed → `{ service: null, candidates: [] }`; closed with a same-guid twin → `{ service, candidates: [] }`; else `/search/bytitle` (title, `similar`, max 50) + `searchPodcasts(author, 60)` raw, `movedCandidates`, then `getEpisodes(id, 200)` per candidate via `mapLimit(…, PI_FANOUT, …)`, each item `episodeWithoutValue`.

- [ ] **Step 1: Baseline** `curl -s -o /dev/null -w '%{http_code}' 'localhost:3000/api/moved?guid=f842b7c8-9f12-54f2-a0b8-4f95c63dad4c'` → `404` (route absent).
- [ ] **Step 2: Implement** the type, `findMovedCandidates`, and the route.
- [ ] **Step 3: Verify:** Mr. Videoman (`f842b7c8-9f12-54f2-a0b8-4f95c63dad4c`) → 2 candidates, ids `7854985` and `6813307`, each with ≥1 item; Runaway Train (`25e0c184-6ae9-541d-b756-1c8816c2cb59`) → `7685451` only; Worried → `candidates: []`, `service: 'RSS Blue'`; Homegrown Hits → `service: null`; `?guid=` → 400; a 121-char guid → 400.
- [ ] **Step 4: `npm run typecheck && npm run lint`** — 0 errors.
- [ ] **Step 5: Commit** `feat(moved): /api/moved lists same-title-and-artist copies on a new guid`.

### Task 4: Cached rows re-resolve; the merge keeps `carried`

**Files:**
- Modify: `lib/podcast-meta.ts` (`warmPodcastCache`, `resolveVia`, `warmEpisodeCache`, `resolveEpisodeByGuid`; add `fetchMovedCandidates`)
- Modify: `lib/nostr/favorites-hydrator.ts` (paint loop re-resolve tests; both post-resolve merges → `mergeResolvedRow`; export `favoriteFromEpisode`)

**Interfaces:**
- Consumes: `closedService`, `mergeResolvedRow` (Task 1); `/api/moved` (Task 3).
- Produces: `fetchMovedCandidates(guid: string): Promise<MovedAnswer | null>` — module-level `Map<string, Promise<…>>` (one request per guid per tab), at most 3 in flight, `null` on any non-200 (never cached as an answer). `favoriteFromEpisode(ep: Episode, feedGuid: string): FavoriteEpisode | null` now exported.
- Rules: a `bmb:pmeta` hit whose `url` is closed, and a `bmb:epmeta` hit whose `enclosureUrl` or `image` is closed, is treated as a miss (not promoted, not returned). Paint loop: show re-resolves when `!hit || !hit.artwork || closedService(hit.url)`; item re-resolves when `(!hit || closedService(hit.enclosureUrl) || closedService(hit.image)) && item.feedGuid && looksLikeFeedGuid(item.feedGuid)`.

- [ ] **Step 1:** Read `docs/nostr.md` § favorites before editing the hydrator (CLAUDE.md rule).
- [ ] **Step 2: Implement** the cache rules, the paint-loop tests, `mergeResolvedRow` in both merges, the export, and `fetchMovedCandidates`.
- [ ] **Step 3: Run `npm run check:favsync && npm run check:moved && npm run typecheck`** — all pass.
- [ ] **Step 4: Commit** `fix(favorites): re-resolve rows on a closed host, and keep carried across a resolve`.

### Task 5: `<MovedOffer>` and the swap

**Files:**
- Create: `components/moved-offer.tsx`
- Modify: `components/lists/favorites.tsx` (`FavoriteFeedRows`, `FavoriteItemRows`)

**Interfaces:**
- Consumes: `fetchMovedCandidates`, `favoriteFromEpisode`, `favoriteFromPodcast`, `planSwap`, `closedService`, store `addFavorite`/`addFavoriteEpisode`/`removeFavorite`/`removeFavoriteEpisode`, `requestFavoritesSync`.
- Produces: `<MovedOffer feedGuid: string; scope: 'feed' | { itemGuid: string }; carried?: boolean />` rendering an `<li>` (indented under the row, `pl-[68px]` to clear the 56px cover + 12px gap) or `null`.
- Mount rule: feed row when `closedService(p.url)`; item row when `ep.feedGuid && (closedService(ep.enclosureUrl) || closedService(ep.image))`; carried rows pass `carried` and get no buttons. Render as a sibling after the row inside a `Fragment` keyed like the row — `<PodcastRow>` is shared and stays unchanged.
- Copy: first line `{service} closed. Found:`; one line per candidate `{title} — {author} · {host label}` + button `REPLACE` (host label: `Fountain` for `feeds.fountain.fm`, `Wavlake` for `wavlake.com`/`www.wavlake.com`, else the hostname). After a swap: `Replaced.` plus, when tracks stayed, `{n} of {m} tracks not found on {host label} — kept.`
- Swap order: `addFavorite` (if `addFeed`, built with `favoriteFromPodcast`, `addedAt` = old row's), every `addFavoriteEpisode` (`addNew` moves; `favoriteFromEpisode(ep, candidate.podcast.podcastGuid)` with old `addedAt`), then `removeFavoriteEpisode` for every move, then `removeFavorite` (if `removeFeed`), then ONE `requestFavoritesSync(identity)`.

- [ ] **Step 1: Implement** the component and the mount rules.
- [ ] **Step 2: `npm run typecheck && npm run lint`** — 0 errors.
- [ ] **Step 3: Commit** `feat(favorites): offer REPLACE for an album that moved to a new guid`.

### Task 6: End-to-end, docs, ship

**Files:**
- Create: `scripts/e2e-moved.mjs`; Modify: `package.json` (`"e2e:moved": "node scripts/e2e-moved.mjs"`)
- Modify: `docs/ui.md` (favorites rows: the offer), `docs/feeds.md` (closed hosts, same-guid twin, payment follows), `CLAUDE.md` (index rows for `lib/moved-feeds.ts`, `components/moved-offer.tsx`, `app/api/moved/`; add `moved-feeds.ts` to the import-free list), `docs/testing.md` (`e2e:moved` row)

- [ ] **Step 1: Write `scripts/e2e-moved.mjs`** on `scripts/cdp.mjs` + `scripts/local-relay.mjs` with a throwaway key (the `e2e-favorites.mjs` binding pattern). Seed a public kind:10333 with: Worried feed `7153bbb0-b8c4-521f-80c0-cef62d8ef67b` + its item `405be9f7-684f-54b8-9035-009111f1933f`; Mr. Videoman `f842b7c8-9f12-54f2-a0b8-4f95c63dad4c` (itemless); Homegrown Hits `ac746d09-7c3b-5bcd-b28a-f12d6456ca8f` (control). Assertions:
  - Worried's row cover `src` names `feeds.fountain.fm` and loads (`naturalWidth > 0`).
  - A second load with `bmb:favorites:<npub>` pre-seeded with the DEAD Worried row (`url` on rssblue, `artwork` set) also ends on the Fountain cover.
  - Mr. Videoman shows `RSS Blue closed. Found:` and two REPLACE buttons; each button's box ≥ 24×24.
  - Press the Fountain REPLACE → the local relay receives a kind:10333 whose `i` tags include `podcast:guid:9b2014ae-ca84-552d-9283-8510b686adc7` and not `podcast:guid:f842b7c8-9f12-54f2-a0b8-4f95c63dad4c`, and still include Worried and Homegrown Hits.
  - At 390×844 (`Emulation.setDeviceMetricsOverride`, `mobile: true`): `scrollWidth <= clientWidth`.
  - Homegrown Hits row has no offer.
- [ ] **Step 2: Run `npm run e2e:moved`** against `npm run dev` — every line `ok`.
- [ ] **Step 3: Run the 2026-11-14 diagnosis harness** (Chad's public tags under a throwaway key) and compare to the baseline (258 ok / 4 tiles / 13 pending): Worried moves to ok; the three new-guid albums show offers.
- [ ] **Step 4: Update the docs** listed above; `npm run check:claudemd` within budget.
- [ ] **Step 5: Full gate:** `npm run typecheck && npm run lint && npm run check && npm run build` (then `rm -rf .next` before any `dev`), `npm run e2e:favorites`.
- [ ] **Step 6: Commit, push the branch (asks Chad), open a draft PR** listing what the browser verified and the gaps (feed-id paths, saved playback state, item missing on a twin, real-phone test).
