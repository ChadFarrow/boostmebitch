# Music plays at 1×

**Date:** 2026-11-02

## Intent

A music show mixes talk and songs. A listener who wants the talk at 2× does not want the songs at
2×. The listener sets a speed for the episode. When a track plays, the audio goes to 1×. When the
track ends, the audio goes back to the speed the listener set.

The idea comes from v4vmusic.com. A test of its public pages on 2026-11-02 found no
speed control with nothing playing and no sign-in, so its behaviour was not observed. Nothing here
copies it.

Example shows: Homegrown Hits, Lightning Thrashes, Into The Doerfel-Verse. They are examples. The
feature keys off data in the feed, never off a list of show names.

**Terms.** A *track marker* is one `<podcast:valueTimeSplit>` tag in an episode's feed: it says that
a track plays from a start time for a length. The code calls it a *window* or a `valueTimeSplit`
(`ValueTimeSplit` in `lib/types.ts`). A *hold* is the stretch of an episode that plays at 1× because
of one or more track markers. The *set speed* is the store's `playbackRate`, the speed the listener
chose.

## Goals

- At any set speed above 1×, audio inside a hold plays at 1×, and audio outside a hold plays at the
  set speed.
- A skip, a scrub, a chapter jump, a resume and a `?t=` link all land on the right speed, because the
  position decides and nothing else.
- A song with a wrong marker length still plays at 1× for the song's own length.
- The speed controls keep saying the true state.

## Non-goals

- No detection of music in the audio, and no use of chapters. The one chapter file read
  (Doerfel-Verse 80) names songs and talk with plain titles and has no field that says which is
  which.
- No change for an episode with no track markers. It stays at the set speed through its songs.
- No new setting, and no per-show on/off.
- No change for a live item. It stays at 1× with no control, as now.

## Anti-goals

Any of these makes the feature a failure even if songs play at 1×:

- **Saving the 1×.** `setPlaybackRate` writes the show's own entry, and an entry outranks the global
  speed for ever. A hold must never write to storage.
- **Moving money.** `splitAtPosition`, `allocationAt`, `useActiveSplit`, the streaming ledger and every
  boost path stay exactly as they are. `remoteItem.medium` also stays as it is, because streaming and
  public favorites read it (see "What the builder decided").
- **A bad marker holding 1× through talk.** Lightning Thrashes 110 has a 113-minute marker that points
  at a podcast. It must not hold.
- **A `<Player>` render per tick.** The store flag changes only when a hold starts or ends.

## Constraints

- `npm run check:*` is the test suite. There is no test runner.
- `lib/util.ts` must stay loadable under `node --experimental-strip-types`, so the pure rule goes
  there and `check:vts` drives the shipping function.
- `/api/value-splits` answers with a one-hour CDN cache, so a response from before this change has
  none of the new fields. The player must treat that as "not known".
- `batchPodcasts` caps at `MAX_BATCH` (100) and `PI_FANOUT` bounds concurrency (`check:fanout`).
- The screen can be locked. The repo docs say that iOS can suspend the page's JavaScript while audio
  plays, so a switch can come late there. A web page cannot schedule a rate change without JavaScript.

## What the data says

Measured on 2026-11-02 from the production `/api/feed` and `/api/by-guid/batch` routes, read only,
across the three example shows.

| Show | Episodes with track markers (RSS) |
|---|---|
| Homegrown Hits | 156 of 157 |
| Lightning Thrashes | 108 of 111 |
| Into The Doerfel-Verse | 28 of 82 (5 of the newest 20) |

**The tag's own `medium` is empty on all 3,461 markers.** The remote feed's Podcast Index record has
it. Across 922 distinct remote feeds:

| Remote feed medium | Markers |
|---|---|
| `music` | 3,337 (96.4%) |
| not in Podcast Index | 101 |
| `podcast` | 14 |
| `publisher` | 6 |
| `video` | 3 |

