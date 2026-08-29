# Feeds and API routes — PI, RSS enrichment, podroll, the breaker

Read before touching `app/api/*`, `lib/pi.ts`, `lib/podcast-meta.ts`, `lib/live-status.ts`, or `components/podroll.tsx`.

Core rules live in [`../CLAUDE.md`](../CLAUDE.md); this file holds the reasoning.

## Feed ordering + RSS enrichment (`/api/feed`)

`app/api/feed/route.ts` builds the episode list from PI's `/episodes/byfeedid`, then enriches and re-sorts. `getRssEpisodeEnrichment(podcast.url)` fetches the raw RSS **once** and returns `{ episodes, feedMedium, feedPodroll, feedFunding }` (`RssFeedEnrichment`): a per-guid map of fields PI doesn't index, plus channel-level `<podcast:medium>`, `<podcast:podroll>` and `<podcast:funding>`.

**Why RSS, not just PI:** PI's episode API surfaces only the iTunes namespace (`itunes:season`/`itunes:episode`), not the Podcasting 2.0 `<podcast:season>`/`<podcast:episode>` tags many music album feeds use. So `buildEpisode` leaves `season`/`episode` null for those, and without the RSS pass the music sort treats every track as `season=1, episode=0` → tracks render in date order, not track order.

- **Per item:** `<podcast:season>` (prefer the `number=` attr, else text) and `<podcast:episode>` (text, falling back to `<itunes:episode>`), merged as fallbacks only when PI's value is null (`season: e.season ?? rss?.season ?? null`). **Both readers go through `parseSeasonEpisode` (`lib/pi.ts`), and that exists because the two copies had already drifted:** only `getFeedFromRss` carried the `<itunes:episode>` fallback, so a feed numbering its items the iTunes way was ordered correctly in the not-in-PI preview and arbitrarily here. `lib/types.ts` documents `Episode.episode` as "`<podcast:episode>` / `<itunes:episode>` if present", so the enrichment copy was the one out of step with stated intent — unified onto the fallback. The season/episode asymmetry (attribute vs text) is the spec, not a bug, and `Number(s) || null` maps both a non-numeric string **and a literal 0** to null deliberately: item numbering is 1-based, so a 0 means the feed wrote something unusable. Same pass carries `socialInteract`, the show-notes HTML, `<podcast:transcript>`, and `<link>` (the episode web page → `Episode.link`, surfaced as **"Episode page ↗"** under the notes, since feeds often abbreviate `<description>`).
- **Funding:** `<podcast:funding url>message</podcast:funding>` (channel-level, `parseFunding`) → `Podcast.funding` (also read from PI's `funding` in `buildPodcast`), rendered as `[⊙ SUPPORT]` (its own `CoinIcon`) in the `EpisodeList` header **and on the episode detail page** (order `SHARE · SUPPORT · BOOST`). PI's by-guid/search lookups don't index the funding tag — only this RSS pass does — so the episode page (which reads `selectedPodcast`) would otherwise miss it. `EpisodeList` and the cold deep-link restore call **`syncSelectedPodcast(p)`** to push the RSS-enriched podcast back into `selectedPodcast` for the *same* show without disturbing episode/discussion navigation.
- **Nostr identity — TWO conventions, both read by `parseFeedNpubs` (`lib/feed-xml.ts`).** `<podcast:txt purpose="nostr|npub">npub1…</podcast:txt>` is the feed's claim about *itself*; `<podcast:person npub="npub1…">Name</podcast:person>` is a claim about a *participant* and is the only one that scales past a single identity, since it's per-person and legal per-`<item>` — that's where a guest, a featured artist or a second co-host gets named. The `npub` attribute isn't in the spec's list (href/img/role/group) but is written in the wild (MSP 2.0 emits it on music feeds, alongside a matching `<podcast:txt>` holding the same key). **`txt` entries come first because the cap truncates**, and the union is deduped by pubkey — a feed naming one person in both places yields exactly one `p` tag, not two notifications per boost. Parsed at **both** levels — channel → `Podcast.nostrNpubs` (the show/album artist), item → `Episode.nostrNpubs` (a specific track's artist) — and `p`-tagged on boost notes, see [`nostr.md`](nostr.md). PI indexes no `<podcast:txt>` in any endpoint, so like podroll and funding this is RSS-only, and `/api/by-guid` (pure PI JSON, no RSS pass) never carries it. **Filter on `purpose`, against the `NOSTR_TXT_PURPOSES` allowlist** — `<podcast:txt>` is a general container and the same feed routinely carries `verify` / `applepodcastsverify` tokens; an unqualified tag is not an identity claim. **The spec registers no vocabulary for `purpose`, so hosts picked their own spelling and both are live: Podhome writes `purpose="npub"`, others write `purpose="nostr"`.** Shipping with only `nostr` made a feed that *does* declare an npub look exactly like one that doesn't — the first real boost tagged nobody, and nothing in the app could tell you why (which is what `probe:npubs` below exists for). Add a spelling to that set when one is observed, naming the host. Widening it stays safe **only because the value is still checksum-validated**: the allowlist picks which tags to look at, `nip19.decode` decides what's accepted. Don't collapse it into "any purpose whose value happens to decode". **Parse the channel level from `channelSlice(xml)`, never raw XML** — a `<podcast:liveItem>` in the channel header carries its own `<podcast:txt>`, and reading that as the show's npub would tag one broadcast's guest on every boost forever. The parser lives in `lib/feed-xml.ts` rather than `pi.ts` so `npm run check:npub` can import the real function: `pi.ts` isn't loadable by `node --experimental-strip-types` (`PiHttpError` uses a parameter property). `readAttr`, `decodeXmlText` and `channelSlice` moved there with it — one copy, imported back into `pi.ts`. **`npm run probe:npubs -- <feedUrl>`** answers "does this specific feed actually declare one" against a live feed: it prints every `<podcast:txt>` verbatim *and* the subset that survives validation, so a tag that's present but rejected (wrong `purpose`, an nprofile, a typo'd npub) is distinguishable from no tag at all — which is the one question `check:npub`'s synthetic vectors can't answer.
- **Channel:** `<podcast:medium>` from the XML slice before the first `<item>` → `feedMedium`. The music check is case-insensitive **and** falls back to RSS (`isMusic = isMusicMedium(podcast) || feedMedium === 'music'`), because PI doesn't reliably index `medium` either. The route then **backfills `podcast.medium` from `feedMedium`** before responding — the client only receives `podcast.medium`, and every client-side `isMusicMedium(podcast)` check depends on this. `<podcast:podroll>` comes off the same slice.

**Sort order:** live (live > pending, `LIVE_RANK`) first; **music feeds** by `season` (disc) then `episode` (track) ascending; everything else by `datePublished` desc. Enrichment is best-effort — a failed RSS fetch falls back to empty values, leaving episodes unenriched rather than breaking the feed. `getRssEpisodeEnrichment` has a single caller; changing its return shape means updating that `.catch()` fallback too.

**The music-vs-date half of that is `compareEpisodeOrder` (`lib/util.ts`), shared with `getFeedFromRss` — do not restate it here.** It was written out twice, once in this route's sort and once in the raw-RSS preview path, and each copy's comment named the *other* as the authority ("same rule as /api/feed" / "matches /api/feed"). Two implementations of one rule with nothing keeping them equal, and the divergence would have been silent: the same album served through the PI-backed route and through the not-in-PI preview would list its tracks in different orders, with nothing on screen reporting a fault. On a music feed that order is also what the player's prev/next walks, so it is the running order of the record, not a display detail.

