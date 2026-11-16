# DEMU: a search type for self-hosted music

**Date:** 2026-11-15

## Intent

Chad wants a search on the main site that returns only DeMu music. His words: *"DMU would be
anything that's self-hosted … on a user's own website or fountain.fm also counts … RSS Blue did
until they went away, and PodHome would also count. Basically anything that's not Wavelake."*
And: *"anything with a generator tag of Wavelake isn't on this list. So if it's a Wavelake
generator tag, but it's hosted somewhere else, then that still gets removed."*

Prior art he named: LNBeats (`thebells1111/lnbeats`). Its search bar had a **DeMu** button that
narrowed the album list to `!v.generator.includes('Wavlake')`
(`src/components/Discover/Discover.svelte:155`). For BMB he chose the existing type menu instead
of a separate button: *"Boost Me Bitch already has a filter on the search box. So just adding one
that just says DMU would help. And then it would only return DMU items."*

It ships on the main site, not beta only. It goes to `main` as a PR (a draft first, once the lane
and the menu option work).

## The rule

A feed is **DeMu** when all three hold:

1. It is music: Podcast Index medium `music` (the same test `matchesSearchType(p, 'music')` uses).
2. Its `<generator>` does **not** contain `wavlake`, compared case-insensitively. The host does
   not matter.
3. Its URL is not on a closed host: `closedService(url)` (`lib/moved-feeds.ts`) is `null`. Today
   that removes RSS Blue, which answers `410 Gone` for every feed.

A blank generator passes rule 2. 190 DeMu feeds have none.

### Measured 2026-11-15 against Podcast Index

| What | Count |
|---|---|
| `/podcasts/bymedium?medium=music` — all music feeds, one call, ~1 s, 9.9 MB | 8,671 |
| Generator contains "Wavlake" | 7,371 |
| … of those, hosted somewhere other than `wavlake.com` (QA feeds on a `run.app` host) | 5 |
| On `wavlake.com` without a Wavlake generator | 0 |
| DeMu by rules 1–2 | 1,300 |
| … on `feeds.rssblue.com` (removed by rule 3) | 137 |
| DeMu by rules 1–3 | 1,163 |

`/search/music/byterm` caps at 60 rows, and Wavlake fills most of them: for `bitcoin` 54 of 60,
for `love` 45 of 60. A filter over those rows alone leaves a handful and cannot reach a DeMu album
ranked below 60.

**Reference set: Homegrown Hits** (PI feed 6611624, `https://feed.homegrownhits.xyz/feed.xml`).
Chad: the show plays only DeMu. Its feed names 631 distinct `<podcast:remoteItem feedGuid>`
values; 575 are in the music roster, and **574 of them pass rules 1–2**. The one that fails is
*Katherines Wheel* (`https://www.wavlake.com/feed/10b82d0f-f893-49c1-b1e2-55e97fe32465`, Wavlake
generator) — Chad's rule excludes it, and this design follows the rule. **101 of the 574 are on
`feeds.rssblue.com`**, so rule 3 removes them and **473 pass all three**. Those 101 are Podcast
Index records of feeds that now answer `410`; an artist who moved to a new host shows under the
new feed once PI indexes it.

## Goals

- A **DEMU** entry in `SEARCH_TYPES` (`lib/util.ts`), so `<SearchTypeMenu>` shows it with no new
  control. A search under it returns only DeMu albums.
- Results are complete: a DeMu album PI ranks below row 60 is still found.
- New music shows at once when PI's search has it, and within 6 hours through the roster.
- Works on both brands (`boostmebitch.com` and `boostmebuddy.com`); nothing in it is per-brand.

## Non-goals

- No song (single-track) search. LNBeats applied DeMu to albums only, and so does this.
- No DeMu badge or host icon on rows under other types.
- No playlists (`musicL`) and no music shows that declare `medium=podcast`.
- No list kept by hand. The roster comes from Podcast Index only.

## Approaches

| | How | Trade-off |
|---|---|---|
| A. Filter only | Run the MUSIC lanes, drop Wavlake-generator rows | Smallest; misses everything past PI's 60 rows |
| B. Roster only | Cache the DeMu roster from `bymedium`, substring-match title and author | Complete; no PI ranking, no description match, new feeds wait up to 6 h |
| **C. Both (chosen)** | Filtered PI lanes first, roster adds what they missed | Ranked and complete; the most code, but it is the shape PLAYLISTS already has |

Chad left the method to Claude (*"whatever makes filtering the search easy"*). C is Claude's call:
the type menu's rule in `docs/feeds.md` is that each option runs its own server lane, and a plain
row filter is named there as the bug.

## How it works

**Server lane, `type=demu` in `/api/search`:**

1. In parallel: `searchMusicPodcasts(query, 50)`, `searchPodcasts(query, 50)`, and the DeMu roster
   search.
2. PI rows pass the rule. The generator test runs on PI's raw `generator` field, which every
   search row carries (verified on `/search/byterm` and `/search/music/byterm`); `buildPodcast`
   drops it today, so the test runs before that mapping or the field is carried through.
   byterm rows must also pass the music test; music/byterm rows are trusted as music, as in the
   MUSIC lane.
3. Order: music/byterm hits, then byterm hits, then roster hits not already listed (dedupe by
   feed id). Cap 50 (`MAX_TYPED_HITS`).
4. `total` is byterm's unfiltered count, as for every typed lane, so the empty state reads
   *"No DeMu albums match X. N results across all types."*

**The DeMu roster**, modelled on the playlist roster in `lib/pi.ts`:

- One `getFeedsByMedium('music', …)` call, filtered by the rule, cached in a one-entry
  `createBoundedCache`. Fresh 6 h, servable 24 h.
- `pi()` needs a raised `maxBytes` for this one call (9.9 MB today, growing).
- Never cache a refresh that failed (the `allSettled` rule the playlist roster follows).
- A cold roster is waited for briefly, then the search goes without it and answers `no-store`
  (`CuratedHits.answered` pattern), so a CDN does not keep a short answer.
- Matching: case-insensitive substring over title and author, as `filterPlaylistsByQuery` does.
  Store only the fields a result row needs, so the cached roster stays small.

**Pinned by a check:** the rule, the type's allowlist entry and the lane merge get vectors in
`check:musicl` (or a new `check:demu`), built from real PI rows: a Wavlake feed on `wavlake.com`,
a Wavlake-generator QA feed on `run.app`, *Katherines Wheel*, a Fountain feed, an RSS Blue feed, a
blank-generator feed. `naive()` is the host test `url.includes('wavlake.com')`, which passes the
QA feeds.

## Testing

- `npm run typecheck`, `lint`, `check`, `build`.
- Browser (headless Chrome over CDP, dev server): pick DEMU, search `bitcoin`, `love`, and a DeMu
  album title PI ranks below 60; confirm no row has a Wavlake generator and the deep album shows.
  Search a Wavlake-only title and confirm the empty state wording. Phone layout of the menu with
  CDP device emulation.
- Homegrown Hits: a one-off script confirms that 574 of its 575 music feeds pass rules 1–2, and
  that rule 3 removes only the 101 on `feeds.rssblue.com`.

## Left to the builder

- Label `DEMU`, noun `DeMu albums`, placeholder *"search self-hosted music…"* — Claude's call.
- Whether the roster cold wait is 1.5 s or 2.5 s (the two existing rosters use these).
- Where the rule function lives (`lib/util.ts` beside `matchesSearchType` is the default).
- Docs: the selector section of `docs/feeds.md`, and the `check:*` table in `CLAUDE.md` if a new
  script is added.
