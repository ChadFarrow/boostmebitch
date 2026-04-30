# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Names

- **`boostmebitch`** — repo, working directory, npm package name, and `APP_NAME` default for the Podcast Index `User-Agent`.
- **"Boost Me Bitch"** — display name in the page header and `<title>`.
- **`BoostMeBitch`** — `app_name` in the boostagram TLV JSON and `client` tag on published Nostr notes (CamelCase, no spaces — matches Helipad-aggregator convention used by Fountain, StableKraft, etc.).

The README at the repo root describes the architecture in detail; treat it as the spec.

## Commands

```bash
npm install
cp .env.example .env.local       # then fill in PI key + secret
npm run dev                       # next dev
npm run build                     # next build
npm run start                     # next start (prod)
npm run lint                      # next lint — only checker in the repo
```

There is **no test runner, no typecheck script, and no formatter configured.** `next build` is the de facto typecheck (strict mode is on in `tsconfig.json`).

Path alias: `@/*` maps to the repo root (`tsconfig.json` `baseUrl: "."`). Imports look like `@/lib/types`, `@/components/player`.

## Server vs client boundary (don't cross it)

The Podcast Index credentials (`PODCAST_INDEX_KEY` / `PODCAST_INDEX_SECRET`) must never reach the browser. Enforced by file conventions, not bundler config:

- **Server-only:** `lib/pi.ts` (uses `node:crypto`, reads `process.env`, hits Podcast Index). Imported only by `app/api/search/route.ts` and `app/api/feed/route.ts`. Never import it from anything in `components/` or from `app/page.tsx`. The BoostBox proxy at `app/api/lightning/boostbox/route.ts` follows the same pattern — it reads `BOOSTBOX_URL` / `BOOSTBOX_API_KEY` and forwards to the upstream service so the API key never reaches the browser.
- **Browser-only:** `lib/store.ts` (Zustand, `'use client'`), `lib/v4v/nwc.ts` / `webln.ts` / `lnaddr.ts`, `lib/nostr/`, `lib/storage.ts` — they all touch `window.*` or `localStorage`. SSR guards exist (`typeof window === 'undefined'`) but assume client context.
- **Isomorphic:** `lib/types.ts` (pure types), `lib/v4v/boost.ts` (orchestration logic; pulled in by client code).

Components fetch via the local API routes (`fetch('/api/feed?id=…')`) — they never call Podcast Index directly.

## Nostr identity enrichment

`loginWithExtension()` only returns `{ pubkey, npub }` from NIP-07. After login, `components/nostr-auth.tsx:loadProfile` runs in the background and merges three more pieces onto the identity:

- **Profile metadata (kind:0):** `name`, `display_name`, `picture`, `nip05`, `about` — used to render the avatar + display name in the header. Also auto-fills the boost modal's "From" field.
- **NIP-65 relay list (kind:10002):** `writeRelays` is the union of unmarked entries and entries marked `write`. Used as the publish target for boost notes and favorites events when present.
- **NIP-51 favorites (kind:30003 with `d:boostmebitch:favorites`):** the user's saved-podcast set. See "Favorites" below.

All three queries run against `DEFAULT_RELAYS`. If a user has none of those events on those relays, we fall back to the npub-only header, default publish set, and empty favorites respectively. We do NOT fetch contacts (kind:3), DMs, reactions, or anything else — the only NIP-07 permissions ever requested are `getPublicKey` (login) and `signEvent` (each boost or favorites mutation).

`resolvePublishRelays(identity)` in `lib/nostr/` is the single source of truth for "which relays do we publish to": localStorage `bmb:relays` override → identity NIP-65 write relays → `DEFAULT_RELAYS`. Capped at 20 to keep publish latency bounded.

## Favorites (NIP-51 kind:30003)

Logged-in users can ♡ a podcast row to favorite it. Storage is split:

- **Authoritative:** a NIP-51 kind:30003 event, `d`-tag `boostmebitch:favorites`, with one `i: podcast:guid:<guid>` + `k: podcast:guid` per favorite. Published to the user's NIP-65 write relays.
- **Cache:** localStorage `bmb:favorites:<npub>` (or `bmb:favorites:guest` when not signed in) holds the full `FavoritePodcast[]` so the left "Favorites" panel renders instantly without re-resolving GUIDs.

Toggle UX: each click is optimistic and updates Zustand + localStorage immediately. Publishing to Nostr is **debounced 1.5 s** via `schedulePublishFavorites` so rapid hearting collapses into a single signing prompt.

Hydration on login (in `loadProfile`):
1. Fetch the user's kind:30003 event.
2. Compare `event.created_at` (s) vs the newest `addedAt` (ms) in the local cache.
3. If Nostr is newer or local is empty, adopt the Nostr guid set; resolve unknown guids via `/api/by-guid` (which proxies Podcast Index `/podcasts/byguid`).
4. If local is newer, push it back up to Nostr (debounced).

