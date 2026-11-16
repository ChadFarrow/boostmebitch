# DEMU: a search type for self-hosted music

**Date:** 2026-11-15

## Intent

Chad wants a search on the main site that returns only DeMu music. His words: *"DMU would be
anything that's self-hosted … on a user's own website or fountain.fm also counts … RSS Blue did
until they went away, and PodHome would also count. Basically anything that's not Wavelake."*
And: *"anything with a generator tag of Wavelake isn't on this list. So if it's a Wavelake
generator tag, but it's hosted somewhere else, then that still gets removed."*

**Why:** listeners request songs on **Homegrown Hits**, and the show plays only DeMu. Chad: *"in
the past what people have done, they've gone to LNBeats, click the DMU button, and then search for
whatever song they were going to request, and if it came back, then that means it was DMU. So
then they could send it to the show."* BMB takes over that check.

**Prior art:** LNBeats (`thebells1111/lnbeats`, Steven Bell). Its search bar had a **DeMu**
button that kept only `!v.generator.includes('Wavlake')` (`src/components/Discover/Discover.svelte:155`),
on the album results only. LNBeats is a music-only site, so its search page also showed every
album as a grid before anything was typed. BMB searches podcasts too, so Chad wants only the
selector: *"Boost Me Bitch already has a filter on the search box. So just adding one that just
says DMU would help. And then it would only return DMU items."* — *"I'm not interested in showing
the grid in search."*

It ships on the main site, not beta only. It goes to `main` as a PR (a draft first, once the lane
and the menu option work).

## The rule

A feed is **DeMu** when all three hold:

1. It is music: Podcast Index medium `music`.
2. Its `<generator>` does **not** contain `wavlake`, compared case-insensitively. The host does
   not matter.
3. Its URL is not on a closed host: `closedService(url)` (`lib/moved-feeds.ts`) is `null`. Today
   that removes RSS Blue, which answers `410 Gone` for every feed.

A blank generator passes rule 2. 190 DeMu feeds have none.

### Measured 2026-11-15 against Podcast Index

| What | Count |
|---|---|
| All music feeds (`/podcasts/bymedium?medium=music`) | 8,671 |
| Generator contains "Wavlake" | 7,371 |
| … of those, hosted somewhere other than `wavlake.com` (QA feeds on a `run.app` host) | 5 |
| On `wavlake.com` without a Wavlake generator | 0 |
| DeMu by rules 1–2 | 1,300 |
| … on `feeds.rssblue.com` (removed by rule 3) | 137 |
| DeMu by rules 1–3 | 1,163 (427 distinct artists, 15,409 tracks) |

**Reference set: Homegrown Hits** (PI feed 6611624, `https://feed.homegrownhits.xyz/feed.xml`).
Its feed names 631 distinct `<podcast:remoteItem feedGuid>` values; 575 are music feeds in Podcast
Index, and **574 pass rules 1–2**. The one that fails is *Katherines Wheel*
(`https://www.wavlake.com/feed/10b82d0f-f893-49c1-b1e2-55e97fe32465`, Wavlake generator); Chad's
rule excludes it. **101 of the 574 are on `feeds.rssblue.com`**, so rule 3 removes them and 473
pass all three. Those 101 are PI records of feeds that now answer `410`; an artist who moved shows
under the new feed once PI indexes it.

## Goals

- A **DEMU** entry in `SEARCH_TYPES` (`lib/util.ts`), so `<SearchTypeMenu>` shows it with no new
  control. A search under it returns only DeMu albums.
- Searching a DeMu artist's name or a DeMu album's title finds it.
- Works on both brands (`boostmebitch.com` and `boostmebuddy.com`); nothing in it is per-brand.

## Non-goals

