// Pure rules for community playlists. Import-free on purpose: check:community
// loads this file under plain Node.

export const MIN_SONGS = 10;
export const MAX_SONGS = 500;
export const MAX_TITLE_LEN = 120;
export const MAX_DESCRIPTION_LEN = 1000;
/** The longest maker name: a label under the title, not a paragraph. */
export const MAX_OWNER_NAME_LEN = 64;
/**
 * The shortest side a cover link may have. Square art of 1400 to 3000 px is only
 * preferred (Chad, 2026-11-12): these feeds are not sent to Apple, whose directory
 * sets that rule, and apps crop or fit a cover that is not square. The feed names
 * the listener's link itself, so this site serves no listener's picture to apps.
 */
export const ART_MIN_PX = 300;
/** The longest art link or song `feedUrl` stored: the cap every sibling URL parameter carries. */
export const MAX_URL_LEN = 2048;
/**
 * The largest write body (POST and PUT) the routes read. A real 500-song playlist
 * (UUID feed guids, permalink item guids, a feed URL each) is about 120 KB; the
 * old 64 KB cap refused one of about 250 songs, far below MAX_SONGS.
 */
export const MAX_PLAYLIST_BODY_BYTES = 256 * 1024;

// The limits `parsePlaylistRemoteItems` enforces on a remote item.
const MAX_FEED_GUID_LEN = 120;
const MAX_ITEM_GUID_LEN = 2048;

export interface PlaylistSong { feedGuid: string; itemGuid: string; feedUrl?: string }
export interface PlaylistDraft {
  title: string;
  description: string;
  /**
   * Who made the playlist, as the maker typed it in the NAME box ('' for none).
   * Printed as the feed's `<itunes:author>` and shown under the title in the list
   * (Chad, 2026-11-16: "add a box for people to enter their name into and use that").
   */
  ownerName: string;
  artUrl: string | null;
  songs: PlaylistSong[];
}

export type DraftProblem =
  | { kind: 'title-missing' }
  | { kind: 'title-too-long' }
  | { kind: 'description-too-long' }
  | { kind: 'name-too-long' }
  | { kind: 'too-few-songs'; have: number }
  | { kind: 'too-many-songs'; have: number }
  | { kind: 'duplicate-song'; itemGuid: string }
  | { kind: 'bad-song'; index: number }
  | { kind: 'art-not-https' }
  /** Starts with https:// but is no usable address: no host, unparsable, or over MAX_URL_LEN. */
  | { kind: 'art-bad-link' }
  /** The field holds what looks like a secret key or an NWC string. The text is never echoed. */
  | { kind: 'secret'; field: 'title' | 'description' | 'name' };

const len = (s: string) => [...s].length;

/** A one-line name: control characters become spaces, runs of white space one space, ends trimmed. */
export function foldName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** `u` as an absolute http(s) link with a host, no longer than MAX_URL_LEN; else null. */
function linkOf(u: unknown, protocols: readonly string[]): string | null {
  if (typeof u !== 'string' || u.length > MAX_URL_LEN) return null;
  try {
    const x = new URL(u);
    return protocols.includes(x.protocol) && x.hostname !== '' && x.href.length <= MAX_URL_LEN ? x.href : null;
  } catch {
    return null;
  }
}
const songFeedUrl = (u: unknown) => linkOf(u, ['http:', 'https:']) ?? undefined;

/**
 * `holdsSecret` is `textHoldsSecret` (lib/nostr/npub-input.ts). It is a REQUIRED
 * parameter because this file must stay import-free: every caller — the maker,
 * both write routes, check:community — hands the one shared test in, and none
 * can forget it.
 */
