import { NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
import { COMMUNITY_FEED_ORIGIN, COMMUNITY_FEEDS_ON, communityFeedUrl, communityCoverUrl, coverVersion } from '@/lib/curated-playlists';
import { buildPlaylistFeedXml } from '@/lib/community/feed-doc';
import { buildCover } from '@/lib/community/cover';
import { communityStoreConfigured, getPlaylist } from '@/lib/community/store';
import { UUID_RE, authUrl } from '@/lib/community/http';
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
  // First line, as on every route: the limit holds whether the feature is on or off.
  const limited = rateLimit(req, 'community-feed', 240);
  if (limited) return limited;
  // The feed and cover answer wherever published playlists are served, maker or not.
  if (!COMMUNITY_FEEDS_ON) return text(404);
  const { file } = await ctx.params;
  const m = /^(.+)\.(xml|jpg)$/.exec(file);
  if (!m || !UUID_RE.test(m[1])) return text(404);
  const [, id, ext] = m;
  // A playlist feed has ONE address, on COMMUNITY_FEED_ORIGIN. Any other host that
  // runs this route (beta, the bitch site, a deployment URL) sends the app there for
  // good, so an app that subscribed to another copy moves itself (Chad, 2026-11-12).
  // 301 is the code podcast apps read as "update the subscription". The host comes
  // from authUrl (x-forwarded-host behind Vercel). No Cache-Control, like every
  // answer but a 200.
  const here = new URL(authUrl(req));
  if (here.origin !== new URL(COMMUNITY_FEED_ORIGIN).origin) {
    return NextResponse.redirect(`${COMMUNITY_FEED_ORIGIN}${here.pathname}${new URL(req.url).search}`, 301);
  }
  if (!communityStoreConfigured()) return text(404);
  return withErrorHandling(async () => {
    const p = await getPlaylist(id);
    if (p === null) return text(404);
    if (p === 'gone') return text(410);
    if (ext === 'xml') {
      const xml = buildPlaylistFeedXml(p, {
        feedUrl: communityFeedUrl(id),
        // The listener's own link: apps load it from its host, and this site serves no
        // listener's picture to them. Only a playlist with no link gets our cover (the grid).
        coverUrl: p.artUrl ?? communityCoverUrl(id, coverVersion(p.updatedAt)),
        ownerNpub: nip19.npubEncode(p.ownerPubkey),
        fallbackDescription: `A community playlist on ${BRAND.displayName}.`,
        // The guid saved when the row was made, never one recomputed from today's origin.
        podcastGuid: p.podcastGuid,
      });
      return new NextResponse(xml, {
        headers: {
          'content-type': 'application/rss+xml; charset=utf-8',
          'cache-control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=600',
        },
      });
    }
    // Only the exact current address (`?v=<current>`, nothing else) reaches the
    // expensive path. Any other query — an old version a podcast app cached with an
    // older feed, none, or extra junk — is sent to the current address. 307, not a
    // permanent redirect: the current version moves with every edit, and a cached
    // permanent answer would pin today's target. No Cache-Control: a 200 only.
    const current = coverVersion(p.updatedAt);
    if (new URL(req.url).search !== `?v=${current}`) {
      return NextResponse.redirect(communityCoverUrl(id, current), 307);
    }
    const c = await buildCover(p.artUrl, p.songs);
    return new NextResponse(new Uint8Array(c.jpg), {
      headers: {
        'content-type': 'image/jpeg',
        // A cover that fell back because something failed must not stay cached long,
        // and no cover stays a day: a deleted playlist's cover must leave the CDN soon.
        'cache-control': c.failed ? 'public, max-age=60, s-maxage=300' : 'public, max-age=3600, s-maxage=3600',
        'x-cover-source': c.source,
      },
    });
  }, 'could not build the playlist file');
}