It returns a comparator rather than sorting, because this route needs it as the **tail** of a larger sort — the live ranking above is this route's own concern and stays here. It lives in `lib/util.ts` because that file's only import is type-only, which keeps it loadable under `node --experimental-strip-types`; see [`../CLAUDE.md`](../CLAUDE.md)'s note on why that import line is load-bearing.

**The two defaults are asymmetric on purpose.** `season ?? 1` treats an untagged item as disc 1, because most albums are single-disc and tag no season at all. `episode ?? 0` sorts an untagged track to the **front** of its disc. They don't match and shouldn't be "tidied" to.

**Live-item status is polled, because `/api/feed` is fetched once.** `EpisodeList` loads the feed once per `feedId` mount and nothing asks again, so a `<podcast:liveItem>` going `pending` → `live` was invisible to anyone already on the page — and `liveStatus === 'pending'` disables the row's play button, so the stale badge locked the listener out at the exact moment they wanted to press play. Observed on Mutton, Mead & Music: the feed read `status="live"` while the page read PENDING, and a hard refresh fixed it.

`useLiveStatusPoll` (`lib/use-live-status-poll.ts`) polls **`/api/live-status?id=<feedId>`** every 45 s (30 s floor, `document.hidden` gate, `visibilitychange`/`focus` triggers — the `nostr-live-streams.tsx` pattern) while the loaded feed has an item with a non-`ended` `liveStatus`. A show without one never polls.

- **The route is RSS-only — no PI `/episodes/live` call.** PI lags the transition badly: when this was caught, the publisher's feed said `live` while PI returned **zero** live items for the feed. It uses `fetchFeedXml`'s per-caller `maxAgeMs: 10_000`, so the shared 60 s window `/api/feed` depends on is untouched, and it caches for 10 s so several listeners on one show collapse to one upstream fetch. `/api/feed`'s own `s-maxage=300` is what made a hard refresh necessary and deliberately does not apply here.
- **An unreadable feed answers 503, never an empty 200.** `getLiveItemsFromRss` returns `[]` for both "no live items" and "couldn't read the feed", so `getLiveItemsFromRssDetailed` exists to carry `ok`. Without it one failed publisher fetch mid-broadcast tells the client every item ended — stripping a LIVE badge, and on a `pending` item *enabling* play for a stream that hasn't started.
- **`applyLiveStatuses` (`lib/live-status.ts`) only touches episodes that already carry a `liveStatus`**, so a regular episode can never be marked ended. It returns the same array reference when nothing moved, so a quiet poll costs no re-render, and it preserves a `startTime` the feed stopped publishing rather than erasing the "started …" line.
- **A guid-less episode is left untouched, forever — it is not evidence the broadcast ended, only that it can't be matched.** Matching is by guid; a `<podcast:liveItem>` genuinely reaches the client with none (`getLiveItemsFromRssDetailed` synthesizes its own id from `guid ?? title ?? …` for exactly this reason). Folding "unmatchable" into "absent, therefore ended" would end every guid-less live item on its very first poll.
- **Ending a guid-bearing episode takes TWO CONSECUTIVE misses, not one.** `/api/feed`'s own merge comment says PI wins on collision because it "carries the canonical 'live' transition the publisher's RSS may lag on" — but this poll is RSS-only (see above), so a live item PI would show that the RSS doesn't carry yet, or one a parse hiccup missed, is absent from an otherwise-successful poll and would be ended on the spot. `applyLiveStatuses` instead takes and returns a per-guid miss counter (`Record<guid, number>`, threaded through the caller's `useRef`, reset whenever `feedId` changes so a stale count can't carry from the previous show): one miss just increments it, the second consecutive miss ends the item, and any response that *does* contain the guid resets the counter to 0 — including reviving an already-`'ended'` episode, since a guid reappearing is a rebroadcast. A genuinely finished broadcast is still absent ~45 s later and ends there; the cost of the safety margin is one extra tick, which is cheap next to wrongly-ended being invisible and permanent.
- **The hook polls once immediately on activation**, not only on the first interval tick — `/api/feed` can already be up to ~5 min stale (its own `s-maxage=300` plus the 60 s RSS cache), so waiting out the first 45 s on top of that leaves a stale `pending` badge — and the disabled play button that comes with it — for no reason. The 30 s floor still stops it stacking with a `focus` that lands moments later.
- **`setEpisodeQueue` and `syncSelectedPodcast` are deliberately not re-fired** — only the two live fields are patched, so playback is undisturbed. Known consequence: `episodeQueue` keeps the pre-flip episode objects until the next full feed load, which affects prev/next nav only. Same family: an item that flips to `'ended'` keeps its position in the list — `isFirstLive` in `components/lists.tsx` is still truthy for `'ended'` and the list isn't re-sorted after a patch, so a finished broadcast sits under "Live & upcoming" with no badge until the next full feed load.
- **Preview (not-in-PI) feeds never poll.** `EpisodeList` synthesizes a negative `feedId` for them, which the route rejects as non-positive — harmless today only because `getFeedFromRss` never surfaces a `liveStatus` for a preview feed, so `hasLiveItem` is always false and the hook never fires a request. Worth knowing so it doesn't silently start 400ing every 45 s if preview feeds ever gain live items.
- **Out of scope:** a live item published *after* page load won't appear (that needs replacing the live section, not patching fields), and Nostr kind:30311 streams are untouched — `nostr-live-streams.tsx` polls itself.


## How many episodes a feed serves

`/api/feed?id=` asks PI for **`PI_EPISODE_MAX` (1000)** items, not the 50 it used to. The number is PI's own ceiling for `/episodes/byfeedid`, and it is a ceiling rather than a page size because **that endpoint has no offset and no "older than" parameter** — `max` is the only lever it exposes. So an item the first call doesn't ask for is an item no later call can fetch: there is no "load older episodes" request to make, and the reader simply never sees it. That is what the 50 cost — an episode past the newest 50 was unreachable in the list, unfavoritable, and `loadEpisodeFromFeed` returned `null` for a favorite of one.

Three things follow, and they are the reason the number isn't simply raised and forgotten:

- **The upstream read cap has to scale with the ask.** `getEpisodes` sends `fulltext`, so PI returns every description untruncated and the body grows with `max`. `pi()` reads through `readCappedText`, whose 8 MB default a 1000-item archive show can pass — and passing it **throws**, which `withErrorHandling` turns into a 500 on the whole show page. A feed that worked while it was truncated would break outright once it wasn't. `pi()` therefore takes an optional `maxBytes` and `getEpisodes` scales it (24 KB per requested episode, well past any real one) for asks over 100.
- **The response has a byte budget, and prose is shed before rows are.** Vercel's Node runtime refuses a non-streamed response over 4.5 MB, so `fitEpisodesToBudget` caps the serialized `episodes` array at 3.5 MB. It sheds `contentEncoded` from the oldest episodes first, then `description`, and only drops whole episodes when shedding every word in the feed still isn't enough. That order is the point: **no list row renders either field** — only `<EpisodeDetailView>` does, and it already renders a notes-less episode — so a stripped episode still lists, plays, favorites and boosts, while a dropped one is invisible. Measured against synthetic worst cases, a 1000-item feed keeps every row up to ~76 MB of raw prose. The raw-RSS preview path (`?url=`) goes through the same function: it reads every `<item>` in a document `safeFetch` accepts up to 8 MB, so it has always been able to build a body the platform will not send.
- **`/api/value-splits` uses the same constant, twice over.** An episode the list can show must be one that route can find the tracks for — it looks the episode up by id inside `getEpisodes(feedId, …)`, so a smaller `max` there means a boost inside a `<podcast:valueTimeSplit>` window 404s on exactly the older episodes this change made reachable. The identical PI URL also shares `/api/feed`'s Next fetch-cache entry instead of opening a second one.

