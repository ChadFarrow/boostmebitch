import { NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
import { withErrorHandling } from '@/lib/api-handler';
import { getPlaylistChannel } from '@/lib/pi';
import { buildCover, buildFirstSongCover } from '@/lib/community/cover';
import { coverStyleFor } from '@/lib/community/rules';

/**
 * GET /api/playlist-cover?feedUrl=<playlist feed> → a 1400 x 1400 JPEG: for a
 * v4vmusic.com playlist its first song's art (v4vmusic's own style), for any
 * other host a 2 x 2 grid of its first four songs' covers (`coverStyleFor`).
 *
 * WHY. A playlist BMB does not host names its own `itunes:image`, and that
 * picture can die while the songs live on. On 2026-11-15 two of the curated
 * playlists showed a letter tile: "Christmas" (cover on RSS Blue, 410) and
 * "ChadF's favorite V4V albums" (a DigitalOcean CDN name with no DNS record, the
 * origin 404), while 33 of the 36 Christmas songs played. `<PodcastCover>` asks
 * this as its `fallbackSrc` rung, AFTER the feed's own cover, so the feed's
 * picture always wins while it loads (`playlistCoverFallback`, lib/util.ts).
 *
 * The same builder as a BMB playlist's `/feeds/playlists/<id>.jpg` with no art
 * link (`buildCover(null, songs)`), so the two look alike. The feed is read
 * through `getPlaylistChannel` → `fetchFeedXml`: `safeFetch`, the byte cap and
 * the shared 60 s cache, and a document that is not a playlist is a 404, never a
 * cover. Only the first four references are resolved: one Podcast Index batch
 * and four capped image fetches, whatever the playlist's length.
 */
export const runtime = 'nodejs';

const MAX_URL_LEN = 2048;

export async function GET(req: Request) {
  // Each playlist row on a page asks once, and the CDN keeps the answer a day.
  const limited = rateLimit(req, 'playlist-cover', 60);
  if (limited) return limited;

  const feedUrl = new URL(req.url).searchParams.get('feedUrl')?.trim() ?? '';
  if (!feedUrl || feedUrl.length > MAX_URL_LEN || !/^https?:\/\//i.test(feedUrl)) {
    return NextResponse.json({ error: 'bad feedUrl' }, { status: 400 });
  }

  return withErrorHandling(async () => {
    const ch = await getPlaylistChannel(feedUrl);
    if (!ch) return NextResponse.json({ error: 'not a playlist' }, { status: 404 });
    const songs = ch.refs.slice(0, 4).map((r) => ({ feedGuid: r.feedGuid, itemGuid: r.itemGuid }));
    // v4vmusic.com shows a playlist with its first song's art, so its playlists
    // match that; every other host gets BMB's grid (`coverStyleFor`).
    const c = coverStyleFor(feedUrl) === 'first-song' ? await buildFirstSongCover(songs) : await buildCover(null, songs);
    return new NextResponse(new Uint8Array(c.jpg), {
      headers: {
        'content-type': 'image/jpeg',
        // A grid built on a failure (Podcast Index or a tile could not be asked)
        // must not stay long; a good one changes only when the first four songs do.
        'cache-control': c.failed ? 'public, max-age=60, s-maxage=300' : 'public, max-age=86400, s-maxage=86400',
        'x-cover-source': c.source,
      },
    });
  }, 'could not build the playlist cover');
}
