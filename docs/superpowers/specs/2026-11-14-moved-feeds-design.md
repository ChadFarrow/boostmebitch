# Follow a favorite whose feed host closed

**Date:** 2026-11-14

## Intent

Chad reported *"a lot of cover art is missing"* on `/favorites`. Measured the same day against his
public kind:10333 (231 feed favorites, 237 item favorites): **33 of 468 rows have no cover that
loads, and 32 of them are on RSS Blue.** RSS Blue closed ("RSS Blue is now part of Fountain"):
every `feeds.rssblue.com/<slug>` feed and every `media.rssblue.com` file — covers AND audio, also
behind the `op3.dev/e,pg=…/` prefix — answers **410 Gone**. These favorites cannot play either.

Podcast Index still serves the old records as healthy (`dead: 0`, `lastHttpStatus: 200`, last
crawl 2025-08-07), and `/podcasts/byguid` and `/podcasts/batch/byguid` return the dead copy.

Chad: *"some of these were RSS Blue feeds that moved to fountain or other places."* A search by
title and artist found four of the fifteen dead albums elsewhere:

| Album | Artist | New home (PI feed id) | Same `podcastGuid`? |
|---|---|---|---|
| Worried | Suzanne Santo | Fountain 7520866 | **yes** — only `/search/bytitle` shows it |
| Mr. Videoman | Prosperous Soul | Fountain 7854985 ("Mr Videoman"), Wavlake 6813307 | no |
| Runaway Train | Prosperous Soul | Fountain 7685451 | no |
| Keep Searching | Prosperous Soul | Wavlake 6816637 | no |

The other ten (Herbivore ×5, June & The Jets ×2, Love Ethic, MOOKY, Emily Ronna, Circle the
Earth) have no copy in Podcast Index. Podcast Index keeps no cached copy of a cover; its own page
links the dead URL.

**Chad's decision (option 2 of two offered):** when the copy has the **same guid**, switch to it
automatically; when the match has a **new guid**, show it on the row and swap the favorite only
after he presses a button.

## Goals

1. **Same guid, automatic, everywhere the app resolves by guid.** When Podcast Index's record for
   a guid sits on a closed host and a live feed carries the same `podcastGuid`, the app resolves
   the guid to the live feed: title, cover, feed id, episodes, enclosures. The favorites list is
   NOT changed — kind:10333 names the guid, and the guid is the same.
2. **Same guid, for items too.** An item favorite whose parent guid resolves to a live twin
   resolves the item on the twin (`/episodes/byguid?guid=<item>&feedid=<twin id>`), so its cover
   and enclosure are the live ones. Measured: the Worried track's item guid is on the twin.
3. **New guid, ask first.** A favorite row whose feed is on a closed host and has no same-guid
   twin asks the server for candidates. Each candidate shows on the row as
   `MOVED? <title> — <artist> · <host>` with a **REPLACE** button. With two candidates (Mr.
   Videoman) both show, and Chad picks one.
4. **REPLACE swaps through the same store actions a heart uses.** For an album row:
   `removeFavorite(old)` + `addFavorite(new)`, plus each favorited track of the old album that
   matches a track of the new album by normalized title: `removeFavoriteEpisode(old item)` +
   `addFavoriteEpisode(new item)`. For a track row: that one track. Then ONE
   `requestFavoritesSync(identity)`. After the swap the row says how many tracks moved and how
   many stayed (`moved 1 of 2 tracks — 1 not found on Fountain`).
5. **Rows already cached on a device pick up the switch.** Chad's own browser holds the dead URLs
   in `bmb:favorites:<npub>` (no TTL), `bmb:pmeta` and `bmb:epmeta` (7 days). A cached row on a
   closed host must be re-resolved, or goal 1 never reaches the device that reported the bug.

## Non-goals

- **No automatic swap on a new guid.** Chad chose the ask.
- **No label for a dead favorite with no match** (the ten with no copy). That was a separate option
  in the first list, and Chad did not pick it. The row keeps today's initial tile.
- **No change to the kind:10333 wire format, the merge, or `lib/nostr/favorites-list.ts`.** A swap
  is a sequence of the store actions a heart already performs.
