import { NextResponse } from 'next/server';
import { withErrorHandling, requireJsonBody, readCappedRequestJson, NO_STORE } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { COMMUNITY_PLAYLISTS_ON, communityFeedUrl } from '@/lib/curated-playlists';
import {
  validatePlaylistDraft, withIndexFeedUrls, MAX_PLAYLIST_BODY_BYTES, type DraftProblem, type ArtRefusal,
} from '@/lib/community/rules';
import { textHoldsSecret } from '@/lib/nostr/npub-input';
import { cleanText } from '@/lib/community/clean-text';
import { checkArt, verifySongs } from '@/lib/community/checks';
import { authenticate, summaryOf, NOT_FOUND, NOT_CONFIGURED, BANNED } from '@/lib/community/http';
import { notifyPodcastIndexAfter } from '@/lib/community/pi-notify';
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
  const limited = rateLimit(req, 'community-playlists:write', 6);
  if (limited) return limited;
  if (!COMMUNITY_PLAYLISTS_ON) return NOT_FOUND();
  const notJson = requireJsonBody(req);
  if (notJson) return notJson;
  return withErrorHandling(async () => {
    if (!communityStoreConfigured()) {
      return NOT_CONFIGURED();
    }
    const parsed = await readCappedRequestJson(req, MAX_PLAYLIST_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const auth = await authenticate(req, parsed.body);
    if (!auth.ok) return auth.response;
    if (await isBanned(auth.pubkey)) {
      return BANNED();
    }
    const raw = (parsed.body && typeof parsed.body === 'object' ? parsed.body : {}) as { draft?: unknown };
    // A secret key in the title or description is refused here (`{ kind: 'secret' }`,
    // the text never echoed) before anything is stored or sent to Podcast Index.
    const v = validatePlaylistDraft(raw.draft, textHoldsSecret);
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
      // Each feedUrl is the one Podcast Index holds, never the client's (rules.ts).
      songs: withIndexFeedUrls(v.draft.songs, (s) => songs.feedUrls.get(s.feedGuid)),
      title: cleanText(v.draft.title),
      description: cleanText(v.draft.description),
    });
    // A ban that landed after the isBanned read above is caught inside the INSERT.
    if (row === 'banned') return BANNED();
    notifyPodcastIndexAfter(communityFeedUrl(row.id), 'new');
    return NextResponse.json({ id: row.id, feedUrl: communityFeedUrl(row.id) }, { status: 201, headers: NO_STORE });
  }, 'could not publish the playlist');
}