export function validatePlaylistDraft(
  raw: unknown,
  holdsSecret: (text: string) => boolean,
): { ok: true; draft: PlaylistDraft } | { ok: false; problems: DraftProblem[] } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const problems: DraftProblem[] = [];

  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const description = typeof o.description === 'string' ? o.description.trim() : '';
  // Absent (an older draft or client) is the same as an empty box: no name.
  const ownerName = foldName(o.ownerName);
  // First, so the maker names it before anything else: the playlist is public.
  if (holdsSecret(title)) problems.push({ kind: 'secret', field: 'title' });
  if (holdsSecret(description)) problems.push({ kind: 'secret', field: 'description' });
  if (holdsSecret(ownerName)) problems.push({ kind: 'secret', field: 'name' });
  if (!title) problems.push({ kind: 'title-missing' });
  else if (len(title) > MAX_TITLE_LEN) problems.push({ kind: 'title-too-long' });
  if (len(description) > MAX_DESCRIPTION_LEN) problems.push({ kind: 'description-too-long' });
  if (len(ownerName) > MAX_OWNER_NAME_LEN) problems.push({ kind: 'name-too-long' });

  const artRaw = typeof o.artUrl === 'string' ? o.artUrl.trim() : '';
  const artUrl = artRaw === '' ? null : artRaw;
  if (artUrl !== null) {
    if (!/^https:\/\//i.test(artUrl)) problems.push({ kind: 'art-not-https' });
    else if (!linkOf(artUrl, ['https:'])) problems.push({ kind: 'art-bad-link' });
  }

  const rawSongs = Array.isArray(o.songs) ? (o.songs as unknown[]) : [];
  const songs: PlaylistSong[] = [];
  const seen = new Set<string>();
  rawSongs.forEach((s, index) => {
    const r = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
    const feedGuid = typeof r.feedGuid === 'string' ? r.feedGuid : '';
    const itemGuid = typeof r.itemGuid === 'string' ? r.itemGuid : '';
    if (!feedGuid || feedGuid.length > MAX_FEED_GUID_LEN || !itemGuid || itemGuid.length > MAX_ITEM_GUID_LEN) {
      problems.push({ kind: 'bad-song', index });
      return;
    }
    const key = `${feedGuid}\n${itemGuid}`;
    if (seen.has(key)) {
      problems.push({ kind: 'duplicate-song', itemGuid });
      return;
    }
    seen.add(key);
    const song: PlaylistSong = { feedGuid, itemGuid };
    // Kept as a hint only: what is STORED is the index's address (withIndexFeedUrls).
    const feedUrl = songFeedUrl(r.feedUrl);
    if (feedUrl) song.feedUrl = feedUrl;
    songs.push(song);
  });
  if (rawSongs.length > MAX_SONGS) problems.push({ kind: 'too-many-songs', have: rawSongs.length });
  else if (songs.length < MIN_SONGS) problems.push({ kind: 'too-few-songs', have: songs.length });

  if (problems.length) return { ok: false, problems };
  return { ok: true, draft: { title, description, ownerName, artUrl, songs } };
}

/** What `addSong` did. `'full'` is MAX_SONGS reached; `'already'` the same pair is in it. */
export type AddSongResult = 'added' | 'already' | 'full';

/**
 * Add one song to the END of a playlist's song list: the "+ PLAYLIST" control
 * beside the player's hearts, which collects into a draft on this device
 * (nothing is sent until the maker's PUBLISH or SAVE). A song is the PAIR
 * `feedGuid` + `itemGuid`, the key `validatePlaylistDraft` refuses a duplicate
 * on, so a song already in the list is never added twice and a draft never
 * grows past MAX_SONGS: either would make the next SAVE fail on a problem the
 * user did not cause in the maker. Returns a new array and never changes the one
 * passed in. Only the two guids are copied: a stored `feedUrl` is the index's,
 * never the client's (`withIndexFeedUrls`).
 */
export function addSong(
  songs: readonly PlaylistSong[],
  song: PlaylistSong,
): { songs: PlaylistSong[]; result: AddSongResult } {
  if (songs.some((s) => s.feedGuid === song.feedGuid && s.itemGuid === song.itemGuid)) {
    return { songs: [...songs], result: 'already' };
  }
  if (songs.length >= MAX_SONGS) return { songs: [...songs], result: 'full' };
  return { songs: [...songs, { feedGuid: song.feedGuid, itemGuid: song.itemGuid }], result: 'added' };
}

/**
 * The songs as they are STORED and published. A song's `feedUrl` is the one
 * `urlFor` answers — what Podcast Index holds for its feed (`verifySongs`), or for
 * a song an edit kept, what was stored when it was checked — never the client's:
 * the public feed hands it to every app as the address of the ARTIST's feed, so a
 * client-chosen one would point listeners anywhere. None, a non-http(s) link or
 * one over MAX_URL_LEN gives no `feedUrl` (it is optional in a remoteItem). Only
 * the two guids and that URL are copied.
 */
export function withIndexFeedUrls(
  songs: readonly PlaylistSong[],
  urlFor: (song: PlaylistSong) => string | undefined,
): PlaylistSong[] {
  return songs.map((s) => {
    const feedUrl = songFeedUrl(urlFor(s));
    return feedUrl ? { feedGuid: s.feedGuid, itemGuid: s.itemGuid, feedUrl } : { feedGuid: s.feedGuid, itemGuid: s.itemGuid };
  });
}