**Long markers are mostly real songs with a bad length.** 24 markers run over 15 minutes: 18 `music`,
4 `podcast`, 2 not in Podcast Index. Homegrown Hits 122 has a marker of 5,643 minutes over a song of
3:25. Homegrown Hits 111 has 5,823 minutes over 3:45. Every one of the 18 is over a song of 2 to 6
minutes.

**Normal markers are accurate.** In a random sample of 176 markers of 15 minutes or less, Podcast
Index knew the track length for 169. Of those, 162 match within 30 seconds (median difference 0,
p10 −7 s, p90 +1 s).

**Neighbouring markers crowd each other.** Across 3,144 neighbouring pairs of markers of 15 minutes or
less: 502 overlap, 508 have a gap under 5 s, 228 have 5–10 s, 184 have 10–30 s, 1,722 have more than
30 s.

`remoteStartTime` is 0 on all 3,461 markers.

## Approaches

**A. Track markers only.** The player reads the markers already on the episode and ignores any over
15 minutes. It needs no server change and works offline. The 18 songs with bad markers would play at
the set speed, which breaks "music at 1×". 10 short markers that point at other podcasts would play
at 1×.

**B. Track markers plus Podcast Index data. Chad picked this.** `/api/value-splits` already looks up
each track, and `<Player>` already loads that list for the track art, so no new client request is
needed. It adds the track's real length and its feed's medium. It fixes those 18 songs and those 10
markers. It needs a server change and a fallback to test: before the lookup answers, and offline, the
player uses A's rules.

Chad asked for the `medium` check. The length check alone cannot do its job: the 113-minute marker
points at a 300-minute podcast episode, so `min(marker, track)` still holds 113 minutes.

## What Chad decided

- The listener sets a speed for the episode. A track plays at 1×. When the track ends, the audio goes
  back to the set speed.
- **Music is hard-coded at 1×.** A speed press during a song changes only the set speed, and the new
  speed starts when the song ends.
- Approach B.

## Proposed to Chad and not corrected

Chad can overturn each of these.

- No new setting. Every speed above 1× behaves this way, including 3.5× and 5×.
- The 1× is never saved.
- Skips, scrubs, chapter jumps, resume and `?t=` follow the position.
- An episode with no track markers stays at the set speed. This affects 54 of the 82 Into The
  Doerfel-Verse episodes.
- "Into the Dwarfiverse" means Into The Doerfel-Verse. Podcast Index has no show with the first name.
- Live items do not change.
- Album and playlist tracks (`playsAsTracks`) also play at 1×, with the speed controls hidden, as on a
  live item. They now play at the global speed, and `e2e:speed` pinned that, so this is a deliberate
  change to existing behaviour.

## The hold rule

For a marker with start `s` and length `d`:

1. If the remote feed's medium is known and is not `music`, `musicL` or `publisher`, there is no hold.
2. If the track length `L` is known and above 0, hold over `[s, s + min(d, L))`.
3. If `L` is not known (feed not in Podcast Index, no `itemGuid`, lookup not answered yet, offline, an
   old cached response, or past `MAX_RESOLVED_SPLITS`), hold over `[s, s + d)` only when `d` is 15
   minutes or less. Otherwise there is no hold.
4. Any hold that covers the position counts, so overlaps are safe. Two holds with a gap under 5 s
   between them merge.

`L` is measured from `remoteStartTime` when a marker has one: `L - remoteStartTime`. All measured
markers have 0.

Why `publisher` counts as music: a publisher feed leads to the album feeds, and
`lib/musicl-resolver.ts` already walks it that way.

## Calls made by the builder

These are not Chad's decisions. Check them.

- **15-minute cap** for a marker with no known track length. Of 169 sampled markers below it, 162
  match their track within 30 s, and all 18 `music` markers above it sit on a song of 2 to 6 minutes.
  A real song over 15 minutes with no known length plays at the set speed.
