# The /demu page: every self-hosted album, newest first

**Date:** 2026-11-15
**Builds on:** PR #580 (`feat/demu-search`) — the DEMU search type and `isDemuFeed` (`lib/demu.ts`).
Design of that PR: `docs/superpowers/specs/2026-11-15-demu-search-design.md`.

## Intent

Chad: *"let's just make a page. That's boostmebitch.com/demu. And when you go there, it's just a
search bar at the top, and then it just loads the recent demu albums and lists all of this."* Two
PRs: #580 is the search type, this is the page.

**Why:** listeners request songs on **Homegrown Hits**, which plays only DeMu (self-hosted, not
Wavlake). LNBeats used to be where they checked a song and found new DeMu music. The search type
answers "is this artist DeMu"; this page answers "what is new in DeMu" and lets a listener scan
everything.

**Order (Chad):** *"Top of the list should be just whatever's newest, whether that's a single, an
updated album, or a brand new album."* That is the date of a feed's newest track
(`newestItemPubdate`). Chad accepted, after being told twice, that daily radio and DJ-mix feeds with
`medium=music` (for example *Global Trance Podcast with Area55*) will often sit at the top.

**Layout (Chad, from the mockups, layout C):** *"I like C with the dates on it, especially for
mobile, because the list I think looks better, and it's nice knowing how old some of these tracks
are and when they were added. And I think grouping it weekly is a good idea."* Mockups:
https://claude.ai/artifact/CqjdBgZGCR6RXosN4SLySo (board C).

Chad approved the proposals below as a whole (*"Looks good"*), and chose approach A.

## Goals

- `/demu` on the main site (both brands), reachable from two entry points (below).
- A search bar at the top; below it, every DeMu album, newest first, in groups by time.
- Each row: cover, title, artist, track count (or "single"), the date of the newest track and its
  age (`Nov 14 · 1 day`), and the ♥ favorite button.
- The search filters this list by title and artist, instantly, and the groups stay. Because the list
  holds every DeMu album, a broad word (`bitcoin`) finds every match, which the DEMU search type
  (filtered PI search, 60-row limit) cannot.
- A tap on a row opens the album, and the album page offers "← back to DeMu".

## Non-goals

- No song (track) search: the list holds feeds, not tracks.
- No cover grid (layout B) and no desktop-only layout: one list that works at phone width first.
- No new nav tab: playlists are not a tab either ("content, not a destination", `home-page.tsx`).
- No list kept by hand, no database. Podcast Index is the only source.
- No change to the DEMU search type.

## Anti-goals (a failure even if it "works")

- **The page never says "no DeMu albums" when the list did not load.** A failed or cold read and an
  empty answer are different claims (the `couldNotAsk` / `CuratedHits.answered` rule the app already
  follows). Failure renders "Could not load the DeMu list" with a retry.
- **No Wavlake album ever appears.** Every row passes `isDemuFeed`, which fails closed on a row with
  no `generator` field.
- **The page never waits on Podcast Index for long.** A cold server waits a bounded time, then
  answers "not loaded yet" (`no-store`) rather than hanging the page.

## The data

Measured 2026-11-15 against Podcast Index:

- `/podcasts/bymedium?medium=music` answers **all 8,671 music feeds in one call**, ~1 s, ~9.9 MB.
  `max` is ignored. Every row carries `generator`, `newestItemPubdate`, `episodeCount`, `artwork`,
  `image`, `podcastGuid`, `url`, `author`, `title`, `id`, `dead`.
- 1,163 pass the DeMu rule (427 distinct artists; 638 are single-track feeds).
- The page needs only the fields of a row. Estimated ~350 KB of JSON for 1,163 rows, ~80 KB
  compressed — **not measured** (PI rate-limited the test machine); measure it during the build.

## Approaches (Chad chose A)

| | How | Trade-off |
|---|---|---|
| **A. One list sent to the phone (chosen)** | `/api/demu` holds the DeMu roster on the server (one `bymedium` call, cached 6 h) and sends the slim list; the page sorts, groups, filters and pages in the browser | Instant, complete search; reuses the playlist-roster pattern in `lib/pi.ts`. Cost: one ~80 KB download per visit |
| B. Pages from the server | `/api/demu?page=N`, search on the server | Smaller first load; every scroll and keystroke waits; groups split across page edges |
| C. Server-built page | ISR of `/demu` every 6 h | No API route; but `pi()` disables the Next.js data cache on purpose (auth headers change every second), so it needs a cache path unlike the rest of the app |

