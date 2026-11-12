import { NextResponse } from 'next/server';
import { nip19 } from 'nostr-tools';
import { verifyNip98, authMessage } from './auth';
import { communityFeedGuid } from './feed-doc';
import type { CommunityPlaylistSummary, StoredPlaylist } from './rules';
import { communityFeedUrl, communityCoverUrl, coverVersion } from '../curated-playlists';

// SERVER-ONLY glue the three community-playlist routes share.

export const NOT_FOUND = () => NextResponse.json({ error: 'not found' }, { status: 404 });

/**
 * The URL a NIP-98 token must name: the request URL without its query string.
 * Behind a proxy `req.url` can carry an internal host, so `x-forwarded-*` wins.
 */
export function authUrl(req: Request): string {
  const u = new URL(req.url);
  const first = (h: string | null) => h?.split(',')[0]?.trim() || null;
  const host = first(req.headers.get('x-forwarded-host')) ?? u.host;
  const proto = first(req.headers.get('x-forwarded-proto')) ?? u.protocol.replace(/:$/, '');
  return `${proto}://${host}${u.pathname}`;
}

/** Verify the Authorization header; on failure return the 401 to send. */
export async function authenticate(
  req: Request,
  body: unknown | null,
): Promise<{ ok: true; pubkey: string } | { ok: false; response: NextResponse }> {
  const r = await verifyNip98(
    req.headers.get('authorization'),
    authUrl(req),
    req.method,
    // verifyNip98 re-parses and re-hashes, so the re-stringified body is equivalent.
    body === null ? null : JSON.stringify(body),
  );
  if (r.ok) return r;
  return { ok: false, response: NextResponse.json({ error: authMessage(r.reason) }, { status: 401 }) };
}

export function summaryOf(p: StoredPlaylist): CommunityPlaylistSummary {
  const feedUrl = communityFeedUrl(p.id);
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    feedUrl,
    podcastGuid: communityFeedGuid(feedUrl),
    ownerPubkey: p.ownerPubkey,
    ownerNpub: nip19.npubEncode(p.ownerPubkey),
    coverUrl: communityCoverUrl(p.id, coverVersion(p.updatedAt)),
    songCount: p.songs.length,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