export type ArtRefusal = 'not-image' | 'format' | 'too-small';

/** A cover link is a PNG or JPEG whose shortest side is at least ART_MIN_PX. Any shape and transparency pass. */
export function artVerdict(meta: {
  format?: string;
  width?: number;
  height?: number;
}): { ok: true } | { ok: false; reason: ArtRefusal } {
  const { format, width, height } = meta;
  if (!format || !width || !height) return { ok: false, reason: 'not-image' };
  if (format !== 'jpeg' && format !== 'png') return { ok: false, reason: 'format' };
  if (Math.min(width, height) < ART_MIN_PX) return { ok: false, reason: 'too-small' };
  return { ok: true };
}

// ---- an uploaded cover (the UPLOAD button, lib/community/blossom.ts) --------

/**
 * The Blossom server an uploaded cover goes to when the user names none of their
 * own (kind:10063), or when none of theirs takes it. No trailing slash.
 */
export const ART_UPLOAD_SERVER = 'https://blossom.primal.net';

/** The kind of a user's Blossom server list (BUD-03). */
export const BLOSSOM_SERVER_LIST_KIND = 10063;

/** How many of the user's own servers an upload tries before the default. */
export const MAX_USER_BLOSSOM_SERVERS = 3;

/**
 * The user's Blossom servers from a kind:10063's tags, in THEIR order (BUD-03:
 * the first is the most trusted), normalised to `https://host[/path]` with no
 * trailing slash. Third-party text, so: `https:` only (the upload carries a
 * signed authorization, and a plain-http server hands it to the network), no
 * credentials in the URL, query and fragment dropped, duplicates dropped, at
 * most MAX_USER_BLOSSOM_SERVERS. Anything else is skipped, never repaired.
 */
export function blossomServersFromTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (out.length >= MAX_USER_BLOSSOM_SERVERS) break;
    if (!Array.isArray(t) || t[0] !== 'server' || typeof t[1] !== 'string') continue;
    let u: URL;
    try {
      u = new URL(t[1].trim());
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) continue;
    const base = `https://${u.host}${u.pathname.replace(/\/+$/, '')}`;
    if (!out.includes(base)) out.push(base);
  }
  return out;
}

/** Where an upload is tried, in order: the user's own servers, then the default once. */
export function artUploadServers(userServers: readonly string[]): string[] {
  const out = userServers.filter((s, i) => userServers.indexOf(s) === i);
  if (!out.includes(ART_UPLOAD_SERVER)) out.push(ART_UPLOAD_SERVER);
  return out;
}

/**
 * The longest side an uploaded cover keeps. The cover route serves 1400 px, and
 * the art check reads at most 24 MP: a 24 MP phone photo (5712 x 4284) is over
 * that, so it must shrink in the browser or the check refuses it.
 */
export const ART_UPLOAD_MAX_PX = 3000;

/**
 * The size a picked picture is re-encoded at: the longest side at most
 * ART_UPLOAD_MAX_PX, never enlarged. `null` when the shortest side, AFTER the
 * shrink, is under ART_MIN_PX — the art check would refuse that upload, and the
 * user would learn it only at PUBLISH, with a file already on a public server.
 */
