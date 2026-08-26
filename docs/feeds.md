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

