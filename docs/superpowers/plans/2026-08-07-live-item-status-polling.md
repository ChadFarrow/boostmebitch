# Live-Item Status Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `<podcast:liveItem>` that flips `pending` → `live` updates the show page's badge (and enables its play button) within ~45 s, with no reload.

**Architecture:** A new lightweight `/api/live-status?id=<feedId>` route returns just each live item's guid, status and start time, read from the publisher's RSS with a 10 s freshness override. A client hook polls it while the loaded feed has any live item, and a pure merge function patches `liveStatus`/`liveStartTime` into the episodes already in state. Nothing else about the list is refetched or replaced.

**Tech Stack:** Next.js App Router route handler, React hook, TypeScript (strict). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-07-live-item-status-polling-design.md`

## Global Constraints

- **No test runner and no formatter in this repo.** Do not add Jest/Vitest and do not add a sixth `check:*` script — that was considered and left out of scope. The verification cycle is `npm run typecheck`, `npm run lint`, the five existing `check:*` scripts, `next build`, plus the concrete manual checks each task specifies.
- **Stop the dev server before `npm run build`** — the build rewrites `.next` and a running server then serves a mismatched chunk manifest.
- Path alias `@/*` → repo root.
- Server-only modules (`lib/pi.ts`, `lib/rate-limit.ts`) must never be imported from a browser module. The new client hook talks to the API route only.
- New API routes start with `rateLimit(req, '<route>', N)` and set `Cache-Control` on **200 responses only**.
- All `bmb:*` persistence goes through `lib/storage.ts` — this feature persists nothing, so it adds no keys.
- Scratchpad for throwaway files: `/private/tmp/claude-501/-Users-chad-mini-Vibe-boostmebitch/c1dd0f05-1f27-43e6-afc5-9498ed79b7d8/scratchpad`

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/pi.ts` (modify) | Add `getLiveItemsFromRssDetailed` returning `{ ok, items }`; existing `getLiveItemsFromRss` delegates to it |
| `lib/live-status.ts` (create) | Pure merge: `LiveStatusItem` type + `applyLiveStatuses(episodes, items)` |
| `app/api/live-status/route.ts` (create) | The polled endpoint |
| `lib/use-live-status-poll.ts` (create) | The client polling hook (sits beside the existing `lib/use-horizontal-wheel.ts`) |
| `components/lists.tsx` (modify) | Wire the hook into `EpisodeList` |
| `CLAUDE.md` (modify) | Document the polling path |

**Deviation from the spec, deliberate:** the spec placed the hook "in `components/lists.tsx`". It goes in `lib/use-live-status-poll.ts` instead, matching the existing `lib/use-horizontal-wheel.ts` precedent and keeping `lists.tsx` (already ~700 lines) from growing. The pure merge is split out again so it can be exercised without a browser.

---

### Task 1: `getLiveItemsFromRssDetailed` in `lib/pi.ts`

`getLiveItemsFromRss` returns `[]` both for "this feed has no live items" and "the publisher's feed was unreachable". The polling route must tell those apart, or one failed fetch mid-broadcast reports every item as ended.

**Files:**
- Modify: `lib/pi.ts:328-354`

**Interfaces:**
- Consumes: `fetchFeedXml(rssUrl, opts)`, `parseRssLiveItems(xml)` — both already private to this file
- Produces: `getLiveItemsFromRssDetailed(rssUrl: string, feedId: number, podcastGuid?: string, opts?: { maxAgeMs?: number }): Promise<{ ok: boolean; items: Episode[] }>`, used by Task 3. `getLiveItemsFromRss` keeps its exact current signature and behavior.

- [ ] **Step 1: Replace the body of `getLiveItemsFromRss` with a delegating pair**

Replace lines 321-354 (the comment block plus the function) with:

```ts
// PI's /episodes/live only indexes currently-broadcasting items; pending
// liveItems live exclusively in the publisher's RSS. Fetch the feed XML
// and pull <podcast:liveItem status="pending|live"> directly.
//
// Hand-rolled regex parser instead of pulling in fast-xml-parser etc — the
// shape we care about (top-level <podcast:liveItem> blocks plus a few
// well-known children) is narrow and stable.
//
// `ok` separates "this feed has no live items" from "we could not read the
// feed", which the bare [] cannot. /api/live-status needs the distinction:
// a client told every item ended would strip a LIVE badge mid-broadcast, and
// on a `pending` item it would enable the play button for a stream that has
// not started. Callers that only want the items keep using
// getLiveItemsFromRss below.
export async function getLiveItemsFromRssDetailed(
  rssUrl: string,
  feedId: number,
  podcastGuid?: string,
  opts?: { maxAgeMs?: number },
): Promise<{ ok: boolean; items: Episode[] }> {
  const xml = await fetchFeedXml(rssUrl, opts);
  if (xml == null) return { ok: false, items: [] };
  const items = parseRssLiveItems(xml).map((r): Episode => ({
    id: -fnvHash(r.guid ?? r.title ?? `${rssUrl}#${r.startTime ?? ''}`),
    guid: r.guid,
    title: r.title ?? 'Untitled live item',
    description: r.description,
    enclosureUrl: r.enclosureUrl ?? '',
    enclosureType: r.enclosureType,
    image: r.image,
    feedId,
    podcastGuid,
    liveStatus: r.status,
    liveStartTime: r.startTime,
    value: r.value,
    socialInteract: r.socialInteract,
    liveValue: r.liveValue,
    liveRemoteItem: r.remoteItem,
    liveValueTimeSplits: r.valueTimeSplits?.length ? r.valueTimeSplits : undefined,
  }));
  return { ok: true, items };
}

export async function getLiveItemsFromRss(
  rssUrl: string,
  feedId: number,
  podcastGuid?: string,
  opts?: { maxAgeMs?: number },
): Promise<Episode[]> {
  const { items } = await getLiveItemsFromRssDetailed(rssUrl, feedId, podcastGuid, opts);
  return items;
}
```

- [ ] **Step 2: Verify the type-level contract holds**

Run: `npm run typecheck`
Expected: PASS with no output. If it fails on `fnvHash` or `Episode` being unused/undefined, the imports at the top of `lib/pi.ts` were disturbed — they should be untouched by this edit.

- [ ] **Step 3: Verify no caller changed behavior**

Run: `grep -n "getLiveItemsFromRss" -r app lib --include="*.ts"`
Expected: exactly three call sites remain unchanged — `app/api/feed/route.ts:53`, `app/api/live-value/route.ts:39`, and the internal delegation. Neither route's line should have been edited by this task.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/pi.ts
git commit -m "Separate an unreadable feed from one with no live items

getLiveItemsFromRss answers [] for both, which is fine for /api/feed but
not for a poller: a client told every item ended would strip a LIVE badge
mid-broadcast, and on a pending item it would enable play for a stream
that has not started."
```

---

### Task 2: `applyLiveStatuses` — the pure merge

**Files:**
- Create: `lib/live-status.ts`
- Test (throwaway, deleted in Step 5): `<scratchpad>/check-live-status.mjs`

**Interfaces:**
- Consumes: `Episode` from `lib/types.ts` (type-only import, so this module stays isomorphic and loadable by plain Node)
- Produces:
  - `interface LiveStatusItem { guid: string; status: 'pending' | 'live'; startTime?: number }`
  - `applyLiveStatuses(episodes: Episode[], items: LiveStatusItem[]): Episode[]` — returns the **same array reference** when nothing changed, so the caller can skip `setState`

- [ ] **Step 1: Write the failing check**

Create `<scratchpad>/check-live-status.mjs`:

```js
import { applyLiveStatuses } from '../../../../Users/chad-mini/Vibe/boostmebitch/lib/live-status.ts';

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok  ${name}`); return; }
  console.error(`  FAIL ${name}`);
  failures++;
}

const pending = { id: -1, guid: 'g-live', title: 'Ep', enclosureUrl: '', feedId: 1, liveStatus: 'pending', liveStartTime: 100 };
const regular = { id: 5, guid: 'g-reg', title: 'Old', enclosureUrl: '', feedId: 1 };

// pending -> live
{
  const out = applyLiveStatuses([pending, regular], [{ guid: 'g-live', status: 'live', startTime: 200 }]);
  check('flips pending to live', out[0].liveStatus === 'live');
  check('adopts the new start time', out[0].liveStartTime === 200);
  check('leaves regular episodes alone', out[1] === regular);
}

// absent guid -> ended
{
  const out = applyLiveStatuses([pending, regular], []);
  check('absent live item becomes ended', out[0].liveStatus === 'ended');
  check('a regular episode is never marked ended', out[1].liveStatus === undefined);
}

// no change -> same reference
{
  const input = [pending, regular];
  const out = applyLiveStatuses(input, [{ guid: 'g-live', status: 'pending', startTime: 100 }]);
  check('a no-op merge returns the same array reference', out === input);
  check('a no-op merge keeps the same episode objects', out[0] === pending && out[1] === regular);
}

// a start time the feed stopped publishing is preserved
{
  const out = applyLiveStatuses([pending], [{ guid: 'g-live', status: 'live' }]);
  check('keeps the known start time when the item drops start', out[0].liveStartTime === 100);
}

// an already-ended item is not churned
{
  const ended = { ...pending, liveStatus: 'ended' };
  const out = applyLiveStatuses([ended], []);
  check('an already-ended item is left untouched', out[0] === ended);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
```

Use the real absolute path in the import — `/Users/chad-mini/Vibe/boostmebitch/lib/live-status.ts`. The point of importing the real module (rather than reimplementing it in the script) is the same one the repo's `check:*` scripts make: a copy passes green while the shipping code drifts.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --experimental-strip-types <scratchpad>/check-live-status.mjs`
Expected: FAIL — `Cannot find module .../lib/live-status.ts`.

- [ ] **Step 3: Write the module**

Create `lib/live-status.ts`:

```ts
import type { Episode } from './types';

/**
 * One live item as `/api/live-status` reports it. `status`/`startTime` are the
 * wire names for `Episode.liveStatus` / `Episode.liveStartTime`.
 */