- **5-second merge.** 508 of 3,144 gaps are under 5 s. At 2× the rate would go up for under 2.5 s and
  come down again. That sounds like a fault, not a feature.
- **`video` means no hold.** 3 markers, all Hyper SpaceOut. Anything not known to be music stays at the
  set speed.
- **The label.** The speed controls keep naming the set speed, because that is what a press changes,
  and add a short note that the song plays at 1×: the SPEED tile's word line reads `♪ AT 1×`, and the
  chip reads `2× ♪1× ↻`. `aria-label` and the slider's `aria-valuetext` state the true speed. A phone
  mini-bar has no speed control, so it shows nothing; the ear already says it.
- **A hold starts early by one `timeupdate` interval at the set speed** (0.25 s × set speed), so the
  song's first beat is not at speed. The lead uses the set speed, not the current rate, or the hold
  would drop out as soon as it starts.
- **A new field, `feedMedium`, not `remoteItem.medium`.** `remoteItem.medium` is empty on every
  marker, and it looks like the place for this. It is not. `<FavTrackHeart>` publishes it to a public
  favorites list, and its comment says that a guess published there is one no other app will correct.
  `actionFor` in `lib/v4v/streaming.ts` also reads it for the action word on a streaming payment.
  Filling it from a lookup would change both.
- **`medium` is a separate batched lookup** in `/api/value-splits`, through `batchPodcasts`, because
  Podcast Index carries it on the feed record and not on the episode. A failed lookup returns the
  splits as they are, because those splits pay artists.

## What happens where

- `lib/util.ts`: `musicHoldSpans(markers)` and `inMusicHold(spans, t, lead)`, pure and pinned by
  `check:vts`. `withFeedMediums(splits, feeds)` is pure too.
- `lib/pi.ts`, `lib/musicl-resolver.ts`: `resolveOneSplit` carries `trackDuration` on every branch.
- `app/api/value-splits/route.ts`: adds `feedMedium` after resolving.
- `lib/store.ts`: `musicHold` (never persisted), and `isMusicItem(current)`, which uses the
  download-record witness that `speedKeyFor` uses.
- `components/player/use-music-hold.ts`: holds the spans, sets `musicHold` inside the `set()` that
  moves `current`, and exposes the sync that both `onTimeUpdate` handlers and `onSeeked` call.
- `components/player.tsx`: one effective rate for the apply effect and the Media Session.
- `components/player/speed-button.tsx`, `components/fullscreen-player.tsx`: the note, and the controls
  hidden on a music item.

## Streaming

No change. The listener pays per real minute at any speed (`docs/streaming.md`). A 4-minute song takes
4 real minutes at 1× and 2 at 2×, so at a per-minute rate the artist gets twice the sats for that
song. The listener's rate per real minute does not move.

## Found on the way, not fixed

**Bad markers also steer money.** `splitAtPosition` returns the first match, so a bad long marker
covers every later marker that follows it in the list. In Homegrown Hits 122, all 10 later markers
first-match the bad one. Homegrown Hits 111: 3 of 3. Homegrown Hits 134: 8 of 8. A boost or a stream
during those songs credits the artist of the bad marker. This is existing behaviour, read from the
code and the feed data, not from a payment. It needs its own look.

**A `?t=` link on a second load does not play.** The same link opened again in one tab parks at the
second and never calls `play()`. Production does the same, measured on 2026-11-02, so it is not from
this change. The cause was not looked for. The restore is guarded on `!current`, so a reveal that
runs first is the likely one.

## Left to the builder

The exact label fit, the file layout inside `components/player/`, and how the e2e reaches a position.

## Not testable here

- A locked iPhone: needs an iPhone. iOS can suspend the page's JavaScript, so the switch can come late.
- Android background: needs a device. `docs/android.md` has no verdict on background audio.
- An audible click at the switch: the test browser is muted.
