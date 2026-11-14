# GIF picker: a playing video grid, and nostr.build on boostmebitch.com

**Date:** 2026-11-14

## Intent

Chad looked at the GIF search grid on `/live` and asked whether a GIF can play when he hovers it.
The grid shows still first frames (GIPHY `200w_s.gif`), so a GIF cannot be seen moving until it is
picked. PR #562 built a hover preview. In the same session Chad asked to move boostmebitch.com from
GIPHY to nostr.build, and then, when shown nostr.build's grid design, chose it: **every GIF on
screen plays**, on both deploys, if the bytes are not too much.

Decisions Chad made on 2026-11-14:

- boostmebitch.com searches **gifs.nostr.build, from the browser** (no key, a registered Origin).
- boostmebuddy.com stays on **GIPHY**, now at rating `pg-13` (PR #564: Chad, "if anyone is using
  Buddy I assume they are over 13").
- The grid follows **nostr.build's grid design** — each tile plays a small MP4 in a pooled
  `<video>` — on **both** deploys.

## What was measured (2026-11-14)

- **GIPHY, 8 real ids:** stills `200w_s.gif` 11–21 KB; `200w.mp4` 12–50 KB for seven, 196 KB for
  one; animated `200w.webp` 24–870 KB. The eight as playing MP4s: 369 KB, against 149 KB as stills.
- **nostr.build:** a post URL `https://gifs.nostr.build/<64-hex>.gif` is 93 characters, 105 with a
  `nostr.build_` prefix (GIPHY's `giphyGifUrl` is 58). Originals 1.5–8 MB. MP4s 12–42 KB. PNG stills
  `still/w240` 49–73 KB. nostr.build's own sample of 240 tiles: MP4 median 40 KB per tile.
- **nostr.build result shape (40 results for "applause"):** 39 had `url == https://gifs.nostr.build/<id>`
  and `mp4 == …/mp4/orig/<id>`. One had an `id` that differs from its file name, but every media URL
  of that result shared one **file key**: the last path segment of `url`. One of the 40 was
  `format: webp` (`.webp` URL).
- **nostr.build API** (`/developers/llms-full.txt`, `/developers/grid.md`, `/api/v1/openapi.json`):
  a browser call needs a registered Origin and **no** custom headers (an `Authorization` header fails
  the CORS preflight). `http://localhost` and `http://127.0.0.1`, any port, are a shared development
  client that needs no registration. Unregistered: 403 `client_not_registered`, which a browser sees
  as a CORS failure with no status. 120 requests a minute per IP. `safe=1` is the default and the only
  content filter. "GIFs from nostr.build", linked to https://nostr.build, is a condition of use.
- **WebKit, per nostr.build's measurements:** every animated `<img>` keeps a decoding thread for the
  page's life, and the page freezes at 512 threads (third search in their pickers). MP4 tiles from a
  pool stayed at 26 threads over 14 searches. A new `<video>` per tile makes each later play and pause
  slower, because WebKit walks every media session ever made.
- **Chrome, PR #562's e2e:** removing an `<img>` 50 ms into its fetch did not cancel the fetch.
- **This repo:** the CSP (`next.config.mjs`) sets no `img-src`, `media-src` or `connect-src`, so no
  config change is needed. The boost note picture route (`app/api/og/boost.png`) draws podcast art,
  not the GIF. `check:lnurl` pins the GIF-last-line rule with a 58-character GIPHY URL only.

## Goals

1. On both deploys the picker grid plays each on-screen GIF as a muted, looping MP4 in a pooled
   `<video>`, following nostr.build's eleven grid rules (below, as adopted).
2. boostmebitch.com searches `gifs.nostr.build` from the browser. boostmebuddy.com keeps `/api/gifs`
   (GIPHY, server proxy, `pg-13`).
3. The URL on the wire is the source's own post URL: nostr.build's `url` on boostmebitch.com,
   `giphyGifUrl(id)` on boostmebuddy.com. `withGif` and `gifCost` keep their rules.
4. A stored boost shows its GIF in `<BoostCard>` for either source, on either deploy, so old GIPHY
   boosts keep their picture after the switch.
5. Attribution per source: "GIFs from nostr.build" (a real link) or "Powered by GIPHY".

## Non-goals (this version)

- No NIP-92 `imeta` tag for the GIF. nostr.build asks for one, but `/api/nostr/site-sign` allows one
  `imeta` and the banner holds it. Same as GIPHY today.
- No `suggest` combobox, no starter chips, no Similar or Copy link, no Report action. The picker
  shows only GIFs the user searched for or the empty-box list.
- No HEAD warming of MP4s ahead of the load zone.
- No virtualization. nostr.build's plain sample mounts all 200 tiles and measured flat memory.
- No change to how live chat, note cards or the My Boosts list draw a GIF beyond goal 4.

## Anti-goals (a failure even if it works)

- An animated `<img>` in the grid while H.264 plays.
- A new `<video>` per tile, or a pool emptied per opening or per query.
- Any media URL in an `src`, or any `url(...)` in CSS, that was not rebuilt from a validated key.
- A pasted `nsec` reaching gifs.nostr.build or GIPHY.
- boostmebitch.com in production without a registered Origin (every search would fail).

## Approaches

**Where the nostr.build search runs.** (A) From the browser, with the site's Origin registered.
(B) Through our `/api/gifs` route with a nostr.build API key. **Chose A**: nostr.build documents it
for websites, it needs no secret, each user has their own 120/minute budget, and it can be built and
tested now from `127.0.0.1`. The cost: Vercel preview URLs (`*.vercel.app`) cannot search, and the
route's second `nsec` check does not run (the picker's check, before any request, stays). B keeps the
route and works on previews, but puts every user on the server's budget and needs a key in Vercel.

**The grid.** (A) Stills, with PR #562's hover preview (one animation at a time). (B) nostr.build's
design: every tile near the screen holds a pooled `<video>`, and plays while on screen. **Chose B**,
on both deploys: the MP4s are about as small as the stills (GIPHY 2.5 times, nostr.build smaller than
its PNG stills), everything moves, and it is the design nostr.build measured not to freeze Safari.
A costs less code. **#562 is superseded** and is closed when this PR opens.

## Design

### Sources and the pick

- `BRAND.gifSource`: `'nostrbuild'` for `bmb`, `'giphy'` for `buddy` (`lib/brand.ts`, a new field).
- A pick is `{ src: 'giphy', id }` or `{ src: 'nostrbuild', key }`. The boost modals hold a pick in
  place of `gifId`, and turn it into the wire URL at send time.
- **Every URL is rebuilt from a validated key.** GIPHY: `isGiphyId` as today; `200w.mp4`,
  `200w_s.gif`, `200w.webp` under `https://media.giphy.com/media/<id>/`. nostr.build: the key is the
  last path segment of `url`, matching `^(nostr\.build_)?[0-9a-f]{64}\.(gif|webp)$`; `url`, `mp4`
  (`/mp4/orig/<key>`), and `previews.w240.animated` / `.still` (`/anim/w240/<key>`,
  `/still/w240/<key>`) must each equal the rebuilt form, or the result is dropped. `webm` and `hevc`
  are kept only when they start with `https://gifs.nostr.build/` and contain no `#`. `lqip` only as
  `data:image/(webp|png|jpeg);base64,…`. `width` and `height`: positive integers up to 4096. `title`:
  trimmed, 120 characters.
- GIPHY's parser also keeps `images.fixed_width.width` / `.height` (same integer rule), so every tile
  has its size before it loads. GIPHY has no `lqip`; its tiles paint a solid placeholder.

### Search

- **nostr.build (boostmebitch.com):** a plain `fetch` to
  `https://gifs.nostr.build/api/v1/search?q=<q>&limit=200` (no headers); the empty box asks
  `/api/v1/gifs?kind=reaction&limit=200` (nostr.build has no trending). The query is trimmed, spaces
  collapsed, cut at 500 characters between code points; one Latin letter is not searched. Debounce
  300 ms (as now). 15 s timeout. Never aborted: a late answer is ignored (the existing `live` flag).
  Retried once after 1 s only when the request failed before an answer. 429 → "Too many searches for
  now: give it a minute." Anything else, including the CORS failure an unregistered Origin produces →
  "GIFs are unavailable right now." with a Try again button.
- **GIPHY (boostmebuddy.com):** `/api/gifs` as now, `limit` 50 (GIPHY's maximum), with sizes.
- The `looksLikeSecretKey` refusal stays in the picker, before any request, for both sources.

### The grid (`<GifGrid>`, `lib/video-pool.ts`)

- **Layout:** two columns (the picker is at most 512 px wide, so three would be under nostr.build's
  180 px floor). Each GIF goes under the shorter column, in result order, so the best results fill the
  top row. Tile height from `width`/`height` at the column width, ratio clamped to 3:4 … 2:1.
- **Zones,** with `IntersectionObserver` whose `root` is the picker's scroll box (held in state, not a
  ref): *near* is within half the box's height; *on screen* is a tenth visible.
- **A tile's life:** far → its placeholder only, no request. Near for 150 ms → borrows a `<video>`,
  `src = mp4 + '#t=0.001'`, paused, `autoplay` off. On screen → `play()`. Off screen but near →
  `pause()` (only if playing). Out of near → released.
- **The pool:** one per page, never emptied. Each video made once with `muted`, `loop`, `playsInline`,
  `preload="auto"`, `disablePictureInPicture`, `aria-hidden`, `src` on the element (no `<source>`).
  Release = `pause()`, `removeAttribute('src')`, `load()`, detach, return. Listeners and the fade timer
  are added on borrow and removed on release.
- **Painting:** on `loadeddata` the video fades in, and the placeholder hides when the fade ends (a
  transparent GIF: when it starts). Nothing behind a drawn video; the video carries the tile's radius;
  an empty `<img>` is `display: none`; the focus ring is inset.
- **Fallbacks,** in order: placeholder, video, animated preview, still. No H.264
  (`canPlayType('video/mp4; codecs="avc1.4d401e"')`, asked once) → the animated preview after 150 ms on
  screen. A video `error` → the animated preview, then the still. `prefers-reduced-motion: reduce`, or
  a `play()` that rejects with `NotAllowedError` → stills for the whole grid until the next search, and
  only near the screen. A transparent nostr.build GIF plays `hevc` on WebKit, `webm` on Chrome and
  Firefox, else `mp4`; on error, `mp4`.
- **Picking:** each tile is a `<button>` named by its title. One pick per opening; the picker closes.
- **Phone:** the search field is focused on open only where `(hover: hover)` matches, so a phone's
  keyboard does not cover the grid.

### Wire and display

- `withGif`, `gifCost` and `buildLnurlComment`'s whole-URL-or-nothing rule are unchanged. A
  93-character URL leaves about 155 characters for words, and is dropped whole more often on a small
  `commentAllowed`. The words survive.
- The picked GIF above the message stays one animated `<img>` (the source's animated preview).
- `<BoostCard>` recognises GIPHY URLs (as now) and nostr.build URLs (the key regex on the whole line)
  on both deploys, and draws the animated preview, hidden on error.

### Settled after the builder review (the author's calls)

- **The lock-screen hook hears every GIF tile.** `use-media-session.ts` listens for `playing` in the
  capture phase on `document`, and hands the lock-screen actions over again each time, because a
  WebKit remote-command listener starts from its defaults. A tile video is a media element in the
  document, so it fires that too. **The hand-over stays for every `playing`** — a repeat is harmless,
  and if a tile video ever does reset WebKit's commands, this is what repairs them. **The `ms.reg`
  log line is skipped when the target is a tile video** (pool videos carry `data-gif-tile`), so one
  scroll through 200 GIFs cannot push the player's events out of the 150-line playback log. The
  playback log itself attaches to the player's own elements only (`lib/playback-log.ts`), so tile
  videos never reach it. Whether iOS keeps ⏮/⏭ on the lock screen while the picker plays GIFs over a
  playing track is a phone check (below).
- **GIPHY's MP4s in WebKit.** Three `200w.mp4` files probed: H.264 Main or Constrained Baseline,
  `yuv420p`, level 3.0 — what every iPhone Safari plays, and the same kind as nostr.build's. The
  boostmebuddy Vercel project builds a preview for every PR, so the GIPHY grid gets its phone check
  there, before merge.
- **GIPHY sizes without a key.** No `GIPHY_API_KEY` is in any local env file, so no raw answer can be
  recorded. The parser takes `images.fixed_width` width/height, else `images.original`, and a result
  with neither is **kept** at a 1:1 ratio, never dropped, so a missing field cannot empty the grid.
  The buddy preview confirms the real sizes.
- **Bodies are capped in the browser too.** The nostr.build answer is read with `readCappedJson`
  (CLAUDE.md: "server OR browser"); a 200-result answer is well under 1 MB, cap 2 MB.
- **Merge order.** #564 changes `giphyRating` in `lib/giphy.ts` and the same `docs/money-boosts.md`
  line; this branch is rebased on `main` after #564 merges.

## Testing

- **`npm run e2e:gifgrid`**, headless installed Chrome over CDP (it plays H.264). The APIs are stubbed
  with recorded real results (`/api/gifs`, and `gifs.nostr.build/api/*` by a `Fetch` pattern); the
  media load from the real CDNs. It checks, on each source:
  - every `<video>` ever made is counted (an init script wraps `document.createElement`): after ten
    searches it stays near the most in use at once;
  - a far tile holds no video and made no media request; a near tile holds a paused video on its first
    frame; an on-screen tile plays; scrolling releases; a new search releases every video;
  - reduced motion (`Emulation.setEmulatedMedia`) and a rejected `play()` give stills and no video;
  - a pick puts the exact source URL in the modal, and `<BoostCard>` draws a stored boost of each source;
  - a result with a foreign host, a `#` in its MP4, a bad `lqip` or a key/url mismatch is dropped;
  - a typed `nsec` sends nothing to either API; 429 and a network failure show their messages;
  - at 390×844 with touch: two columns, no sideways overflow.
  Each check is made to fail once by breaking the code on purpose (no release, a new video per tile, a
  near video that plays).
- One run against the real nostr.build API from `127.0.0.1` (the shared development client).
- `check:lnurl` gains a 93-character nostr.build URL case. `typecheck`, `lint`, `build`.
- The e2e also checks that a tile video's `playing` writes no `ms.reg` line, while the player's own
  `playing` still does, and that `setActionHandler` still runs after a tile plays.
- **Not reachable here:** WebKit playback (Playwright's WebKit has no H.264; logic only) and the
  ten-searches-deep Safari thread and memory check, which needs Safari on iOS. Chad's phone checks,
  added to his To do note: the nostr.build grid on beta.boostmebitch.com (`npm run beta -- add <PR>`,
  after the beta origin is approved); the GIPHY grid on the boostmebuddy PR preview; and the
  lock-screen ⏮/⏭ with the picker open over a playing music track.

## What Chad does

1. Register at https://gifs.nostr.build/developers (Nostr sign-in, 1000 sats once) with the origins
   `https://www.boostmebitch.com`, `https://boostmebitch.com`, `https://beta.boostmebitch.com`.
   `_@boostmebitch.com` names the site's key, not Chad's, so the origins wait for nostr.build's review.
2. Merge after the origins are approved. Merge #564 first: both PRs change one line in
   `docs/money-boosts.md`.

## Left to the builder

File and component names, the placeholder colour, the fade length, and the exact copy of the empty
and searching states, within the rules above.
