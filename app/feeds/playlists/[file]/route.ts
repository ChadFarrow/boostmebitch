import { NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
import { COMMUNITY_PLAYLISTS_ON, communityFeedUrl, communityCoverUrl, coverVersion } from '@/lib/curated-playlists';
import { buildPlaylistFeedXml } from '@/lib/community/feed-doc';
import { buildCover } from '@/lib/community/cover';
import { communityStoreConfigured, getPlaylist } from '@/lib/community/store';
import { UUID_RE } from '@/lib/community/http';
import { withErrorHandling } from '@/lib/api-handler';
import { BRAND } from '@/lib/brand';
import { nip19 } from 'nostr-tools';

export const runtime = 'nodejs';

// The public feed and cover of a community playlist: /feeds/playlists/<uuid>.xml and .jpg.
// The store is the authority; these answers are built from it on every cold read.

// No Cache-Control on a 404 or 410: only a 200 is cached.
const text = (status: number) => new NextResponse(status === 410 ? 'gone' : 'not found', {
  status, headers: { 'content-type': 'text/plain; charset=utf-8' },
});

export async function GET(req: Request, ctx: { params: Promise<{ file: string }> }) {
  if (!COMMUNITY_PLAYLISTS_ON) return text(404);
  const limited = rateLimit(req, 'community-feed', 240);
  if (limited) return limited;
  const { file } = await ctx.params;
  const m = /^(.+)\.(xml|jpg)$/.exec(file);
  if (!m || !UUID_RE.test(m[1])) return text(404);
  const [, id, ext] = m;
  if (!communityStoreConfigured()) return text(404);
  return withErrorHandling(async () => {
    const p = await getPlaylist(id);
    if (p === null) return text(404);
    if (p === 'gone') return text(410);
    if (ext === 'xml') {
      const xml = buildPlaylistFeedXml(p, {
        feedUrl: communityFeedUrl(id),
        coverUrl: communityCoverUrl(id, coverVersion(p.updatedAt)),
        ownerNpub: nip19.npubEncode(p.ownerPubkey),
        fallbackDescription: `A community playlist on ${BRAND.displayName}.`,
      });
      return new NextResponse(xml, {
        headers: {
          'content-type': 'application/rss+xml; charset=utf-8',
          'cache-control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=600',
        },
      });
    }
    // A random `?v=` must not reach the expensive path: only the current version is built.
    const v = new URL(req.url).searchParams.get('v');
    if (v !== null && v !== String(coverVersion(p.updatedAt))) return text(404);
    const c = await buildCover(p.artUrl, p.songs);
    return new NextResponse(new Uint8Array(c.jpg), {
      headers: {
        'content-type': 'image/jpeg',
        // A cover that fell back because something failed must not stay cached for a day.
        'cache-control': c.failed ? 'public, max-age=60, s-maxage=300' : 'public, max-age=3600, s-maxage=86400',
        'x-cover-source': c.source,
      },
    });
  }, 'could not build the playlist file');
}