**The client reveals rows, it does not fetch them.** `<EpisodeList>` opens at 10 rows and adds `PAGE_SIZE` (50) per press of "Load more episodes"; the fetch is one call and the button is pure rendering. The step is bigger than the opening count because 10 at a time is a hundred presses to reach the bottom of an archive show. It stays a **button** rather than infinite scroll for the reason it always has: the Nostr comments feed sits below the list and has to keep a stable, reachable position on mobile. Music feeds still render the whole album at once (track order is the running order of the record) — covers are `loading="lazy"`, so a long playlist costs DOM, not requests.

**When the list is short of the feed, it says so.** The route sets `truncated` when PI returned its ceiling or the budget dropped rows, and `<EpisodeList>` renders one line under the last row: *"Older episodes exist, but this feed is longer than the app can load in one go."* A list that simply stops is indistinguishable from a show that stopped — which is exactly the report this change came from — and the two causes are indistinguishable from the reader's side, so the sentence names neither. Hitting the ceiling **exactly** is read as truncation on purpose: a feed of exactly 1000 items over-reports, which costs a sentence, while under-reporting costs the reader the answer.

**The one case still truncated is a feed longer than 1000 items.** PI cannot serve past that in one call and has no way to page backwards, so the tail of a very long-running daily show is out of reach through this route. The RSS document holds it — `getRssEpisodeEnrichment` already parses every `<item>` — but RSS-derived episodes carry synthetic negative ids (`-fnvHash`), which `/api/value-splits` and the live-status poller both key off, so unioning them into a PI-backed list is a bigger change than a number.

## musicL playlists (`<podcast:medium>musicL`)

A **playlist** feed publishes **no `<item>` elements at all**. Its contents are channel-level `<podcast:remoteItem feedGuid=… itemGuid=…/>` entries, each naming one item that lives in somebody else's feed.

**It is not just `musicL`.** The spec gives every medium an `L`-suffixed "list" counterpart and says a list feed "is intended to exclusively contain one or more `<podcast:remoteItem>`s", so `LIST_MEDIUMS` in `lib/util.ts` is the whole set — `podcastL`, `musicL`, `videoL`, `filmL`, `audiobookL`, `newsletterL`, `blogL`, `publisherL`, `courseL`, `mixedL`. It is an **allowlist, never `endsWith('l')`**: no standard medium happens to end in `l` today, so the loose test passes right now and silently widens the day one does — and `medium="cool"` would already be a playlist. The LocalBitcoiners community list in the collection is a real `podcastL` with 949 entries and the identical wire shape.