export interface LiveStatusItem {
  guid: string;
  status: 'pending' | 'live';
  startTime?: number;
}

/**
 * Merge a successful `/api/live-status` response into the loaded episode list.
 *
 * Only episodes that already carry a `liveStatus` are eligible — a regular
 * episode is never touched, whatever the response says.
 *
 * An eligible episode whose guid is ABSENT from the response is marked
 * `'ended'`: the broadcast finished and the publisher dropped the item, so its
 * badge should go (LiveBadge renders null for 'ended'). Callers must only pass
 * items from a response they know succeeded — see the `ok` flag on
 * /api/live-status. Merging an errored or unreachable-feed response would end
 * a broadcast that is still running.
 *
 * A `startTime` the feed has stopped publishing is preserved rather than
 * erased; losing it would silently drop the "started …" line in the UI.
 *
 * Returns the SAME array reference when nothing changed, so the caller can skip
 * setState and the re-render with it.
 */
export function applyLiveStatuses(
  episodes: Episode[],
  items: LiveStatusItem[],
): Episode[] {
  const byGuid = new Map(items.map((i) => [i.guid, i]));
  let changed = false;
  const next = episodes.map((e) => {
    if (!e.liveStatus) return e;
    const hit = e.guid ? byGuid.get(e.guid) : undefined;
    if (hit) {
      const startTime = hit.startTime ?? e.liveStartTime;
      if (e.liveStatus === hit.status && e.liveStartTime === startTime) return e;
      changed = true;
      return { ...e, liveStatus: hit.status, liveStartTime: startTime };
    }
    if (e.liveStatus === 'ended') return e;
    changed = true;
    return { ...e, liveStatus: 'ended' as const };
  });
  return changed ? next : episodes;
}
```

- [ ] **Step 4: Run it to make sure it passes**

Run: `node --experimental-strip-types <scratchpad>/check-live-status.mjs`
Expected: every line `ok`, then `all passed`, exit 0.

Then run: `npm run typecheck && npm run lint`
Expected: both PASS.

- [ ] **Step 5: Delete the throwaway script and commit**

```bash
rm <scratchpad>/check-live-status.mjs
git add lib/live-status.ts
git commit -m "Add the pure merge for live-item status updates

