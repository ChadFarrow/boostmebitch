# UI — players, chapters, transcripts, lists, routing, theme

Read before touching `components/player.tsx`, `fullscreen-player.tsx`, `lists.tsx`, `chapter*`, `transcript*`, `home-page.tsx`, `episode-detail-view.tsx`, `auth-control.tsx`, or the theme/PWA files.

Core rules live in [`../CLAUDE.md`](../CLAUDE.md); this file holds the reasoning.

## PWA install

`public/manifest.json` + `public/sw.js` + `<ServiceWorkerRegister>` (`components/sw-register.tsx`, mounted in `app/layout.tsx`). Display mode `standalone`; icons in `public/icons/` + `public/icon.svg`; iPhone splashes in `public/splash/`. Header has `pt-[env(safe-area-inset-top)]` so the bolt + title clear the notch.

**The SW has no precaching.** Next.js emits hashed bundle URLs that change every build, so a stale cache would silently break installed users. The empty `fetch` handler exists only so Chrome/Edge surface the install prompt.


## Auth: two independent logins (`<AuthControl>`)

**Lightning and Nostr are two separate logins.** A user can connect a wallet and boost with **no Nostr identity** — the payment rails, boost orchestrator and `:guest` storage never touch `identity`. `components/auth-control.tsx` fronts both: one **"Sign in ▾"** dropdown when neither is connected (⚡ Connect wallet / ◆ Sign in with Nostr), the wallet balance chip inline once a wallet connects, and a direct button for whichever login remains; once both are set it delegates the Nostr side to `<NostrAuth>`'s `<AccountMenu>`. Both modals' open-state lives in the store (`walletOpen`/`signInOpen`); `<AuthControl>` owns the `<WalletModal>` render, `<NostrAuth>` owns `<SignInModal>`. The account menu is **Nostr-only**.

**Mount-gate for wallet state:** `walletConnected = mounted && hasAnyWallet()`. `hasAnyWallet()` reads localStorage, which the server can't see, so gating it behind a mount effect keeps the first client render matching SSR; without it React discards and regenerates the whole header subtree.

**`walletRestoring` (store) makes the header say "connecting…" instead of offering "Connect wallet" for a wallet the user already has.** `hasAnyWallet()` reads false for the whole Spark SDK-import + handshake window on a cold load. Set from `doLoadProfile` and **gated on positive evidence, never speculatively**: `shouldRestoreSpark` alone is true for anyone without a connected Spark wallet, *including people who never had one*, who would then sit on a false "connecting…" and be told to connect anyway. It fires only when the signer is `'local'` (a Google account always derives a wallet) or a cached balance says this npub had one last session. **Three paths must clear it** or the label sticks forever: the `storage.npub.get() !== id.npub` early return (upstream of the `.finally()` that normally clears it), `abandonRestoredSession()`, and `signout()`. The button still opens the wallet modal on tap — a status label, not a lock.

The balance chip renders **no ⚡ of its own**; `<AuthControl>` draws one in the button and that one has to stay, because `<WalletBalanceChip>` returns null whenever the balance is unknown (WebLN exposes none, every rail is null mid-reconnect) and the lone bolt is what still reads as "connected".


## Episode list pagination + music-feed behaviors (`components/lists.tsx`)

`/api/feed` returns ~50 episodes at once, so pagination is pure client-side slicing. `EpisodeList` holds `visibleCount` (starts at 10, reset in the `[feedId]` effect) and renders `data.episodes.slice(0, visibleCount)`; a **"Load more episodes (N)"** `.btn-ghost` reveals +10 per tap and disappears when all are shown.

Two load-bearing choices:

1. **A button, not infinite scroll** — the per-podcast Nostr comments feed renders *below* the list, so auto-loading would make the list grow as the user scrolls toward the comments ("footer runs away"), burying them on mobile.
2. **No fixed-height inner scroll box** — a second scroll container would fight mobile momentum scroll, the sticky `top-[var(--app-header-h)]` header, and the `scrollIntoView` fix on `window.innerWidth < 1024`. Slicing keeps the page a single scroll container.

Section-divider labels ("Live & upcoming" / "Episodes") derive `prev` from the **sliced** array so they stay correct.

**Music feeds (`isMusic = isMusicMedium(data.podcast)`) behave like albums:**

