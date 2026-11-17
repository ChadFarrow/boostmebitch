# Boost note wording: say what was boosted, then where it was found

**Date:** 2026-11-16

## Intent

Chad sent a screenshot of rev.hodl's boost note `b1d67bdd…` (2026-11-16) and wrote: *"the info
here for the track and playlist thats being boosted is a little confusing and hard to know whats
happening"*. The note read:

```
rev.hodl boosted 121 sats → ITDV music playlist
📻 Sing For You
```

The sats went to "Sing For You" by The Doerfels, from "Disco Swag - The Album". The playlist
received nothing. His proposed wording: *"rev.hodl boosted 121 sats to Sing For You from the ITDV
music playlist"*. He added that the wording of these notes never had much work, *"so this might
just be a general issue also"*. He chose approach B below.

What the screenshot shows wrong, measured on the published event and on production:

| Surface | Shows | Fact |
|---|---|---|
| Body | `→ ITDV music playlist`, then `📻 Sing For You` | The arrow names the container, which was not paid |
| `i` tags | `podcast:guid:88b0640a…` (the playlist) with `podcast:item:guid:12711f57…` | That item lives in feed `b2a87a4c…` (the album). The boostagram's `remote_feed_guid` and the quoted 9735 summary already name the album; only the note pairs the item with the wrong feed |
| Our card | "ITDV music playlist" and the playlist art only | `useNoteMeta` asks `/api/episode-by-guid` for the item under the playlist guid: 404 |
| Banner (`/api/og/boost.png`) | "ITDV music playlist" large, "Sing For You" small | Same inversion, in every other client |
| Banner art | `art3` is the playlist's cover | The container's art offered for an item of another feed |

The body, the tags and the banner art all present the container as the parent of a track it
only lists — the rule CLAUDE.md states as *"A container feed is not always the parent of the
items it lists"*.

## Approaches

| | Scope | Trade-off |
|---|---|---|
| A | The playlist row only: Chad's sentence, the item's own feed in the tags, the banner | Fixes the screenshot; leaves the same `→ <show>` inversion on every episode note |
| **B (chosen)** | One sentence pattern for every boost note: `boosted N sats to <what> from <where>`. Includes A | One function writes every sentence, so the cost over A is small; Chad called the problem general |
| C | B, plus our card resolving already-published playlist notes by reading the playlist feed to find the track's album | Only fixes old notes in OUR feed; a new lookup per old playlist note |

## Goals

### 1. The sentence

One sentence replaces the `→` line, the `📻` line and the `🎵` line:

`<sender> boosted N sats to <what>[ by <artist>][ from <where>]`

| Boost | `<what>` | `by` | `<where>` |
|---|---|---|---|
| A show (no episode) | show title | — | — |
| An episode | episode title | — | show title |
| A track on an album (music feed, container is the parent) | track title | album's `author`, via `authorLine` (dropped when it repeats the title) | album title |
| A row of a `*L` playlist (the item's `podcastGuid` names another feed) | item title | the artist, from `/api/remote-item`, music rows only | playlist title |
| A song inside an episode or a live show (`PublishArgs.track`, a track leg settled) | song title | split artist | `<episode> of <show>` |
| BOOST ALL (`contentOverride`) | `N tracks` | — | album title |

Examples, from real feeds:

```
rev.hodl boosted 121 sats to Sing For You by The Doerfels from ITDV music playlist
ChadF boosted 100 sats to Episode 146 from Homegrown Hits
ChadF boosted 100 sats to Copenhagen by Alice from Episode 146 of Homegrown Hits
ChadF boosted 300 sats to 3 tracks from Homegrown Hits (100 each)
```

- No sender name keeps today's form: `Boosted 100 sats to …`.
- Every name is cleaned to one line first (`noteTrackText`), so a feed title cannot add a line.
- The amount stays the intent, `value_msat_total` (invariant 7).

### 2. The tags of a playlist row

When `episode.podcastGuid` names a feed other than the container's: the item's own feed first,
then the item, then the playlist —

```
['i', 'podcast:guid:<album>', <hint>]       ← readers take the FIRST as the show
['i', 'podcast:item:guid:<track>', <hint>]
['i', 'podcast:guid:<playlist>', <hint>]   ← the playlist's own page still lists the note
```

Our card then resolves the track, and the note agrees with its boostagram and its receipt. Every
other note's tags are unchanged.

### 3. The banner

- When `ep` is present: `ep` is the large line and `from <title>` the small one. Without `ep`,
  `title` stays the large line. **Parameter names and meanings do not change** (`title` is still
  the show, `ep` still the episode), so the public contract holds — and because the route draws
  each banner on request, every note ever published gets the new order, rev.hodl's included.
- A playlist row no longer sends the playlist's cover as an art candidate.

## Non-goals

- The amount. The badge says 121 while 6 settled; that is invariant 7, kept on purpose. Chad
  may raise it as its own task.
- Notes already published keep their text and tags (approach C was not chosen).
- The banner does not name a song inside an episode; it keeps `<episode> / from <show>`.
- No change to the `p` tags, the boostagram, the summary receipt or the live chat line.

## Anti-goals

- A note that names an artist for a track leg that did not settle (`boostNoteTrack`'s rule stays).
- A note the site-sign route refuses: the body keeps the `⚡ Boost ⚡` prefix and the 2000-character
  cap, where the song part is the one that gives way, as the `🎵` line does today.
- A banner that renders worse for an old note: a long title must still fit in 300 px.

## Left to the builder

- Where the sentence is built. My call: a pure function in `lib/util.ts`, pinned by vectors in
  `check:vts` built from the published event, so the plain-Node check imports the shipping code.
- How the playlist artist reaches the note: the same 2-second capped lookup `noteTrackArtist` uses.
- Docs in the same change: `docs/nostr.md` (the body template), `docs/money-boosts.md` (lines that
  name the `📻` and `🎵` lines).

## Verification

- `npm run check`, `typecheck`, `lint`, `build`.
- The banner route rendered locally for rev.hodl's URL, a show-only URL, and the longest titles the
  caps allow, and looked at.
- The modal driven in headless Chrome on a playlist track, an album track and an episode, against
  `npm run relay` with a throwaway key; the published event read back from the relay.