**`isPlaylistMedium` and `playsAsTracks` are deliberately different gates.** The first asks *is this a playlist* (how it PAGES); the second asks *are its rows tracks* (how a row BEHAVES), and only `music`/`musicL` answer yes. A `podcastL` row is a podcast episode, so a tap must open the detail view — its notes, chapters, transcript and discussion are the reason somebody taps it. Collapsing the two looks like a simplification and turns every podcast playlist into a jukebox. `targetWord` follows suit: the container word comes from the first gate, the item word from the second, so **"PLAYLIST · EPISODE" is a correct pairing**. The reference case is [chadf-musicl-playlists/HGH-music-playlist.xml](https://raw.githubusercontent.com/ChadFarrow/chadf-musicl-playlists/refs/heads/main/docs/HGH-music-playlist.xml): 233 KB, **1770 entries of which 1217 are distinct, across 598 feeds**, and not one `<item>`.

Before this shipped the app opened one as a show with no episodes — `getFeedFromRss`'s `<item>` loop finds nothing — which is indistinguishable from a broken feed.

**The entries carry no `feedUrl`.** Only the guid pair, so a track is resolved through Podcast Index (`/episodes/byguid`) and nothing else. That is one PI lookup per track, which is why the whole list is not a request anybody can make.

### The parser lives in `lib/feed-xml.ts`, and its exclusions are the correctness half

`parsePlaylistRemoteItems(channelSlice(xml))`. It is in `feed-xml.ts` rather than `pi.ts` for the same reason `parseFeedNpubs` is: that module loads under `node --experimental-strip-types`, so `npm run check:musicl` pins the **real** parser instead of a copy. `pi.ts` cannot be loaded that way (`PiHttpError` uses a parameter property).

Three things it must exclude, and each one over-accepted is rows in the list the curator never published:

- **`<podcast:podroll>` contents** — stripped by the parser itself. `parsePodroll` scopes itself *into* the block so the two don't collide from that direction, but a channel-wide scan reads the host's recommended **shows** as songs, and nothing on the entry says which it is. The nesting is the only signal.
- **`<podcast:liveItem>` blocks** — already stripped by `channelSlice`, which is why the input must be that and never raw XML. A live item's own `<podcast:remoteItem>` is the "now playing" pointer (`Episode.liveRemoteItem`), i.e. one broadcast's current song.
- **An entry missing either guid** — an item guid alone is not a lookup key, and a `feedGuid` + `feedUrl` pair is podroll-shaped.

**Order is the data, and dedupe is mandatory.** A playlist's running order is the order the entries are written in; nothing on an entry restates it, unlike an album whose tracks carry `<podcast:episode>` numbers. So the parser never sorts, and dedupe keeps the **first** occurrence. Dedupe is not cosmetic: `playNext`/`playPrev` locate the current track with `findIndex(e => e.id === …)` and a row's React key is that id, so two rows sharing one make the second unreachable.

`MAX_PLAYLIST_REFS` (5000) caps the list because it is feed-supplied and `safeFetch` accepts 8 MB — roughly 88,000 entries, i.e. one document deciding how much this process allocates.

### `/api/playlist` — one page, and why it is its own route

```
GET /api/playlist?url=<feedUrl>&offset=0&limit=100
  → { podcast, episodes, total, offset, nextOffset, notFound, couldNotAsk }
```

- **A GET, not the existing POST `/api/episode-by-guid/batch`.** That route's body is per-user so it sets no cache header. A playlist page is public and byte-identical for every viewer, and a shared cache answering it is the whole thing that keeps thirteen pages of one playlist off PI's quota. It is also why the guids stay server-side: a short URL is cacheable, a hundred item guids (routinely permalink URLs) are not.
- **`limit` is clamped to `MAX_BATCH` (100)**, so one page is at most one `batchEpisodes` call and there is no second fan-out ceiling to keep in sync.
- **`offset`/`limit` are digits-only.** `Number('0x64')` is 100 and `Number('1e3')` is 1000; `parseInt('64abc')` is 64. Each yields a plausible page the caller never asked for, and every distinct spelling of one number is another CDN entry for bytes we already hold — the amplification `artWidth` documents.
- **`nextOffset` is the server's answer and the client uses it verbatim.** Deriving `offset + limit` on the client desyncs the moment dedupe or the ref cap removes anything, and the symptom is skipped tracks — which nobody can see.
- Rate limit **30/min**, with `/api/publisher` and the batch routes, because it fans out to PI.

**The `podcast` it returns carries no `podcastGuid`**, even though a playlist does publish a `<podcast:guid>`. `previewPodcastFromChannel` withholds it deliberately: PI has not indexed these feeds, so `/podcasts/byguid` cannot resolve one on any device, and a feed favorite writes that guid to a shared kind:10333 list with no undo — an unopenable placeholder forever. Being present on the wire is not the test; being resolvable is.

### The three-state contract reaches the screen

`batchEpisodes`' answer is carried through, never flattened. **Every ref yields a row** — a dropped row is invisible, and an invisible track makes the playlist look shorter than the curator published it, with no way to reach it because `nextOffset` steps past.

| `batchEpisodes` | Row | Line under the list | Cacheable |
|---|---|---|---|
| key present, `Episode` | full row: cover, play, ⚡ V4V, BOOST, heart | — | yes |

**The ⚡ and the BOOST in that first row are not free — they are a second resolution pass, and without it every one of them is dead.** See *Whose value block pays a playlist row* below.
| key present, `null` | placeholder, `unresolved: 'not-found'`, play suppressed | "N … aren't in Podcast Index yet" | yes |
| key **absent** | placeholder, `unresolved: 'could-not-ask'` | "N … couldn't be looked up" + ↻ RETRY | **no** |

The absent case drives the cache header: `couldNotAsk > 0` answers `Cache-Control: no-store`. Without that a PI outage during one page is frozen into the CDN for five minutes and the retry re-serves the same empty page. `notFound` rows *are* cacheable — PI answered.

A placeholder has an empty `enclosureUrl`, so the client **suppresses** the play control rather than disabling it. The heart stays, on `<FavTrackHeart>`'s precedent: the identifiers come off the wire and are the whole record, and withholding the control until PI has crawled the album would hide it on exactly the independent releases this app exists to pay.

### Whose value block pays a playlist row

**A playlist track arrives from Podcast Index with no value block, and the container's is the CURATOR's.** Both halves of that sentence were bugs, and each is invisible on its own.

`/api/playlist` resolves every row through `/episodes/byguid`, and PI's episode record carries a `value` only when the ITEM declares one. Most music feeds declare `<podcast:value>` once, on the album's CHANNEL, and let every track inherit it — which is exactly the fallback `resolveOneSplit` has always made for a `<podcast:valueTimeSplit>`, and exactly the one this route never made. So the block existed, the artist was payable, and the track shipped with `value: null`. The measured symptom is the whole feature going quiet: BOOST greys out on every track of every playlist, and **a disabled button is indistinguishable from a feature this app does not have** — it was reported as "why can't I boost this playlist or any others", not as a bug in a route.

`fillTrackValues` (`lib/pi-batch.ts`) is the pass, two stages, cheapest first:

1. **`batchPodcasts` over the DISTINCT parent feeds.** PI's *feed* record does carry the channel-level block — it is the same source `/api/feed` already trusts for every ordinary show's `e.value ?? podcast.value` — and the read index answers most of it in one round trip. No RSS at all, and the rows of one album cost one lookup between them.
2. **Read the album feed, item block then channel block**, for what stage 1 could not answer. That is `resolveItemValueFromRss`, which is `resolveRemoteItemFromRss`'s direct branch and **deliberately has no publisher walk**: that walk fans out to `MAX_ALBUM_FEEDS`, the page's feed list is curator-supplied, and nested the two multiply. Capped at `MAX_TRACK_VALUE_FEEDS` (16) distinct feeds per page, warned when it truncates, and sequential within one feed so the 5-minute `fetchFeedXml` cache serves the second track rather than a second fetch.

Rows are matched to their album by **`episode.podcastGuid`** — PI's answer for which feed the item actually lives in — never by the playlist's own `feedGuid`, which may name a publisher.

**And the container is never the fallback.** `payableValue` (`lib/util.ts`, pinned by `check:musicl`) replaced `episode.value ?? podcast.value` at every boost surface, including the unattended streaming payer. A playlist's own `<podcast:value>` belongs to the person who made the list, so falling through to it pays them for a song they had no part in: the modal renders a valid split, every leg reports ✓, and nothing on screen says the artist was never in it. Two independent signals refuse — the list MEDIUM, and an item whose `podcastGuid` disagrees with the container's — and the refusal is deliberately narrow in three places, because over-refusing hides BOOST on feeds that do declare a block: a SHOW-level boost on a playlist still pays the playlist, an episode with its own block is untouched, and the guid test needs BOTH guids present, since a feed PI has not indexed carries neither. That last one is the independent release this app exists to pay.

**Known gap, deliberately not closed in v1:** unlike `<FavTrackHeart>` there is no `parentFeedGuid` verdict here, so a playlist `feedGuid` naming a **publisher** feed would write an entry no app can open. `/api/remote-item` answers that question, but it is an RSS fetch plus a PI call per row and a page is 100 rows. Follow-up, not a per-row call.

### Both entry paths, and the fallback that makes the medium optional

`<EpisodeList>` takes `playlistUrl` when the caller already knows the medium (`<HomePage>` reads it off the search result), which skips a round trip. When it doesn't, the effect recovers one request later: **a musicL feed answering with zero rows is the same signal.** `/api/feed?id=` backfills `podcast.medium` from the RSS channel parse, so this works even though PI does not reliably index the tag. `episodes.length === 0` is part of that test on purpose — a hybrid feed that declares musicL and *also* publishes real items keeps its items.

The list is excluded from `<PodcastNostrFeed>`'s `episodeGuids`: those guids belong to other feeds' items, so asking for this feed's per-episode chatter with them pulls in notes about somebody else's album.

### Episode captions (`<podcast:txt purpose="episode">`)

Most of these playlists mark which show each run of tracks came from — HGH has 148 markers, MMM 151 — and the marker always sits **before** the run it captions. `parsePlaylistRemoteItems` reads captions and items in **one pass** so document order associates them; two scans could not, because a marker's only claim on a track is that it appears above it. The caption rides on each row (`Episode.playlistGroup`) rather than in a separate groups array, so a page appended by "load more" carries its own and the heading logic stays a comparison with the previous row — no state to keep in sync across a page boundary.

Three rules, all pinned: the `purpose` is **read** (every one of these feeds also carries `purpose="source-feed"`, and other feeds put verification tokens and npubs under the same tag, so an unqualified `<podcast:txt>` would print a feed URL as a heading); an empty marker **clears** the caption rather than captioning with a blank; and dedupe keeps the **first** occurrence, so a track replayed on a later show keeps the newest episode's caption, which is where a reader looks for it. Three playlists in the collection publish no markers at all (Greatest Hits, LocalBitcoiners, and the publisher feed), so the flat list is a first-class state, not a fallback.

### A publisher feed of playlists, and the one curated link

`chadf-musicl-publisher.xml` is a `medium=publisher` feed whose `<podcast:remoteItem feedUrl=…>` entries name the playlists. `<HomePage>`'s **BROWSE PLAYLISTS** button opens it through the publisher view that already existed — **one URL in the codebase, not a list of playlists.** A playlist added to the publisher feed appears the same day with no code change. (StableKraft takes the other road and hardcodes its twelve playlist URLs in five separate places; those five copies have already drifted from each other and from the collection's own `FEEDS.md`, and each lists a different subset.)