export function artUploadSize(width: number, height: number): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const scale = Math.min(1, ART_UPLOAD_MAX_PX / Math.max(width, height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  if (Math.min(w, h) < ART_MIN_PX) return null;
  return { width: w, height: h };
}

/**
 * The cover link for a finished upload, REBUILT from the hash we computed, never
 * read from the server's answer: BUD-01 says `<server>/<sha256>` serves the blob,
 * and the answer is third-party data. `null` unless the answer names that same
 * hash, so a server that stored something else is not given a playlist's cover.
 */
export function uploadedArtUrl(server: string, sha256: string, answer: unknown): string | null {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (!answer || typeof answer !== 'object') return null;
  const got = (answer as { sha256?: unknown }).sha256;
  if (typeof got !== 'string' || got.toLowerCase() !== sha256) return null;
  return `${server}/${sha256}.jpg`;
}

/**
 * Which picture `/api/playlist-cover` makes for a playlist BMB does not host,
 * when the feed's own cover fails. A v4vmusic.com playlist uses its FIRST
 * song's art, because that is what v4vmusic itself shows for a playlist (Chad,
 * 2026-11-15: "so we match their style"); every other host gets the 2 x 2 grid
 * of the first four songs, BMB's own no-art cover. The host is matched exactly
 * or as a subdomain, never as a substring: `v4vmusic.com.example` is not it.
 */
export function coverStyleFor(feedUrl: string): 'first-song' | 'grid' {
  let host: string;
  try {
    host = new URL(feedUrl).hostname.toLowerCase();
  } catch {
    return 'grid';
  }
  return host === 'v4vmusic.com' || host.endsWith('.v4vmusic.com') ? 'first-song' : 'grid';
}

export interface StoredPlaylist extends PlaylistDraft {
  id: string;
  ownerPubkey: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommunityPlaylistSummary {
  id: string;
  title: string;
  description: string;
  feedUrl: string;
  podcastGuid: string;
  ownerPubkey: string;
  ownerNpub: string;
  ownerName: string | null;
  coverUrl: string;
  songCount: number;
  createdAt: string;
  updatedAt: string;
}

/** The feed origin of the production deploys (the default of `COMMUNITY_FEED_ORIGIN`). */
export const PRODUCTION_FEED_ORIGIN = 'https://www.boostmebuddy.com';

/**
 * Where `lib/community/archive-notify.ts` may send `GITHUB_ARCHIVE_TOKEN`, or null
 * for nowhere. GitHub's API, on a server whose feeds are the real ones; or the
 * LOOPBACK stub a test names in `PLAYLIST_ARCHIVE_API`. An override that is set
 * and is anything else is null, never GitHub: a typo in a test's env must not
 * send a real dispatch, and the variable must not be a way to mail the token to
 * another host (`http://127.0.0.1.nip.io`, `http://localhost@evil.example`).
 */
export function archiveDispatchBase(override: string | undefined, feedOrigin: string): string | null {
  if (override) return loopbackOrigin(override);
  return feedOrigin === PRODUCTION_FEED_ORIGIN ? 'https://api.github.com' : null;
}

/** The origin of a test stub: `http:` on a loopback NAME OR ADDRESS, no userinfo. Else null. */
function loopbackOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
    return u.protocol === 'http:' && loopback && !u.username && !u.password ? u.origin : null;
  } catch {
    return null;
  }
}

/** The Podcast Index API that `lib/community/pi-notify.ts` writes to. */
export const PI_API_BASE = 'https://api.podcastindex.org/api/1.0';

/** What `piNotifyBase` reads; the server passes `process.env` and `COMMUNITY_FEED_ORIGIN`. */
export interface PiNotifyEnv {
  /** `COMMUNITY_PI_NOTIFY`: only the exact value `on` turns it on. */
  notify: string | undefined;
  /** `PI_NOTIFY_API`: a test's loopback stub. */
  override: string | undefined;
  /** `VERCEL_ENV`: production, preview or development; unset off Vercel. */
  vercelEnv: string | undefined;
  /** `VERCEL_GIT_COMMIT_REF`: the branch the deploy was built from. */
  gitRef: string | undefined;
  feedOrigin: string;
}

/**
 * Where `lib/community/pi-notify.ts` may send a playlist feed, or null for nowhere.
 * A feed added to Podcast Index stays there for good (PI has no delete), so this
 * says yes only on a deploy that serves the REAL feeds:
 *
 * - `COMMUNITY_PI_NOTIFY=on`, and
 * - the feed origin is `https://www.boostmebuddy.com`, and
 * - Vercel production, or the `beta` branch's preview (the maker is beta only
 *   today, and beta writes the same database production's feeds read). A PR
 *   preview is a preview too, so the branch is named; off Vercel (`next dev`,
 *   `next start`) there is no `VERCEL_ENV`, so a laptop with the real database
 *   and the switch in `.env.local` still sends nothing.
 *
 * A test's `PI_NOTIFY_API` replaces all three of the last checks, and only a
 * loopback stub is accepted there. An override that is set and is anything else
 * is null, NEVER the real API: a typo in a test's env must not become a real
 * submission (`docs/feeds.md`, "Podcast Index").
 */
export function piNotifyBase(env: PiNotifyEnv): string | null {
  if (env.notify !== 'on') return null;
  if (env.override) {
    const o = loopbackOrigin(env.override);
    return o ? `${o}/api/1.0` : null;
  }
  if (env.feedOrigin !== PRODUCTION_FEED_ORIGIN) return null;
  const deployed = env.vercelEnv === 'production' || (env.vercelEnv === 'preview' && env.gitRef === 'beta');
  return deployed ? PI_API_BASE : null;
}