Only episodes that already carry a liveStatus are eligible, so a regular
episode can never be marked ended; an eligible guid missing from a
successful response has finished broadcasting. Returns the same array
reference when nothing moved, so a poll that finds no change costs no
re-render."
```

---

### Task 3: `/api/live-status` route

**Files:**
- Create: `app/api/live-status/route.ts`

**Interfaces:**
- Consumes: `getLiveItemsFromRssDetailed` (Task 1), `getPodcast` from `lib/pi.ts`, `withErrorHandling` from `lib/api-handler.ts`, `rateLimit` from `lib/rate-limit.ts`
- Produces: `GET /api/live-status?id=<feedId>` → `200 { ok: true, items: LiveStatusItem[] }` | `400` | `404` | `503`, consumed by Task 4

- [ ] **Step 1: Write the route**

Create `app/api/live-status/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { getPodcast, getLiveItemsFromRssDetailed } from '@/lib/pi';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';

// How stale the feed XML may be when answering. Mirrors /api/live-value: the
// override applies to THIS call only (see fetchFeedXml), so /api/feed keeps its
// cheaper shared 60 s window.
const LIVE_XML_MAX_AGE_MS = 10_000;

/**
 * What is the status of this feed's live items right now?
 *
 * GET /api/live-status?id=<feedId>
 *   → { ok: true, items: [{ guid, status, startTime }] }
 *
 * Polled by the show page while a live item is on screen, so it answers one
 * question and does no split resolution. RSS only, no PI /episodes/live call:
 * PI lags the transition badly — observed 2026-08-07 with a feed publishing
 * status="live" while PI returned zero live items for it — so the extra 1000-
 * record fetch per poll would buy nothing.
 */