- **No grid or browse list.** DEMU with an empty box behaves as every other type does today.
- **No song search in this PR.** Measured: for 30 random song titles from multi-track DeMu albums,
  Podcast Index search found the album 0 times (a cached roster of feed titles and artists also
  found it 0 times). PI has no episode-title search. A song search needs a stored index of the
  15,409 tracks and a job that keeps it current — a separate PR if Chad wants it. The 638 DeMu
  singles are found by their song title today, because the song is the album title.
- No DeMu badge or host icon on rows under other types.
- No playlists (`musicL`) and no music shows that declare `medium=podcast`.
- No list kept by hand, and no cached roster.

## Approaches

| | How | Trade-off |
|---|---|---|
| **A. Filter the music lanes (chosen)** | Run the two PI searches the MUSIC type runs, keep the DeMu rows | Small. Measured: found 60/60 random DeMu artists by name and 60/60 random DeMu albums by title. Short on broad words: for `bitcoin`, 54 of PI's 60 music rows are Wavlake |
| B. Roster only | Cache all DeMu feeds from `bymedium` (one 9.9 MB call), substring-match title and artist | Complete for broad words; no PI ranking; a 10 MB fetch and a cache |
| C. Both | A first, roster adds what A missed | The most code. Chad first chose C, when a browse grid was still in scope |

Claude's call, from Chad's direction that the method is open (*"whatever makes filtering the
search easy"*) and that the row limit is not a concern for how people search (*"they would kind of
just be searching to see if the artist was considered DMU or not"*). The browse grid was the one
need only a roster could meet, and it is out. If broad-word searches prove too short, the roster
from B can be added later as a second lane without changing the rule.

## How it works

**Server lane, `type=demu` in `/api/search`:**

1. In parallel: `searchMusicPodcasts(query, 50)` and `searchPodcasts(query, 50)` — the same two
   calls the MUSIC lane makes.
2. Every row must pass the DeMu rule. The generator test runs on PI's raw `generator` field, which
   every search row carries (verified on `/search/byterm` and `/search/music/byterm`).
   `buildPodcast` drops that field today, so either it carries `generator` through or the test runs
   before that mapping. byterm rows must also pass the music test; music/byterm rows are trusted as
   music, as in the MUSIC lane (`mergeSearchLanes`).
3. Order: music/byterm hits, then byterm hits, deduped by feed id, capped at `MAX_TYPED_HITS` (50).
4. `total` is byterm's unfiltered count, as for every typed lane, so a narrowed empty result reads
   *"No DeMu albums match X. N results across all types."* and offers ALL — never "no results".
5. The feed-URL branch is unchanged: a pasted URL ignores the selector, as it does today.

**Pinned by a check:** the rule, the `parseSearchType` allowlist entry and the lane's filter get
vectors in `check:musicl` (or a new `check:demu`), built from real PI rows: a Wavlake feed on
`wavlake.com`, a Wavlake-generator QA feed on `run.app`, *Katherines Wheel*, a Fountain feed, an
RSS Blue feed, a blank-generator feed. `naive()` is the host test `url.includes('wavlake.com')`,
which passes the QA feeds.

## Testing

- `npm run typecheck`, `lint`, `check`, `build`.
- Browser (headless Chrome over CDP, dev server): pick DEMU; search a DeMu artist (for example
  `Sakrecoer`), a DeMu album title, and a Homegrown Hits artist; confirm every row is DeMu and no
  row has a Wavlake generator. Search a Wavlake-only artist and confirm the empty-state wording.
  Paste a feed URL under DEMU and confirm the lookup still answers. Phone layout of the menu with CDP
  device emulation.

## Left to the builder

- Label `DEMU`, noun `DeMu albums`, placeholder *"search self-hosted music…"* — Claude's call.
- Where the rule function lives (`lib/util.ts` beside `matchesSearchType` is the default; it needs
  `closedService` from the import-free `lib/moved-feeds.ts`, so check the import rules for
  `lib/util.ts` first).
- Docs: the selector section of `docs/feeds.md`, and the `check:*` table in `CLAUDE.md` if a new
  script is added.