/** What every playlist podping asks for. Every community playlist is `<podcast:medium>musicL`. */
export const PODPING_MEDIUM = 'musicL';
/** The podping reason: the feed changed. A deleted feed uses it too; an app that reads it finds the 410. */
export const PODPING_REASON = 'update';

/** What `podpingEndpoint` reads. It never sees the token: only whether one is set. */
export interface PodpingEnv {
  /** `COMMUNITY_PI_NOTIFY`: the one switch for every public notice a playlist write sends. */
  notify: string | undefined;
  /** `PODPING_ENDPOINT_URL`: Chad's msp-podping-service pusher. */
  endpoint: string | undefined;
  /** Is `PODPING_BEARER_TOKEN` set? (The value is read only where the request is made.) */
  hasToken: boolean;
  vercelEnv: string | undefined;
  gitRef: string | undefined;
  feedOrigin: string;
}

/**
 * Where `lib/community/podping-notify.ts` may send a podping, or null for nowhere.
 * A podping is written to the Hive blockchain, so it is public and permanent, and
 * the request carries a bearer token. So, in the same order as `piNotifyBase`:
 *
 * - `COMMUNITY_PI_NOTIFY=on` (one switch turns every public notice off), and
 * - the endpoint and the token are both set, and
 * - the endpoint is `https:` with no userinfo (the token rides in a header), and
 * - the feed origin is `https://www.boostmebuddy.com`, and
 * - Vercel production, or the `beta` branch's preview; a PR preview and a laptop
 *   with the real values in `.env.local` send nothing.
 *
 * A test's endpoint on a loopback address (`http://127.0.0.1:<port>`) skips the
 * last two checks: nothing leaves the machine. Anything else that is not https is
 * null, NEVER sent as written.
 */
