import { NextResponse } from 'next/server';
import { getFeedFromRss } from '@/lib/pi';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';

/**
 * Resolve a NIP-73 `podcast:item:guid:` favorite from the feed's RSS, for the
 * items Podcast Index can't answer for.
 *
 * This is step 3 of the spec's "Resolving an entry" — fall back to the
 * position-2 URL hint and search the feed's items — and it is not a rare edge
 * case. `/api/episode-by-guid` needs PI to hold both the feed and the episode,
 * and for self-hosted music feeds it frequently holds neither: measured against
 * a real shared list, PI resolved 0 of 227 track favorites while their parent
 * feeds' RSS resolved 223 of them. Without this route those favorites sync
 * correctly, survive every merge, and then render as nothing at all.
 *
 * The item guid is the ONLY match key. Titles collide across feeds and are
 * re-edited upstream; the guid is what the favorite was published under.
 *
 * SSRF: `feedUrl` is caller-supplied, so the fetch goes through `getFeedFromRss`
 * → `fetchFeedXml`, which is guarded in lib/safe-fetch.ts. Do not swap in a
 * bare `fetch` here.
 *
 * See github.com/ChadFarrow/PC20-Nostr/specs/pc20-favorites.md
 */
export async function GET(req: Request) {
  // Matches /api/episode-by-guid: favorites hydration fans out across a whole
  // list on a fresh device, and this route is the fallback for that same fan-out.
  const limited = rateLimit(req, 'episode-by-feed-url', 300);
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const feedUrl = searchParams.get('feedUrl')?.trim();
  const itemGuid = searchParams.get('itemGuid')?.trim();
  if (!feedUrl || !itemGuid) {
    return NextResponse.json({ error: 'missing feedUrl or itemGuid' }, { status: 400 });
  }
  // Item guids are any globally-unique string per the spec and are routinely
  // permalink URLs, so they get the same slack as in /api/episode-by-guid.
  if (feedUrl.length > 2048) return NextResponse.json({ error: 'invalid feedUrl' }, { status: 400 });
  if (itemGuid.length > 2048) return NextResponse.json({ error: 'invalid itemGuid' }, { status: 400 });

  return withErrorHandling(async () => {
    const parsed = await getFeedFromRss(feedUrl);
    const episode = parsed?.episodes.find((e) => e.guid === itemGuid);
    // 404, never 500 — a 5xx trips the client-side breaker and disables ALL
    // metadata resolution for the rest of the tab (same reasoning as
    // /api/episode-by-guid). A feed that no longer carries the guid is a
    // legitimate not-found, not a server fault.
    if (!episode) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(
      // The feed's own title is the only source of the show name here — PI
      // doesn't know this feed, so `feedTitle` would otherwise be blank and the
      // row would render an episode with no podcast attached.
      { episode: { ...episode, feedTitle: episode.feedTitle ?? parsed?.podcast.title } },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
    );
  }, 'lookup failed');
}
