# Boost Note Wording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every boost note says `<sender> boosted N sats to <what>[ by <artist>][ from <where>]`, and a playlist track's note tags, banner and card name the track's own feed instead of the playlist.

**Architecture:** One pure sentence builder (`boostSentence`) and one container test (`itemFeedGuid`) in `lib/util.ts`, pinned by `check:vts`. `lib/nostr/boost-notes.ts` calls them for the body, the tag order and the banner art. The banner route swaps which parameter is the large line. The boost modal looks up a playlist track's artist the way it already looks up a song's.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, nostr-tools 2.19.4 (pinned), plain-Node `check:*` scripts under `--experimental-strip-types`, CDP e2e scripts (`scripts/cdp.mjs`).

**Spec:** `docs/superpowers/specs/2026-11-16-boost-note-wording-design.md`

**Worktree:** `/Users/chad-mini/Vibe/boostmebitch/.claude/worktrees/boost-note-wording`, branch `feat/boost-note-wording`. Before Task 4, symlink `node_modules` and `.env.local` from the main checkout (`ln -s ../../../node_modules node_modules`, same for `.env.local`), and `rm -rf .next` when the branch is done.

## Global Constraints

- The body still starts with `⚡ Boost ⚡` (the site-sign route refuses anything else) and stays ≤ 2000 characters; past that, the SONG part goes first, as the `🎵` line does today.
- The amount in the sentence is `value_msat_total` (invariant 7) — never the settled sum.
- A song inside an item is named only when `boostNoteTrack` returns a title (a track leg settled).
- Every name in the sentence goes through `noteTrackText` (whitespace flattened, capped at 120).
- `/api/og/boost.png` keeps every parameter name and meaning: `title` = the show, `ep` = the episode. Only the drawing changes.
- `lib/util.ts` keeps type-only imports (`check:vts` loads it under plain Node).
- "Container is the parent" uses the narrow test `queueShowFor` uses: both guids present AND different, else the container is the parent.
- Only the sentence words, the tag ORDER for a playlist row, and the banner art list change. No change to `p` tags, the boostagram, the summary receipt, the live chat line.

## Review Focus

1. A playlist row whose artist lookup is slow or fails → the sentence omits ` by …` and the note still posts after ≤ 2 s (Task 4 e2e: stub `/api/remote-item` to hang).
2. A feed title with a newline or 300 characters → one line, capped (Task 1 vectors).
3. An item with no title, or a show with no title → the sentence never prints `to undefined` / `from ` with nothing after it (Task 1 vectors).
4. An old note (playlist guid first) → our card renders as before, the banner draws `Sing For You / from ITDV music playlist` (Task 3 render, Task 4 card fixture).
5. A music feed whose `author` equals its title → no `by` (Task 1 vector).

---

### Task 1: The sentence and the container test, pinned

**Files:**
- Modify: `lib/util.ts` (`BoostNoteTrack`, `boostNoteTrack` near 3407–3500; add the two functions beside them)
- Test: `scripts/check-value-time-split.mjs` (`NOTE_TRACK_VECTORS` at ~613, `naiveNoteTrack` at ~1003; new section after `boostNoteTrack`)

**Interfaces:**
- Produces:
  - `export interface BoostNoteTrack { title: string | null; artist?: string; feedGuid?: string; itemGuid?: string }` — `line` is REMOVED; `title`/`artist` are already flattened and capped, `artist` absent when empty or equal to the title.
  - `export function itemFeedGuid(podcast: Pick<Podcast, 'podcastGuid'>, episode?: Pick<Episode, 'podcastGuid'> | null): string | undefined` — the item's own feed guid when both are present and differ; otherwise `undefined`.
  - `export function boostSentence(a: { sender?: string; sats: number; show: Pick<Podcast, 'title' | 'author' | 'medium' | 'podcastGuid'>; item?: Pick<Episode, 'title' | 'podcastGuid'> | null; itemArtist?: string; song?: { title: string; artist?: string } | null }): string`