export async function GET(req: Request) {
  // Polled, so the same budget /api/live-value gets rather than the default 30.
  const limited = rateLimit(req, 'live-status', 60);
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const id = Number(searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'missing or invalid id' }, { status: 400 });
  }
  return withErrorHandling(async () => {
    const podcast = await getPodcast(id);
    if (!podcast?.url) return NextResponse.json({ error: 'feed not found' }, { status: 404 });
    const { ok, items } = await getLiveItemsFromRssDetailed(
      podcast.url,
      id,
      podcast.podcastGuid,
      { maxAgeMs: LIVE_XML_MAX_AGE_MS },
    );
    // An unreadable feed is NOT an empty one. Answering 200 with [] here tells
    // the client every live item ended, which would strip a LIVE badge in the
    // middle of a broadcast.
    if (!ok) return NextResponse.json({ error: 'feed unreachable' }, { status: 503 });
    return NextResponse.json(
      {
        ok: true,
        // Matching is by guid, so an item without one is unusable to the client.
        items: items
          .filter((e) => e.guid)
          .map((e) => ({ guid: e.guid, status: e.liveStatus, startTime: e.liveStartTime })),
      },
      { headers: { 'Cache-Control': 'public, max-age=10, s-maxage=10' } },
    );
  }, 'live-status fetch failed');
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both PASS.

- [ ] **Step 3: Verify against the real feed**

Start the dev server if it isn't running (`npm run dev`), then:

```bash
curl -s 'http://localhost:3000/api/live-status?id=6594523' | head -c 400
```

Expected: `{"ok":true,"items":[…]}`. Feed 6594523 is Mutton, Mead & Music — the show from the original report. When it has a live item the entry's `status` is `"pending"` or `"live"`; between broadcasts `items` is legitimately `[]` with `ok: true`. Either is a pass; a 500 is not.

- [ ] **Step 4: Verify the input guard**

