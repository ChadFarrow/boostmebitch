import { NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
import {
  COMMUNITY_FEED_ORIGIN, COMMUNITY_FEEDS_ON, communityFeedUrl, communityCoverUrl, coverVersion, communityPublisherFeedUrl,
} from '@/lib/curated-playlists';
import { buildPublisherFeedXml, communityFeedGuid } from '@/lib/community/feed-doc';
import { communityStoreConfigured, listPlaylists } from '@/lib/community/store';
import { authUrl } from '@/lib/community/http';
import { withErrorHandling } from '@/lib/api-handler';
import { BRANDS } from '@/lib/brand';
import { nip19 } from 'nostr-tools';

export const runtime = 'nodejs';

// A maker's publisher feed: /feeds/publishers/<npub>.xml. It lists every playlist the
// maker published (`<podcast:medium>publisher`), and each playlist names it back in
// `<podcast:publisher>` (app/feeds/playlists). Same switch, limit, single address and
// caching as the playlist feed beside it. Built from the store on every cold read.

// No Cache-Control on a 404: only a 200 is cached.
const notFound = () => new NextResponse('not found', {
  status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' },
});

/** The owner's hex key when `npub` is a canonical (lower-case) npub, else null. */
function ownerOf(npub: string): string | null {
  try {
    const d = nip19.decode(npub);
    if (d.type !== 'npub' || nip19.npubEncode(d.data) !== npub) return null;
    return d.data;
  } catch {
    return null;
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ file: string }> }) {
  // First line, as on every route: the limit holds whether the feature is on or off.
  const limited = rateLimit(req, 'community-publisher-feed', 240);
  if (limited) return limited;
  if (!COMMUNITY_FEEDS_ON) return notFound();
  const { file } = await ctx.params;
  const m = /^(npub1[a-z0-9]+)\.xml$/.exec(file);
  const owner = m ? ownerOf(m[1]) : null;
  if (!m || !owner) return notFound();
  const npub = m[1];
  // One address per feed, as for a playlist: any other host answers 301 to the feed origin.
  const here = new URL(authUrl(req));
  if (here.origin !== new URL(COMMUNITY_FEED_ORIGIN).origin) {
    return NextResponse.redirect(`${COMMUNITY_FEED_ORIGIN}${here.pathname}${new URL(req.url).search}`, 301);
  }
  if (!communityStoreConfigured()) return notFound();
  return withErrorHandling(async () => {
    const rows = await listPlaylists({ limit: 200, owner });
    // The spec requires one remoteItem at least, and a maker with no published playlist
    // has no publisher feed: 404, so an arbitrary npub does not get an empty feed.
    if (rows.length === 0) return notFound();
    const feedUrl = communityPublisherFeedUrl(npub);
    const xml = buildPublisherFeedXml(
      rows.map((p) => ({
        feedUrl: communityFeedUrl(p.id),
        podcastGuid: p.podcastGuid,
        coverUrl: p.artUrl ?? communityCoverUrl(p.id, coverVersion(p.updatedAt)),
        updatedAt: p.updatedAt,
      })),
      {
        feedUrl,
        podcastGuid: communityFeedGuid(feedUrl),
        ownerNpub: npub,
        // The name on the newest playlist: the maker's Nostr name when it was saved.
        ownerName: rows[0].ownerName,
        siteName: BRANDS.buddy.displayName,
        generator: `${BRANDS.buddy.displayName} (${BRANDS.buddy.origin})`,
      },
    );
    return new NextResponse(xml, {
      headers: {
        'content-type': 'application/rss+xml; charset=utf-8',
        'cache-control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=600',
      },
    });
  }, 'could not build the publisher feed');
}
