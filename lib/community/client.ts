// Browser-only: signs NIP-98 calls to the community-playlist routes with whichever
// signer is active (Amber, bunker, local key or NIP-07).
import { getToken } from 'nostr-tools/nip98';
import { activeNostr } from '@/lib/nostr/signer';
import type { CommunityPlaylistSummary, PlaylistDraft, StoredPlaylist } from './rules';

export const PLAYLISTS_PATH = '/api/community-playlists';
const DEFAULT_SIGN_TIMEOUT_MS = 90_000;

/** The signer did not answer in time (a closed Amber, a dismissed prompt). */
export class SignTimeoutError extends Error {
  constructor() {
    super('The signer did not answer.');
    this.name = 'SignTimeoutError';
  }
}

/** The signer is missing. */
export class NoSignerError extends Error {
  constructor() {
    super('No signer is connected.');
    this.name = 'NoSignerError';
  }
}

function signTimeoutMs(o?: { timeoutMs?: number }): number {
  // `window.__bmbSignTimeoutMs` is the e2e's lever: honoured only when it is set.
  const w = (typeof window !== 'undefined' ? (window as unknown as { __bmbSignTimeoutMs?: unknown }) : {}).__bmbSignTimeoutMs;
  if (typeof w === 'number' && w > 0) return w;
  return o?.timeoutMs ?? DEFAULT_SIGN_TIMEOUT_MS;
}

/**
 * One request with a NIP-98 `Authorization` header. Only the SIGN step races the
 * timeout; the network call after it has its own life. Rejects with
 * `SignTimeoutError` when the signer is silent, `NoSignerError` with none.
 */
export async function signedFetch(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
  o?: { timeoutMs?: number },
): Promise<Response> {
  const nostr = activeNostr();
  if (!nostr) throw new NoSignerError();
  const url = `${location.origin}${path}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SignTimeoutError()), signTimeoutMs(o));
  });
  let token: string;
  try {
    token = await Promise.race([getToken(url, method, (e) => nostr.signEvent(e), true, body as Record<string, unknown> | undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
  return fetch(url, {
    method,
    headers: {
      Authorization: token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const publishPlaylist = (d: PlaylistDraft) =>
  signedFetch(PLAYLISTS_PATH, 'POST', { draft: d });

export const savePlaylist = (id: string, d: PlaylistDraft, expectedUpdatedAt: string) =>
  signedFetch(`${PLAYLISTS_PATH}/${id}`, 'PUT', { draft: d, expectedUpdatedAt });

export const deleteOwnPlaylist = (id: string) =>
  signedFetch(`${PLAYLISTS_PATH}/${id}`, 'DELETE');

/** An unsigned read: the route answers anyone. `null` means it could not be loaded. */
export async function fetchPlaylist(id: string): Promise<StoredPlaylist | null> {
  try {
    const r = await fetch(`${PLAYLISTS_PATH}/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const j = (await r.json()) as { playlist?: StoredPlaylist };
    return j.playlist ?? null;
  } catch {
    return null;
  }
}

/** `owner` is a hex pubkey. `null` = could not load (never an empty list for a failure). */
export async function fetchCommunityPlaylists(owner?: string): Promise<CommunityPlaylistSummary[] | null> {
  try {
    const q = owner ? `?owner=${encodeURIComponent(owner)}` : '';
    const r = await fetch(`${PLAYLISTS_PATH}${q}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const j = (await r.json()) as { playlists?: CommunityPlaylistSummary[] };
    return Array.isArray(j.playlists) ? j.playlists : null;
  } catch {
    return null;
  }
}
