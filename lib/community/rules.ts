// Pure rules for community playlists. Import-free on purpose: check:community
// loads this file under plain Node.

export const MIN_SONGS = 10;
export const MAX_SONGS = 500;
export const MAX_TITLE_LEN = 120;
export const MAX_DESCRIPTION_LEN = 1000;
export const ART_MIN_PX = 1400;
export const ART_MAX_PX = 3000;

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
  | { kind: 'art-not-https' };

const len = (s: string) => [...s].length;
const isHttp = (u: string) => /^https?:\/\//i.test(u);

export function validatePlaylistDraft(
  raw: unknown,
): { ok: true; draft: PlaylistDraft } | { ok: false; problems: DraftProblem[] } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const problems: DraftProblem[] = [];

  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const description = typeof o.description === 'string' ? o.description.trim() : '';
  if (!title) problems.push({ kind: 'title-missing' });
  else if (len(title) > MAX_TITLE_LEN) problems.push({ kind: 'title-too-long' });
  if (len(description) > MAX_DESCRIPTION_LEN) problems.push({ kind: 'description-too-long' });

  const artRaw = typeof o.artUrl === 'string' ? o.artUrl.trim() : '';
  const artUrl = artRaw === '' ? null : artRaw;
  if (artUrl !== null && !/^https:\/\//i.test(artUrl)) problems.push({ kind: 'art-not-https' });

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
    if (typeof r.feedUrl === 'string' && isHttp(r.feedUrl)) song.feedUrl = r.feedUrl;
    songs.push(song);
  });
  if (rawSongs.length > MAX_SONGS) problems.push({ kind: 'too-many-songs', have: rawSongs.length });
  else if (songs.length < MIN_SONGS) problems.push({ kind: 'too-few-songs', have: songs.length });

  if (problems.length) return { ok: false, problems };
  return { ok: true, draft: { title, description, artUrl, songs } };
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