Two things had to change for that to work:

- **`/api/publisher` falls back to RSS for a child Podcast Index does not hold.** Nothing says a publisher's children were ever submitted to PI, and these are served off `raw.githubusercontent.com`. A `null` used to drop the child, so a publisher of unindexed feeds rendered as an **empty collection with no error** — the failure that reads as "this publisher has nothing". PI still wins wherever it answered; this only fills holes. The probe stays **uncaught**, so "PI is down" is still a 5xx and never a page of RSS-derived children pretending PI agreed.
- **A failed load is no longer rendered as an empty one.** `publisherError` separates "we could not fetch these" (message + retry, and **no count**, since `0 feeds` over a load error asserts the very thing we just said we could not determine) from "this publisher lists nothing". That mattered little while the only way in was pasting a URL; with a button on the home page, a PI outage would otherwise have told every visitor that the collection is empty.

**A Podcast Index 429 used to arrive as a 500, and the cause was the cap on the ERROR body.** `lib/pi.ts` built its `PiHttpError` as `new PiHttpError(res.status, await readCappedText(res, 4 * 1024))` — and `readCappedText` **throws** past its ceiling rather than truncating. PI answers a rate limit with a ~7 KB Cloudflare page, so the read threw while evaluating the argument, the `PiHttpError` was never constructed, and a plain `Error` reached `lib/api-handler.ts` and went out as a 500. Every PI-backed route failed at once with `response too large (exceeded 4096 bytes)` as the only clue, which reads as an app bug rather than as a rate limit. Losing the class is the expensive half: `getPodcastByFeedUrl` and every sibling test `e instanceof PiHttpError` to turn a 400/404 into a miss, and `lib/podcast-meta.ts` files 429/408 under `COULD_NOT_ASK` — an uncached null that deliberately does not trip the client-side breaker. A `.catch(() => '')` on that read fixes it; the status carries the meaning and the body is a courtesy.

**A 429 is not an outage, and `/api/publisher`'s probe now says so.** That probe is uncaught on purpose — `getPodcastByFeedUrl` already turns PI's 400/404 into a null, so a throw means PI is failing and the 5xx is what trips the client breaker. A rate limit was riding that path, and it should not: a 429 belongs in `COULD_NOT_ASK`, uncached and explicitly *not* breaker-tripping. One 429 was taking the whole collection to a 500, on a page whose children are plain XML on `raw.githubusercontent.com` that needs no PI at all — while `/api/playlist` served the same feeds from the same process, because `piRecordFor` already swallows this. So a **429/408 skips the PI fan-out entirely** (asking N more times cannot help, and spends quota we have been told we do not have) and every child falls through to the RSS repair. The answer is honest rather than degraded — the feed document is the authority, PI is the accelerator — and it is **`no-store`**, because those records carry no PI id or guid and caching them would serve the thinner version for five minutes after PI came back. Any other status still throws. `couldNotAskPi` rides on the response so a caller can say what happened.

**`/api/publisher` reports `listed` beside `feeds`, and a surface that states a count MUST compare them.** The route drops a child it can neither find in Podcast Index nor read from RSS, which is right — one dead entry must not cost the reader the other nine — but the survivors are then indistinguishable from the whole, and a caller holding only them prints that number as a fact about the collection. Reported 2026-08-29 as **"4 playlists" over a collection of eleven** while PI was rate limiting: no error, nothing on screen saying seven were missing, and it self-corrects on the next load, which is what makes it hard to report. `listed` is `albumUrls.length`.

**Known data bug in the collection, which does not affect us:** every `feedGuid` in the publisher feed disagrees with the `<podcast:guid>` of the playlist it points at (all nine). We resolve children by `feedUrl`, so nothing here breaks — but anything resolving that publisher by guid would find the wrong feed or none.

### Surfacing playlists in search

`/search/byterm` has **no medium parameter**, so a playlist Podcast Index ranks poorly — or has indexed under a title the query does not lead with — is unreachable by keyword however the user phrases it. `/podcasts/bymedium` can be asked for a medium directly, so `/api/search` runs it as a second lane beside byterm and prepends what byterm missed.

- **PI's documented enum for that parameter lists only the seven base mediums**, not the `L` variants. Whether the live index accepts `musicL` is therefore not something the docs settle. `getFeedsByMedium` treats a **400 as `[]`** — "no playlists of this kind" is the same answer as "this index will not be asked that" from the caller's point of view — so an index that refuses them costs one cheap 400 per medium and the lane simply stays empty. Only auth and 5xx propagate. Measured against a stub: all ten list mediums are asked, and the eight it rejected were skipped with no effect on the search.
- **The roster is cached hard, and a cold one is WAITED for — briefly.** List feeds are rare and slow-moving, so one refresh serves six hours (servable for 24). Skipping the lane outright on a cold roster was wrong for the one search that matters most: a playlist is a new kind of feed, so somebody typing a playlist's name is very often looking for exactly what this lane finds — and on a serverless runtime "cold" is not a once-per-deploy event, it is every new instance. A missing lane there makes the feature look broken, then work on a retry, which is the hardest failure to report and the easiest to dismiss. So a cold search waits up to `ROSTER_COLD_WAIT_MS` (1500 ms) and then goes without it, the refresh continuing behind for the next one. Measured against a stub: 0.71 s cold with the lane present on a healthy index, and exactly 1.55 s with no lane when the index takes six seconds — the search is never held hostage. That is the read-index rule again: this lane may be absent, and its absence must never be reported as "there are no playlists".
- **A refresh that nothing answered for is not cached.** `Promise.allSettled`, not `all` with a `.catch(() => [])`, because those produce the same value from opposite claims: a fulfilled arm is PI saying "none of this medium", a rejected one is us failing to ask. Flattening the second into the first writes an empty roster on one transient outage and serves it as fact for six hours — the lane silently ceasing to exist, with nothing on screen or in a log to say so. Verified by breaking the endpoint mid-run: the previous roster keeps serving and recovers when PI does.
- **The problem turned out to be RANK, not absence — and the first version only fixed absence.** Measured against the live index after deploy: `mutton` returned the Mutton, Mead & Music Playlist at position **eight**, under a dog-behaviour show and two mutton-cooking episodes. byterm had it all along, so a lane adding only what byterm *missed* changed nothing about the search somebody would actually run. `rankPlaylistsFirst` (`lib/util.ts`) therefore promotes matching playlists from **wherever they came from**, byterm's own results included, capped at `MAX_PLAYLIST_HITS` (6).
- **PI's own leader keeps its place.** It is nearly always the exact-name match, so displacing it answers a different question than the one asked: `flowgnar` returns the Flowgnar podcast then the Flowgnar playlist, which is already right, and a blind prepend would invert it. Everything *below* the leader is where a playlist gets lost — which is exactly where `mutton` buried one. A leader that is itself a playlist is already promoted and is not held back against itself. It promotes; it never re-ranks, so a query matching no playlist comes back in PI's order untouched. Pinned by `check:musicl` against the **real captured `mutton` and `flowgnar` responses** — synthetic lists would not have produced either case. `filterPlaylistsByQuery` (`lib/util.ts`, pinned by `check:musicl`) requires **every** term, re-checks the medium so a base-medium feed can never be stamped as a playlist, and matches nothing for an empty query.

