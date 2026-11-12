import { NextResponse } from 'next/server';
import { withErrorHandling, requireJsonBody, readCappedRequestJson, NO_STORE } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { COMMUNITY_PLAYLISTS_ON, communityFeedUrl } from '@/lib/curated-playlists';
import { validatePlaylistDraft, type DraftProblem, type ArtRefusal } from '@/lib/community/rules';
import { cleanText } from '@/lib/community/clean-text';
import { checkArt, verifySongs } from '@/lib/community/checks';
import { authenticate, summaryOf, NOT_FOUND } from '@/lib/community/http';
import { communityStoreConfigured, createPlaylist, isBanned, listPlaylists } from '@/lib/community/store';

export const runtime = 'nodejs';

type Problem =
  | DraftProblem
  | { kind: 'art'; reason: ArtRefusal }
  | { kind: 'song-not-found'; itemGuid: string }
  | { kind: 'not-music'; itemGuid: string };

const HEX64 = /^[0-9a-f]{64}$/;

export async function GET(req: Request) {
  const limited = rateLimit(req, 'community-playlists:list', 60);
  if (limited) return limited;
  if (!COMMUNITY_PLAYLISTS_ON) return NOT_FOUND();
  return withErrorHandling(async () => {
    if (!communityStoreConfigured()) return NextResponse.json({ playlists: [] }, { headers: NO_STORE });
    const owner = new URL(req.url).searchParams.get('owner');
    if (owner !== null && !HEX64.test(owner)) {
      return NextResponse.json({ error: 'invalid owner' }, { status: 400 });
    }
    const rows = await listPlaylists({ limit: 200, ...(owner ? { owner } : {}) });
    return NextResponse.json(
      { playlists: rows.map(summaryOf) },
      {
        // A listing for one owner is read back right after a write: never cache it.
        headers: owner
          ? NO_STORE
          : { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=300' },
      },
    );
  }, 'could not list playlists');
}

export async function POST(req: Request) {
  const limited = rateLimit(req, 'community-playlists:write', 20);
  if (limited) return limited;
  if (!COMMUNITY_PLAYLISTS_ON) return NOT_FOUND();
  const notJson = requireJsonBody(req);
  if (notJson) return notJson;
  return withErrorHandling(async () => {
    if (!communityStoreConfigured()) {
      return NextResponse.json({ error: 'community playlists are not available' }, { status: 503 });
    }
    const parsed = await readCappedRequestJson(req, 64 * 1024);
    if (!parsed.ok) return parsed.response;
    const auth = await authenticate(req, parsed.body);
    if (!auth.ok) return auth.response;
    if (await isBanned(auth.pubkey)) {
      return NextResponse.json({ error: 'This account cannot publish playlists.' }, { status: 403 });
    }
    const raw = (parsed.body && typeof parsed.body === 'object' ? parsed.body : {}) as { draft?: unknown };
    const v = validatePlaylistDraft(raw.draft);
    if (!v.ok) return NextResponse.json({ error: 'not publishable', problems: v.problems }, { status: 400 });

    const [art, songs] = await Promise.all([
      v.draft.artUrl ? checkArt(v.draft.artUrl) : Promise.resolve({ ok: true as const }),
      verifySongs(v.draft.songs),
    ]);
    const problems: Problem[] = [];
    if (!art.ok) problems.push({ kind: 'art', reason: art.reason });
    for (const itemGuid of songs.notFound) problems.push({ kind: 'song-not-found', itemGuid });
    for (const itemGuid of songs.notMusic) problems.push({ kind: 'not-music', itemGuid });
    if (problems.length) return NextResponse.json({ error: 'not publishable', problems }, { status: 400 });

    const row = await createPlaylist(auth.pubkey, {
      ...v.draft,
      title: cleanText(v.draft.title),
      description: cleanText(v.draft.description),
    });
    return NextResponse.json({ id: row.id, feedUrl: communityFeedUrl(row.id) }, { status: 201, headers: NO_STORE });
  }, 'could not publish the playlist');
}
