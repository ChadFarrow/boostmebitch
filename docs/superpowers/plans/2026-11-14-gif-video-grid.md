# GIF Video Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The boost modals' GIF picker plays every on-screen GIF as a pooled MP4 on both deploys, and boostmebitch.com searches gifs.nostr.build from the browser while boostmebuddy.com keeps GIPHY.

**Architecture:** A source-neutral `GifTile` / `GifPick` layer (`lib/gifs/`) turns either source's answer into tiles whose every URL is rebuilt from a validated key. `<GifGrid>` lays tiles out in two masonry columns and drives each tile's `<video>` from one page-wide pool by two `IntersectionObserver`s rooted at the picker's scroll box. `<GifPicker>` picks the source from `BRAND.gifSource`, owns search state, and hands a `GifPick` to the modals, which turn it into the wire URL at send time.

**Tech Stack:** Next.js 15 App Router, React, TypeScript (strict), Tailwind; tests are node scripts — CDP against installed headless Chrome (`scripts/cdp.mjs`), pure sections under `node --experimental-strip-types` with `scripts/e2e-resolve-hook.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-14-gif-video-grid-design.md`

## Global Constraints

- Every media URL in an `src`, and every `url(...)` in CSS, is rebuilt from a validated key; a result whose own URLs differ from the rebuilt ones is dropped.
- nostr.build key regex: `^(nostr\.build_)?[0-9a-f]{64}\.(gif|webp)$`; base `https://gifs.nostr.build`; `url` = base/key, `mp4` = base/mp4/orig/key, animated = base/anim/w240/key, still = base/still/w240/key.
- GIPHY: `https://media.giphy.com/media/<id>/` + `giphy.gif` (wire), `200w.mp4`, `200w_s.gif` (still), `200w.webp` (animated).
- `lqip` accepted only as `data:image/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+`; `webm`/`hevc` only under base with no `#`; `width`/`height` integers 1–4096; `title` trimmed, ≤ 120 chars.
- Browser calls to gifs.nostr.build send no custom headers, read through `readCappedJson` (cap 2 MB), 15 s timeout, never aborted; retried once after 1 s only when no answer arrived.
- Copy: 429 → `Too many searches for now: give it a minute.`; other failures → `GIFs are unavailable right now.` + `Try again`; attribution `GIFs from <a href="https://nostr.build" target="_blank" rel="noopener noreferrer">nostr.build</a>` or `Powered by GIPHY`.
- Grid: 2 columns; ratio clamped 3:4…2:1; near = within half the scroll box's height (`rootMargin: '50% 0px'`), on screen = 10 % visible; 150 ms near before a video is borrowed; `#t=0.001` on the waiting `src`.
- Pool video: `muted`, `loop`, `playsInline`, `preload="auto"`, `disablePictureInPicture`, `aria-hidden="true"`, `data-gif-tile=""`; release = `pause()`, `removeAttribute('src')`, `load()`, detach.
- No `check:*` script is added (CLAUDE.md has 0 words to spare); pure tests live in `scripts/e2e-gif-grid.mjs --pure`.
- A pasted `nsec` is refused in the picker before any request, for both sources.

## Review Focus

1. A search answered late after the box changed (typed "cat", then cleared): the older answer must not replace the newer grid. → Task 4, `late answer ignored`.
2. A transparent nostr.build GIF in Chrome plays its `webm`; a failing `webm` falls back to `mp4`. → Task 3, `transparent tile plays webm, then mp4 on error`.
3. Closing the picker (pick, Close, Escape) while tiles play releases every video. → Task 3, `close releases every video`.
4. An extreme ratio (1000×50, 50×1000) gets a clamped tile height. → Task 3, `extreme ratios clamped`.
5. Opening the picker again makes no new `<video>` beyond the pool's high-water mark. → Task 3, `second opening reuses the pool`.

---

### Task 1: Sources — keys, URLs, parsers, tiles