Sign-out clears the in-memory favorites; the per-npub localStorage cache is left in place so re-signing in is fast.

What this code deliberately doesn't do: episode-level favorites, multiple lists/categories, or any "share this list" UI. The kind:30003 is publicly readable to anyone with the user's pubkey + relay set.

## Show-level boost

`BoostModal` now accepts `episode` as optional. When omitted (`isShowBoost = !episode`), the modal:

- Headlines the podcast title and skips the playback-timestamp line.
- Reads the value block from `podcast.value` instead of `episode.value`.
- Builds a boostagram with `podcast`, `feedID`, `url`, `remote_feed_guid`, but skips `episode`, `itemID`, `episode_guid`, `remote_item_guid`. `ts: 0`.
- The Nostr boost note's auto-formatted body skips the `📻 <episode>` line and the `podcast:item:guid:` `i`-tag.

The "⚡ BOOST" button at the top-right of `EpisodeList`'s header opens the modal in this mode (gated on `podcast.value.recipients.length > 0`). The per-episode boost path in `Player` is unchanged.

## Boost flow invariants

`components/boost-modal/index.tsx` orchestrates the user flow (state + `go()`), with render-only slice components in the same folder; `lib/v4v/boost.ts` is the engine. A few rules are load-bearing:

1. **Lightning first, then Nostr.** `publishBoostNote` only fires after `sendBoost` returns *and* at least one recipient succeeded (`collected.some(r => r.ok)`). This prevents false "I boosted" notes when payments all fail. Don't reorder.
2. **Rail priority is NWC over WebLN.** `pickRail()` in `lib/v4v/boost.ts` returns `'nwc'` if a URI is saved, else `'webln'`, else `null`. The modal lets the user override but defaults to this.
3. **Episode value-block fallback happens server-side.** `app/api/feed/route.ts` does `e.value ?? podcast.value` before returning. Components assume `episode.value` is populated when the channel has one — don't re-implement the fallback in the modal.
4. **Splits use weights, not percentages.** `splitSats()` floors per-recipient, then dumps the remainder onto the first non-fee recipient. `ValueRecipient.split` is a weight; total weight is the denominator.
5. **TLV records:** boostagram JSON goes in record `7629169` (Podcasting 2.0 standard) — that's the only TLV we add for boost metadata. The `sender_id` field already lives inside the JSON; we deliberately do **not** also emit a separate `696969` sender record because that key collides with shared-node sub-account routing (e.g. getalby.com uses `customKey=696969 customValue=<sub-account>`). Per-recipient `customKey`/`customValue` from the value block IS attached to the keysend so payments to shared nodes route to the right sub-account. Keep the JSON shape compatible with Helipad / Fountain / Castamatic ingestion.
6. **WebLN customRecords are plain JSON, not hex.** WebLN providers (Alby, Mutiny) hex-encode `customRecords` values internally before putting them on the wire. Pre-hexing here causes double-encoding and Helipad can't `JSON.parse` the boostagram. NWC's `pay_keysend` is the opposite — NIP-47 spec requires hex-encoded TLV values. See `tlvHexFor` (NWC) vs `recordsForKeysend` (WebLN) in `lib/v4v/boost.ts` — they look symmetric but the wire formats are genuinely different.
7. **Note amount is intent, not actual.** `formatContent` and the `amount` tag use `boostagram.value_msat_total` (what the user clicked Send on), not the sum of successful legs. A user who boosts 100 sats and has one leg fail still posts "Boosted 100 sats" — the partial breakdown is visible in the modal and Helipad.
8. **BoostBox is LNURL-only.** `lib/v4v/boostbox.ts` POSTs the metadata via the `/api/lightning/boostbox` proxy *before* `fetchLnInvoice`, then puts the returned `desc` (`rss::payment::boost <url>`) in the LUD-21 `comment` field. Keysend recipients are untouched — TLV `7629169` already carries the boostagram inline. Failure of the BoostBox call is non-fatal; the LNURL leg falls back to `boostagram.message` as the comment so the payment still goes through.

## Nostr publish shape

`publishBoostNote()` in `lib/nostr/boost-notes.ts` builds a kind:1 with:

- NIP-73 `i`/`k` tag pairs for `podcast:guid:<feed-guid>` and (when an episode is in scope) `podcast:item:guid:<item-guid>`.
- `r` tag pointing at the **best public landing page** via `podcastLandingUrl`: prefers `https://pod.link/<itunesId>` (smart deep-link that auto-routes to the user's podcast app), falls back to `https://podcastindex.org/podcast/<feedId>`, then the raw RSS feed URL.
- `amount` tag in millisats — uses `boostagram.value_msat_total` (intent), not the sum of successful legs.
- `client` tag — `boostagram.app_name`, defaults to `BoostMeBitch`.
- `t` tags `boostagram` + `value4value`.

Publish target is `resolvePublishRelays(identity)`: localStorage `bmb:relays` override → identity NIP-65 write relays → `DEFAULT_RELAYS`. Kept to a max of 20 relays.

The auto-formatted note body lives in `formatContent()` in the same file (override per call with `contentOverride`):

```
⚡ Boost ⚡

[boostagram message, if present]

Boosted N sats → [podcast title]
📻 [episode title, omitted on show-level boosts]

[pod.link or PI URL]
```

Same `signAndPublish` helper handles both kind:1 boost notes and kind:30003 favorites, so a third event kind would be ~10 lines.

## v4v-toolkit swap-out boundary

`lib/v4v/*` and `lib/nostr/` are intentionally the only files that talk to wallets / signers. Components import only from these three entry points: `lib/v4v/boost.ts` (orchestrator), `lib/v4v/nwc.ts` (URI persistence helpers), `lib/nostr/` barrel (auth + publish). When swapping in `v4v-toolkit`, replace internals here without touching `components/` or `app/`.

## Background art and the canvas-bg gotcha

`app/layout.tsx` renders the hero collage (`public/hero.jpg`) as a fixed full-viewport layer behind everything, with a 75% ink overlay and `<Image fill priority />` so it gets AVIF/WebP optimization. The `<html>` element carries `bg-ink` (NOT `<body>`); this matters because a `body` background propagates to the canvas and would paint over the fixed image layer regardless of z-index. If someone moves `bg-ink` back onto `<body>` the art will silently disappear. Same `hero.jpg` doubles as the OG image via `metadata.openGraph.images`.

## State + persistence

Zustand store (`lib/store.ts`) holds: `identity`, `current` (episode + podcast), `isPlaying`, `positionSec`. No persistence — state is in-memory only.

Everything else lives in `localStorage` on the device and is never sent server-side. **All `bmb:*` keys are accessed through typed helpers in `lib/storage.ts`** — don't call `localStorage.getItem`/`setItem` directly anywhere else.

- `bmb:nwc_uri` — NWC URI (`storage.nwcUri`); `lib/v4v/nwc.ts` re-exports save/load/clear/has wrappers.
- `bmb:relays` — JSON array, manual publish-relay override (`storage.relays`); when absent, `resolvePublishRelays` falls back to NIP-65 then `DEFAULT_RELAYS`.
- `bmb:sender_name` — last "From" name typed into the boost modal (`storage.senderName`).
- `bmb:npub` — sentinel for silent re-login on page load (`storage.npub`).
- `bmb:favorites:<npub>` / `bmb:favorites:guest` — per-identity favorites cache (`storage.favorites.get(npub) / .set(npub, …)`).
- `bmb:boosts:<npub>` / `bmb:boosts:guest` — local log of sent boosts (`storage.boosts`), capped at 200 newest-first. Each entry holds the boostagram intent + per-leg results, with the BoostBox URL on each LNURL leg and the published Nostr `noteId` patched in once `publishBoostNote` resolves. The Zustand `boostsTick` (`bumpBoosts()`) wakes up subscribers — `GlobalNostrFeed` mixes these into the relay-discovered notes and dedupes any whose `noteId` matches a returned note.

If you add another persisted field, add a typed accessor to `lib/storage.ts` and follow the `bmb:*` prefix.

## Styling tokens

Tailwind config (`tailwind.config.ts`) defines a small custom palette used everywhere — don't introduce new colors without adding them here:

- `ink` (background), `bone` (foreground), `bolt` (Lightning yellow), `nostr` (magenta), `muted` (secondary text), `line` (subtle borders).
- Fonts: `font-display` (Bricolage Grotesque), `font-mono` (JetBrains Mono).
- Animation: `animate-bolt` is a 1.4s opacity pulse used on the hero.

Reusable element classes (`.card`, `.btn`, `.btn-bolt`, `.btn-ghost`, `.input`, `.stamp`, `.headline`, `.seek`) are defined in `app/globals.css`. Read that file before inventing new ones.

## Conventions worth keeping

- `<img>` over `next/image` for podcast artwork — `next.config.mjs` already allows all HTTPS hosts, but the README documents the choice as intentional (avoiding per-host config). The hero/OG art at `public/hero.jpg` IS served via `next/image` because it's a known local asset and we want AVIF/WebP for LCP.
- Native HTML5 `<audio>` plays the enclosure URL directly — no proxy, no transcoding.
- API routes return `{ error }` JSON with appropriate status codes via `getErrorMessage(e, fallback)` from `lib/util.ts`; clients swallow errors silently. When adding new routes, match the shape so a future error UI can render uniformly.
- Inline SVG icons (`components/icons.tsx:BoltIcon`) on yellow buttons instead of `⚡` emoji — the colored emoji is invisible on `bg-bolt`. Use the icon component, not the emoji, for any new bolt-yellow button. Other places (yellow text on dark bg, V4V stamps) keep the emoji because the colored glyph reads fine.
