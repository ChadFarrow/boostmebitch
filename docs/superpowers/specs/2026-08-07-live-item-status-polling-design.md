# Live-item status polling

**Date:** 2026-08-07

## Problem

A `<podcast:liveItem>` transitioning `pending` → `live` is invisible to a listener
already sitting on the show page. `components/lists.tsx:242` fetches `/api/feed`
once per `feedId` mount and nothing ever asks again, so the badge is frozen at
whatever the feed said when the page loaded.

Observed on Mutton, Mead & Music (feed 6594523) on 2026-08-07. The publisher's
RSS read:

```xml
<podcast:liveItem status="live" start="2026-08-07T18:55:00.000Z" …>
```

while the page still showed `PENDING`. PI's `/episodes/live?max=1000` returned
**zero** items for that feed, so PI had not noticed either — but our RSS path had
the correct answer and was never asked for it. A hard refresh flipped it.

Two layers make even a reload lag: `/api/feed` responds
`public, s-maxage=300, stale-while-revalidate=600`
(`app/api/feed/route.ts:144`), and `rssXmlCache` holds the feed XML for 60 s
server-side.

The badge is not cosmetic. `lists.tsx:423` disables the play button while
`liveStatus === 'pending'`, so a stale badge locks the listener out of the
broadcast at the exact moment they want to press play.

## Scope

**In:** the status of live items already present in the loaded feed —
`pending` → `live`, and `live` → ended.

**Out:**

- A live item published *after* page load. Catching it would mean replacing the
  live section wholesale rather than patching fields, which is a different
  design.
- Nostr kind:30311 streams. `components/nostr-live-streams.tsx` already polls
  itself; this touches only RSS live items.
- Any change to how regular episodes load.

## Design

### Server — `app/api/live-status/route.ts`

A lightweight sibling of `/api/live-value`:

```
GET /api/live-status?id=<feedId>
→ 200 { ok: true, items: [ { guid, status, startTime } ] }
→ 404 feed not found
→ 503 publisher's RSS unreachable
```

- `rateLimit(req, 'live-status', 60)` — polled, so the same budget
  `/api/live-value` gets rather than the default 30.
- `getPodcast(id)` for the feed URL, then the live items from RSS with
  `{ maxAgeMs: 10_000 }`. That per-caller override exists already
  (`fetchFeedXml`, `lib/pi.ts:290`) and does **not** shorten the shared 60 s
  window for `/api/feed`; a successful short-TTL fetch still populates the
  shared cache.
- `Cache-Control: public, max-age=10, s-maxage=10` on the 200 only. Several
  listeners on one show collapse to one upstream fetch, and the 5-minute
  `s-maxage` that forced the hard refresh does not apply here.
- Response carries only `guid`, `status`, `startTime`. No value blocks, no split
  resolution — this endpoint answers one question.

**RSS only; no PI `/episodes/live` call.** The incident above is the argument:
the feed was correct and PI was empty. Adding PI would mean pulling 1000 records
per poll to learn less than the feed already says.

### `ok` — distinguishing "nothing live" from "feed unreachable"

`getLiveItemsFromRss` returns `[]` for both. Without separating them, one failed
publisher fetch during a broadcast tells the client every item ended: the LIVE
badge would vanish mid-show, and a `pending` item wrongly marked ended would
*enable* the play button for a stream that has not started.

So `lib/pi.ts` gains `getLiveItemsFromRssDetailed(...): { ok: boolean; items: Episode[] }`,
where `ok` reflects whether `fetchFeedXml` returned XML. `getLiveItemsFromRss`
delegates to it and keeps its current signature, so `/api/feed` and
`/api/live-value` are untouched. The new route returns 503 when `ok` is false.

### Client — `useLiveStatusPoll` in `components/lists.tsx`

Follows the polling shape already established in
`components/nostr-live-streams.tsx:55-72`:

- **Active** only while `episodes.some(e => e.liveStatus)`. A show with no live
  item never polls.
- **Triggers:** 45 s interval, `visibilitychange`, `focus`.
- **Floor:** 30 s between actual requests, so overlapping triggers debounce.
- **Gate:** skip when `document.hidden`.

On a successful response, `setData` maps over the current episodes:

- guid present in `items` → `liveStatus = item.status`,
  `liveStartTime = item.startTime` (the response's `status`/`startTime` are the
  wire names for `Episode.liveStatus`/`Episode.liveStartTime`)
- guid absent, and the episode currently has a `liveStatus` → set
  `liveStatus = 'ended'`, leaving `liveStartTime` as-is

`'ended'` makes `LiveBadge` render null (`lists.tsx:29`), so a finished
broadcast loses its badge without a reload — the mirror of the reported bug.

A failed request, or `ok: false`, changes nothing.

Only `liveStatus` and `liveStartTime` are written. `setEpisodeQueue` and
`syncSelectedPodcast` are **not** re-fired: the queue holds the same episode
objects and playback is undisturbed.

A generation guard keyed on `feedId` prevents a poll in flight during a show
switch from painting onto the new show — the same `genRef` pattern
`components/podroll.tsx` uses, for the same reason.

## Error handling

| Case | Behavior |
| --- | --- |
| Network failure / non-2xx | Leave state alone, try again next tick |
| `ok: false` (503) | Leave state alone |
| Feed 404 | Leave state alone; polling continues while a live item is in state |
| Poll resolves after show switch | Discarded by the generation guard |
| Tab hidden | No request issued |

Nothing here surfaces an error to the user. A stale badge is the failure this
fixes; an error banner about it would be worse than the stale badge.

## Verification

The repo has no test runner. Before shipping:

- `npm run typecheck`
- `npm run lint`
- `npm run check:spark`, `check:sanitizer`, `check:ssrf`, `check:liveblock`,
  `check:stream` — none pin these files, but the rule is to run all five
- `next build` with the dev server stopped

Manual: open the show page for feed 6594523 while an item is `pending`, keep the
tab focused, and confirm the badge flips to LIVE within ~45 s of the publisher
setting `status="live"` — with no reload, and with the play button becoming
enabled. Confirm a show with no live item issues no `/api/live-status` requests.
