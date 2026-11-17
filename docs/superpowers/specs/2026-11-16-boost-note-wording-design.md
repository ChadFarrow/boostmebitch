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

## Addendum, 2026-11-16: the shared format (PC20-Nostr #51)

PC20-Nostr #51 (`pc20-boost-notes.md`, merged 2026-11-17 03:25 UTC, `draft`) made this
sentence the format for every one of Chad's apps:
`<who> boosted <N> sats to <what>[ by <artist>][ from <where>][ via <app>]`. Chad answered its
open questions on 2026-11-16, and three answers change this branch:

| # | Chad's answer | This branch |
|---|---|---|
| 1 | An album boost says `by <artist>`: *"ChadF boosted 100 sats to Disco Swag - The Album by The Doerfels"* | A show boost on a music feed (`playsAsTracks`, not a `*L` playlist) names the album's `author` |
| 2 | Every app ends the sentence with `via <app>` (*"Yes, add the app."*) | ` via <boostagram.app_name>` — `BRAND.wireName`, the name the payment carries — on every note and on BOOST ALL, after ` (<each> each)` |
| 3 | An auto boost posts no Nostr note | No change. The only `action: 'auto'` legs are streaming's, and streaming publishes no kind 1 (CLAUDE.md, streaming invariants); its kind 3369/33369 events are outside the rule |

Three more rules of the format differ from what the branch writes, and the branch follows the
format (my calls, each pinned by a test):

- **Rule 6: `by` is dropped only when it equals `<what>`.** The branch dropped an album's author
  when it repeated the ALBUM title, also on a track boost, where the album is `<where>`.
- **Rule 15: the playlist's `podcast:guid` comes after the song's pair.** The boosted item's pair,
  then the song a split paid, then the playlist.
- **Rule 12: the mentions come before the quoted receipt's `nevent`.** The builder wrote the
  `nevent` first.

**Our note card shows the app twice.** It writes `via <client tag>` above the body, and the body
now ends with `via BoostMeBitch`. My call: the card leaves its label out when a line of the body
already ends with `via <that client>`; a note without it (every note written before the format,
and other apps' notes) keeps the label.

## Addendum, 2026-11-17: the site-sign length limit (Chad chose "choice 4")

A note the SITE signs (signed out, or Anonymous) goes through `/api/nostr/site-sign`, which refused
any body over 2000 characters. A real boost could pass that: a summary receipt, a 250-character
message, 4 feed npubs and 2 typed mentions measured 2032 after every shed, so the note failed and
RETRY NOTE failed the same way. The limit exists because the route is unauthenticated and asks for
no proof of payment — it bounds how much free text a stranger can publish under the site's verified
name. Chad's call: real boosts must never fail on it. Choice 4: measure the largest REAL note and set
the limit just above it.

**Measured with the shipping builder (2026-11-17):** every part at the most a real boost carries — a
250-character message with 4 typed mentions placed inline, 120-character names (the cap
`noteTrackText` already applies), a song inside an episode with its artist, 4 feed npubs, a receipt
with the three longest default relay hints, 500-character feed URLs, 300-character titles — is
**4,757** characters. The banner URL is the largest part (2,219), because it carries up to three cover
URLs and both raw titles.

Some parts have no maximum today, so "the largest real note" needs caps first. My calls:

| Part | Today | Change |
|---|---|---|
| Banner `title` / `ep` | the raw title, any length | cut to 120 characters — the banner draws at most 47, so no picture changes |
| A landing link (body + `r` tag) | any length | left out over 512 characters, never cut. The route already refused an `r` tag over 512, so such a note failed before |
| The limit | 2000 | the measured largest real note, rounded up: route `MAX_CONTENT` and builder `SITE_SIGN_MAX_CONTENT` together |
| The shed | song, then `by` | song, then `by`, then the banner line, then the receipt line (its `q` tag stays) |

The two new shed steps make it total: once the links are capped, what is left (message, sentence,
links, mentions) is far under the limit, so a note past every real maximum — a cover URL thousands of
characters long, a title of non-Latin text that percent-encodes nine times over — loses its picture,
then its ⚡ line on Fountain, and still posts. Cover URLs stay uncapped: the route tries them in order,
and the shed drops the banner rather than a candidate.

A stranger calling the route directly can now have the site sign about 5,000 characters of their own
text per note instead of 2,000; the rate limit (30 a minute per IP, 600 per route) is unchanged. The
lasting fix is a route that asks for proof of payment — a separate change.
