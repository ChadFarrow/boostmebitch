import { loadPlaylistPage, tripPiBreaker } from '@/lib/podcast-meta';
import type { Podcast } from '@/lib/types';
import { communityPlaylistToPodcast, mapLimit, PI_FANOUT } from '@/lib/util';
import { COMMUNITY_COLLECTION_URL, COMMUNITY_PLAYLIST_URLS, COMMUNITY_PLAYLISTS_ON } from '@/lib/curated-playlists';
import { fetchCommunityPlaylists } from '@/lib/community/client';

/**
 * The curated playlist collection: which feed it comes from, and how to read it.
 *
 * Browser-only — it calls `fetch` against this app's own API routes and trips
 * the client-side Podcast Index breaker. It lived at the top of
 * `components/home-page.tsx` while `<HomePage>` was the only surface that
 * showed a collection; `/playlists` is now the second, and `<HomePage>` still
 * needs `loadCollection` for its `?publisher=` cold restore and for a
 * third-party publisher feed a visitor found by searching. Two copies of this
 * fetch had already drifted apart once inside that one file.
 */

// The URLs themselves live in an import-free leaf, because the server reads the
// same list (`lib/curated-roster.ts`, for search) and cannot import this module.
// Re-exported so the callers that already import them from here do not move.
export {
  MUSICL_PUBLISHER_URL,
  COMMUNITY_COLLECTION_URL,
  COMMUNITY_COLLECTION_TITLE,
} from '@/lib/curated-playlists';