- **No general dead-feed probe.** See "Detection" under Approaches.
- **No change to `services/nostr-index`.** It caches PI's raw answers; the app post-processes
  them (goal 1 applies to an index answer exactly as to a direct one).
- **No report to Podcast Index.** That is Chad's call, outside this repo.
- **No change to search results.** `/api/search` lists both copies of Worried; that is PI's data.
- **No switch on paths keyed by a feed ID or a stored URL.** `getPodcast(feedId)` (`/api/feed?id=`,
  the `?feed=<id>` deep link), the `feedId` fallback in `/api/item-value`, and saved playback state
  (`bmb:now_playing`, `bmb:play_history`, queue entries, per-show settings keyed by feed id) keep
  what they hold. A favorite opened from `/favorites` is unaffected, because its row carries the
  twin's feed id once the guid resolves. The PR states this gap.
- **No offer when a same-guid twin exists but a favorited item's guid is not on it.** Measured:
  the Worried track's item guid is on the twin. A host that re-imports with new item guids would
  need a "same feed, new item" offer; that is a later change.

## Anti-goals

- **A favorite replaced without a press.** A title-and-artist match can be wrong ("Runaway Train"
  matches four unrelated feeds by title alone), and a swap changes a shared list other apps read
  and, through the new feed's value block, who a boost pays.
- **A swap that drops a track it could not place.** An unmatched track stays on the list under its
  old guid. Losing a favorite is worse than keeping a dead one.
- **A swap that touches a `carried` entry.** It lives in the half this device does not write
  (`localFavoriteEntries` skips it). A carried row shows the candidate as information, no button.
- **A slower resolve for healthy feeds.** A feed not on a closed host costs zero extra requests.
- **A re-resolve that drops `carried`.** Today's post-resolve merge in
  `lib/nostr/favorites-hydrator.ts` rebuilds a row from `favoriteFromPodcast`/`favoriteFromEpisode`
  and loses `carried`. Goal 5 sends more rows through that merge, so the merge must keep
  `prev.carried` (set THIS cycle by the paint loop, so it is not stale).

## Constraints (from the repo)

- A Podcast Index miss (400/404) is `null` **in the wrapper**; 429/408 is "could not ask", never
  `null`; a 5xx throws. The twin search follows the same rules: a failed search is "no answer",
  never "no twin", and is not cached.
