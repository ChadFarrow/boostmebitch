import { loadPlaylistPage, tripPiBreaker } from '@/lib/podcast-meta';
import type { Podcast } from '@/lib/types';

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

/**
 * ChadF's musicL **publisher** feed — the app's single curated entry point.
 *
 * It is a publisher feed rather than a list of playlist URLs, and that is the
 * whole point: the publisher lists its children, so a playlist added there
 * appears here the same day with no code change. StableKraft takes the other
 * road and hardcodes its twelve playlist URLs — in five separate places, which
 * have already drifted apart from each other and from the collection's own
 * FEEDS.md, and each of which lists a different subset.
 *
 * Nothing else in the app is curated; the rest is search. One constant is the
 * smallest thing that makes a collection discoverable without pasting a URL,
 * and `/api/publisher` was already able to render it.
 */
export const MUSICL_PUBLISHER_URL =
  'https://raw.githubusercontent.com/ChadFarrow/chadf-musicl-playlists/refs/heads/main/docs/chadf-musicl-publisher.xml';

/**
 * The SECOND curated collection: playlists other people made.
 *
 * The feed above is ChadF's and lists what ChadF publishes. These are not his,
 * they span two hosts and four authors, and **no publisher feed lists them**:
 * v4vmusic.com publishes none — measured, `/publisher.xml`, `/feed.xml` and
 * `/playlists.xml` all 404 and `/api/playlists` answers 401 — so the zero-deploy
 * road this module prefers genuinely does not exist for them.
 *
 * **They are a separate collection rather than extras appended to ChadF's.**
 * The previous arrangement (`EXTRA_PLAYLIST_URLS`) appended them to that feed's
 * own children, which put Ashna's and Aaron of Essex's work in a row the app
 * introduces as ChadF's — the same false claim about authorship that keeps them
 * out of the publisher feed itself. Two collections cost one more heading; one
 * collection costs somebody else's credit.
 *
 * Named for what it IS, never for a host: the Lightning Thrashes entry is on
 * cdn.kolomona.com, so "v4vmusic playlists" would have been false on screen the
 * day it shipped.
 *
 * Keep this list SHORT. A URL in the codebase needs a deploy to change, and
 * every entry costs one `/api/search` call on load — that route's per-IP limit
 * is 60/min, shared with the search box on a household IP. Past ~15 entries
 * this wants a batch door rather than a fan-out.
 *
 * **A v4vmusic `/s/<n>` link is a WEB PAGE, not a feed.** It answers 200 with
 * HTML and no `<podcast:medium>`, so it looks addable and resolves to nothing;
 * `/s/<n>.xml` serves the same HTML and the GUIDs in that markup 404. Several
 * v4vmusic playlists have no RSS feed at all and cannot be shown here in any
 * form. Check for the medium tag before adding a URL.
 */
export const COMMUNITY_COLLECTION_URL = 'bmb:collection:community';

/** What the Community collection is CALLED, wherever it is introduced. */
export const COMMUNITY_COLLECTION_TITLE = 'Community playlists';

const COMMUNITY_PLAYLIST_URLS: readonly string[] = [
  // "Christmas" — Sir Libre, 36 tracks. Moved here from the extras that used to
  // hang off ChadF's feed: same third-party authorship as the rest of this list.
  'https://v4vmusic.com/playlist/508a029b-020f-4334-9704-e0a9a5f800fb.xml',
  // "ChadF's favorite V4V albums" — ChadF, 13 tracks. His, but made ON
  // v4vmusic rather than by the tooling that writes the publisher feed, so it
  // belongs with the list it was made alongside.
  'https://v4vmusic.com/playlist/2a52af08-f6dc-4910-9943-bf226aeb82e9.xml',
  // "New Music Nudge Unit" — Aaron of Essex, 76 tracks.
  'https://v4vmusic.com/playlist/334bb12d-1f72-4c0e-88e1-266bd1e2dff9.xml',
  // "This is Haleen - Electronic" — Ashna, 19 tracks.
  'https://v4vmusic.com/playlist/9a3a90a2-7e76-438a-b382-c75eae85cf0a.xml',
  // "This is Haleen - Acoustic" — Ashna, 32 tracks.
  'https://v4vmusic.com/playlist/833e9177-d363-4869-8f4e-29a0afd747ac.xml',
  // "Massif - Damn Your Idols" — Ashna, 26 tracks.
  'https://v4vmusic.com/playlist/7585c2bd-c334-4e1b-bd9e-8c957279a5c4.xml',
  // "Lightning Thrashes Playlist episodes 1 - 60" — Kolomona Myer AKA Sir
  // Libre, 383 tracks. The one entry not on v4vmusic, and the reason this
  // collection is not named after a host.
  'https://cdn.kolomona.com/podcasts/lightning-thrashes/playlists/001-to-060-lightning-thrashes-playlist.xml',
];

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
    if (feedUrl === COMMUNITY_COLLECTION_URL) return await loadUrlList(COMMUNITY_PLAYLIST_URLS);
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
      // A 5xx is the route saying PI itself is down — its probe is deliberately
      // uncaught. Trip the breaker rather than rendering an empty collection.
      if (res.status >= 500) tripPiBreaker();
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
  const resolved = await Promise.all(wanted.map(resolveFeedUrl));
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