- **No pagination** — `visibleEpisodes = isMusic ? data.episodes : …slice(0, visibleCount)`; `remaining` is 0 so "Load more" never renders. Still capped at the ~50 `/api/feed` returns.
- **Row tap plays the track** instead of `openEpisode(e)` — tracks carry little extra metadata, so the detail page isn't worth it. Non-music rows still open the detail view.
- **Header album art is a play button** when `isMusic && firstPlayable` — the `<PodcastCover>` wraps in a `<button>` with an always-visible `bg-ink/45` scrim + `▶`/`❚❚`. Plays from `firstPlayable` (first non-pending track), or toggles play/pause if a track from this show is current (`showIsCurrent`, matched by `podcastGuid`/`id`).

## Players (mini + fullscreen)

Two surfaces share one `<audio>` and the store's playback state: the always-mounted mini-player (`components/player.tsx`) and the `<FullscreenPlayer>` it opens. **`<Player>` is mounted in `app/layout.tsx`**, not any page, so playback and the overlay survive route changes (browse ↔ `/stream/<naddr>`).

**Both read the store via per-field selectors, never a bare `useApp()`.** In zustand v5 a selector-less `useApp()` re-renders on *every* store write; `<Player>` is always mounted and owns the fullscreen player, the chapters/transcript fetches and the reverse-portal `<video>`, so a bare subscription re-renders that heavy subtree on every unrelated mutation on top of the 1 Hz position ticks. Actions are stable refs, so selecting them is free.

- **Transport controls are shared.** `<TransportControls size="sm"|"lg">` renders ⏮ / play-pause / ⏭ as a **fragment** (drops into each parent's flex row) and owns the queue math: `idx = episodeQueue.findIndex(...)`, prev disabled at 0, next at the last index. Backed by `playPrev`/`playNext` (mirror images — walk `episodeQueue`, reset `positionSec`) and `togglePlay`. Don't re-inline these buttons.
- **`playNext` auto-advances on `onEnded` only for music**; other media stop.
- **Fullscreen layout** is a two-pane flow in one scroll container (`flex-1 overflow-y-auto flex flex-col sm:flex-row`): art centered in a sticky left half, info in the right. On mount while open it locks scroll on **both `<html>` and `<body>`** (the page scrolls at `<html>`, where the background lives) so the underlying scrollbar doesn't show through; restored on close.
- **Right pane:** title/seek → control row (`<TransportControls size="lg">` + a `flex-1` `⚡ BOOST`), then a second row of `<FavHeart size="md">` + SHARE + the STREAM button → value-split disclosure → **album tracklist** for music (`Album · N tracks`, `episodeQueue` clickable, current highlighted, `max-h-80` scroll) → `<EpisodeInfoPanel>` → `socialInteract` thread. **For Nostr live streams the right pane is replaced by the live chat.**
- **HLS video lives alongside the `<audio>`** — see Nostr live streams for the reverse-portal `<video>` and the `isHlsUrl` branching.
- **`playerExpanded` is store state, not local**, so surfaces outside `<Player>` (a live-stream card) can open it; `<Player>` still owns the render. The header `← back` and ✕ both call `onClose` (collapse, not stop). Signed out, the header shows `◆ Sign in`.
- **The "About this episode" box wraps long tokens** — `whitespace-pre-wrap break-words`. The fullscreen copy has no inner scroll box (see the `<EpisodeInfoPanel>` note below); the *detail view's* notes do carry `overflow-x-hidden`, and there it is load-bearing next to any `overflow-y-auto`: a computed `overflow-y` of `auto` makes the browser compute `overflow-x` to `auto` too, so one unbreakable token (a bare URL) wider than the box spawns a horizontal scrollbar. Same gotcha as the html/body `overflow-x: clip` note in [`../CLAUDE.md`](../CLAUDE.md).

## Chapters (Podcasting 2.0 `<podcast:chapters>`)

`Episode.chaptersUrl` comes straight from PI's `chaptersUrl` — no RSS enrichment needed. `useChapters(url)` (`lib/chapters.ts`) fetches `{ chapters: [{ startTime, title, img?, url? }] }` and **no-ops on an empty `url`**, so callers can invoke it unconditionally (React hook rules). Per-chapter `img` and `url` are surfaced when present: both chapter lists show the thumbnail and a trailing `↗` link (a **sibling** anchor, so it doesn't nest inside the seek button); rows are tap-to-seek.