```bash
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:3000/api/live-status'
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:3000/api/live-status?id=abc'
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:3000/api/live-status?id=-1'
```

Expected: `400` for all three.

- [ ] **Step 5: Commit**

```bash
git add app/api/live-status/route.ts
git commit -m "Add /api/live-status for polling live-item state

RSS only. PI's /episodes/live lags the transition badly -- on 2026-08-07
a feed published status=\"live\" while PI returned zero live items for it
-- so a 1000-record fetch per poll would buy nothing. 503 rather than an
empty 200 when the feed cannot be read."
```

---

### Task 4: The polling hook, wired into `EpisodeList`

**Files:**
- Create: `lib/use-live-status-poll.ts`
- Modify: `components/lists.tsx` (import block at lines 2-15; `EpisodeList` around lines 266-272, immediately after the `useStreamPanel` call)

**Interfaces:**
- Consumes: `applyLiveStatuses`, `LiveStatusItem` (Task 2); `GET /api/live-status` (Task 3)
- Produces: `useLiveStatusPoll(feedId: number | null, active: boolean, onItems: (items: LiveStatusItem[]) => void): void`

- [ ] **Step 1: Write the hook**

Create `lib/use-live-status-poll.ts`:

```ts
'use client';

import { useEffect, useRef } from 'react';
import type { LiveStatusItem } from './live-status';

const POLL_MS = 45_000;
/** Overlapping triggers (interval + focus + visibilitychange) debounce to this. */
const POLL_MIN_MS = 30_000;

/**
 * Poll `/api/live-status` while the show page has a live item on screen.
 *
 * The show page fetches /api/feed once per feedId mount and never asks again,
 * so a <podcast:liveItem> going pending → live was invisible to anyone already
 * looking at it — and a pending badge disables the play button, locking the
 * listener out at exactly the wrong moment.
 *
 * Same shape as components/nostr-live-streams.tsx: interval plus focus and
 * visibilitychange, gated on document.hidden with a floor so the overlapping
 * triggers don't stack.
 *
 * `onItems` is held in a ref, so callers may pass an inline arrow without
 * memoizing — the effect depends only on feedId and active. It fires ONLY for
 * a successful `ok: true` response; every failure path is silent and leaves the
 * caller's state alone, because a stale badge beats an ended broadcast.
 */
export function useLiveStatusPoll(
  feedId: number | null,
  active: boolean,
  onItems: (items: LiveStatusItem[]) => void,
): void {
  const cbRef = useRef(onItems);
  cbRef.current = onItems;

  useEffect(() => {
    if (!feedId || !active) return;
    // Doubles as the generation guard: switching shows tears this effect down,
    // so a poll still in flight for the previous feed can't paint onto the new
    // one. Same hazard <Podroll>'s genRef exists for.
    let cancelled = false;
    let lastPollMs = 0;

    const maybePoll = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const now = Date.now();
      if (now - lastPollMs < POLL_MIN_MS) return;
      lastPollMs = now;
      fetch(`/api/live-status?id=${feedId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled || !d?.ok || !Array.isArray(d.items)) return;
          cbRef.current(d.items as LiveStatusItem[]);
        })
        .catch(() => {});
    };

    const timer = setInterval(maybePoll, POLL_MS);
    document.addEventListener('visibilitychange', maybePoll);
    window.addEventListener('focus', maybePoll);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', maybePoll);
      window.removeEventListener('focus', maybePoll);
    };
  }, [feedId, active]);
}
```

- [ ] **Step 2: Add the imports to `components/lists.tsx`**

After line 15 (`import { useStreamPanel } from './streaming-settings';`) add:

```ts
import { applyLiveStatuses } from '@/lib/live-status';
import { useLiveStatusPoll } from '@/lib/use-live-status-poll';
```

- [ ] **Step 3: Wire it into `EpisodeList`**

Immediately after the existing `useStreamPanel(...)` call (currently `components/lists.tsx:266-272`) and **above every early return** — the hook-order rule that block already carries — insert:

```ts
  // A live item's status is fixed at load time otherwise: /api/feed is fetched
  // once per feedId and nothing asks again. Polls only while this feed has a
  // live item on screen, and patches liveStatus/liveStartTime in place —
  // setEpisodeQueue and syncSelectedPodcast are deliberately NOT re-fired, so
  // playback is undisturbed.
  const hasLiveItem = data.episodes.some((e) => !!e.liveStatus && e.liveStatus !== 'ended');
  useLiveStatusPoll(feedId, hasLiveItem, (items) => {
    setData((prev) => {
      const episodes = applyLiveStatuses(prev.episodes, items);
      return episodes === prev.episodes ? prev : { ...prev, episodes };
    });
  });
