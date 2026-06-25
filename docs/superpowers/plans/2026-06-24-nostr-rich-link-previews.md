# Rich Nostr Link Previews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make shared BoostMeBitch links unfurl on Nostr with the real show/episode artwork, title, and description instead of the generic homepage card.

**Architecture:** `app/page.tsx` is currently a `'use client'` component, so it cannot export `generateMetadata` and every URL emits the static site card from `app/layout.tsx`. We split the page into a thin **server** shell (`app/page.tsx`) that exports `generateMetadata` and a **client** body (`components/home-page.tsx`) holding the existing UI verbatim. The new `generateMetadata` resolves the `?podcast=`/`?feed=`/`?episode=` query params server-side via existing `lib/pi.ts` helpers and emits per-show/episode Open Graph tags. No new route, no link changes — the SHARE button, boost-note deep link, and address-bar copies all already point at this route.

**Tech Stack:** Next.js 15.1.6 (App Router, `generateMetadata` with async `searchParams`), TypeScript (strict), existing `lib/pi.ts` (`getPodcastByGuid`, `getPodcast`, `getEpisodeByGuid`) and `lib/format.tsx` (`stripHtml`).

## Global Constraints

- **No test runner / no formatter.** Verification is `npm run typecheck` (`tsc --noEmit`, strict), `npm run lint` (ESLint flat config), `next build`, plus `curl | grep` against the dev server. Do NOT add a test framework.
- **Do NOT run `npm run build` while the dev server is running** — it clobbers `.next` chunks and breaks the running dev server. Stop the dev server first, or use a separate verification pass.
- **Server/client boundary:** `lib/pi.ts` is server-only (reads `process.env`, uses `node:crypto`). It may be imported by `app/page.tsx` (a server component) but NEVER by a `'use client'` file. `components/home-page.tsx` must keep `'use client'` and must NOT import `lib/pi.ts`.
- **Path alias:** `@/*` → repo root.
- **Image style:** raw Podcast Index artwork URL, as-is. No generated/branded OG image.
- **Resilience:** `generateMetadata` must never throw — any failure returns `{}` so the page inherits the static layout metadata. The feature can only add a better card, never regress.
- **Episode image fallback is `episode.image ?? podcast.image ?? podcast.artwork`** — `Episode` has no `artwork` field (corrects the spec's `episode.artwork` mention).

---

### Task 1: Split `app/page.tsx` into a server shell + client body

Pure mechanical refactor with no behavior change. This task ships independently: the app must build and run exactly as before, just with the home UI living in a new client component file.

**Files:**
- Create: `components/home-page.tsx` (the existing client UI, moved verbatim)
- Modify: `app/page.tsx` (becomes a server shell that renders `<HomePage />`)

**Interfaces:**
- Produces: `export function HomePage()` in `components/home-page.tsx` — the React component formerly named `Home` in `app/page.tsx`. Default-exported `Page()` in `app/page.tsx` renders it.

- [ ] **Step 1: Create `components/home-page.tsx` from the current `app/page.tsx`**

Copy the **entire current contents** of `app/page.tsx` into a new file `components/home-page.tsx`, with two edits:
1. Keep the `'use client';` directive as the first line.
2. Rename the component export from `export default function Home()` to `export function HomePage()` (named export, not default).

All `@/...` imports resolve unchanged from the new location. Do not change any logic, hooks, effects, or JSX.

- [ ] **Step 2: Replace `app/page.tsx` with a server shell**

Overwrite `app/page.tsx` with exactly:

```tsx
import { HomePage } from '@/components/home-page';

export default function Page() {
  return <HomePage />;
}
```

(No `'use client'` — this is now a server component. `generateMetadata` is added in Task 2.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (exit 0, no errors). If `HomePage` import/export names mismatch, fix them.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: PASS with no new errors.

- [ ] **Step 5: Verify the app still renders (dev server)**

Start the dev server (`npm run dev`), then in another shell:
Run: `curl -s http://localhost:3000/ | grep -i "Boost Me Bitch"`
Expected: matches the title/header text — confirms the page server-renders and the client body mounts. Manually load `http://localhost:3000/` in a browser and confirm search, favorites, and selecting a show still work exactly as before. Stop the dev server when done.

- [ ] **Step 6: Commit**

```bash
git add app/page.tsx components/home-page.tsx
git commit -m "refactor: split home into server shell + client HomePage body"
```

---

### Task 2: Add `generateMetadata` to `app/page.tsx`

Adds the actual feature: resolve the query params server-side and emit per-show/episode Open Graph tags.

**Files:**
- Modify: `app/page.tsx` (add `generateMetadata`)

**Interfaces:**
- Consumes: `getPodcastByGuid(guid: string): Promise<Podcast | null>`, `getPodcast(feedId: number): Promise<Podcast | null>`, `getEpisodeByGuid(feedGuid: string, itemGuid: string): Promise<Episode | null>` from `@/lib/pi`; `stripHtml(s: string): string` from `@/lib/format`; `Metadata` from `next`.
- Produces: `export async function generateMetadata({ searchParams })` in `app/page.tsx`.

- [ ] **Step 1: Implement `generateMetadata`**

Edit `app/page.tsx` to:

```tsx
import type { Metadata } from 'next';
import { HomePage } from '@/components/home-page';
import { getPodcastByGuid, getPodcast, getEpisodeByGuid } from '@/lib/pi';
import { stripHtml } from '@/lib/format';

// Trim show notes / descriptions to a card-sized blurb. stripHtml first so we
// never emit raw markup into og:description.
function ogDescription(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const text = stripHtml(raw).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > 200 ? text.slice(0, 197).trimEnd() + '…' : text;
}

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// Per-show / per-episode Open Graph tags so a shared ?podcast=&episode= link
// unfurls on Nostr with the real artwork + title instead of the static site
// card. Best-effort: any failure returns {} and the page inherits the static
// metadata from app/layout.tsx. Reading searchParams opts this route into
// dynamic rendering, which is fine — the page is already fully client-driven.
export async function generateMetadata(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
): Promise<Metadata> {
  try {
    const sp = await searchParams;
    const podcastGuid = firstParam(sp.podcast);
    const feedId = firstParam(sp.feed);
    const episodeGuid = firstParam(sp.episode);

    // Resolve the show: by podcast guid, else by feed id.
    let podcast = podcastGuid ? await getPodcastByGuid(podcastGuid) : null;
    if (!podcast && feedId && /^\d+$/.test(feedId)) {
      podcast = await getPodcast(Number(feedId));
    }
    if (!podcast) return {};

    // Episode-level card when ?episode= is present and we have the podcast guid
    // (PI's /episodes/byguid requires the podcast guid).
    let title = podcast.title;
    let description = ogDescription(podcast.description);
    let image = podcast.image ?? podcast.artwork;

    const guidForEpisode = podcast.podcastGuid ?? podcastGuid;
    if (episodeGuid && guidForEpisode) {
      const episode = await getEpisodeByGuid(guidForEpisode, episodeGuid);
      if (episode) {
        title = `${episode.title} — ${podcast.title}`;
        description = ogDescription(episode.description) ?? description;
        image = episode.image ?? podcast.image ?? podcast.artwork;
      }
    }

    const images = image ? [image] : undefined;
    return {
      title,
      description,
      openGraph: { title, description, images, type: 'website' },
      twitter: { card: 'summary_large_image', title, description, images },
    };
  } catch {
    return {};
  }
}

export default function Page() {
  return <HomePage />;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (exit 0). Fix any signature mismatches against the real `lib/pi.ts` exports if they surface.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS with no new errors.

- [ ] **Step 4: Verify episode-level card (dev server)**

Start `npm run dev`. Use a real show guid + episode guid (e.g. from the user's link: `podcast=56fbb1aa-da79-5e4b-bebc-3b934ab8914c&episode=d27b83bd-3450-4edd-9f7f-41acde2c1463`):

Run: `curl -s 'http://localhost:3000/?podcast=56fbb1aa-da79-5e4b-bebc-3b934ab8914c&episode=d27b83bd-3450-4edd-9f7f-41acde2c1463' | grep -iE 'property="og:(title|image|description)"|name="twitter:'`
Expected: `og:title` contains the episode title + " — " + show name; `og:image` is the episode/show artwork URL; `og:description` is a stripped, ≤200-char blurb. (Requires `PODCAST_INDEX_KEY`/`SECRET` in `.env.local`.)

- [ ] **Step 5: Verify show-level card and graceful fallback**

Run: `curl -s 'http://localhost:3000/?podcast=56fbb1aa-da79-5e4b-bebc-3b934ab8914c' | grep -iE 'property="og:(title|image)"'`
Expected: `og:title` = the show title (no " — "); `og:image` = show artwork.

Run: `curl -s 'http://localhost:3000/?podcast=not-a-real-guid' | grep -iE 'property="og:title"'`
Expected: falls back to the static site title ("Boost Me Bitch — Podcast Boost Station") — confirms the `{}`/empty-resolve path inherits layout metadata without erroring.

Run: `curl -s 'http://localhost:3000/' | grep -iE 'property="og:title"'`
Expected: static site title — the no-params path is unaffected. Stop the dev server when done.

- [ ] **Step 6: Production build sanity (dev server stopped)**

Ensure the dev server is stopped, then:
Run: `npm run build`
Expected: build succeeds; `/` is reported as dynamic (ƒ) rather than static (○) — expected because `generateMetadata` reads `searchParams`.

- [ ] **Step 7: Commit**

```bash
git add app/page.tsx
git commit -m "feat: per-show/episode Open Graph tags for rich Nostr link previews"
```

---

## Notes for the implementer

- **Why two tasks:** Task 1 is a risky verbatim move that must be provable in isolation (app still works); Task 2 layers the feature on top. A reviewer can accept/reject each independently.
- **Don't repoint any links.** `components/lists.tsx:ShareButton` and `lib/nostr/boost-notes.ts:bmbLandingUrl` already emit `/?podcast=<guid>` and benefit automatically. Touching them is out of scope.
- **`?publisher=` and `?discussion=1`** intentionally get no custom card — they inherit the static site card. Out of scope.
- **`og:url` is intentionally omitted** (the spec mentioned it). It isn't needed for a Nostr/OG card to unfurl — the client links to the URL that was actually posted — and setting it correctly would mean trusting the `Host` header to pick between `boostmebitch.com` / `boostmebitch.vercel.app`. Left out to keep the change minimal and robust; can be added later if a canonical-URL need arises.
- **Manual end-to-end (optional):** after deploy, paste a `?podcast=&episode=` URL into a Nostr client (or any OG debugger) and confirm the episode card renders. Not required for task completion — the curl checks cover the server-rendered tags.
