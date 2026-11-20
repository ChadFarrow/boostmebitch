// Browser-only: signs NIP-98 calls to the community-playlist routes with whichever
// signer is active (Amber, bunker, local key or NIP-07).
import { getToken } from 'nostr-tools/nip98';
import type { Event, EventTemplate } from 'nostr-tools/pure';
import { activeNostr } from '@/lib/nostr/signer';
import type { CommunityPlaylistSummary, PlaylistDraft, StoredPlaylist } from './rules';

export const PLAYLISTS_PATH = '/api/community-playlists';

/**
 * What a community call needs from a signer: `signEvent`, nothing else. The active
 * signer has it; so does the guest key (`lib/community/guest-key.ts`), which is not
 * a signer the app signs in with and is never `window.nostr`.
 */
export interface CommunitySigner {
  signEvent: (template: EventTemplate) => Promise<Event>;
}

/** `signer`: sign with this instead of the active one (the guest key). */
export interface SignOptions {
  timeoutMs?: number;
  signer?: CommunitySigner;
}
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

/**
 * The signer answered with a failure, or its transport threw: a bunker whose
 * connection dropped, a refused prompt, an extension that errored. The request
 * never left, so this must never read as "could not reach the server" — it did
 * (2026-11-15: a disconnected signer on beta showed exactly that, and only
 * reconnecting the signer fixed it). `cause` is the signer's own rejection,
 * which for a NIP-46 bunker is a bare string (docs/signers.md).
 */
export class SignFailedError extends Error {
  constructor(public readonly cause: unknown) {
    super('The signer did not sign.');
    this.name = 'SignFailedError';
  }
}

function signTimeoutMs(o?: { timeoutMs?: number }): number {
  // `window.__bmbSignTimeoutMs` is the e2e's lever: honoured only when it is set.
  const w = (typeof window !== 'undefined' ? (window as unknown as { __bmbSignTimeoutMs?: unknown }) : {}).__bmbSignTimeoutMs;
  if (typeof w === 'number' && w > 0) return w;
  return o?.timeoutMs ?? DEFAULT_SIGN_TIMEOUT_MS;
}

/**
 * Race one signer call against the sign timeout. Rejects with `SignTimeoutError`
 * when the signer is silent and `SignFailedError` when it fails: every rejection
 * from the SIGN step is a signer problem, never a network one.
 */
export async function withSignTimeout<T>(p: Promise<T>, o?: { timeoutMs?: number }): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SignTimeoutError()), signTimeoutMs(o));
  });
  try {
    return await Promise.race([p, timeout]);
  } catch (e) {
    if (e instanceof SignTimeoutError) throw e;
    console.warn('[community] signer failed', e);
    throw new SignFailedError(e);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One request with a NIP-98 `Authorization` header. Only the SIGN step races the
 * timeout; the network call after it has its own life. Rejects with
 * `SignTimeoutError` when the signer is silent, `SignFailedError` when it fails,
 * `NoSignerError` with none. `o.signer` replaces the active signer for this one call.
 */
export async function signedFetch(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
  o?: SignOptions,
): Promise<Response> {
  const nostr = o?.signer ?? activeNostr();
  if (!nostr) throw new NoSignerError();
  const url = `${location.origin}${path}`;
  const token = await withSignTimeout(
    getToken(url, method, (e) => nostr.signEvent(e), true, body as Record<string, unknown> | undefined),
    o,
  );
  return fetch(url, {
    method,
    headers: {
      Authorization: token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const publishPlaylist = (d: PlaylistDraft, o?: SignOptions) =>
  signedFetch(PLAYLISTS_PATH, 'POST', { draft: d }, o);

export const savePlaylist = (id: string, d: PlaylistDraft, expectedUpdatedAt: string, o?: SignOptions) =>
  signedFetch(`${PLAYLISTS_PATH}/${id}`, 'PUT', { draft: d, expectedUpdatedAt }, o);

export const deleteOwnPlaylist = (id: string, o?: SignOptions) =>
  signedFetch(`${PLAYLISTS_PATH}/${id}`, 'DELETE', undefined, o);

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
