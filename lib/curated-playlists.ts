/**
 * The two curated playlist collections, as DATA — the URLs and nothing else.
 *
 * An import-free leaf, because both sides of the server/browser boundary need
 * the same list and neither may import the other's module:
 * `lib/playlist-collection.ts` (browser-only — it reaches this app's own API
 * routes and trips the client-side Podcast Index breaker) renders the
 * collections on `/playlists`, and `lib/curated-roster.ts` (server-only — it
 * reads the feeds directly) makes the same playlists findable from
 * `/api/search` before Podcast Index has indexed them. Two copies of a URL list
 * is the StableKraft failure this module's comments describe; one list, two
 * readers, is the fix.
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

export const COMMUNITY_PLAYLIST_URLS: readonly string[] = [
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

/**
 * Community playlists: BMB-hosted musicL feeds that listeners publish. The leaf
 * may not import `lib/brand.ts`, so the default is the buddy origin as a literal;
 * `check:community` asserts it equals `BRANDS.buddy.origin` when the env is unset.
 */
export const COMMUNITY_FEED_ORIGIN: string =
  process.env.NEXT_PUBLIC_COMMUNITY_FEED_ORIGIN || 'https://www.boostmebuddy.com';

export const COMMUNITY_FEED_PATH = '/feeds/playlists/';

/** The one feature switch every community-playlist surface and route reads. */
export const COMMUNITY_PLAYLISTS_ON: boolean = process.env.NEXT_PUBLIC_COMMUNITY_PLAYLISTS === 'on';

export function communityFeedUrl(id: string): string {
  return `${COMMUNITY_FEED_ORIGIN}${COMMUNITY_FEED_PATH}${id}.xml`;
}

export function communityCoverUrl(id: string, version: number): string {
  return `${COMMUNITY_FEED_ORIGIN}${COMMUNITY_FEED_PATH}${id}.jpg?v=${version}`;
}

/** Cache-busting version for a cover: whole seconds of `updatedAt`. */
export function coverVersion(updatedAt: string): number {
  return Math.floor(Date.parse(updatedAt) / 1000);
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** The id when `url` is exactly `<origin>/feeds/playlists/<uuid>.xml`, else null. */
export function communityIdFromFeedUrl(url: string | undefined): string | null {
  if (!url) return null;
  const prefix = `${COMMUNITY_FEED_ORIGIN}${COMMUNITY_FEED_PATH}`;
  if (!url.startsWith(prefix)) return null;
  const m = new RegExp(`^(${UUID})\\.xml$`, 'i').exec(url.slice(prefix.length));
  return m ? m[1] : null;
}