**A pasted feed URL now falls back to RSS on a PI FAILURE, not only on a PI miss.** `getPodcastByFeedUrl` turns 400/404 into `null`, and only that null used to reach `getFeedFromRss` — an auth error or a 5xx propagated out as a 500. So the one input where PI matters least (the user handed us the URL; we can read it ourselves) failed hardest when PI was down: measured, pasting a playlist URL answered 500 while `/api/playlist` served the same feed's 1217 tracks from the same process. The PI error is remembered and **rethrown if the RSS read also comes up empty**, so a real outage still surfaces as a 5xx and "PI is down" never renders as "no such feed".

### The search type selector — and why it picks LANES, not a filter

`ALL · ♫ MUSIC · PODCASTS · PLAYLISTS · ⚡ NPUB`, a dropdown above the box (`<SearchTypeMenu>`; the form is in [`ui.md`](ui.md)). `type` rides on `/api/search` and `type=all` is the behaviour above, byte for byte — the selector can only ever narrow from a full answer, never replace one.

**Client-side filtering was the obvious build and it is the bug.** `/search/byterm` has no medium parameter and answers 50 ranked rows, so narrowing those rows here cannot reach an album Podcast Index ranked at position 60 — and the row is then simply absent, which reads as *"the index does not have this record"*. That is the same failure the playlist lane one section up exists to fix, arriving through a control the user pressed themselves. So each option runs its own server lane:

- **MUSIC** — `/search/music/byterm` (`searchMusicPodcasts`) beside byterm. **The music lane's rows are NOT re-checked against the medium and byterm's are**, which is the opposite of what `filterPlaylistsByQuery` does and is deliberate in both directions. Asking that endpoint *is* the medium question, and PI's own `medium` field can contradict the feed (feed 7683902 again), so re-filtering it discards exactly what it answered; byterm's rows carry no such answer, so they must pass `matchesSearchType`. `filterPlaylistsByQuery` re-checks because its output gets stamped `♫ PLAYLIST` on screen and a stamp is a claim — nothing here stamps anything. `mergeSearchLanes` (`lib/util.ts`) owns both halves.
- **PLAYLISTS** — the same two lanes `rankPlaylistsFirst` merges, minus the promotion: with nothing but playlists on screen there is no PI leader to hold back. byterm's hits lead because they are ranked answers rather than substring matches over a roster.
- **PODCASTS** — byterm, filtered. **A RESIDUAL bucket — "not music, not a list medium" — never `medium === 'podcast'`.** PI leaves the tag blank on a large share of what it holds, so an inclusion test empties the chip of most of the index, silently. A `medium=publisher` collection lands here too: a mild mislabel, against the alternative of a feed reachable under no option but ALL, and the row already carries its own `▸ ALBUMS` stamp.
- **NPUB** — never reaches the server at all, and is the **only** mode that looks a pasted key up. Every other one treats an npub as ordinary text and searches for it as typed; a row offers this mode in one press so that does not read as a dead end. That makes NPUB the strongest form of the `nsec` guard — no request is issued — but the guard itself stays unconditional across all five modes, because `looksLikeSecretKey` answers a different question from "did this parse". A name typed under NPUB renders an explainer saying what the mode accepts, because a mode that silently does nothing is the dead control this repo keeps paying for.

**`searchMusicPodcasts` treats a 400/404 as `[]`**, exactly as `getFeedsByMedium` does and for the same reason: PI's documented search endpoints are not a settled list, and an index that will not serve this path is indistinguishable from one holding no music for the term. MUSIC then degrades to byterm's music rows — shorter, never broken. Only auth and 5xx propagate. Driven against a stub with the endpoint 400ing: the mode still returned the byterm album.

**The response is `{ feeds, total, type }`, and both new fields exist for the empty state.** `total` is the *unfiltered* byterm count, free because every typed lane runs byterm anyway; `type` is the type actually **applied**, which is not always the one asked for — the feed-URL branch is an exact lookup and ignores the selector. A narrowed empty result must never say "no results", which is a claim about Podcast Index and false under a filter; it says *"No albums match X. 23 results across all types."* with a control back to ALL. Echoing the requested type instead would let the screen name a filter that never ran.

`type` is part of the URL, so it is already part of the CDN cache key; `SEARCH_CACHE` and the 60/min rate limit are unchanged, and every lane is still at most two PI calls over a fixed list rather than an attacker-chosen fan-out. `matchesSearchType`, `mergeSearchLanes` and `parseSearchType` are pinned by `npm run check:musicl` against a `naive()` per function — the one for `matchesSearchType` being `p.medium === type`, which passes every music and playlist vector while emptying PODCASTS.

### Podcast Index's copy of a feed can be blank or wrong — the feed itself outranks it

Measured on ChadF's Greatest Hits playlist, **PI feed 7683902**: the feed declares `<podcast:medium>musicL` and a title, and PI holds it with `title: ""` and `medium: "podcast"`. Two consequences, both of which read as "the playlist isn't there":

- **`/api/feed` only backfilled `medium` when PI supplied NONE**, so PI's wrong value won over the publisher's own tag, `isPlaylistMedium` was false, and the feed opened as a show with no episodes — the exact bug playlist support exists to fix, arriving through PI rather than through the parser. The route was already inconsistent about this: `isMusic` reads `|| feedMedium === 'music'`, so the RSS value already decided the SORT while PI's decided what shipped to the client. **`feedMedium` now wins whenever it exists** — it is read from `channelSlice` of the live feed moments earlier, while PI's is a crawl that can be stale.
- **A blank PI title renders as an invisible row** in search results, a headerless show page, and — the one that bites a collection hardest — a blank CARD in the publisher view. `/api/feed` fills an empty title from the channel's; `/api/search` and `/api/publisher` both go through **`piRecordIsBlank` + `mergeRssOverPi`** (`lib/util.ts`, pinned by `check:musicl` against PI's real record). PI keeps the feed id and guid, which only it can supply and which the rest of the app resolves by; the feed supplies what PI got wrong. Only for a **blank** title: a PI record that has one is the one the rest of the index agrees on. Deliberately **not** marked `isPreview`, since PI really does hold the feed and claiming otherwise would suppress the share link, the favorite heart and URL mirroring.

  **The repair is shared rather than inlined because it started in one route and needed to be in three.** `/api/publisher` resolves its children through the very same `getPodcastByFeedUrl`, so a blank record was a blank card there — on exactly the feeds a collection is most likely to contain, since a publisher lists whatever its author lists. Verified against a stub returning PI's blank shape for one of the nine real children: nine cards, zero blank, the repaired one keeping PI's feed id while the other eight fall back to RSS previews.