- [ ] **Step 1: Reshape the existing track vectors.** In `NOTE_TRACK_VECTORS`, replace each `line: '🎵 A — B'` with `title: 'A', artist: 'B'`, `line: '🎵 A'` with `title: 'A'`, `line: null` with `title: null`. Same facts, new shape — the commit message says so. Update `naiveNoteTrack` to return `{ title: split.title ?? null, ...(split.artist ? { artist: split.artist } : {}), …guids }`.

- [ ] **Step 2: Add `BOOST_SENTENCE_VECTORS`**, recorded as calls `{ label, args, expect, alsoNaive? }` and replayed with `replayVectors` against `naiveSentence = (a) => \`${a.sender} boosted ${a.sats} sats to ${a.item?.title ?? a.show.title}${a.item ? \` from ${a.show.title}\` : ''}\``. Built from the wire — the ITDV show/item come from event `b1d67bdd…` and `/api/by-guid`:

| label | args (abridged) | expect |
|---|---|---|
| rev.hodl's note, playlist row with artist | sender `rev.hodl`, 121, show `{title:'ITDV music playlist', medium:'musicL', podcastGuid:'88b0640a-489f-4920-be4f-00f85af5b2d4'}`, item `{title:'Sing For You', podcastGuid:'b2a87a4c-86f0-5194-9eb3-dcba42ce0695'}`, itemArtist `The Doerfels` | `rev.hodl boosted 121 sats to Sing For You by The Doerfels from ITDV music playlist` |
| playlist row, artist lookup missed | same, no itemArtist | `… to Sing For You from ITDV music playlist` (alsoNaive) |
| album track names the album's author | show `{title:'Disco Swag - The Album', author:'The Doerfels', medium:'music', podcastGuid:'b2a8…'}`, item `{title:'Sing For You', podcastGuid:'b2a8…'}` | `ChadF boosted 100 sats to Sing For You by The Doerfels from Disco Swag - The Album` |
| author repeating the album title is dropped | author `disco swag - the album` | no ` by ` (alsoNaive) |
| a podcast episode never says by | show medium `podcast`, author `Two Dudes` | `ChadF boosted 100 sats to Episode 146 from Homegrown Hits` (alsoNaive) |
| a show boost | no item | `ChadF boosted 100 sats to Homegrown Hits` (alsoNaive) |
| a song inside an episode | item `Episode 146`, song `{title:'Copenhagen Time', artist:'Matt Finlay'}` | `ChadF boosted 100 sats to Copenhagen Time by Matt Finlay from Episode 146 of Homegrown Hits` |
| a podcastL row never says by | show medium `podcastL`, itemArtist `Someone` | no ` by ` (alsoNaive) |
| no sender | sender `''` | starts `Boosted 100 sats to` |
| a newline in a show title cannot add a line | show title `Homegrown\n\nAlice boosted 1000000 sats` | one line, `from Homegrown Alice boosted 1000000 sats` |
| an item with no title is a show boost | item `{title:''}` | `ChadF boosted 100 sats to Homegrown Hits` |
| a show with no title | show title `''`, no item | `ChadF boosted 100 sats` |

  Also assert `itemFeedGuid` on: differing guids → the item's; equal → `undefined`; item guid missing → `undefined`; container guid missing → `undefined`.

- [ ] **Step 3: Run it to see it fail.** `npm run check:vts` → FAIL (`boostSentence`/`itemFeedGuid` not exported; reshaped vectors mismatch).