**Files:**
- Create: `lib/gifs/nostr-build.ts` (import-free)
- Create: `lib/gifs/pick.ts`
- Modify: `lib/giphy.ts` (`parseGiphyResults`, new `giphyMp4Url`)
- Modify: `lib/brand.ts` (`Brand.gifSource`)
- Modify: `app/api/gifs/route.ts` (`LIMIT = 50`)
- Create: `scripts/e2e-gif-grid.mjs` (pure section), `scripts/fixtures/gifs-nostr-build.json`
- Modify: `package.json` (`"e2e:gifgrid": "node --experimental-strip-types scripts/e2e-gif-grid.mjs"`)

**Interfaces:**
- Produces (`lib/gifs/nostr-build.ts`): `NB_BASE`, `isNbKey(s: unknown): s is string`, `nbGifUrl(key)`, `nbMp4Url(key)`, `nbAnimUrl(key)`, `nbStillUrl(key)`, `nbKeyFromUrl(url: string): string | null`, `normalizeNbQuery(q: string): string | null` (null = do not search), `nbSearchUrl(q: string): string` (`/api/v1/search?q=…&limit=200`), `NB_BROWSE_URL` (`/api/v1/gifs?kind=reaction&limit=200`), `interface NbResult { key; title; width; height; lqip: string|null; webm: string|null; hevc: string|null; transparent: boolean }`, `parseNbResults(json: unknown): NbResult[]`.
- Produces (`lib/giphy.ts`): `interface GifResult { id; title; width: number|null; height: number|null }` (sizes from `images.fixed_width`, else `images.original`), `giphyMp4Url(id)`.
- Produces (`lib/gifs/pick.ts`): `type GifPick = { src: 'giphy'; id: string } | { src: 'nostrbuild'; key: string }`; `interface GifTile { pick; title; width; height; mp4; animated; still; lqip: string|null; alpha: { webm: string|null; hevc: string|null } | null }`; `giphyTile(r: GifResult): GifTile` (null sizes → 1:1 at 200×200); `nbTile(r: NbResult): GifTile`; `gifWireUrl(p: GifPick): string`; `gifPreviewUrl(p: GifPick): string` (animated rendition); `gifPickFromWireLine(line: string): GifPick | null`; `gifPickKey(p: GifPick): string`.
- Produces (`lib/brand.ts`): `Brand.gifSource: 'nostrbuild' | 'giphy'` — `bmb` → `'nostrbuild'`, `buddy` → `'giphy'`.

- [ ] **Step 1: Record the fixture.** With `fetch` from a page served on `http://127.0.0.1` (the shared dev client — never a faked `Origin` header from Node or `curl`), save `/api/v1/search?q=applause&limit=40` and `?q=cat&limit=40` answers, `tags` removed, to `scripts/fixtures/gifs-nostr-build.json` as `{ "applause": {...}, "cat": {...} }`. Add, in the file, one synthetic `bad` list holding: a foreign-host `url`, an `mp4` with `#`, a `lqip` of `javascript:…`, a `url`/`mp4` key mismatch, a 1000×50 and a 50×1000 item, and one transparent item with `webm`/`hevc` under the base.
- [ ] **Step 2: Write the failing pure tests** in `scripts/e2e-gif-grid.mjs`, section `0. Pure` (runs first; `--pure` exits after it, so no dev server is needed):
  - `parseNbResults(fixture.applause)` keeps 39 of 40 or more and every kept `key` passes `isNbKey`; the `id`≠file-name item keeps the file key.
  - `parseNbResults(bad)` drops the foreign-host, `#`-mp4 and mismatch items; the `javascript:` `lqip` becomes `null`; the transparent item keeps `webm`/`hevc`.
  - `normalizeNbQuery('  Cat   Videos ')` = `'cat videos'`; `('a')` = `null`; `('😂')` = `'😂'`; `('')` = `null`; 600 chars → 500 code points.
  - `gifWireUrl({src:'nostrbuild',key})` = `https://gifs.nostr.build/<key>`; `gifWireUrl({src:'giphy',id:'1VQr7rkEjsLXG'})` = `https://media.giphy.com/media/1VQr7rkEjsLXG/giphy.gif`.
  - `gifPickFromWireLine` returns the pick for both wire forms, and `null` for `https://gifs.nostr.build/still/w240/<key>`, `https://evil.example/<key>`, and a wire URL with trailing text.
  - `giphyTile` of a result with null sizes has `width` 200, `height` 200; `parseGiphyResults` reads `images.fixed_width.width/height` (strings "200"/"146" → 200/146), and keeps a record with no `images`.