**A feed missing from a publisher feed is a data problem, not a bug.** BROWSE PLAYLISTS renders exactly what `chadf-musicl-publisher.xml` lists — nine children. Greatest Hits, Lightning Thrashes, Two for Tunestr and the LocalBitcoiners list are not among them, so they do not appear there; the collection's own `FEEDS.md` disagrees with the publisher feed too. That is the cost of the one-URL design and the right trade: the app never needs a code change when the collection grows, but it also cannot show what the publisher does not list.

### No scheduled reparse, and why

StableKraft runs a nightly GitHub Actions job that re-fetches every playlist and writes new tracks into Postgres. That job exists because its read path resolves tracks **from the database with zero network**, so the database has to be filled ahead of time. Ours resolves on demand through `batchEpisodes`, so a playlist edited on GitHub is live within about five minutes (`fetchFeedXml`'s 60 s window plus the route's `s-maxage=300`) with no job at all. Adding a cron would buy nothing and add a thing that can fail silently.

### `?playlist=<feedUrl>` is the deep link

A preview feed is not URL-mirrored, because a publisher checking their own unsubmitted feed has nothing to share. A playlist is the exception — people share these — and it restores exactly, because `/api/playlist` keys off the feed URL rather than a PI id. Same shape as `?publisher=<feedUrl>`.

## Podroll (`<podcast:podroll>`, host-recommended shows)

A channel-level `<podcast:podroll>` holds `<podcast:remoteItem feedGuid=… feedUrl=…>` entries pointing at other shows the host recommends. PI doesn't index it, so it rides the same RSS pass as `feedMedium`: `parsePodroll(channelXml)` → `feedPodroll` → `podcast.podroll: PodrollItem[]`. Entries without a `feedGuid` are skipped (the spec requires it; `feedUrl` is an optional hint).

`components/podroll.tsx` renders the row on the detail view, mounted from `EpisodeList` behind `<DeferredOnScroll>` with **no placeholder** — the component owns its skeleton and renders nothing when no entry resolves, so a placeholder heading would flash in and vanish.