export function podpingEndpoint(env: PodpingEnv): string | null {
  if (env.notify !== 'on' || !env.endpoint || !env.hasToken) return null;
  let u: URL;
  try {
    u = new URL(env.endpoint);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (loopback) return u.protocol === 'http:' ? u.origin + u.pathname : null;
  if (u.protocol !== 'https:') return null;
  if (env.feedOrigin !== PRODUCTION_FEED_ORIGIN) return null;
  const deployed = env.vercelEnv === 'production' || (env.vercelEnv === 'preview' && env.gitRef === 'beta');
  return deployed ? u.origin + u.pathname : null;
}

/**
 * The pusher request for one feed: `GET <endpoint>?url=<feed>&reason=update&medium=musicL`.
 * `detailed_response=true` makes the pusher answer `{ message: "enqueued" | "duplicate" }`
 * instead of an empty 200. Null when the feed is not an http(s) URL.
 */
export function podpingRequestUrl(endpoint: string, feedUrl: string): string | null {
  let feed: URL;
  let u: URL;
  try {
    feed = new URL(feedUrl);
    u = new URL(endpoint);
  } catch {
    return null;
  }
  if (feed.protocol !== 'https:' && feed.protocol !== 'http:') return null;
  u.search = new URLSearchParams({
    url: feed.href, reason: PODPING_REASON, medium: PODPING_MEDIUM, detailed_response: 'true',
  }).toString();
  return u.href;
}


// ── Podcast Index notices (lib/community/pi-notify.ts) ───────────────────────

/**
 * PI's own add form. A person adds a feed there by hand; it has a captcha, so no
 * server, script or agent sends it. /admin links it for each playlist Podcast Index
 * does not list yet (docs/feeds.md, "Podcast Index").
 */
export const PI_ADD_FORM = 'https://podcastindex.org/add';

/** One notice (keyless `hub/pubnotify` + podping) per feed in this window. */
export const PI_NOTICE_THROTTLE_MS = 10 * 60_000;
/** At most this many of ONE owner's playlists get their FIRST notice in a day. */
export const PI_NOTICE_OWNER_DAILY = 5;
/** At most this many playlists, over all makers, get their FIRST notice in a day. */
export const PI_NOTICE_GLOBAL_DAILY = 30;
/** The day the two caps count over. */
export const PI_NOTICE_DAY_MS = 24 * 60 * 60_000;
/** The wait before the second `hub/pubnotify` (MSP sends a second one too; our feed is `no-cache`). */
export const PI_SECOND_NOTIFY_MS = 15_000;

/** What `piNoticeAllowed` reads about one playlist; the server reads it from the store. */
export interface PiNoticeFacts {
  /** The owner is in `community_bans` now. */
  banned: boolean;
  /** Songs stored (each was checked against Podcast Index when it was saved). */
  songCount: number;
  /** The store holds this feed's Podcast Index id (`pi_feed_id`). */
  inIndex: boolean;
  /** A notice was sent for this playlist before (`pi_first_notified_at`). */
  notifiedBefore: boolean;
  /** When the last notice went (`pi_notified_at`, ms), or null for never. */
  lastNotifiedAt: number | null;
  /** This owner's playlists whose FIRST notice went in the last `PI_NOTICE_DAY_MS`. */
  ownerFirstToday: number;
  /** All playlists whose FIRST notice went in the last `PI_NOTICE_DAY_MS`. */
  allFirstToday: number;
  now: number;
}

export type PiNoticeRefusal = 'unknown' | 'banned' | 'too-few-songs' | 'throttled' | 'owner-cap' | 'global-cap';
export type PiNoticeVerdict = { send: true; first: boolean } | { send: false; reason: PiNoticeRefusal };

/**
 * May a publish or SAVE send its notice (one keyless `hub/pubnotify`, its second
 * one, and one podping)? A notice can add the feed to Podcast Index for good (PI has
 * no delete) and writes a public podping to Hive, and it needs no key, so a maker
 * could otherwise use this site to put junk feeds there. So:
 *
 * - not when the owner is banned, nor with fewer than `MIN_SONGS` songs;
 * - one per feed per `PI_NOTICE_THROTTLE_MS` (a timestamp in the future counts as
 *   recent: the safe direction for a clock that is ahead);
 * - a FIRST notice (never notified, and not known to be in the index) counts
 *   against two caps a day: `PI_NOTICE_OWNER_DAILY` for the owner and
 *   `PI_NOTICE_GLOBAL_DAILY` over all makers. A later notice for the same feed does
 *   not count: it is a feed PI was already told about.
 *
 * Anything that is not a finite number or a boolean answers `unknown`: no notice.
 * Guests (a browser key) follow the same rules: the global cap is the real guard,
 * because a guest key costs nothing to make.
 */
export function piNoticeAllowed(f: PiNoticeFacts): PiNoticeVerdict {
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  if (!num(f.now) || !num(f.songCount) || !num(f.ownerFirstToday) || !num(f.allFirstToday)
    || (f.lastNotifiedAt !== null && !num(f.lastNotifiedAt))
    || typeof f.banned !== 'boolean' || typeof f.inIndex !== 'boolean' || typeof f.notifiedBefore !== 'boolean') {
    return { send: false, reason: 'unknown' };
  }
  if (f.banned) return { send: false, reason: 'banned' };
  if (f.songCount < MIN_SONGS) return { send: false, reason: 'too-few-songs' };
  if (f.lastNotifiedAt !== null && f.now - f.lastNotifiedAt < PI_NOTICE_THROTTLE_MS) {
    return { send: false, reason: 'throttled' };
  }
  const first = !f.notifiedBefore && !f.inIndex;
  if (first && f.ownerFirstToday >= PI_NOTICE_OWNER_DAILY) return { send: false, reason: 'owner-cap' };
  if (first && f.allFirstToday >= PI_NOTICE_GLOBAL_DAILY) return { send: false, reason: 'global-cap' };
  return { send: true, first };
}

/**
 * The wait before the second `hub/pubnotify`: `PI_SECOND_NOTIFY_MS`, or a test's
 * `PI_NOTIFY_SETTLE_MS` (whole ms, 0 to `PI_SECOND_NOTIFY_MS`) when the notices go
 * to a loopback stub. On the real API the variable is ignored.
 */
export function piSecondNotifyMs(raw: string | undefined, toStub: boolean): number {
  if (!toStub || raw === undefined || !/^\d{1,6}$/.test(raw)) return PI_SECOND_NOTIFY_MS;
  return Math.min(Number(raw), PI_SECOND_NOTIFY_MS);
}

/**
 * The feed id in a Podcast Index lookup answer (`podcasts/byguid`, `podcasts/byfeedurl`),
 * or null. PI answers a guid it does not hold with `feed: []`, a URL with a 400, and
 * either may carry `feed` as an object or an array. Only a positive whole number is an id.
 */
export function piFeedIdFrom(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const feed = (body as { feed?: unknown }).feed;
  const one = Array.isArray(feed) ? feed[0] : feed;
  const id = one && typeof one === 'object' ? (one as { id?: unknown }).id : undefined;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}