## How it works (decided)

### Server: the roster and `/api/demu`

- **Roster** in `lib/pi.ts`, modelled on the playlist roster (`playlistRoster`,
  `refreshPlaylistRoster`, `searchPlaylistFeeds`): one `/podcasts/bymedium?medium=music` call,
  rows kept only if `isDemuFeed(row, closedService)` passes, stored in a one-entry
  `createBoundedCache`, fresh 6 h, servable 24 h, refreshes deduped (one in flight).
  - `pi()`'s default byte cap is too small for 9.9 MB: pass a `maxBytes` for this call
    (the mechanism exists — see the comment at `lib/pi.ts:98`), with headroom for growth.
  - **Never cache a refresh that failed** (the `allSettled` rule the playlist roster follows): a
    failure keeps serving the last good roster.
  - The row projection keeps `generator` as PI sends it (`""` when blank), so `isDemuFeed` sees
    blank (pass) and absent (fail) as different things.
  - **Dead feeds are dropped** (`dead === 1`), for the reason closed hosts are: a listener who finds
    one cannot play or request it. `lib/moved-feeds.ts` already skips them the same way. *(Claude's
    call, from the builder check.)*
  - **One row per `podcastGuid`.** Podcast Index holds some albums twice under one guid (LNBeats
    kept a `dupes.json` of them); two rows would share one ♥. Keep the row with the newest
    `newestItemPubdate`, ties to the higher `id`. *(Claude's call.)*
  - The API count is therefore **below** the 1,163 measured for the search rule; measure it.
- **`/api/demu`** (`app/api/demu/route.ts`): `GET`, no parameters. Answers
  `{ albums: DemuAlbum[], answered: boolean, fetchedAt: number | null }`.
  - `DemuAlbum = { id, podcastGuid, title, author, image, artwork, url, medium, v4vHint, newestItemPubdate, episodeCount }`
    — what a row, the ♥ and `selectPodcast` need, nothing else (no description). **`medium` is
    required**: `<FavHeart>` writes `declaredMedium(podcast)` into the shared kind:10333 favorites
    event, so a row without it saves a favorite with no medium — public, and with no undo.
    `v4vHint` keeps the ⚡ V4V stamp consistent with the DEMU search results. *(Claude's call, from
    the builder check.)*
  - A cold roster is waited for up to a bound (2.5 s, as the curated roster), then the route answers
    `answered: false`, `albums: []`, `no-store`. A warm answer is cacheable at the CDN
    (`s-maxage` well under the 6 h roster window, with `stale-while-revalidate`).
  - Rate-limited like `/api/search` (`lib/rate-limit.ts`). PI 429/5xx map through
    `withErrorHandling` as everywhere else.

### Pure functions (pinned)

In the import-free `lib/demu.ts` (or a sibling import-free leaf), pinned by `check:demu`:

- `sortDemuAlbums(albums, now)`: `newestItemPubdate` descending; ties by `id` descending; a row with
  no `newestItemPubdate` goes last. **A future date sorts as `now`** (a scheduled or wrong date must
  not hold the top for weeks), and its age reads `upcoming`, never a negative age. *(Claude's call.)*
- `demuGroups(albums, now, tz)`: the group a row falls in, by the date of its newest track, in the
  **viewer's local time zone**:
  - **Weeks, Monday to Sunday, for the 8 most recent weeks**, counting this week: `THIS WEEK · NOV 9–15`,
    `LAST WEEK · NOV 2–8`, then `WEEK OF OCT 26`.
  - **Then months, for the 12 months before that**: `OCTOBER 2026`.
  - **Then years**: `2024`.
  - **A row with no date** goes in a last group, `NO DATE`. *(Claude's call.)*
  - An empty group is not rendered.
- `matchesDemuQuery(album, query)`: case-insensitive substring on title or author, trimmed.
- The row's date line: `Nov 14 · 1 day` (`today`, `1 day`, `N days`, then weeks/months/years —
  the builder picks the exact bands, consistent with any existing "ago" helper in the app).

### The page

- `app/demu/page.tsx` (metadata `DeMu — ${BRAND.displayName}`, same `<AppHeader>` +
  `max-w-7xl mx-auto px-4 pt-8` shell as `/playlists`) and `components/demu-page.tsx` (client).
- Heading `DeMu` and one line saying what it is ("Self-hosted music. Nothing from Wavlake."), then
  the search input, then the count (`1,163 DeMu albums` / `14 DeMu albums match “longy”`).
- Rows reuse the existing row component (`<PodcastResults>` / its row) per group, so the cover
  fallback, the ♥ and keyboard behaviour match the rest of the app. The date and age go on the row
  (the mockup puts them at the right; inside the row's `meta` line is acceptable if the component
  has no slot for a right-hand column).
- Paging: the existing progressive pager (`useRevealed`, `ShowMore`, `useAutoReveal` in
  `components/lists/grouping.tsx`) **as it is** — 12 rows a step, more as the listener scrolls. Not
  "about 100 first": the hook's page size is a bytes cap shared with `/favorites`, and its own note
  says a wish for infinite scroll is no reason to raise it. *(Claude's call, from the builder check;
  this replaces the "about 100 rows" Chad saw in the proposal.)*
- **Coming back keeps the listener's place.** The search words, the number of rows shown and the
  scroll position live in a module-level, NOT persisted, store (no new `bmb:*` key), and are restored
  when `/demu` mounts again — by "← back to DeMu" or the browser's back button. A reload starts
  fresh. *(Claude's call, from the builder check.)*
- Opening: the `/playlists` handoff (`components/playlists-page.tsx`, `openPlaylist`):
  `selectPodcast(p)`, then `setShowOrigin({ path: '/demu', label: 'DeMu' })`, then
  `router.push('/')`. Never `router.push('/?podcast=…')` (the comment there says why).
- States: loading; loaded; filtered with no match (*"No DeMu albums match “X”."*); not loaded
  (`answered: false` or a failed fetch: *"Could not load the DeMu list."* + retry). The last never
  reuses the no-match sentence.

### Entry points

- **`BROWSE DEMU`** beside `♫ BROWSE PLAYLISTS` on `/` (`components/home-page.tsx` ~line 746),
  same visibility condition, same `btn-ghost btn-compact` style.
- **"browse all DeMu →"** when the applied search type is `demu`, beside the result count line in
  `<HomePage>`. It opens `/demu` with the current search words already in the box (handed over
  through the same in-memory store), so the listener sees the full matching list. *(Claude's call.)* **Not below the search box**: `docs/ui.md` reserves the space under the input for the
  npub suggestion and the nsec warning ("nothing may be added down there").

## Constraints

- Main site, both brands; nothing per-brand. Ships to `main` as a PR after #580 (base it on
  `feat/demu-search` until #580 merges).
- `lib/util.ts` keeps only type-only imports; `lib/demu.ts` stays import-free.
- PI load: one ~10 MB `bymedium` call per 6 h per warm server instance, plus cold instances.
- Phone first: 390 px wide, no horizontal overflow, touch targets ≥ 24×24 CSS px (WCAG 2.5.8).
- Docs: `docs/feeds.md` (the roster and the route), `docs/ui.md` (the page and the two entry
  points), and the `CLAUDE.md` docs map for the new files if the 15,100-word budget allows (4 words
  spare after #580).

## Testing

- `check:demu`: vectors for `sortDemuAlbums` (incl. a future date and a missing date), `demuGroups`
  (week edges on Sunday/Monday midnight, the 8-week/12-month/year boundaries, a time zone where the
  day differs from UTC, the `NO DATE` group), the dead/duplicate-guid filter, and
  `matchesDemuQuery`, each against a `naive()`.
- Browser: a ♥ on `/demu` saves the favorite with `medium: music` (read the store, on a throwaway
  key per `docs/testing.md` — never a real account); back from an album restores the search words,
  the rows shown and the scroll position.
- API: `/api/demu` answers ~1,163 albums, none with a Wavlake generator, none on `rssblue.com`;
  measure the response size (raw and gzip).
- Browser (headless Chrome over CDP, dev server, live PI), desktop and phone (390×844,
  `mobile: true`): the page loads with week headings; `longy` filters to Longy's self-hosted albums
  and keeps headings; `bitcoin` finds more than the DEMU search type does; a tap opens the album and
  "← back to DeMu" returns; `BROWSE DEMU` on `/` and "browse all DeMu →" under a DEMU search both
  reach the page; a failed `/api/demu` shows "Could not load the DeMu list.", not "no albums".

## Left to the builder

- The exact age bands on the row date line.
- The CDN `s-maxage` for `/api/demu` (well under 6 h).
- Whether the date sits in a right-hand column or in the `meta` line (see The page).
- Names of helper functions and where the roster code sits inside `lib/pi.ts`.