`lib/chapters.ts` is the single home, exporting `chapterUrlFor(current)`, `chapterState(chapters, pos, dur)` → `{ index, chapter, end }`, and `buildChapterNav(chapters, idx, pos, seek)` → the `<TransportControls>` `prev`/`next` override (or undefined). Three surfaces render chapters: the detail view (read-only), the fullscreen player, the mini-player.

**One fetch per episode, owned by `<Player>`.** `<Player>` always mounts `<FullscreenPlayer>` (translated off-screen when collapsed), so if both called `useChapters` the JSON would be fetched **twice** per play. `Player` does the single `useChapters(chapterUrlFor(current))` and passes `chapters`/`chaptersLoading` down. `chapterUrlFor` is also the **single gate**: it returns `''` for live streams and music feeds, so chapters are podcasts-only everywhere at once, with no per-component `!isMusic` checks.

**Both players** carry the same affordances: seek-bar **tick marks** (`<ChapterTicks>`), a **current-chapter label** (`<ChapterLabel>`, `start–end · title`) — both in `components/chapter-ui.tsx` — and **chapter-stepping ⏮/⏭** via `buildChapterNav` feeding the `prev`/`next` override (absent → falls back to episode/track nav). Prev restarts the current chapter if >3 s in, else jumps back. The tick wrapper uses a `block` input + `flex items-center` so ticks center on the 2px track (an inline-block input leaves a baseline descender gap that drops them below the line).

**Fullscreen `<EpisodeInfoPanel>`** merges about-text, chapters and transcript under an **About / Chapters / Transcript** tab strip. Tabs appear only for sections with content (2+); a lone section renders under a plain label; a loading section shows its own state; neither → null. The strip is `inline-flex max-w-full overflow-x-auto` with `shrink-0` pills, so it's compact on desktop and swipeable on mobile instead of clipping the last tab. Chapters there are seek targets with an active highlight. Receives `chapters`/`loading` as props. The list **flows with the page's single scroll** — no inner `max-h`/`overflow` box, which fought the right pane's own scroll. The non-live right pane splits into a **pinned header** (title, seek, transport/boost, value-split, album) and a **scrollable body** so controls stay put while About/Chapters scroll (desktop `sm+` only; mobile stays one scroll).

**The fetch goes through `/api/chapters?url=<encoded>`, not directly.** Many chapter hosts (notably `feeds.fountain.fm`) serve the JSON with **no `Access-Control-Allow-Origin`**, so a direct browser fetch is CORS-blocked and the hook's `.catch()` silently rendered no chapters. `app/api/chapters/route.ts` is the proxy: `rateLimit` → `safeFetch` with timeout → upstream JSON verbatim, `Cache-Control` on the 200 only. The client parser stays the single source of truth.

## Transcripts (Podcasting 2.0 `<podcast:transcript>`) — a near-clone of Chapters

`Episode.transcriptUrl` + `transcriptType` hold the **best timed** transcript, chosen **JSON > SRT > VTT** (untimed html/plain last). Parsed primarily from RSS `<podcast:transcript url type>` (`parseTranscripts` in `lib/pi.ts`, merged by guid), with PI's `transcriptUrl` as fallback; selection via `pickBestTranscript`/`transcriptRank`.

`lib/transcript.ts` mirrors `lib/chapters.ts`: `TranscriptCue { startTime, endTime?, text, speaker? }`; `parseCueBlocks` (SRT and VTT share a block structure, so one parser serves both) / `parseTranscriptJson` (word-level JSON grouped into readable lines), dispatched by `parseTranscript(text, type)`; `useTranscript(url, type)` (no-ops on empty url); `transcriptSourceFor(current)` gate (skips live/music). **`transcriptIndexAt(cues, pos)` picks the greatest `startTime ≤ pos`, deliberately NOT "last passed"** — auto-captioners emit out-of-order cues (a real SRT had one), and the reduce shortcut lets such a cue hijack the highlight for its whole window.

