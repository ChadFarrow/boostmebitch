# Rich Nostr link previews via dynamic Open Graph metadata

**Date:** 2026-06-24
**Status:** Approved, pending implementation plan

## Problem

When a BoostMeBitch URL like
`https://www.boostmebitch.com/?podcast=<guid>&episode=<itemGuid>` is posted on
Nostr, the client unfurls it into a link-preview card built from the page's
Open Graph (OG) tags. Today that card is **always the generic homepage card**
("Boost Me Bitch — Podcast Boost Station" + the static hero image), regardless
of which show or episode the link points at.

Two causes:

1. **No per-route OG metadata.** The only OG block lives in `app/layout.tsx` as
   a static object — identical for every URL on the site.
2. **`app/page.tsx` is a `'use client'` component.** Client components cannot
   export `generateMetadata`, so the home route can never emit dynamic tags.
   Episode/show identity is resolved client-side from `?podcast=`/`?episode=`
   query params, which a crawler (it runs no JS) never sees.

Net effect: every shared link collapses to the same site card, making a specific
episode link look like "just the site, not a link."

## Goal

A shared link to a show or episode unfurls on Nostr (and any OG consumer:
iMessage, Twitter, Discord) with **that show's / episode's real artwork, title,
and description**.

Must cover all three link forms the user uses, all of which already point at the
same query-param URL:

- The `↗ SHARE` button (`components/lists.tsx:ShareButton`) → `/?podcast=<guid>`
- The boost-note "boost back on BMB" deep link
  (`lib/nostr/boost-notes.ts:bmbLandingUrl`) → `/?podcast=<guid>`
- A raw copy of the address-bar URL → `/?podcast=<guid>[&episode=<itemGuid>]`
  (and the `?feed=<id>` fallback form)

## Key insight

Because all three forms already resolve to the **home route** with query params,
we do **not** need a new route or any link changes. If the home route itself
emits per-podcast/episode OG tags, all three unfurl richly for free.

The only blocker is that `app/page.tsx` is a client component. Splitting it into
a thin server shell (which *can* export `generateMetadata`) + a client body
unblocks everything.

## Design

### 1. Split `app/page.tsx` into server shell + client body

- Move the existing `Home` component **verbatim** into a new
  `components/home-page.tsx`. Keep its `'use client'` directive and every hook,
  effect, and piece of logic unchanged — this is a pure cut-and-paste with no
  behavior change. Imports use the `@/` alias so they resolve unchanged.
- `app/page.tsx` becomes a **server component**:

  ```tsx
  import type { Metadata } from 'next';
  import { HomePage } from '@/components/home-page';

  export async function generateMetadata(
    { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
  ): Promise<Metadata> { /* see below */ }

  export default function Page() {
    return <HomePage />;
  }
  ```

### 2. `generateMetadata({ searchParams })`

- Await `searchParams` (Next 15 passes it as a Promise). Read `podcast`,
  `feed`, `episode` (coerce array values to their first element).
- Resolve server-side via existing `lib/pi.ts` helpers:
  - `podcast=<guid>` → `getPodcastByGuid(guid)`; if absent, `feed=<id>` →
    `getPodcast(Number(id))`.
  - If a podcast resolved **and** `episode=<itemGuid>` is present →
    `getEpisodeByGuid(podcastGuid, itemGuid)` for episode-level fields. (PI's
    `/episodes/byguid` requires the podcast guid, which we have.)
- Build OG fields:
  - **Episode card** (episode resolved):
    - title: `"<episode.title> — <podcast.title>"`
    - description: `stripHtml(episode.description)` truncated to ~200 chars
    - image: `episode.image ?? episode.artwork ?? podcast.image ?? podcast.artwork`
  - **Show card** (only podcast resolved):
    - title: `podcast.title`
    - description: `stripHtml(podcast.description)` truncated to ~200 chars
    - image: `podcast.image ?? podcast.artwork`
  - Set both `openGraph` and `twitter` (`title`, `description`, `images`), and
    `openGraph.url` to the canonical request URL. PI artwork URLs are absolute,
    so they need no `metadataBase` resolution.
- **Image style:** raw PI artwork URL, as-is. No generated/branded image.

### 3. Resilience (load-bearing)

- Wrap the entire body in `try/catch`. On **any** failure — PI down, missing
  API key, unresolvable/garbage guid, or simply no relevant params — return
  `{}`. Next merges that with `app/layout.tsx`, so the page silently inherits
  the existing static site card. The feature can only *add* a better card; it
  can never break the page or regress the current behavior.
- Ensure a slow PI call cannot hang page render (PI helpers already use
  bounded fetches; confirm during implementation and add a guard if needed).

## Out of scope (YAGNI)

- No new route (e.g. `/p/[guid]/[episode]`); no URL-scheme change. The existing
  "Show-page URL contract (`?podcast=<guid>`)" in CLAUDE.md stays intact.
- No repointing of `ShareButton` or `bmbLandingUrl` — they already point at the
  query-param home and benefit automatically.
- No branded/generated OG image (`ImageResponse`). Raw artwork only.
- `?publisher=<feedUrl>` and `?discussion=1` views are **not** given custom
  cards; they inherit the default site card. Can be added later if wanted.

## Trade-offs

- Reading `searchParams` in `generateMetadata` opts the home route into
  **dynamic rendering** (no static prerender). Acceptable — the page is already
  fully client-driven and dynamic.
- A crawler hitting many distinct episode URLs triggers one PI lookup per URL.
  These are cheap and PI/Next-cached, and gated behind `try/catch`.

## Verification

This is about crawler-visible server-rendered HTML, so it can be verified
without posting to Nostr:

```bash
curl -s 'http://localhost:3000/?podcast=<guid>&episode=<itemGuid>' \
  | grep -iE 'og:(title|image|description)|twitter:'
```

Confirm:
- A `?podcast=&episode=` URL emits episode-level `og:title`/`og:image`.
- A `?podcast=` URL emits show-level tags.
- A bare `/` (and a garbage guid) emits the existing static site card.
- `npm run typecheck` and `npm run lint` pass; `next build` succeeds.