- The batch three-state contract (`lib/pi-batch.ts`): key present with a value, present with
  `null`, ABSENT = could not ask. A twin lookup that fails leaves the dead record in place (it is
  still PI's answer); it never turns a key absent or `null`.
- Fan-out is bounded with `mapLimit`/`PI_FANOUT`, never a bare `Promise.all` over a list.
- Only an RSS document names a payee. A same-guid switch changes which RSS document is read (the
  live one); the boostagram's `remote_feed_guid`/`remote_item_guid` are unchanged because the
  guids are unchanged.
- Favorites writes go through the store and `requestFavoritesSync`, which already handles the mode
  (`public`/`private`/`off`/never chosen), a degraded read and a refused publish (`null`).
- Pure functions a check script pins live in an import-free leaf (`scripts/import-free.mjs`).
- Per-IP limits are sized against a ~231-entry list; a new route needs its own `rateLimit`.

## Approaches

**Detection — how the app knows a feed is dead.**

| Approach | Cost | Verdict |
|---|---|---|
| Podcast Index's `dead` / `lastHttpStatus` | free | **Fails**: PI reports the RSS Blue feeds as `dead: 0`, status 200. |
| PI crawl age (`lastCrawlTime` older than N days) | free | **Fails**: in Chad's list 14 LIVE feeds were last crawled more than 180 days ago (wavlake, doerfelverse, behindthesch3m3s…), mixed in with the RSS Blue ones (331–464 days). |
| Probe each feed URL (GET, 404/410 = dead) | one fetch per favorite per cold resolve | General, but it puts a third-party fetch behind every one of ~231 resolves to find fifteen. |
| **A list of closed hosts** (`CLOSED_HOSTS`) | free | **Chosen.** Exact for the measured problem, zero cost for healthy feeds, testable. Adding the next closed host is one line plus its measurement. |

A probe can be added later behind the same `feedIsClosed` question if a second host closes
silently; nothing in this design depends on the list being the only signal.

**New-guid matches — Chad chose "ask first"** over "same guid only" (brings back one album) and
"swap automatically on a title-and-artist match" (wrong-match risk, changes the shared list and
the payee without asking).

## Design

### Closed hosts (`lib/moved-feeds.ts`, import-free, pinned by `check:moved`)

```ts
export const CLOSED_HOSTS: { name: string; hosts: string[]; since: string }[] = [
  { name: 'RSS Blue', hosts: ['feeds.rssblue.com', 'media.rssblue.com'], since: '2026-11-14' },
];
/** The closed service a URL belongs to, or null. Matches the URL's own host, and a closed host
 *  that appears as a PATH SEGMENT behind an analytics prefix (op3.dev/e,pg=…/media.rssblue.com/…,
 *  podtrac …/redirect.mp3/media.rssblue.com/…). */
export function closedService(url: string | null | undefined): string | null;
```

Also in this leaf, all pure: `normTitle`, `pickLiveTwin(dead, searchFeeds)` (same guid, different
id, not closed, **same normalized author as the dead record** — Podcast Index holds copycat feeds
that reuse a guid, and a twin is about to receive boosts with no press; measured: both copies of
Worried say "Suzanne Santo" — then the newest `lastCrawlTime`, then the highest id),
`movedCandidates(dead, searchFeeds)` (different guid, not closed, normalized title equal,
normalized artist equal — BOTH, never the title alone), `matchTracks(oldTracks, newItems)` (by
normalized title; one-to-one; unmatched reported), and `planSwap(...)` (below).

### Same-guid switch (server, `lib/pi.ts` + `lib/pi-batch.ts`)

- `liveTwinFor(rawFeed)`: if `closedService(rawFeed.url)` is null, return null with NO request.
  Otherwise `GET /search/bytitle?q=<title>&max=50&similar`, then `pickLiveTwin`. Server-side
  bounded cache keyed by guid: a twin or a definite "none" for 24 h; a failed search is not cached.
- `getPodcastByGuid` and the index branch of `batchPodcasts` return the twin's `Podcast` when one
  exists. The batch runs `liveTwinFor` only over the records on a closed host, through `mapLimit`
  at `PI_FANOUT`.
- `getEpisodeByGuid(feedGuid, itemGuid)` and `batchEpisodes`: when the answer's enclosure or feed
  image is on a closed host (zero extra cost otherwise), resolve the twin for `feedGuid` and ask
  `/episodes/byguid?guid=<item>&feedid=<twin id>`. A miss there keeps the original answer.
- `resolveOneSplit` (a `valueTimeSplit` remote item): its own raw `/podcasts/byguid` read of the
  feed URL goes through the same twin step, so a window naming a moved album pays from the live
  feed's RSS. Without it, such a window pays no one (today's behaviour: the dead RSS answers 410).
- **Payment follows the switch on every path.** Because the twin step is inside
  `getPodcastByGuid`, every payee read through a guid moves to the twin's RSS value block with no
  separate press: `/api/item-value` (a boost or a stream on the Worried favorite), `/api/feed` for
  the opened show, and `resolveOneSplit`. **Chad, 2026-11-14: payment follows the switch** (asked
  as "payment follows the switch" vs "display and playback switch, payment waits for a confirm";
  he chose the first). The copycat guard in `pickLiveTwin` (same normalized author) is what makes
  that safe to do with no press.

### Candidates for a new guid (server, `GET /api/moved?guid=<feed guid>`)

- 400 on a missing or over-long guid; `rateLimit(req, 'moved', 120)`.
- Reads PI's record for the guid. If the feed is not on a closed host, or a same-guid twin exists,
  answers `{ candidates: [] }` (the resolve already switched).
- Otherwise `/search/bytitle` (title) and `/search/byterm` (author), `movedCandidates`, at most
  three, each with its items (`/episodes/byfeedid?id=<id>&max=200`, normalized with
  `episodeFromPiRecord` to full `Episode` records, value block stripped — the swap writes them as
  favorites, and the hydrator does not re-resolve a row it already holds, so a `{ guid, title }`
  stub would stay without a cover), through `mapLimit`. Answer `{ service: 'RSS Blue', candidates: [{ podcast, items }] }`,
  `Cache-Control: public, s-maxage=86400` on success, `no-store` on a could-not-ask.

