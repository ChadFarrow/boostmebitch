import { NextResponse } from 'next/server';
import { withErrorHandling, NO_STORE } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { COMMUNITY_PLAYLISTS_ON } from '@/lib/curated-playlists';
import { communityStoreConfigured, readMakerHint } from '@/lib/community/store';

export const runtime = 'nodejs';

// GET /api/community-playlists/maker-hint?guid=<podcastGuid>
//
// The playlist ZAP tile's HINT, read once per page: who owns the playlist and
// whether a Lightning address was stored for them on PUBLISH or SAVE. It lights
// the tile on a first visit, before any relay answers (Chad, 2026-11-25:
// "saved-address: yes"). It answers a boolean, never the address: the payee is
// the maker's LIVE kind:0, read by the page (docs/money-boosts.md, "A HINT lights
// the tile"). The page also checks `owner` against the feed's npub.
//
// `zappable: null` = the database has no `maker_ln` column yet (unknown). No
// playlist, or the switch off, = 404. Cached briefly: a hint may lag a SAVE by a
// minute, and the live read corrects it.
export async function GET(req: Request) {
  const limited = rateLimit(req, 'community-playlists:maker-hint', 120);
  if (limited) return limited;
  if (!COMMUNITY_PLAYLISTS_ON) return NextResponse.json({ error: 'not found' }, { status: 404, headers: NO_STORE });
  return withErrorHandling(async () => {
    const guid = new URL(req.url).searchParams.get('guid') ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(guid)) {
      return NextResponse.json({ error: 'invalid guid' }, { status: 400, headers: NO_STORE });
    }
    if (!communityStoreConfigured()) return NextResponse.json({ error: 'not found' }, { status: 404, headers: NO_STORE });
    const hint = await readMakerHint(guid.toLowerCase());
    if (!hint) return NextResponse.json({ error: 'not found' }, { status: 404, headers: NO_STORE });
    return NextResponse.json(hint, {
      headers: { 'Cache-Control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=300' },
    });
  }, 'could not read the playlist');
}