- [ ] **Step 3: Run** `node --experimental-strip-types scripts/e2e-gif-grid.mjs --pure` — Expected: FAIL, `ERR_MODULE_NOT_FOUND` for `lib/gifs/nostr-build.ts`.
- [ ] **Step 4: Implement** the Task 1 interfaces. `nbTile` builds every URL from `key`; `parseNbResults` reads the key from `url`'s last segment and requires `url`, `mp4`, `previews.w240.animated`, `previews.w240.still` to equal the rebuilt forms.
- [ ] **Step 5: Run** the same command — Expected: every `ok`, exit 0. Then `npm run typecheck`, `npm run check:brand` — pass.
- [ ] **Step 6: Commit** `feat(gifs): source-neutral GIF tiles, nostr.build parser`.

### Task 2: Wire — modals and boost cards hold a `GifPick`

**Files:**
- Modify: `components/boost-modal/index.tsx:166-171`, `components/boost-all-modal.tsx:~71,687`, `components/boost-card.tsx:31-36,93-105`, `components/boost-modal/gif-picker.tsx` (prop types only: `pick: GifPick | null`, `onChange(p: GifPick | null)`)
- Modify: `scripts/check-lnurl-comment.mjs` (a 93-character nostr.build URL case beside the GIPHY one)

**Interfaces:**
- Consumes: `GifPick`, `gifWireUrl`, `gifPreviewUrl`, `gifPickFromWireLine` (Task 1).
- Produces: `<GifPicker pick onChange disabled />`.

- [ ] **Step 1: Add the failing `check:lnurl` cases** with `GIF = 'https://gifs.nostr.build/' + 'a'.repeat(64) + '.gif'`: both fit at 255; a `commentAllowed` that cuts inside it drops the URL and keeps the words.
- [ ] **Step 2: Run** `npm run check:lnurl` — Expected: PASS already (the rule is URL-agnostic). If it fails, stop: `clipProse` is GIPHY-specific and the spec is wrong about it.
- [ ] **Step 3: Change** the modals to hold `GifPick | null`, `gifUrl = pick ? gifWireUrl(pick) : null`; `<BoostCard>` uses `gifPickFromWireLine` and `gifPreviewUrl`; the picked preview above the message uses `gifPreviewUrl`.
- [ ] **Step 4: Run** `npm run typecheck`, `npx eslint` on the four files — pass.
- [ ] **Step 5: Commit** `feat(gifs): boost modals and cards carry a source-neutral GIF pick`.

### Task 3: The video pool and `<GifGrid>` (on the GIPHY source)

**Files:**
- Create: `lib/gifs/video-pool.ts`
- Create: `components/boost-modal/gif-grid.tsx`
- Modify: `components/boost-modal/gif-picker.tsx` (render `<GifGrid>` instead of the `<img>` columns; scroll box held in `useState`)
- Modify: `scripts/e2e-gif-grid.mjs` (browser sections, GIPHY via stubbed `/api/gifs` with the 8 real ids and real sizes)

**Interfaces:**
- Produces (`video-pool.ts`): `borrowVideo(): HTMLVideoElement`, `returnVideo(v: HTMLVideoElement): void`, `canPlayH264(): boolean` (asked once), `alphaSrc(a: GifTile['alpha']): string | null` (hevc for a WebKit UA without `Chrome/`, webm for `Chrome/`/`Firefox/`, else null).
- Produces (`gif-grid.tsx`): `<GifGrid tiles: GifTile[] scrollRoot: HTMLElement | null motion: 'play' | 'still' onAutoplayRefused: () => void onPick: (t: GifTile) => void disabled: boolean />`. Tiles are `<button>`s named by `title`, each carrying `data-gif-key={gifPickKey(pick)}` and `data-state` = `far` | `waiting` | `playing` | `paused` | `still` | `preview`.
- Consumes: `GifTile`, `gifPickKey` (Task 1).

