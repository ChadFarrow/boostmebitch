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
  if (override) {
    try {
      const u = new URL(override);
      const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
      return u.protocol === 'http:' && loopback && !u.username && !u.password ? u.origin : null;
    } catch {
      return null;
    }
  }
  return feedOrigin === PRODUCTION_FEED_ORIGIN ? 'https://api.github.com' : null;
}