```

- [ ] **Step 4: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both PASS. `react-hooks/rules-of-hooks` is the check that matters here — if the insert landed below one of `EpisodeList`'s early returns (`!feedId`, `loading`, `!data.podcast`), lint fails and the hook must move up.

- [ ] **Step 5: Verify in the browser**

With the dev server running, open a show that has a live item — feed 6594523 (Mutton, Mead & Music) is the reference case. In devtools:

1. **Network tab, filter `live-status`.** A show with a live item issues a request roughly every 45 s while the tab is focused. Switch to another tab for a minute and confirm requests stop; switch back and confirm one fires.
2. **A show with no live item issues none at all.** Open any other podcast and confirm zero `live-status` requests.
3. **The flip.** With the show page open and a `PENDING` badge showing, confirm the badge becomes `● LIVE` and the row's play button becomes enabled without a reload. If the show isn't broadcasting, force it: in the Network tab right-click the `live-status` request → "Block request URL" is *not* the test — instead confirm the merge directly by running in the console
   `window.__t = performance.now()` before the poll and watching the row re-render, or simply verify against the real transition at the show's next broadcast.
4. **Playback is undisturbed.** Start any episode from this show, leave the page open across at least two polls, and confirm audio does not stutter or restart.

- [ ] **Step 6: Commit**

```bash
git add lib/use-live-status-poll.ts components/lists.tsx
git commit -m "Poll live-item status so a show going live updates in place

The show page fetched /api/feed once per mount and never asked again, so
a listener already looking at a pending item saw PENDING until they
reloaded -- with the play button disabled the whole time. Patches only
liveStatus/liveStartTime; the queue and selected podcast are untouched."
```

---

### Task 5: Document it and run the full check suite

**Files:**
- Modify: `CLAUDE.md` — the "Feed ordering + RSS enrichment (`/api/feed`)" section

**Interfaces:**
- Consumes: everything above
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Add the CLAUDE.md note**

At the end of the "Feed ordering + RSS enrichment (`/api/feed`)" section, before the "### Show notes" subsection, add:

```markdown
**Live-item status is polled, because `/api/feed` is fetched once.** `EpisodeList` loads the feed once per `feedId` mount and nothing asks again, so a `<podcast:liveItem>` going `pending` → `live` was invisible to anyone already on the page — and `liveStatus === 'pending'` disables the row's play button, so the stale badge locked the listener out at the exact moment they wanted to press play. Observed on Mutton, Mead & Music: the feed read `status="live"` while the page read PENDING, and a hard refresh fixed it.

`useLiveStatusPoll` (`lib/use-live-status-poll.ts`) polls **`/api/live-status?id=<feedId>`** every 45 s (30 s floor, `document.hidden` gate, `visibilitychange`/`focus` triggers — the `nostr-live-streams.tsx` pattern) while the loaded feed has an item with a non-`ended` `liveStatus`. A show without one never polls.

