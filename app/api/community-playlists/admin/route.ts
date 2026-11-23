import { NextResponse } from 'next/server';
import { nip19 } from 'nostr-tools';
import { withErrorHandling, requireJsonBody, readCappedRequestJson, NO_STORE } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { COMMUNITY_PLAYLISTS_ON } from '@/lib/curated-playlists';
import { adminPiStates, notifyPodcastIndexAfter } from '@/lib/community/pi-notify';
import { requestPlaylistArchiveAfter } from '@/lib/community/archive-notify';
import { adminPubkeys } from '@/lib/community/auth';
import { authenticate, summaryOf, NOT_FOUND, NOT_CONFIGURED, UUID_RE } from '@/lib/community/http';
import {
  banPubkey, communityStoreConfigured, deletePlaylist, deletePlaylistsByOwner, listBans,
  listPlaylists, unbanPubkey,
} from '@/lib/community/store';

export const runtime = 'nodejs';
// GET looks up the unlisted playlists in Podcast Index (6 s budget, `adminPiStates`).
export const maxDuration = 30;

const unavailable = NOT_CONFIGURED;
const forbidden = () => NextResponse.json({ error: 'forbidden' }, { status: 403 });

/** A pubkey given as 64 hex characters or as an npub; null when it is neither. */
function pubkeyOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (/^[0-9a-f]{64}$/.test(raw)) return raw;
  try {
    const d = nip19.decode(raw);
    return d.type === 'npub' ? d.data : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const limited = rateLimit(req, 'community-playlists:admin', 30);
  if (limited) return limited;
  if (!COMMUNITY_PLAYLISTS_ON) return NOT_FOUND();
  return withErrorHandling(async () => {
    if (!communityStoreConfigured()) return unavailable();
    const auth = await authenticate(req, null);
    if (!auth.ok) return auth.response;
    if (!adminPubkeys().has(auth.pubkey)) return forbidden();
    const [rows, bans, pi] = await Promise.all([
      listPlaylists({ limit: 200 }),
      listBans(),
      // The Podcast Index half fails ALONE: without it the page still moderates.
      adminPiStates(200).catch((e) => {
        console.warn('[community-pi] admin state failed:', e instanceof Error ? e.message : String(e));
        return null;
      }),
    ]);
    // `pi: null`: no Podcast Index state (the pi_* columns are missing, or the read
    // failed). Otherwise one entry per live playlist; docs/feeds.md, "Podcast Index".
    return NextResponse.json({ playlists: rows.map(summaryOf), bans, pi }, { headers: NO_STORE });
  }, 'could not read the admin list');
}

export async function POST(req: Request) {
  const limited = rateLimit(req, 'community-playlists:admin', 30);
  if (limited) return limited;
  if (!COMMUNITY_PLAYLISTS_ON) return NOT_FOUND();
  const notJson = requireJsonBody(req);
  if (notJson) return notJson;
  return withErrorHandling(async () => {
    if (!communityStoreConfigured()) return unavailable();
    const parsed = await readCappedRequestJson(req, 64 * 1024);
    if (!parsed.ok) return parsed.response;
    const auth = await authenticate(req, parsed.body);
    if (!auth.ok) return auth.response;
    if (!adminPubkeys().has(auth.pubkey)) return forbidden();

    const b = (parsed.body && typeof parsed.body === 'object' ? parsed.body : {}) as
      { action?: unknown; pubkey?: unknown; id?: unknown; deleteAll?: unknown };
    if (b.action === 'ban' || b.action === 'unban') {
      const pubkey = pubkeyOf(b.pubkey);
      if (!pubkey) return NextResponse.json({ error: 'invalid pubkey' }, { status: 400 });
      if (b.action === 'unban') {
        await unbanPubkey(pubkey);
        return NextResponse.json({ ok: true }, { headers: NO_STORE });
      }
      await banPubkey(pubkey, auth.pubkey);
      const deletedIds = b.deleteAll === true ? await deletePlaylistsByOwner(pubkey, auth.pubkey) : [];
      if (deletedIds.length > 0) {
        notifyPodcastIndexAfter(deletedIds, 'gone');
        requestPlaylistArchiveAfter();
      }
      return NextResponse.json({ ok: true, deleted: deletedIds.length }, { headers: NO_STORE });
    }
    if (b.action === 'delete') {
      if (typeof b.id !== 'string' || !UUID_RE.test(b.id)) {
        return NextResponse.json({ error: 'invalid id' }, { status: 400 });
      }
      const done = await deletePlaylist(b.id, auth.pubkey);
      if (done) {
        notifyPodcastIndexAfter(b.id, 'gone');
        requestPlaylistArchiveAfter();
      }
      return NextResponse.json({ ok: true, deleted: done ? 1 : 0 }, { headers: NO_STORE });
    }
    return NextResponse.json({ error: 'invalid action' }, { status: 400 });
  }, 'could not run the admin action');
}