`<TranscriptPanel>` (`components/transcript-ui.tsx`) is a **bounded `max-h-96` scroll box** highlighting the current line and **auto-scrolling to follow playback** — measured via `getBoundingClientRect` relative to the box, **not `offsetTop`** (which is relative to the nearest *positioned* ancestor and scrolls to the wrong place) — and it scrolls only its own box, never the page. Tap a line to seek when `onSeek` is given. `<Player>` owns the single fetch and passes `cues`/`activeIdx` to the fullscreen tab; the detail view fetches its own and highlights while this episode plays.

**In-transcript search** lives entirely inside `<TranscriptPanel>` — component-internal `query` state, no new props — so the detail view and the fullscreen player both get it with no caller changes. A non-empty query filters timed cues case-insensitively on `text` **or** `speaker`, keeping each cue's **original index** so the `i === activeIdx` highlight still lines up. Match-count badge, `No matches.` empty state, per-line highlighting via a local `highlight(text, query)` helper that is **`indexOf`-based, never regex**, so a query containing `.`/`(`/`*` is literal and can't throw or inject a pattern; hits get a `bg-bolt/30` `<mark>`. Filtered rows stay tap-to-seek. Clearing: the `×` button, `Escape`, or delete. **The follow-the-playing-line effect is guarded on `!query`** — while filtering, the active line may be filtered out, so chasing it would be wrong; it re-runs when the query clears. Search shows only in the timed-list branch.

**`app/api/transcript/route.ts`** clones `/api/chapters` but returns **text**, always served as inert **`Content-Type: text/plain; charset=utf-8` + `X-Content-Type-Options: nosniff`** — deliberately not reflecting the upstream Content-Type. Transcript URLs come from third-party RSS, so a malicious host serving `text/html` with a `<script>`, opened directly as `/api/transcript?url=…`, would execute in **our** origin and read `localStorage` (the NWC spending credential, the bunker `clientSk`). The client parser branches on the `?type=` hint — load-bearing, because hosts serve SRT as `application/octet-stream` — so the real upstream MIME is never needed.

**Tap-to-seek plumbing (chapters + transcripts).** The detail view can't touch the audio element, so a store signal bridges: `store.requestSeek(t)` sets `seekReq: { t, n }` and a `<Player>` effect applies it. `play(episode, podcast, startSec?)` takes an optional start position (applied on `loadedmetadata`) so tapping a line/chapter for a **not-current** episode starts it there; when it IS current, `requestSeek` seeks in place.


## Show-page URL contract (`?podcast=<guid>`)

`selectedPodcast` is mirrored to the URL by two `useEffect`s in `components/home-page.tsx` — no Next.js routing. (`app/page.tsx` is a thin server component: `generateMetadata` for OG tags, rendering `<HomePage />`.) One reads `?podcast=<guid>` on mount and calls `resolvePodcastByGuid`; the other watches `selected?.podcastGuid` and writes/clears the param. Hydration re-checks `useApp.getState()` before `setSelected` so the StrictMode double-mount race can't overwrite a user click that landed during resolution.

**`history.replaceState`, not `pushState`.** Deliberate: the explicit "← back to results" button stays the only in-app exit from detail view. `pushState` would make browser-back a second exit and require a `popstate` listener to keep Zustand and the URL in sync. Bad guids fall back to browse silently via the PI breaker.

**Every page-level view is URL-restorable on refresh** — `?podcast=<guid>` (detail), **`?feed=<id>`** (detail fallback for shows with no `podcastGuid`, resolved via `/api/feed`), `?episode=<guid>`, **`?discussion=1`** (layered on podcast/feed + episode; needs `socialInteract` from `/api/feed`), and **`?publisher=<feedUrl>`** (reconstructs a minimal stub, so the back-button label reads "Publisher" on a cold restore). Live streams use `/stream/<naddr>`. All restores re-check `useApp.getState()` before `set` and gate on the PI breaker. Audio resume is NOT restored — only the view.