- **The route is RSS-only — no PI `/episodes/live` call.** PI lags the transition badly: when this was caught, the publisher's feed said `live` while PI returned **zero** live items for the feed. It uses `fetchFeedXml`'s per-caller `maxAgeMs: 10_000`, so the shared 60 s window `/api/feed` depends on is untouched, and it caches for 10 s so several listeners on one show collapse to one upstream fetch. `/api/feed`'s own `s-maxage=300` is what made a hard refresh necessary and deliberately does not apply here.
- **An unreadable feed answers 503, never an empty 200.** `getLiveItemsFromRss` returns `[]` for both "no live items" and "couldn't read the feed", so `getLiveItemsFromRssDetailed` exists to carry `ok`. Without it one failed publisher fetch mid-broadcast tells the client every item ended — stripping a LIVE badge, and on a `pending` item *enabling* play for a stream that hasn't started.
- **`applyLiveStatuses` (`lib/live-status.ts`) only touches episodes that already carry a `liveStatus`**, so a regular episode can never be marked ended; an eligible guid missing from a **successful** response has finished broadcasting and becomes `'ended'` (which renders no badge). It returns the same array reference when nothing moved, so a quiet poll costs no re-render, and it preserves a `startTime` the feed stopped publishing rather than erasing the "started …" line.
- **`setEpisodeQueue` and `syncSelectedPodcast` are deliberately not re-fired** — only the two live fields are patched, so playback is undisturbed. Known consequence: `episodeQueue` keeps the pre-flip episode objects until the next full feed load, which affects prev/next nav only.
- **Out of scope:** a live item published *after* page load won't appear (that needs replacing the live section, not patching fields), and Nostr kind:30311 streams are untouched — `nostr-live-streams.tsx` polls itself.
```

- [ ] **Step 2: Run every check**

Run:

```bash
npm run typecheck && npm run lint && \
npm run check:spark && npm run check:sanitizer && npm run check:ssrf && \
npm run check:liveblock && npm run check:stream
```

Expected: all PASS. None of them pin the files this plan touches, but the repo rule is to run all five before anything ships — a failure here means something unrelated broke and is a stop.

- [ ] **Step 3: Build**

**Stop the dev server first** — the build rewrites `.next` and a running server then serves a mismatched chunk manifest.

Run: `npm run build`
Expected: PASS, with `/api/live-status` appearing in the route list as a dynamic (ƒ) route.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "Document the live-item status poll

Records why the route is RSS-only, why an unreadable feed must 503 rather
than answer an empty 200, and what is deliberately not refetched."
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| `GET /api/live-status?id=<feedId>` returning guid/status/startTime | 3 |
| `rateLimit(…, 'live-status', 60)` | 3 |
| `maxAgeMs: 10_000` override, shared window untouched | 3 |
| `Cache-Control: public, max-age=10, s-maxage=10` on 200 only | 3 |
| RSS only, no PI call | 3 |
| `getLiveItemsFromRssDetailed` with `ok`; 503 when false | 1, 3 |
| Active only while a live item exists | 4 (Step 3, `hasLiveItem`) |
| 45 s interval, 30 s floor, `document.hidden`, visibilitychange/focus | 4 (Step 1) |
| Present guid → adopt status/startTime | 2 |
| Absent guid → `'ended'` | 2 |
| Failure / `ok: false` → no change | 2 (doc contract), 4 (Step 1, `d?.ok` guard) |
| Only `liveStatus`/`liveStartTime` written; queue not re-fired | 2, 4 (Step 3) |
| Generation guard on feedId | 4 (Step 1, `cancelled` + effect teardown) |
| typecheck / lint / five `check:*` / build | 5 |
| Manual verification against feed 6594523 | 3 (Step 3), 4 (Step 5) |

No gaps.

**Placeholder scan:** none — every code step carries the literal code, and the two verification-only steps carry literal commands and expected output.

**Type consistency:** `LiveStatusItem` is defined once in Task 2 and imported by name in Task 4; `applyLiveStatuses(episodes, items)` and `useLiveStatusPoll(feedId, active, onItems)` keep the same parameter names and order everywhere they appear. `getLiveItemsFromRssDetailed`'s `{ ok, items }` shape is destructured identically in Task 3.

**One known soft spot, flagged rather than papered over:** Task 4 Step 5's item 3 depends on a real `pending` → `live` transition, which can't be forced locally without editing the publisher's feed. The honest fallback is to verify the merge logic via Task 2's checks (which do cover the flip) and confirm the end-to-end behavior at the show's next broadcast.
