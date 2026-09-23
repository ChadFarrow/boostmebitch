import { NextResponse } from 'next/server';
import { PI_EPISODE_MAX, getEpisodes, getPodcast, getRssItemValueTimeSplits, resolveValueTimeSplits } from '@/lib/pi';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';

export async function GET(req: Request) {
  const limited = rateLimit(req, 'value-splits', 30);
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const feedId = Number(searchParams.get('feedId'));
  // Episode ids can be negative (RSS-derived live items use -fnvHash), so
  // only zero/NaN/fractional are invalid.
  const episodeId = Number(searchParams.get('episodeId'));
  if (!Number.isInteger(feedId) || feedId <= 0 || !Number.isInteger(episodeId) || episodeId === 0) {
    return NextResponse.json({ error: 'missing or invalid feedId / episodeId' }, { status: 400 });
  }
  return withErrorHandling(async () => {
    // Same `max` as /api/feed on purpose, twice over: an episode the list can
    // show must be one this route can find its tracks for, and an identical PI
    // URL shares that route's fetch cache entry instead of opening a second.
    const episodes = await getEpisodes(feedId, PI_EPISODE_MAX);
    const episode = episodes.find((e) => e.id === episodeId);
    // A NEGATIVE id PI does not hold is an item /api/feed read from the RSS
    // because PI had not crawled it yet (`getRssEpisodesNewerThan`). Its
    // windows are in the feed, not in PI — and a 404 here does not fail the
    // boost: the modal falls back to the SHOW's block for a boost pressed
    // during a song, and streaming pays the show for the whole track.
    let raw = episode?.valueTimeSplits;
    if (!episode && episodeId < 0) {
      const podcast = await getPodcast(feedId);
      raw = podcast?.url ? (await getRssItemValueTimeSplits(podcast.url, episodeId)) ?? undefined : undefined;
    }
    if (!episode && !raw) return NextResponse.json({ error: 'episode not found' }, { status: 404 });
    raw = raw ?? [];
    if (!raw.length) return NextResponse.json({ splits: [] });
    const splits = await resolveValueTimeSplits(raw);
    return NextResponse.json(
      { splits },
      // Splits are effectively immutable per episode — let the CDN keep them.
      { headers: { 'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400' } },
    );
  }, 'value-splits fetch failed');
}