The **SHARE button** (`components/lists.tsx:ShareButton`) copies `origin + ?podcast=<guid>` with a 1.8 s "COPIED" flip. Clipboard-only by design — no Web Share API, no pod.link option (that's what the Nostr boost note links to via `podcastLandingUrl`). Header cluster order: `[♡ FAVORITE] [↗ SHARE] [⊙ SUPPORT] [≋ STREAM] [⚡ BOOST]`; STREAM (toggles the per-show `<StreamRate>` panel, via `useStreamPanel`) and BOOST are gated on `showHasValue`, SUPPORT on `podcast.funding`, the rest always visible.

**The cluster is a `basis-full` SIBLING of the header's text column, not a child of it** — the header is `flex flex-wrap` so that row claims the full width at every breakpoint. Nested under the author line (where it lived) it was capped at the text column's width, which on a 390px screen is ~230px against five ~105px controls, so it stacked one-per-line into a ragged five-row column that made the sticky header ~330px tall. DOM nesting can't be responsive, so the alternatives were `flex-col sm:flex-row` (tidier, still ~350px pinned) or rendering the cluster twice behind `hidden sm:flex` (two `<FavHeart>` store subscriptions and two `ShareButton` timers for a visual concern) — hence the hoist. The four ghost buttons carry `btn-compact` (padding/gap only, height untouched, defined in `globals.css` **below** the `.btn*` family since source order is what breaks the specificity tie). Order above is unchanged and all five stay visible; don't collapse any into a menu. The episode detail page and the fullscreen player carry the same STREAM control — it's show-scoped everywhere, so all three edit one setting.


### Episode detail view

**Tabs.** Show notes / Chapters / Transcript / Boosts collapse into one tab strip (`components/episode-detail-view.tsx`), mirroring the fullscreen `EpisodeInfoPanel`. Only sections with content get a tab; the **Boosts** tab lazy-mounts `<EpisodeNostrFeed>` (no relay fetch until opened) inside a `min-h-[70vh]` so its short loading frame can't collapse the page and yank the scroll.

**Floating BOOST FAB.** A `fixed right-4 z-40 rounded-full` `⚡ BOOST`, shown when `hasValue`. **Hidden while the now-playing bar is up** (`hasValue && !playerVisible`) — the mini-player carries its own BOOST and the FAB (`z-40`) would just overlap the bar (`z-30`); boosting the viewed episode stays reachable via the inline `SHARE · SUPPORT · BOOST` cluster. Since it only renders with the bar hidden, its `bottom` is a fixed `calc(1.5rem + env(safe-area-inset-bottom))`.


## Theme system (light + dark)

**Tokens are role-based, not literal.** `ink` means "page bg", `bone` means "primary fg" — their *values* swap between modes, not their names. Tailwind reads each as `rgb(var(--token) / <alpha-value>)`; the values are CSS variables defined twice in `app/globals.css`:

- `:root` — dark default. `--ink: 10 10 8`, `--bone: 253 250 243`, `--bolt: 250 229 0`, `--nostr: 255 45 146`, `--muted: 138 133 122`, `--line: 31 29 24`, `color-scheme: dark`.
- `:root[data-theme='light']` — values flip: `--ink: 253 250 243`, `--bone: 10 10 8`. Brand colors deepen because the brand yellow/magenta on bone is invisible: `--bolt: 224 168 0` (vibrant amber-gold; the earlier `191 138 0` read as muddy mustard), `--nostr: 197 20 117`, `--muted: 110 105 95`, `--line: 225 220 207`, `color-scheme: light`.

So `bg-ink`, `text-bone`, `border-bone/40`, `bg-ink/75`, `bg-ink/90` all work in both modes with no per-component class changes.

**Single-token tradeoff for `bolt`.** `text-bolt` has ~30 callsites; `bg-bolt` is only `.btn-bolt` plus a couple of `bg-bolt/10` tints. One token serves both roles — light-mode `--bolt` is a vivid mid-amber recognizable as Lightning-yellow on the button AND visible as text on bone. Don't split it unless you're prepared to refactor every callsite.

**FOUC blocker** lives inline in `<head>` in `app/layout.tsx` — reads `bmb:theme` synchronously and sets `data-theme="light"` before paint, with `<html suppressHydrationWarning>`. **Don't move it to a `useEffect`** or light-mode users get a dark flash on every navigation.

**Toggle** is `components/theme-toggle.tsx`, slotted in the header. Only `'light'` is ever written (absent = dark). On toggle it also updates `<meta name="theme-color">` so iOS Safari's status-bar tint follows. `subscribeTheme()` exists (parallel to `subscribeNwc`/`subscribeSpark`) but is currently unused.

Don't introduce a token whose name implies a fixed color (avoid `dark-gray`); follow the role pattern.