- [ ] **Step 1: Write the failing browser tests** (section `1. GIPHY grid`, desktop 1280×900, page load stubs `/api/*`; an init script wraps `document.createElement` to count `video`):
  - `tiles have their height before any media loads` (each button's height = column width × h/w within 1 px, before the first `loadeddata`).
  - `a far tile holds no video and asked for nothing` (scroll so tile N is > 1 box-height away: no `<video>` inside, no request for its id).
  - `a near tile waits paused on its first frame` (`data-state="waiting"`, `video.paused`, `src` ends `#t=0.001`, `readyState ≥ 2`).
  - `an on-screen tile plays` (`data-state="playing"`, `!video.paused`, `currentTime` advances).
  - `scrolling away releases` (`<video>` gone from the tile; no element with `data-gif-tile` and a `src` outside the grid).
  - `ten searches: videos made ≤ most in use + 4`.
  - `reduced motion shows stills and no video` (`Emulation.setEmulatedMedia` `prefers-reduced-motion: reduce`).
  - `refused autoplay shows stills for the grid` (init script makes `HTMLMediaElement.prototype.play` reject `NotAllowedError`).
  - `close releases every video`, `second opening reuses the pool`, `extreme ratios clamped` (Review Focus 3–5), `transparent tile plays webm, then mp4 on error` (Review Focus 2; uses a nostr.build fixture tile mounted through the Task 4 source — mark this test as Task 4's if Task 4 is not done).
  - `phone 390×844 touch: two columns, no sideways overflow`.
- [ ] **Step 2: Run** `APP_URL=http://127.0.0.1:3047 node --experimental-strip-types scripts/e2e-gif-grid.mjs` against a dev server from this worktree — Expected: FAIL at the first grid assertion (no `data-gif-key`).
- [ ] **Step 3: Implement** the pool and the grid. Masonry: walk tiles in order, put each in the shorter column (heights from clamped ratios). A tile borrows on 150 ms near, plays at 10 % on screen (`autoplay` off while waiting), pauses only when playing, returns on leaving near and on unmount (effect cleanup). `loadeddata` → fade in, then hide `lqip`. Fallback chain on `error`: alpha → mp4 → animated `<img>` (shown only after 150 ms on screen) → still. `!canPlayH264()` → the animated preview path. `motion === 'still'` → still `<img>` only near the screen.
- [ ] **Step 4: Run** the e2e — Expected: all section 0–1 checks `ok`.
- [ ] **Step 5: Prove the checks can fail:** copy `gif-grid.tsx` aside; (a) skip `returnVideo` on release, (b) `document.createElement('video')` per tile, (c) `play()` on waiting — each run shows at least one `FAIL`; restore and `cmp` against the copy.
- [ ] **Step 6: Commit** `feat(gifs): playing MP4 grid from a shared video pool`.

### Task 4: nostr.build search from the browser

**Files:**
- Modify: `components/boost-modal/gif-picker.tsx`
- Modify: `scripts/e2e-gif-grid.mjs` (section `2. nostr.build`, `Fetch` pattern `*gifs.nostr.build/api/*` answering from the fixture; media from the real CDN; brand switched by an init script is not possible — run this section against a dev server started with no `NEXT_PUBLIC_BRAND` (bmb), and section 1 against `NEXT_PUBLIC_BRAND=buddy`)

**Interfaces:**
- Consumes: `normalizeNbQuery`, `nbSearchUrl`, `NB_BROWSE_URL`, `parseNbResults`, `nbTile` (Task 1); `<GifGrid>` (Task 3); `readCappedJson` (`lib/capped-body.ts`); `BRAND.gifSource`.

- [ ] **Step 1: Write the failing tests:**
  - `the empty box asks the browse list` (one request to `/api/v1/gifs?kind=reaction&limit=200`, no `authorization` header, grid shows its tiles).
  - `a typed search asks once with limit=200`; `one Latin letter sends nothing`; `late answer ignored` (Review Focus 1: `cat` stub delayed 2 s, box cleared at once → grid shows the browse list after 3 s).
  - `nsec typed: nothing sent to gifs.nostr.build`.
  - `429 shows the wait message, no Try again`; `a failed request shows unavailable + Try again, which asks again`.
  - `a pick puts https://gifs.nostr.build/<key> in the modal, and BoostCard draws it` (stored boost seeded in localStorage per `docs/storage.md`).
  - `the attribution links https://nostr.build`; `Powered by GIPHY` absent.
  - `the field is not focused on open under touch emulation`.
- [ ] **Step 2: Run** against a bmb dev server — Expected: FAIL (`/api/gifs` asked instead).
- [ ] **Step 3: Implement** the source switch in `<GifPicker>`; per-source fetch functions returning `GifTile[]` or an error kind (`'rate' | 'unavailable' | 'setup'`); the existing `live` flag for late answers; one retry after 1 s only on a thrown `fetch`; autofocus only when `matchMedia('(hover: hover)').matches`.
- [ ] **Step 4: Run** both sections (bmb and buddy servers) — Expected: all `ok`.
- [ ] **Step 5: Run once against the real API** (no `Fetch` stub for `gifs.nostr.build`, from `127.0.0.1`): `applause` returns tiles that play.
- [ ] **Step 6: Commit** `feat(gifs): boostmebitch.com searches gifs.nostr.build`.

### Task 5: Keep GIF tiles out of the playback log

**Files:**
- Modify: `components/player/use-media-session.ts:~136-141` (read `docs/ui.md` lock-screen section first)
- Modify: `scripts/e2e-gif-grid.mjs` (section `3. Player`)

- [ ] **Step 1: Write the failing test:** with an episode playing (stubbed feed + `/api/e2e-audio.wav`, as `e2e-dead-track.mjs`), open the picker and let tiles play: `no ms.reg line for a tile`; `the player's own playing still logs ms.reg`; `setActionHandler('nexttrack', …) still set after a tile plays`.
- [ ] **Step 2: Run** — Expected: FAIL on `no ms.reg line for a tile`.
- [ ] **Step 3: Implement:** in `onPlaying(e)`, `handOver` always; `logPlayback('ms.reg', …)` only when `!(e.target instanceof HTMLElement && e.target.hasAttribute('data-gif-tile'))`.
- [ ] **Step 4: Run** section 3 and `npm run e2e:lockbuttons` — Expected: all `ok`.
- [ ] **Step 5: Commit** `fix(player): GIF tile videos write no ms.reg lines`.

### Task 6: Docs, full verification, PR

**Files:**
- Modify: `docs/money-boosts.md` ("A GIF on a boost": two sources, rebuilt URLs, the grid rules, `e2e:gifgrid`), `docs/ui.md` (one sentence at the media-session hand-over: tile videos are handed over but not logged), `CLAUDE.md` (money-boosts row: `the GIF picker's \`lib/giphy.ts\` + \`app/api/gifs/\`` → `the GIF picker's \`lib/giphy.ts\`, \`lib/gifs/\`, \`app/api/gifs/\`` — same word count).

- [ ] **Step 1:** Write the docs. `npm run check:claudemd` — Expected: ≤ budget.
- [ ] **Step 2:** `npm run typecheck`, `npm run lint`, `npm run check:lnurl`, `npm run check:brand`, stop the dev servers, `npm run build` — all pass.
- [ ] **Step 3:** Full `e2e:gifgrid` on both brands; `e2e:lockbuttons`; record the counts for the PR.
- [ ] **Step 4:** Rebase on `main` if #564 merged (conflicts: `lib/giphy.ts` `giphyRating`, the `docs/money-boosts.md` line — keep #564's rating text).
- [ ] **Step 5:** Commit, push (the hook asks Chad), open the PR with the verified/not-verified list from the spec; close #562 as superseded; add Chad's three phone checks to `~/Vibe/project-notes/notes/todo/boostmebitch.md` per `notes/TODO.md`.
- [ ] **Step 6:** Stop every dev server and Chrome this session started; delete `.next`.