### Client

- **Cache re-resolve (goal 5).** In the hydrator's paint loop a cached show re-resolves when
  `!hit.artwork || closedService(hit.url)`; a cached item when `closedService(hit.enclosureUrl ??
  hit.image)`. `lib/podcast-meta.ts` treats a `bmb:pmeta`/`bmb:epmeta` hit on a closed host as a
  miss, so the warm and `resolveVia` ask the server again. The post-resolve merges keep
  `carried: prev?.carried` (anti-goal).
- **Rows.** `components/lists/favorites.tsx`: a feed row or item row whose resolved feed/enclosure
  is still on a closed host (no twin) mounts `<MovedOffer guid=… />`. It asks `/api/moved` once
  per guid per page load (module-level promise map; at most 3 in flight), renders nothing until it
  answers and nothing on an empty answer. Text sketch at 390px:

  ```
  [W]  Mr. Videoman                                  [♥]
       Prosperous Soul
       RSS Blue closed. Found:
       Mr Videoman — Prosperous Soul · Fountain  [REPLACE]
       Mr. Videoman — Prosperous Soul · Wavlake  [REPLACE]
  ```

  A carried row shows the same lines without the buttons.
- **No re-ask loop.** A row that re-resolved and is still on a closed host (no twin) is marked in
  a module-level set for the tab, so it is not re-resolved again on the next paint; `bmb:pmeta`
  keeps skipping closed-host hits on the next page load, which re-asks once per load for the few
  dead rows (15 on Chad's list).
- **REPLACE.** `planSwap({ favorites, favoriteEpisodes, oldGuid, candidate })` (pure) returns
  `{ removeFeed?, addFeed?, removeItems[], addItems[], unmatched[] }`; it never lists a carried
  entry, never removes an unmatched track, and skips an add whose new guid is already a favorite. The component applies it with the store actions and
  calls `requestFavoritesSync(identity)` once. The new rows are built with `favoriteFromPodcast`
  and the episode builder the heart uses, so `addedAt` is the old row's (the list order does not
  jump) and `medium` comes from the new feed.

## Testing

- `npm run check:moved` pins `closedService` (own host, op3 prefix, podtrac prefix, a lookalike
  `media.rssblue.com.evil.example`, a non-URL), `pickLiveTwin`, `movedCandidates` (title-only
  match refused; artist-only match refused; closed-host candidate refused), `matchTracks`,
  `planSwap` (carried skipped; unmatched kept; feed row vs item row).
- A check that the hydrator merge keeps `carried` (whichever of `check:favsync` or a new section
  fits the module's existing pins).
- Real browser, local dev server, local relay seeded with Chad's PUBLIC tags under a throwaway key
  (the harness used for the 2026-11-14 diagnosis): Worried shows the Fountain cover and plays the
  Fountain enclosure; Mr. Videoman shows two candidates; REPLACE on the Fountain one publishes a
  kind:10333 to the local relay with the new guid, without the old one, and with every unmatched
  track still present. A device whose cache holds the dead Worried URLs (seeded `bmb:favorites:`)
  switches after one load.
- Mobile: the offer row at 390×844 with CDP device emulation — no horizontal overflow, REPLACE at
  least 24×24 CSS px.
- `npm run e2e:favorites`, `typecheck`, `lint`, `check`, `build`.

## Calls made by the designer

- Detection by a closed-host list, not a probe (measurements above).
- The automatic switch lives in the server resolvers, so playback, deep links, podroll and the
  queue get it too — not only `/favorites`.
- Two candidates both shown; Chad picks. No ranking between Fountain and Wavlake.
- A candidate needs the same normalized title AND artist; a same-guid twin needs the same
  normalized artist too (copycat guard).
- Feed-ID paths and saved playback state are out of scope (Non-goals); the PR names the gap.
- Item guid missing on a same-guid twin: no offer in this change (Non-goals).
- The swap keeps the old `addedAt`.

## Left to the builder

- Exact normalization (`Mr. Videoman` = `Mr Videoman`: lower-case, strip punctuation, collapse
  spaces).
- Where `<MovedOffer>` sits inside each row and its exact wording within the sketch.
- The bounded-cache sizes.