- **Two-step resolution, guid then feedUrl.** `resolvePodcastByGuid(item.feedGuid)` first; on a miss, `resolvePodcastByFeedUrl(item.feedUrl)` when present. Both share `resolveVia(cacheKey, query)` in `lib/podcast-meta.ts`, so the four guards apply identically; feedUrl entries are cache-keyed `url:<feedUrl>` so they can't collide with a guid. The fallback exists because PI doesn't index every feed by guid — the same coverage gap that forced the RSS fallback in `resolveValueTimeSplits`. Without it those cards silently vanish, and the null miss is cached for the page so they stay gone.
- **`/api/by-guid` takes `guid` **or** `url`** (`getPodcastByGuid` / `getPodcastByFeedUrl`). The `url` branch is not an SSRF surface — it's forwarded to PI as a query param; we never fetch it ourselves. Capped at 2048 (guid at 120).
- **A PI "not found" must 404, never 500.** PI answers an unknown feed URL with **HTTP 400** `{"status":"false","description":"Feed url not found."}`, and `pi()` throws on any non-2xx. Reaching `withErrorHandling` would make that a 500, which would trip the client-side breaker (`resolveVia` treats any 5xx as "PI is down"), so one podroll entry pointing at an unindexed feed would disable *all* metadata resolution — favorites hydration, feed podcast chips — for the rest of the tab. `getPodcastByFeedUrl` catches `PiHttpError` 400/404 and returns null; 401/403 and 5xx still throw. `PiHttpError` exists to carry the status for exactly this distinction — don't go back to a bare `Error`.
- **Probe-first-then-batch**, per the `/api/by-guid` convention: resolve entry 0, check `piMaybeUp()`, then `Promise.all` the rest.
- **`genRef` generation guard, not a mounted flag.** Switching shows swaps `items` *without* unmounting `<Podroll>` (`EpisodeList` holds the previous feed's `data` until the new fetch lands), so a slow resolve for show A could settle last and paint A's recommendations under show B. Only the newest generation commits. Also covers StrictMode's double-mount, which is why there's no unmount cleanup.

`parsePodroll` only sees the pre-first-`<item>` channel slice, so a podroll authored *after* the items is missed — same limitation as `feedMedium`, and conventional feeds put channel metadata first.


**One request for the row, not one per entry.** `<Podroll>` resolved each entry
with its own `/api/by-guid` — "batch" meaning `Promise.all` over N single-guid
routes, the exact shape `useNoteMeta` was rewritten out of. Measured with a
12-entry podroll: **13 `/api/by-guid` requests, now 2** (the probe, then one
`/api/by-guid/batch` for the rest). A podroll is publisher-authored and
routinely runs to dozens of shows, and this row sits under the episode list on
the show page, so its requests land while the feed itself is still downloading.

The `resolveItem` pass is KEPT rather than replaced, for the two things it does
that a batch cannot: a guid PI answered "not found" for still falls back to the
entry's `feedUrl` hint, and a guid the warm could not ask about — a 429, an
aborted request — is still attempted rather than silently dropped from the row.
`warmPodcastCache` fills the same `podcastMem` the resolver reads, so after a
successful warm that pass simply finds its answers in hand.

It is also behind `<DeferredOnScroll>`, so none of this is on the show page's
cold path at all — it costs nothing until the reader scrolls to it.

## /api/by-guid resilience and PI breaker

`/api/by-guid` 5xxs when PI keys are missing or PI is down. A returning user with a 100-guid favorites set would otherwise hammer the broken endpoint on every reload (StrictMode + Fast Refresh amplifies into thousands).

`lib/podcast-meta.ts` is the single resolver module, exporting `resolvePodcastByGuid(guid)` and `resolvePodcastByFeedUrl(feedUrl)` as thin wrappers over one `resolveVia(cacheKey, query)`. Keep new lookups going through it. Four guards stacked:

1. In-memory `Map<cacheKey, Podcast | null>` — **also caches misses**, so each key is attempted at most once per page. `cacheKey` is the bare guid, or `url:<feedUrl>` so the two can't collide.
2. `storage.podcastMeta` (localStorage, 7-day TTL), same `cacheKey`.
3. **Circuit breaker.** The first 5xx trips `sessionStorage['bmb:pi:dead'] = '1'`, persisting across reloads in the same tab. `piMaybeUp()` lets callers gate parallel batches. **This is why a PI "not found" must never reach the client as a 5xx** — see Podroll.
4. Network.

Fan-out callers use **probe-first-then-batch**: await one resolve, check `piMaybeUp()`, then `Promise.all` the rest. The global feed resolver runs in a `useEffect` depending only on `notes` (not `podcasts` state); attempted-guid tracking lives in a `useRef<Set<string>>` so `setPodcasts` doesn't re-fire the effect — that bug caused a fetch storm pinning the dev server.

**A PI miss is not always an HTTP error.** For a feed PI knows but has never crawled, `/podcasts/byfeedurl` answers **200** with `{"status":"true","feed":[],…}` — and `[]` is truthy, so a bare `data.feed ? …` check built a `Podcast` with every field `undefined`. All three lookups in `lib/pi.ts` go through `podcastFromPiFeed`, which normalizes array-or-object and requires an `id`. Symptom when it regresses: a blank search result row, and the RSS-preview fallback in `app/api/search/route.ts` (which only runs on a null) never gets its turn.


## Every PI call carries a deadline (`PI_TIMEOUT_MS`)

`pi()` in `lib/pi.ts` is the one function every Podcast Index call goes through,
and it shipped without a timeout while every *other* outbound fetch in the app
had one — `fetchFeedXml` 8 s, `askIndex` its own, the art/chapter/transcript
proxies theirs. `fetch` has no default, so a PI instance that accepted the
connection and then went quiet held the request open until the **platform**
killed it: on Vercel that is the function's whole duration budget spent on one
hung socket, with the reader watching a spinner for all of it. The routes that
fan out make it worse rather than better — `/api/by-guid/batch` and
`/api/publisher` issue several of these, so one silent upstream stalls a request
that had nothing else left to do.

Two things this is easy to get wrong:

- **A timeout is not a byte cap and neither substitutes for the other.**
  `AbortSignal.timeout` bounds how *long* the call runs; `readCappedText` bounds
  how *many bytes* come back. `pi()` needs both, and had only the second.
- **A timeout must NOT be swallowed as a miss.** It throws an `AbortError`, not
  a `PiHttpError`, so it travels to the route as a 500 and trips the client-side
  breaker — which is the correct reading, because an upstream that will not
  answer is an outage and the breaker exists to notice one. The 400/404
  "PI does not hold this feed" branch tests the exception *class* for exactly
  this reason; widening it to catch anything thrown would file an outage as a
  permanent negative-cached miss.

8 s matches `fetchFeedXml` and is deliberately generous: PI's search endpoint is
genuinely slow on a cold query, and cutting a slow-but-alive answer short trades
a rare hang for a common failure.

## Server-side RSS caches (`createBoundedCache`)

Two modules cache whole RSS bodies server-side: `rssXmlCache` in `lib/pi.ts` (what `fetchFeedXml` serves) and `feedCache` in `lib/musicl-resolver.ts` (the publisher → album walk). **Both are keyed by a URL that came out of feed data**, which is the whole reason the bounds matter.

**Both shipped the same unbounded-growth bug, independently, because the mechanism had been copied.** Each checked expiry on read and evicted nowhere — so an entry past its TTL stopped being *served* but was never *deleted*, and every distinct URL an attacker or a large publisher feed could name pinned one full response body for the life of the instance, with no ceiling on the count. Written once, it can only be fixed once: the bookkeeping is now `createBoundedCache` (`lib/bounded-cache.ts`).

**Both bounds are mandatory — a hard age horizon AND a hard entry cap.** The horizon alone doesn't bound count between sweeps; the cap alone lets a small working set go stale forever.

**`get()` reports an entry's age and refuses to judge freshness.** That is deliberate, and it is what lets the two callers keep genuinely different policies over one mechanism:

- `lib/pi.ts` is **two-tier**. Its horizon is the *stale* window (10 min), not the fresh one (60 s), because a body older than 60 s is still worth serving when a refetch fails — and a single caller (the live-value poller, which needs a "now playing" that turns over in minutes) can ask for a shorter window via `maxAgeMs` without shortening it for everyone. A successful short-TTL fetch still populates the shared cache, so the two paths cooperate.
- `lib/musicl-resolver.ts` is **one-tier**: horizon and freshness are the same 5 minutes, and it has no stale-on-error path, so anything the cache returns is servable as-is.

Keep them as **separate instances**. Only the mechanism is shared; folding the policies together would silently give one caller the other's staleness.

**`set` deletes before it sets, and that line is load-bearing.** Eviction order is insertion order, and re-setting an existing key in a `Map` keeps its ORIGINAL position — so without the delete, a constantly-refreshed entry drifts to the front of the eviction queue and gets evicted while hot, which is the opposite of what a cache is for.

Sweep expired entries **before** capacity-evicting: dropping what nobody can serve should never cost you something still useful. `get` also evicts on a past-horizon read, so a read-heavy, write-idle period can't hold a dead entry indefinitely.

## What the browser is allowed to keep

Most routes here shipped with `s-maxage` and no `max-age`, which lets the CDN
hold a document while the reader's own browser re-downloads it every time.
Three were worth closing, and the argument is the same for each: **a private
cache shorter than the shared one that already exists adds no staleness class
that was not already permitted.**

| Route | Was | Now | Why it mattered |
|---|---|---|---|
| `/api/feed` | `s-maxage=300` | `max-age=60, s-maxage=300` | The largest body the app serves — up to `PI_EPISODE_MAX` episodes with their show notes, trimmed only at 3.5 MB. `<EpisodeList>` unmounts whenever an episode opens, so show → episode → back → episode fetched the whole feed once per step. |
| `/api/chapters` | `s-maxage=3600` | `max-age=3600, s-maxage=3600` | Keyed by the URL the feed names; a music show's chapters JSON is a row and an image URL per track, re-fetched on every episode open. |
| `/api/transcript` | `s-maxage=3600` | `max-age=3600, s-maxage=3600` | Same, and the largest of the per-episode documents. |

The one field on a feed that goes stale inside a minute is a live item's status,
and it is not read from this cache at all: `/api/live-status` polls at
`max-age=10` and `applyLiveStatuses` patches the rows in place.

`/api/by-guid` and `/api/episode-by-guid` are deliberately left alone — the
client already holds them for seven days in `bmb:pmeta:*` / `bmb:epmeta:*`, so a
browser cache would be a third layer answering a question two layers above it
have already answered.

## Batched Podcast Index resolution

`/api/by-guid/batch` and `/api/episode-by-guid/batch` resolve up to 100
identifiers per request. They exist for favorites hydration, which issues one
request per favorited show and one per favorited track — 213 and 232 on the list
this was sized against — drained six at a time because that is what a browser
allows per host. That burst is also what exhausts the per-IP limiter, and a 429
arriving mid-list poisons whatever ran after the budget.

Both go through `lib/pi-batch.ts`, which is shared rather than duplicated
because **the three-state answer is the contract** and two copies is one copy
that eventually forgets it:

| Response | Meaning | Client may cache |
|---|---|---|
| key present, value | PI resolved it | yes |
| key present, `null` | PI answered "not found" | yes — a 404 IS an answer |
| **key absent** | we could not ask | **never** |

It follows probe-first-then-batch: one sequential lookup first, and if that
throws — meaning PI itself is unreachable, since `getPodcastByGuid` already
turns PI's 400/404 into `null` — the remaining N−1 are never attempted and stay
absent. A rejection in the parallel half leaves that key absent too, rather than
recording an absence nobody observed.

**The batch routes deliberately do NOT trip the client-side PI breaker.** They
answer 200 with an empty map when PI is down, and the client's
`warmPodcastCache` caches nothing and returns. The authoritative per-guid path
that runs next still 500s and still trips it. Tripping the breaker from a
*prefetch* would let a warm-up disable metadata resolution for the whole tab.

`warmPodcastCache` / `warmEpisodeCache` (`lib/podcast-meta.ts`) are a **prefetch,
not a rewrite**. `resolveVia`, `resolveEpisodeByGuid`, the breaker and
`COULD_NOT_ASK` are untouched — after a warm pass the existing resolvers find
every entry in `podcastMem` and issue no network calls. Every rule in that file
cost a production incident, so the blast radius of adding speed to it is kept at
zero by construction. Reading the map uses `key in obj`, never `?? null`: the
latter turns every unanswered guid into a cached miss, which is exactly the
poisoning `COULD_NOT_ASK` exists to prevent.

