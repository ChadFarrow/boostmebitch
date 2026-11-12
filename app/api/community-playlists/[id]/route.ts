import { NextResponse } from 'next/server';
import { withErrorHandling, requireJsonBody, readCappedRequestJson, NO_STORE } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { COMMUNITY_PLAYLISTS_ON, communityFeedUrl } from '@/lib/curated-playlists';
import { notifyPodcastIndexAfter } from '@/lib/community/pi-notify';
import {
  validatePlaylistDraft, withIndexFeedUrls, MAX_PLAYLIST_BODY_BYTES, type DraftProblem, type ArtRefusal, type PlaylistSong,
} from '@/lib/community/rules';
import { textHoldsSecret } from '@/lib/nostr/npub-input';
import { cleanText } from '@/lib/community/clean-text';
import { checkArt, verifySongs } from '@/lib/community/checks';
import { adminPubkeys } from '@/lib/community/auth';
import { authenticate, NOT_FOUND, NOT_CONFIGURED, BANNED, UUID_RE } from '@/lib/community/http';
import {
  communityStoreConfigured, deletePlaylist, getPlaylist, isBanned, updatePlaylist,
} from '@/lib/community/store';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };
type Problem =
  | DraftProblem
  | { kind: 'art'; reason: ArtRefusal }
  | { kind: 'song-not-found'; itemGuid: string }
  | { kind: 'not-music'; itemGuid: string };

const unavailable = NOT_CONFIGURED;
const gone = () => NextResponse.json({ error: 'gone' }, { status: 410 });
const forbidden = () => NextResponse.json({ error: 'forbidden' }, { status: 403 });

export async function GET(req: Request, ctx: Ctx) {
  const limited = rateLimit(req, 'community-playlists:one', 120);
  if (limited) return limited;
  if (!COMMUNITY_PLAYLISTS_ON) return NOT_FOUND();
  return withErrorHandling(async () => {
    const { id } = await ctx.params;
    if (!UUID_RE.test(id)) return NOT_FOUND();
    if (!communityStoreConfigured()) return unavailable();
    const p = await getPlaylist(id);
    if (p === null) return NOT_FOUND();
    if (p === 'gone') return gone();
    // The editor reads this and sends `updatedAt` back as `expectedUpdatedAt`: never cache it.
    return NextResponse.json({ playlist: p }, { headers: NO_STORE });
  }, 'could not read the playlist');
}

export async function PUT(req: Request, ctx: Ctx) {
  const limited = rateLimit(req, 'community-playlists:write', 6);
  if (limited) return limited;
  if (!COMMUNITY_PLAYLISTS_ON) return NOT_FOUND();
  const notJson = requireJsonBody(req);
  if (notJson) return notJson;
  return withErrorHandling(async () => {
    const { id } = await ctx.params;
    if (!UUID_RE.test(id)) return NOT_FOUND();
    if (!communityStoreConfigured()) return unavailable();
    const parsed = await readCappedRequestJson(req, MAX_PLAYLIST_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const auth = await authenticate(req, parsed.body);
    if (!auth.ok) return auth.response;
    const cur = await getPlaylist(id);
    if (cur === null) return NOT_FOUND();
    if (cur === 'gone') return gone();
    if (cur.ownerPubkey !== auth.pubkey) return forbidden();
    if (await isBanned(auth.pubkey)) return BANNED();

    const raw = (parsed.body && typeof parsed.body === 'object' ? parsed.body : {}) as
      { draft?: unknown; expectedUpdatedAt?: unknown };
    if (typeof raw.expectedUpdatedAt !== 'string') {
      return NextResponse.json({ error: 'missing expectedUpdatedAt' }, { status: 400 });
    }
    if (Number.isNaN(Date.parse(raw.expectedUpdatedAt))) {
      return NextResponse.json({ error: 'bad expectedUpdatedAt' }, { status: 400 });
    }
    const v = validatePlaylistDraft(raw.draft, textHoldsSecret);
    if (!v.ok) return NextResponse.json({ error: 'not publishable', problems: v.problems }, { status: 400 });

    // Only what changed costs a lookup: songs the stored playlist already holds
    // passed the check when they were saved, and an unchanged cover link is not fetched again.
    const key = (s: PlaylistSong) => `${s.feedGuid}\n${s.itemGuid}`;
    const had = new Map(cur.songs.map((s) => [key(s), s]));
    const added = v.draft.songs.filter((s) => !had.has(key(s)));
    const [art, songs] = await Promise.all([
      v.draft.artUrl && v.draft.artUrl !== cur.artUrl ? checkArt(v.draft.artUrl) : Promise.resolve({ ok: true as const }),
      added.length ? verifySongs(added) : Promise.resolve({ notFound: [], notMusic: [], feedUrls: new Map<string, string>() }),
    ]);
    const problems: Problem[] = [];
    if (!art.ok) problems.push({ kind: 'art', reason: art.reason });
    for (const itemGuid of songs.notFound) problems.push({ kind: 'song-not-found', itemGuid });
    for (const itemGuid of songs.notMusic) problems.push({ kind: 'not-music', itemGuid });
    if (problems.length) return NextResponse.json({ error: 'not publishable', problems }, { status: 400 });

    // A kept song keeps the feedUrl stored when it was checked; an added one takes
    // Podcast Index's. The client's is never stored (rules.ts, withIndexFeedUrls).
    const stored = withIndexFeedUrls(v.draft.songs, (s) => {
      const kept = had.get(key(s));
      return kept ? kept.feedUrl : songs.feedUrls.get(s.feedGuid);
    });
    const out = await updatePlaylist(
      id,
      { ...v.draft, songs: stored, title: cleanText(v.draft.title), description: cleanText(v.draft.description) },
      raw.expectedUpdatedAt,
    );
    if (out === 'gone') return gone();
    if (out === 'banned') return BANNED();
    if (out === 'stale') return NextResponse.json({ error: 'changed elsewhere' }, { status: 409 });
    notifyPodcastIndexAfter(communityFeedUrl(id), 'update');
    return NextResponse.json({ playlist: out }, { headers: NO_STORE });
  }, 'could not save the playlist');
}

export async function DELETE(req: Request, ctx: Ctx) {
  const limited = rateLimit(req, 'community-playlists:delete', 20);
  if (limited) return limited;
  if (!COMMUNITY_PLAYLISTS_ON) return NOT_FOUND();
  return withErrorHandling(async () => {
    const { id } = await ctx.params;
    if (!UUID_RE.test(id)) return NOT_FOUND();
    if (!communityStoreConfigured()) return unavailable();
    const auth = await authenticate(req, null);
    if (!auth.ok) return auth.response;
    const cur = await getPlaylist(id);
    if (cur === null) return NOT_FOUND();
    if (cur === 'gone') return gone();
    const isOwner = cur.ownerPubkey === auth.pubkey;
    if (!isOwner && !adminPubkeys().has(auth.pubkey)) return forbidden();
    await deletePlaylist(id, isOwner ? 'owner' : auth.pubkey);
    notifyPodcastIndexAfter(communityFeedUrl(id), 'update');
    return NextResponse.json({ deleted: true }, { headers: NO_STORE });
  }, 'could not delete the playlist');
}
