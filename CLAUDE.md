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

- **Server-only:** `lib/pi.ts` (uses `node:crypto`, reads `process.env`, hits Podcast Index). Imported only by `app/api/search/route.ts` and `app/api/feed/route.ts`. Never import it from anything in `components/` or from `app/page.tsx`.
- **Browser-only:** `lib/store.ts` (Zustand, `'use client'`), `lib/v4v/nwc.ts` / `webln.ts` / `lnaddr.ts`, `lib/nostr.ts` — they all touch `window.*` or `localStorage`. SSR guards exist (`typeof window === 'undefined'`) but assume client context.
- **Isomorphic:** `lib/types.ts` (pure types), `lib/v4v/boost.ts` (orchestration logic; pulled in by client code).

Components fetch via the local API routes (`fetch('/api/feed?id=…')`) — they never call Podcast Index directly.

## Boost flow invariants

`components/boost-modal.tsx` orchestrates the user flow; `lib/v4v/boost.ts` is the engine. A few rules are load-bearing:

1. **Lightning first, then Nostr.** `publishBoostNote` only fires after `sendBoost` returns *and* at least one recipient succeeded (`collected.some(r => r.ok)`). This prevents false "I boosted" notes when payments all fail. Don't reorder.
2. **Rail priority is NWC over WebLN.** `pickRail()` in `lib/v4v/boost.ts` returns `'nwc'` if a URI is saved, else `'webln'`, else `null`. The modal lets the user override but defaults to this.
3. **Episode value-block fallback happens server-side.** `app/api/feed/route.ts` does `e.value ?? podcast.value` before returning. Components assume `episode.value` is populated when the channel has one — don't re-implement the fallback in the modal.
4. **Splits use weights, not percentages.** `splitSats()` floors per-recipient, then dumps the remainder onto the first non-fee recipient. `ValueRecipient.split` is a weight; total weight is the denominator.
5. **TLV records:** boostagram JSON goes in record `7629169` (Podcasting 2.0 standard); sender pubkey goes in `696969` for clients that read it. Both are constants in `lib/v4v/boost.ts`. Keep the JSON shape compatible with Helipad / Fountain / BoostBot ingestion (see README).

## Nostr publish shape

`publishBoostNote()` in `lib/nostr.ts` builds a kind:1 with NIP-73 tags (`i`/`k` pairs for `podcast:guid:…` and `podcast:item:guid:…`), an `r` tag for the feed URL, an `amount` tag in millisats, and `t` tags `boostagram` + `value4value`. The `client` tag uses `boostagram.app_name` (defaults to `BoostMeBitch`). If you change tags, double-check NIP-73 and the boost-aggregator contract — Helipad-style ingestion depends on the existing shape.

The auto-formatted note body lives in `formatContent()` in the same file. Override per call with `contentOverride`.

## v4v-toolkit swap-out boundary

`lib/v4v/*` and `lib/nostr.ts` are intentionally the only files that talk to wallets / signers. Components import only from these three entry points: `lib/v4v/boost.ts` (orchestrator), `lib/v4v/nwc.ts` (URI persistence helpers), `lib/nostr.ts` (auth + publish). When swapping in `v4v-toolkit`, replace internals here without touching `components/` or `app/`.

## State + persistence

Zustand store (`lib/store.ts`) holds: `identity`, `current` (episode + podcast), `isPlaying`, `positionSec`. No persistence — state is in-memory only.

Everything else lives in `localStorage` on the device and is never sent server-side:

- `bmb:nwc_uri` — NWC URI (`saveNwcUri`/`loadNwcUri` in `lib/v4v/nwc.ts`)
- `bmb:relays` — JSON array of relay URLs; falls back to `DEFAULT_RELAYS` (`lib/nostr.ts`)
- `bmb:sender_name` — last "From" name typed into the boost modal
- `bmb:npub` — sentinel for silent re-login on page load (`components/nostr-auth.tsx`)

If you add another persisted field, follow the `bmb:*` prefix.

## Styling tokens

Tailwind config (`tailwind.config.ts`) defines a small custom palette used everywhere — don't introduce new colors without adding them here:

- `ink` (background), `bone` (foreground), `bolt` (Lightning yellow), `nostr` (magenta), `muted` (secondary text), `line` (subtle borders).
- Fonts: `font-display` (Bricolage Grotesque), `font-mono` (JetBrains Mono).
- Animation: `animate-bolt` is a 1.4s opacity pulse used on the hero.

Reusable element classes (`.card`, `.btn`, `.btn-bolt`, `.btn-ghost`, `.input`, `.stamp`, `.headline`, `.seek`) are defined in `app/globals.css`. Read that file before inventing new ones.

## Conventions worth keeping

- `<img>` over `next/image` for podcast artwork — `next.config.mjs` already allows all HTTPS hosts, but the README documents the choice as intentional (avoiding per-host config). Don't migrate.
- Native HTML5 `<audio>` plays the enclosure URL directly — no proxy, no transcoding.
- API routes return `{ error }` JSON with appropriate status codes; clients tend to swallow errors silently (e.g. `lists.tsx` just `.finally(() => setLoading(false))`). When adding new routes, match the shape so a future error UI can render uniformly.
