# DEMU Search Type Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `DEMU` option in the search type menu that returns only self-hosted (non-Wavlake) music albums.

**Architecture:** `type=demu` on `/api/search` runs the same two Podcast Index searches as `type=music`, keeps only rows that pass the DeMu rule, and joins them with the existing `mergeSearchLanes`. The rule lives in a new import-free leaf, `lib/demu.ts`, pinned by a new `check:demu`. No roster, no cache, no storage.

**Tech Stack:** Next.js 15 / React 19, TypeScript strict, `node --experimental-strip-types` check scripts.

**Spec:** `docs/superpowers/specs/2026-11-15-demu-search-design.md`

## Global Constraints

- The rule: music (the lane's music test), generator does **not** match `/wavlake/i`, and `closedService(url)` is `null`. A blank or absent generator passes.
- Menu entry, verbatim: `{ type: 'demu', label: 'DEMU', noun: 'DeMu albums', placeholder: 'search self-hosted music…' }`, placed directly after the `'music'` entry.
- `lib/demu.ts` has **no imports at all** (not even `import type`); `scripts/import-free.mjs` enforces it. `lib/util.ts` keeps only type-only imports — it must not import `lib/demu.ts` or `lib/moved-feeds.ts`.
- `closedService` is passed **into** the rule as a parameter, so `lib/moved-feeds.ts` stays the one list of closed hosts.
- Fixtures come from the wire (the rows in Task 1, fetched from Podcast Index on 2026-11-15). Never edit a vector to match the code.
- The feed-URL branch of `/api/search` is unchanged: a pasted URL ignores the selector and echoes `'all'`.
- Ships to `main` on both brands. Every push asks Chad (the guard hook). Draft PR first.

## Review Focus

1. **A Wavlake-only artist under DEMU** — expect the narrowed empty state, *"No DeMu albums match “X”. N results across all types."* with `← search all types`, never "no results". Pinned in Task 3's browser test.
2. **`/search/music/byterm` failing (400/404)** — expect DEMU to degrade to byterm's DeMu music rows, never a 500. Pinned in Task 2's route code by the same `.catch(() => [])` the MUSIC lane uses, and checked by reading the branch in review.
3. **The same album on Wavlake and self-hosted** (*Katherines Wheel*: 6443203 on Wavlake, 7287540 on `headstarts.uk`) — expect only 7287540. Pinned by a Task 1 vector and the Task 3 `Longy` search.
4. **A Wavlake generator on a non-Wavlake host** (QA feed 8097582 on `run.app`) — expect it removed. Pinned by the Task 1 vector that `naive()` gets wrong.
5. **A pasted feed URL while DEMU is selected** — expect the lookup to answer as today, with `type: 'all'`. Pinned in Task 3's browser test.

---

### Task 1: The DeMu rule and its check

**Files:**
- Create: `lib/demu.ts`
- Create: `scripts/check-demu.mjs`
- Modify: `package.json` (add `"check:demu": "node --experimental-strip-types scripts/check-demu.mjs"` beside `check:moved`)
- Modify: `CLAUDE.md` — add `demu.ts` to the "must have no imports" list (line ~127, after `moved-feeds.ts`), and a row to the `check:*` table: `` | `check:demu` | `isDemuFeed` — which search rows DEMU keeps | a Wavlake album answers a Homegrown Hits request check as self-hosted, or a self-hosted one is hidden | ``

**Interfaces:**
- Produces: `export interface DemuRow { generator?: string; url?: string }` and
  `export function isDemuFeed(row: DemuRow, closedService: (url: string) => string | null): boolean` in `lib/demu.ts`. It decides rules 2 and 3 only; the lane applies rule 1 (music).

- [ ] **Step 1: Write the failing check**

`scripts/check-demu.mjs`, in the shape of `scripts/check-moved.mjs` plus `replayVectors` (`scripts/replay-vectors.mjs`). Import `isDemuFeed` from `../lib/demu.ts` and `closedService` from `../lib/moved-feeds.ts`. `naive(row) = !String(row.url ?? '').includes('wavlake.com')` (the host test). Vectors are `{ label, args: [row], expect }`, replayed against both; `alsoNaive: true` only where noted. Rows, verbatim from Podcast Index:

| Label | `generator` | `url` | expect | alsoNaive |
|---|---|---|---|---|
| Wavlake album on wavlake.com (7146493) | `Wavlake` | `https://wavlake.com/feed/music/4403575a-c0b8-48df-8738-285ee6c826d7` | `false` | yes |
| Katherines Wheel, Wavlake copy (6443203) | `Wavlake` | `https://www.wavlake.com/feed/10b82d0f-f893-49c1-b1e2-55e97fe32465` | `false` | yes |
| Wavlake QA feed on run.app (8097582) | `Wavlake` | `https://feeds-qa-854568123236.us-central1.run.app/v1/album/naddr1qqjrxdmpxdjnswfj95mxzvrx956rwef595ursdek95ckvwpcxs6rvcmxxcurxq3q8zpx0p6v9qhl2ftq4r3449q9lz6l882zdf4qx7g4nucahuzy4ukqxpqqqzz4kelytds` | `false` | no — naive keeps it |
| Katherines Wheel, MSP copy (7287540) | `Music Side Project Studio` | `https://headstarts.uk/msp/longy/Katherines Wheel/katherines wheel.xml` | `true` | yes |
| Worried on Fountain (7520866) | `Fountain` | `https://feeds.fountain.fm/aCFEYwJijoBbZSUP32JA` | `true` | yes |
| Cartieradio, blank generator (46385) | `` (empty) | `https://feed.justcast.com/shows/dennis-cartier-cartieradio-by-dennis-cartier/audioposts.rss` | `true` | yes |
| Worried on RSS Blue (7101864) | `RSS Blue v1.21.3` | `https://feeds.rssblue.com/worried` | `false` | no — naive keeps it |

Also, outside the replay: `importFreeProblems('lib/demu.ts')` must be empty (same block as `check-moved.mjs:161`).

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run check:demu`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `lib/demu.ts`.

- [ ] **Step 3: Implement `isDemuFeed` in `lib/demu.ts`**

File header comment: the rule, Chad's words from the spec, the LNBeats prior art (`!v.generator.includes('Wavlake')`), why the host is not tested (the `run.app` QA feeds), why `closedService` is a parameter (import-free). Body: `/wavlake/i` on `row.generator ?? ''`, then `closedService(row.url ?? '') === null`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run check:demu && npm run check:claudemd`
Expected: every vector `ok`, 2 vectors proved against `naive()`, import-free clean, `all ok`; the CLAUDE.md budget check passes.

- [ ] **Step 5: Commit**

```bash
git add lib/demu.ts scripts/check-demu.mjs package.json CLAUDE.md
git commit -m "feat(search): DeMu rule, pinned by check:demu"
```

### Task 2: The `demu` search type, end to end

**Files:**
- Modify: `lib/util.ts` — `SearchType`, `SEARCH_TYPES`, `matchesSearchType` (~lines 1749–1813)
- Modify: `lib/types.ts` — `Podcast` (line ~140): add `generator?: string` with a one-line comment (PI's `<generator>`; read by the DEMU lane)
- Modify: `lib/pi.ts` — `buildPodcast` (line ~167): `generator: typeof f.generator === 'string' && f.generator ? f.generator : undefined`
- Modify: `app/api/search/route.ts` — new branch after `type === 'music'` (~line 182)
- Modify: `scripts/check-demu.mjs` — selector vectors

**Interfaces:**
- Consumes: `isDemuFeed(row, closedService)` from Task 1; `closedService` from `lib/moved-feeds.ts`; existing `searchMusicPodcasts`, `searchPodcasts`, `mergeSearchLanes`, `MAX_TYPED_HITS`, `answer`.
- Produces: `SearchType` gains `'demu'`; `matchesSearchType(p, 'demu')` equals `isMusicMedium(p)`; `/api/search?type=demu` answers `{ feeds, total, type: 'demu' }`.

- [ ] **Step 1: Write the failing checks**

Add to `scripts/check-demu.mjs` (import `SEARCH_TYPES`, `parseSearchType`, `matchesSearchType`, `mergeSearchLanes` from `../lib/util.ts`):
- `parseSearchType('demu') === 'demu'` and `parseSearchType('DEMU') === 'demu'`.
- The `SEARCH_TYPES` entry for `'demu'` deep-equals the Global Constraints literal, and its index is `SEARCH_TYPES.findIndex(s => s.type === 'music') + 1`.
- `matchesSearchType({ medium: 'music' }, 'demu') === true`; `matchesSearchType({ medium: 'publisher' }, 'demu') === false` ("Longy - Everything", 7696544, is a publisher feed).
- The lane composition. `music` = the seven Task 1 rows in table order, each with its PI id (from the label) and `medium: 'music'`. `byterm` = `[{ id: 7696544, medium: 'publisher', generator: 'MSP 2.0 - Music Side Project Studio', url: 'https://headstarts.uk/msp/publisher-feeds/longy-everything-publisher-feed.xml' }, <the 7520866 row again>]` (the publisher row is PI's real record for "Longy - Everything").
  `mergeSearchLanes(music.filter(keep), byterm.filter(keep), 'demu', 50)` where `keep = (f) => isDemuFeed(f, closedService)` returns exactly the ids `[7287540, 7520866, 46385]` in that order: music lane first, the publisher row dropped by the music test, the repeated 7520866 deduped.

- [ ] **Step 2: Run to verify they fail**

Run: `npm run check:demu`
Expected: FAIL — `parseSearchType('demu')` returns `'all'`.

- [ ] **Step 3: Implement**

`lib/util.ts`: add `'demu'` to `SearchType`; insert the menu entry after `'music'`; add `case 'demu': return isMusicMedium(p);` to `matchesSearchType`, with a comment that the DeMu half of the rule is applied by the route, because `lib/util.ts` may not import `lib/demu.ts`. Carry `generator` through `buildPodcast` and `Podcast`.

`app/api/search/route.ts`: a `type === 'demu'` branch, same shape and comment style as the MUSIC branch: `Promise.all([searchMusicPodcasts(query, MAX_TYPED_HITS).catch(() => []), searchPodcasts(query, 50)])`, filter both arrays with `isDemuFeed(f, closedService)`, then `answer(mergeSearchLanes(musicKept, bytermKept, 'demu', MAX_TYPED_HITS), feeds.length, type)`. Its comment states why a filter is enough here (spec "Approaches": 60/60 artists, 60/60 titles) and that `docs/feeds.md` records the trade.

- [ ] **Step 4: Verify**

Run: `npm run check:demu && npm run check:musicl && npm run typecheck && npm run lint`
Expected: all pass. `check:musicl` still reports every selector type round-trips and labels and nouns are unique (now 6 types).

Then with a dev server (`rm -rf .next && npm run dev`, per `docs/testing.md`):
Run: `curl -s 'http://localhost:3000/api/search?q=Longy&type=demu' | node -e 'const d=JSON.parse(require("fs").readFileSync(0));console.log(d.type,d.feeds.length,d.total,d.feeds.filter(f=>/wavlake/i.test(f.generator||"")).length,d.feeds.map(f=>f.id).includes(7287540),d.feeds.map(f=>f.id).includes(6443203))'`
Expected: `demu 14 <n> 0 true false` (14 measured on 2026-11-15; a different count is fine if the Wavlake count is `0` and the two booleans hold).

- [ ] **Step 5: Commit**

```bash
git add lib/util.ts lib/types.ts lib/pi.ts app/api/search/route.ts scripts/check-demu.mjs
git commit -m "feat(search): DEMU search type keeps self-hosted music only"
```

### Task 3: Docs, browser test, draft PR

**Files:**
- Modify: `docs/feeds.md` — line 325 menu list becomes `ALL · ♫ MUSIC · DEMU · PODCASTS · PLAYLISTS · ⚡ NPUB`; add a **DEMU** bullet after **MUSIC**: the rule, that it is a filter over the MUSIC lanes and why that is acceptable here (people search known names; measured 60/60 + 60/60; broad words like `bitcoin` come back short; a `bymedium` roster is the upgrade path), and the Homegrown Hits reference numbers from the spec.
- Modify: `docs/ui.md` — line 283 menu list, same change.

- [ ] **Step 1: Update the two docs** as above, and check `CLAUDE.md` still reads correctly.

- [ ] **Step 2: Run the full gate**

Run: `npm run typecheck && npm run lint && npm run check`, then stop the dev server, `npm run build`.
Expected: all pass, `check:demu` listed in the `npm run check` output.

- [ ] **Step 3: Browser test (headless Chrome over CDP, `scripts/cdp.mjs`, dev server)**

Start Chrome with `--user-data-dir="$CLAUDE_JOB_DIR/tmp/chrome-$CLAUDE_CODE_SESSION_ID"`; close it with `Browser.close` and delete the profile at the end. Read the DOM, not screenshots. Each must hold:
- The menu lists `DEMU` directly after `♫ MUSIC`; picking it sets the placeholder to `search self-hosted music…`.
- `Longy` under DEMU: rows include *Katherines Wheel* once; the result count names `DeMu albums`.
- A Homegrown Hits artist other than Longy (pick one from the feed's `remoteItem`s that is self-hosted) is found.
- A Wavlake-only artist (pick one whose every music feed has a Wavlake generator, e.g. from `/search/music/byterm`): the empty state reads *No DeMu albums match “X”.* plus the cross-type count, and `← search all types` switches to ALL.
- Pasting `https://feeds.fountain.fm/aCFEYwJijoBbZSUP32JA` under DEMU returns that one feed.
- Phone: CDP `Emulation.setDeviceMetricsOverride` 390×844, `mobile: true`; the open menu shows all six options, `scrollWidth <= clientWidth`, each option at least 24×24 CSS px.

- [ ] **Step 4: Commit**

```bash
git add docs/feeds.md docs/ui.md
git commit -m "docs: DEMU search type"
```

- [ ] **Step 5: Push and open the draft PR (the push asks Chad)**

`git push -u origin feat/demu-search`, then `gh pr create --draft --base main` with title *Search: DEMU type for self-hosted music* and a body that lists: what DEMU does and the rule; the LNBeats prior art and the Homegrown Hits purpose; verified in the browser (each Step 3 item); not verified and why (real Android/iPhone — needs a device; song search — out of scope by design). Then add the open item to `~/Vibe/project-notes/notes/TODO.md` only if Chad must test something himself.
