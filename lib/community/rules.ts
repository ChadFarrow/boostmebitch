// Pure rules for community playlists. Import-free on purpose: check:community
// loads this file under plain Node.

export const MIN_SONGS = 10;
export const MAX_SONGS = 500;
export const MAX_TITLE_LEN = 120;
export const MAX_DESCRIPTION_LEN = 1000;
export const ART_MIN_PX = 1400;
export const ART_MAX_PX = 3000;
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
  artUrl: string | null;
  songs: PlaylistSong[];
}

export type DraftProblem =
  | { kind: 'title-missing' }
  | { kind: 'title-too-long' }
  | { kind: 'description-too-long' }
  | { kind: 'too-few-songs'; have: number }
  | { kind: 'too-many-songs'; have: number }
  | { kind: 'duplicate-song'; itemGuid: string }
  | { kind: 'bad-song'; index: number }
  | { kind: 'art-not-https' }
  /** Starts with https:// but is no usable address: no host, unparsable, or over MAX_URL_LEN. */
  | { kind: 'art-bad-link' }
  /** The field holds what looks like a secret key or an NWC string. The text is never echoed. */
  | { kind: 'secret'; field: 'title' | 'description' };

const len = (s: string) => [...s].length;

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
  // First, so the maker names it before anything else: the playlist is public.
  if (holdsSecret(title)) problems.push({ kind: 'secret', field: 'title' });
  if (holdsSecret(description)) problems.push({ kind: 'secret', field: 'description' });
  if (!title) problems.push({ kind: 'title-missing' });
  else if (len(title) > MAX_TITLE_LEN) problems.push({ kind: 'title-too-long' });
  if (len(description) > MAX_DESCRIPTION_LEN) problems.push({ kind: 'description-too-long' });

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
  return { ok: true, draft: { title, description, artUrl, songs } };
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

export type ArtRefusal = 'not-image' | 'format' | 'not-square' | 'too-small' | 'too-large' | 'alpha';

export function artVerdict(meta: {
  format?: string;
  width?: number;
  height?: number;
  hasAlpha?: boolean;
}): { ok: true } | { ok: false; reason: ArtRefusal } {
  const { format, width, height, hasAlpha } = meta;
  if (!format || !width || !height) return { ok: false, reason: 'not-image' };
  if (format !== 'jpeg' && format !== 'png') return { ok: false, reason: 'format' };
  if (width !== height) return { ok: false, reason: 'not-square' };
  if (width < ART_MIN_PX) return { ok: false, reason: 'too-small' };
  if (width > ART_MAX_PX) return { ok: false, reason: 'too-large' };
  if (hasAlpha) return { ok: false, reason: 'alpha' };
  return { ok: true };
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
  coverUrl: string;
  songCount: number;
  createdAt: string;
  updatedAt: string;
}