/** One feed URL → the `Podcast` it resolves to, or null. */
async function resolveFeedUrl(url: string): Promise<Podcast | null> {
  try {
    // `/api/search` with a URL is the app's existing "resolve this feed" door:
    // Podcast Index first, the raw RSS when PI does not hold it, and the
    // blank-record repair when PI holds it badly. Re-implementing any of that
    // here is how the two would drift.
    const res = await fetch(`/api/search?q=${encodeURIComponent(url)}`);
    if (!res.ok) return null;
    return (await res.json()).feeds?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * One collection's children — a publisher feed's, or a curated URL list's.
 *
 * Shared by four callers — both sections of `/playlists`, the `?publisher=`
 * cold restore, and `handleSelect` on a publisher row found by searching.
 *
 * **Which collection is decided by the URL, and one of them has no feed behind
 * it.** `COMMUNITY_COLLECTION_URL` is a sentinel, not an address: it must be a
 * string because it round-trips through `?publisher=`, and the `bmb:` scheme
 * makes a collision with a real feed impossible rather than unlikely —
 * `assertSafeFetchUrl` accepts only http(s), and `/api/search`'s
 * `looksLikeFeedUrl` requires `^https?://`, so no feed this app can reach is
 * spelled that way, while `new URL()` still parses it.
 *
 * **Nothing is ever injected into somebody else's collection.** `handleSelect`
 * runs for ANY publisher feed, including one a visitor found by searching, so a
 * feed URL returns that feed's own children and nothing more.
 *
 * Returns null when the collection itself could not be loaded, which the caller
 * renders as an error. An individual child that fails to resolve is dropped
 * instead, and `listed` is what says so.
 *
 * **`listed` is how many entries this collection SHOULD hold**, against
 * `feeds.length` for how many resolved. They disagree when a child could be
 * neither found in Podcast Index nor read from its RSS — routine while PI is
 * rate limiting, and invisible without this, because a surface holding only the
 * survivors will print that number as a fact about the collection. A caller
 * that states a count must compare the two first.
 *
 * **`null` covers a THROWN failure too, not just a non-ok status.** A bare
 * `fetch` rejects when the device is offline or the request is blocked, so for
 * the life of this function the doc line above was false and each caller had to
 * carry its own `try`/`catch` to make it true — two copies at the time, and a
 * third surface would have been one forgotten `catch` away from a page stuck on
 * "loading" forever, with an unhandled rejection as the only trace. The guard
 * belongs with the promise it describes.
 */
export interface Collection {
  feeds: Podcast[];
  /** How many entries the collection names — see the note above. */
  listed: number;
  /**
   * True when the rows were read from RSS because Podcast Index was rate
   * limiting. The list is COMPLETE and the feeds are authoritative, but every
   * record is `isPreview` — no PI id, no guid — so the rows stamp "NOT IN PI"
   * and `<FavHeart>` withholds the favorite. A surface that renders it must say
   * so: a whole page of missing hearts is otherwise indistinguishable from a
   * feature that does not exist, which is the failure this repo has already
   * paid for on the BOOST button.
   */
  couldNotAskPi: boolean;
}

export async function loadCollection(feedUrl: string): Promise<Collection | null> {
  try {
    if (feedUrl === COMMUNITY_COLLECTION_URL) return await loadCommunity();
    // A non-http(s) value is not a publisher feed, and refusing it HERE is what
    // keeps a missed sentinel branch honest. Sent to `/api/publisher` instead,
    // `safeFetch` rejects the scheme, `fetchFeedXml` SWALLOWS the throw,
    // `getPublisherAlbumUrls` returns [], and the route answers a **cached 200
    // `{feeds: []}`** — a confident "this publisher lists nothing" about a
    // collection nobody read, held at the edge for five minutes. Verified
    // against the running route, not reasoned about.
    if (!/^https?:\/\//i.test(feedUrl)) return null;
    const res = await fetch(`/api/publisher?feedUrl=${encodeURIComponent(feedUrl)}`);
    if (!res.ok) {
      // A 5xx is normally the route saying PI itself is down, so it trips the
      // breaker rather than rendering an empty collection. **Except when the
      // route names a different upstream**: it answers 502 `upstream: 'feed'`
      // when the PUBLISHER's own document could not be read, and PI had nothing
      // to do with that. Tripping there would disable metadata resolution for
      // the whole tab because raw.githubusercontent.com blipped.
      if (res.status >= 500) {
        const why = await res.json().catch(() => null);
        if (why?.upstream !== 'feed') tripPiBreaker();
      }
      return null;
    }
    const body = await res.json();
    const own: Podcast[] = body.feeds ?? [];
    // Falls back to what arrived rather than to 0: an older deploy of the route
    // does not send `listed`, and a 0 there would read as "everything is
    // missing" on a collection that is perfectly complete.
    const ownListed: number = typeof body.listed === 'number' ? body.listed : own.length;
    const couldNotAskPi: boolean = body.couldNotAskPi === true;
    return { feeds: own, listed: ownListed, couldNotAskPi };
  } catch {
    return null;
  }
}

/**
 * The Community collection: playlists made on BMB first (newest first), then the
 * curated URL list.
 *
 * **A store that cannot be reached is a SHORTFALL, not an empty store.**
 * `fetchCommunityPlaylists` answers `null` for a failure and `[]` for "nobody has
 * made one", and only the second is a fact. On `null` this adds one to `listed`
 * for the playlists we could not count, so the page's own "N of M" line and
 * RETRY say so, while the curated rows stay readable.
 *
 * **One feed URL, one row.** A stored playlist whose feed address is also in the
 * curated list keeps the stored row and the curated entry is not resolved. Rows
 * are keyed by `p.id`, so two rows for one feed would make the second
 * unreachable, and the count would claim two playlists.
 *
 * The stored rows are built from our own database, so they need no Podcast Index
 * call and are never counted against `couldNotAskPi`.
 */
async function loadCommunity(): Promise<Collection | null> {
  let stored: Podcast[] = [];
  let storeUnreachable = false;
  if (COMMUNITY_PLAYLISTS_ON) {
    const list = await fetchCommunityPlaylists();
    if (list) stored = list.map(communityPlaylistToPodcast);
    else storeUnreachable = true;
  }
  const have = new Set(stored.map((p) => p.url));
  const curated = [...new Set(COMMUNITY_PLAYLIST_URLS)].filter((u) => !have.has(u));
  const rest = await loadUrlList(curated);
  const extra = storeUnreachable ? 1 : 0;
  if (!rest) {
    // The curated half failed outright. With stored rows in hand the page can
    // still show them, with the curated ones counted as missing.
    if (!stored.length) return null;
    return { feeds: stored, listed: stored.length + curated.length + extra, couldNotAskPi: false };
  }
  return {
    feeds: [...stored, ...rest.feeds],
    listed: stored.length + rest.listed + extra,
    couldNotAskPi: rest.couldNotAskPi,
  };
}

/**
 * A collection that is a LIST OF URLS rather than a publisher feed.
 *
 * `listed` is the length of the list, so the caller's "N of M" line works
 * identically here — and it is more precise than the publisher branch can be,
 * because this side knows exactly what it asked for.
 *
 * **`couldNotAskPi` is always false, and that is a limitation rather than a
 * claim.** `/api/search` carries no rate-limit signal the way `/api/publisher`
 * now does, so this cannot tell "Podcast Index does not hold this feed" from
 * "Podcast Index would not answer just now". Most of this list genuinely is
 * unindexed, so `NOT IN PI` is the true stamp for it; under a rate limit the one
 * entry PI does hold is mis-stamped for a single load. Reporting `true` instead
 * would suppress the stamp on every row, which is wrong far more often.
 *
 * Deduped by URL before resolving. `<PodcastResults>` keys rows by `p.id`, so
 * two entries resolving to one feed give two rows one key and the second becomes
 * unreachable; it also keeps `listed` honest and saves a rate-limit slot.
 */
async function loadUrlList(urls: readonly string[]): Promise<Collection | null> {
  const wanted = [...new Set(urls)];
  // BOUNDED. `urls` comes from a playlist's remote items — third-party data — and
  // each `resolveFeedUrl` reaches `/api/search`, so an unbounded start turns one
  // caller into N parallel Podcast Index calls against our own quota and the
  // per-IP limiter. `PI_FANOUT` because Podcast Index is what is being
  // protected; a count cap on the list would not have helped, since the cap
  // decides how many are resolved and `Promise.all` still starts every one of
  // them at once.
  const resolved = await mapLimit(wanted, PI_FANOUT, resolveFeedUrl);
  const feeds = resolved.filter((f): f is Podcast => f !== null);
  // EVERY entry failing is a failed READ, not an empty collection — an empty
  // state is a claim, and `[]` here may only ever mean the list itself is empty.
  // It deliberately does NOT trip the Podcast Index breaker: `resolveFeedUrl`
  // cannot tell a 429 from an outage from a dead host, and this path needs no PI
  // at all, since `/api/search` reads the raw RSS when PI lacks the feed.
  if (!feeds.length && wanted.length) return null;
  return { feeds, listed: wanted.length, couldNotAskPi: false };
}

/**
 * An offset past the last ref of any playlist, so `/api/playlist` answers with
 * its `total` and resolves NO rows.
 *
 * Mirrors `MAX_PLAYLIST_REFS` in `lib/feed-xml.ts`, which is the ceiling the
 * parser itself applies — a copy rather than an import because that module
 * pulls in `nostr-tools`, which is a lot of bundle to carry for one number.
 * **Drift degrades safely in the one direction it can go**: if that cap is ever
 * raised above this, a long playlist resolves a one-row page instead of none,
 * which costs one extra Podcast Index call and returns the identical `total`.
 */
const PAST_LAST_REF = 5000;

/**
 * The deduped track count for one playlist, or null when we could not ask.
 *
 * `/api/playlist` answers `total` for the WHOLE list on every page, so the
 * cheapest way to ask "how long is this?" is to ask for a page that does not
 * exist: past the last ref the route returns `total: refs.length` from an early
 * branch that never calls `batchEpisodes`. The count is the same number either
 * way — it is `refs.length` after the parser's dedupe, which is what a reader
 * sees when they open the list.
 *
 * **The saving is the point, not a micro-optimisation.** A collection is ~10
 * rows and this runs once per row, so asking for a REAL page (`limit: 1`) spent
 * ~20 Podcast Index calls on a line of small text — one `piRecordFor` plus one
 * `batchEpisodes` per row, on top of `/api/publisher`'s own fan-out. That was
 * enough to rate-limit PI from a few page reloads, and a rate-limited PI makes
 * `/api/publisher` drop the children it cannot resolve, so the collection came
 * back SHORT and the page stated the short number as fact. The count was paying
 * for itself in wrong counts. This halves it to the one `piRecordFor` the route
 * makes unconditionally.
 *
 * **Returns null rather than 0 on every failure.** That route is rate limited
 * to 30/min per IP, so a 429 on a household IP shared by a phone and a desktop
 * is ordinary. Zero would render as an empty playlist, which is a claim about
 * the feed rather than about our request — the same distinction `couldNotAsk`
 * draws inside the route.
 */
export async function playlistTrackCount(feedUrl: string): Promise<number | null> {
  try {
    const { total } = await loadPlaylistPage({ feedUrl, offset: PAST_LAST_REF, limit: 1 });
    return typeof total === 'number' ? total : null;
  } catch {
    return null;
  }
}