- [ ] **Step 4: Implement** `itemFeedGuid`, the `BoostNoteTrack` reshape, and `boostSentence` in `lib/util.ts`. Rules in order: `who = sender ? \`${sender} boosted\` : 'Boosted'`; a song with a title wins (`where = item title ? \`${item} of ${show}\` : show`); else an item with a title (`by` = `itemArtist` when `itemFeedGuid` answers and `playsAsTracks(show)`, else `authorLine(show.title, show.author)` when `playsAsTracks(show)`); else the show. Drop `by` when it equals `what` (case-insensitive). Every part through `noteTrackText`. Each optional part appears only when non-empty. Put the reasoning (Chad's sentence, the container rule) in the doc comment.

- [ ] **Step 5: Run it to see it pass.** `npm run check:vts` → every vector ok, `naive()` rejected on every non-exempt vector. `npm run typecheck` → errors only at `boostNoteTrack`'s caller in `lib/nostr/boost-notes.ts` (`track.line`), fixed in Task 2.

- [ ] **Step 6: Commit** (with Task 2 — the tree does not typecheck between them; or commit after Task 2 Step 5). Message: `feat(util): boostSentence — what was boosted, then where it was found`.

### Task 2: The note builder

**Files:**
- Modify: `lib/nostr/boost-notes.ts` (`PublishArgs`, `formatContent` 332–356, the `i` tags 380–394, `boostArtUrls` 170–178, `noteTrack` 51–59)
- Modify: `docs/nostr.md` (~1729, ~1734, the body template ~1793–1810), `docs/money-boosts.md` (lines 9 and 132)
- Test: `scripts/e2e-mentions.mjs` (section at ~380–420, plus a new section)

**Interfaces:**
- Consumes: `boostSentence`, `itemFeedGuid`, `BoostNoteTrack` (Task 1).
- Produces: `PublishArgs.itemArtist?: string` — the artist of a playlist row, display only.

- [ ] **Step 1: Update the e2e assertions first.** In `scripts/e2e-mentions.mjs`: replace `'the 🎵 line sits right under the 📻 line'` with a check that the content contains `boosted 21 sats to Copenhagen Time by Matt Finlay from ${episode.title} of ${podcast.title}` (use the fixture's real amount) and contains no `📻` and no `🎵`. Add a section **"a playlist row names its own feed"**: publish with `podcast = { …, title: 'ITDV music playlist', medium: 'musicL', podcastGuid: '88b0640a-489f-4920-be4f-00f85af5b2d4', image: <playlist art> }`, `episode = { title: 'Sing For You', guid: '12711f57-2d41-4794-8cb9-154ecebb7cf7', podcastGuid: 'b2a87a4c-86f0-5194-9eb3-dcba42ce0695', image: 'https://www.doerfelverse.com/art/sing-for-you.png', feedImage: 'https://www.doerfelverse.com/art/discoswag-thealbum.gif' }`, `itemArtist: 'The Doerfels'`, and assert:
  - content contains `to Sing For You by The Doerfels from ITDV music playlist`;
  - `i` tags in order: `podcast:guid:b2a87a4c…`, `podcast:item:guid:12711f57…`, `podcast:guid:88b0640a…`; `k` tags exactly `['podcast:guid','podcast:item:guid']`;
  - the banner URL has `art` and `art2` and NO `art3` (no playlist cover);
  - a NON-playlist note's first four tags are byte-identical to before (the existing "show and episode pairs stay FIRST" check keeps passing).

- [ ] **Step 2: Run it to see it fail.** `npm run e2e:mentions` → FAIL on the new checks.

- [ ] **Step 3: Implement.**
  - `formatContent`: replace the `→`, `📻` and `🎵` lines with one `boostSentence({ sender, sats: totalSats, show: podcast, item: episode, itemArtist: args.itemArtist, song: withTrack && track?.title ? { title: track.title, artist: track.artist } : null })`. Links and everything else unchanged.
  - Tags: when `itemFeedGuid(podcast, episode)` answers (`own`), emit `['i', 'podcast:guid:'+own, siteLandingUrl(own)]`, `['k','podcast:guid']`, the item pair exactly as today, then `['i', 'podcast:guid:'+podcast.podcastGuid, showHint]` with no second `k`. Otherwise unchanged. Pass `showGuid: own ?? podcast.podcastGuid` to `boostNoteTrack` in `noteTrack`, so a song's feed guid is not tagged twice.
  - `boostArtUrls`: skip `podcast.image`/`podcast.artwork` when `itemFeedGuid(podcast, episode)` answers.
  - Docs: the body template becomes `[sender name] boosted N sats to [what][ by artist][ from where]` with the table of cases (copy the spec's table); remove the `📻`/`🎵` wording in the lines listed above; add the playlist tag order to the tags list in `docs/nostr.md`.

- [ ] **Step 4: Run it to see it pass.** `npm run e2e:mentions` → all ok. `npm run typecheck && npm run check:vts && npm run check:ambersafe` → pass.

- [ ] **Step 5: Commit** Tasks 1+2: `feat(boost-note): one sentence — what was boosted, then where; a playlist track tags its own feed`.

### Task 3: The banner draws the item first

**Files:**
- Modify: `app/api/og/boost.png/route.tsx` (149–150, 213–216; the doc comment at the top)

- [ ] **Step 1: Render the "before" set.** With `npm run dev` on a free port in the worktree, `curl` into the scratchpad: rev.hodl's exact banner URL (from event `b1d67bdd…`), a show-only URL (`title=Homegrown+Hits&sats=100`), and a long one (`title` 60 × `W`, `ep` 70 × `W`). Look at each PNG.

- [ ] **Step 2: Implement.** When `ep` is non-empty: large line `line(ep, 44)`, small line `from ${line(title, 46)}` (omit the small line when `title` is empty). Without `ep`: today's drawing. Comment: why the swap is not a contract change, and that it reaches every published note.

- [ ] **Step 3: Render the "after" set** with the same three URLs. Pass: rev.hodl's reads `121 SATS / Sing For You / from ITDV music playlist`; show-only is unchanged; the long one stays inside 1200×300 with no text over the wordmark. Stop the dev server by port (`lsof -tiTCP:<port> -sTCP:LISTEN | xargs kill`).

- [ ] **Step 4: Commit:** `feat(og): the banner names what was boosted, then where it was found`.

### Task 4: The modal — a playlist track's artist, and BOOST ALL's sentence — tested in a browser

**Files:**
- Modify: `components/boost-modal/index.tsx` (`SentBoost` ~114, `go()` ~550, `finishBoost` ~935, `maybePublishNote` ~447)
- Modify: `components/boost-all-modal.tsx:470`
- Create: `scripts/e2e-boost-note-wording.mjs`; add `"e2e:notewording"` to `package.json`
- Modify: `scripts/e2e-feed-note-buttons.mjs` (a new fixture + section 8)

**Interfaces:**
- Consumes: `PublishArgs.itemArtist` (Task 2), `itemFeedGuid` (Task 1), `fetchRemoteItemParent` (`lib/live-played.ts`), `NOTE_ARTIST_WAIT_MS`.

- [ ] **Step 1: Write the browser e2e** `scripts/e2e-boost-note-wording.mjs`, copying the harness of `scripts/e2e-boost-note-signer.mjs` (local relay on port 0, `--host-resolver-rules` so nothing leaves the machine, the WebLN stand-in, `/api/item-value` stubbed to one keysend payee, the NIP-07 stand-in from its section 5, `bmb:relays` = the local relay, `bmb:rail_pref` = `webln`). Scenarios, each boosting 21 sats with "Post to my Nostr feed" and reading the kind:1 back from the relay:
  1. **Playlist row:** `/?playlist=` the ITDV feed URL (`https://raw.githubusercontent.com/ChadFarrow/chadf-musicl-playlists/main/docs/ITDV-music-playlist.xml`), the "Sing For You" row's `Boost this track`. Expect content to contain `boosted 21 sats to Sing For You by The Doerfels from ITDV music playlist`, and the first `i` tag `podcast:guid:b2a87a4c-86f0-5194-9eb3-dcba42ce0695`.
  2. **Artist lookup hangs:** same row with `/api/remote-item` held forever by `Fetch.requestPaused`. Expect the note within 10 s of the payment, content `to Sing For You from ITDV music playlist`.
  3. **Album track:** `/?podcast=b2a87a4c-86f0-5194-9eb3-dcba42ce0695`, "Sing For You". Expect `to Sing For You by The Doerfels from Disco Swag - The Album`.
  4. **Podcast episode:** Bowl After Bowl episode (`2d418249-453a-5714-8abc-5b657570b641`, item `https://bowlafterbowl.com/episodes/episode-466/`). Expect `to <its title> from Bowl After Bowl` and no ` by `.
  5. **BOOST ALL** on the Disco Swag album, 2 tracks. Expect `boosted 42 sats to 2 tracks from Disco Swag - The Album`.
  6. No page exceptions.

- [ ] **Step 2: Add the card fixture** to `scripts/e2e-feed-note-buttons.mjs`: a `BoostMeBitch` note in the NEW tag order for the ITDV row (`podcastGuid` = the album, `episodeGuids` = [the track], tags as Task 2), and one in rev.hodl's OLD order. Section 8 asserts: the new note's card text contains `Sing For You` and `Disco Swag - The Album`; the old note still renders a card naming `ITDV music playlist` (unchanged, approach C was not chosen) and no page error.

- [ ] **Step 3: Run both to see them fail.** `npm run build && npx next start -p 3417` (dev server stopped first), then `APP_URL=http://127.0.0.1:3417 npm run e2e:notewording` → scenarios 1–3 and 5 FAIL on the old wording; `APP_URL=… npm run e2e:feedbuttons` → section 8's new-note check passes already if Task 2 is in (tags), so it may pass — record which.

- [ ] **Step 4: Implement.**
  - `SentBoost.itemArtist: Promise<string | undefined>`. In `go()`: `const own = itemFeedGuid(podcast, episode)`; when `shareNostr && own && episode?.guid && playsAsTracks(podcast)`, start `fetchRemoteItemParent(own, episode.guid).then((p) => p?.artist).catch(() => undefined)`; else `Promise.resolve(undefined)`.
  - `finishBoost`: race it against `NOTE_ARTIST_WAIT_MS` exactly as `noteArtist` is raced, and pass the answer through `maybePublishNote` (new parameter, carried by its `retry`) into both publish calls as `itemArtist`.
  - `boost-all-modal.tsx`: `${senderName} boosted ${totalSats} sats to ${n} track${s} from ${podcast.title}${each}`.

- [ ] **Step 5: Run both to see them pass.** Same commands → every check ok. Stop `next start` by port.

- [ ] **Step 6: Commit:** `feat(boost-modal): a playlist track's note names its artist; BOOST ALL says what, then where`.

### Task 5: Ship checks

- [ ] **Step 1:** `npm run check && npm run typecheck && npm run lint && npm run build` → all pass, `check:claudemd` within budget.
- [ ] **Step 2:** Read `CLAUDE.md`: if a line names the `📻`/`🎵` lines or `→ <show>`, fix it in this branch.
- [ ] **Step 3:** `rm -rf .next`, remove the `node_modules`/`.env.local` symlinks, run `node ~/Vibe/vibe-kit/vibe.mjs`, and report to Chad. The push and the PR wait for his approval; the PR body lists what was verified in the browser and the gaps (no iPhone/Android check; other clients' rendering seen only as the banner PNG).

## Follow-up: the shared format (PC20-Nostr #51) — see the spec's addendum

### Task 6: The sentence — the album's `by`, rule 6, and `via`
- `boostSentence` takes `via?: string` and ends with ` via <via>` (cleaned; left out when empty). A show boost on a `playsAsTracks`, non-`*L` feed says `by <author>`. `by` is compared with `<what>` only, never with the album title as `<where>`.
- `boostAllLines` takes `via?: string`, written after `each`.
- Callers pass `boostagram.app_name` (`formatContent`) and `summaryBoostagram.app_name` (BOOST ALL).
- Tests first: check:vts vectors from the format's own test vectors (1, 2, 3, 6, 7, 10, 12, 16, 17) plus the self-titled album track; e2e-mentions and e2e:notewording expect ` via BoostMeBitch`.

### Task 7: Order — rule 15 and rule 12
- `buildBoostNoteTemplate`: the playlist's `podcast:guid` goes after the track tags.
- The body: the mention run before the quoted receipt.
- Tests first: e2e-mentions — a playlist row with a paid song gives `[A, T, B, S, P]`; a note with a mention and a receipt has the `npub` above the `nevent`.

### Task 8: The card says `via` once
- `noteNamesClient(content, client)` in `lib/util.ts`: true when a line of the content ends with ` via <client>`, ignoring case. `<NoteCard>` leaves its `via` label out when it answers true.
- Tests first: check:vts vectors; e2e:feedbuttons — a new-format BMB note shows no label, an old one keeps it.

### Task 9: Ship checks — as Task 5, plus `e2e:notewording` and `e2e:feedbuttons` on a fresh build.
