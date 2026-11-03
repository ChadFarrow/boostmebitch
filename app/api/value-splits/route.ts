import { NextResponse } from 'next/server';
import { PI_EPISODE_MAX, getEpisodes, getPodcast, getRssItemValueTimeSplits, resolveValueTimeSplits } from '@/lib/pi';
import { withRemoteFeedMediums } from '@/lib/pi-batch';
import { withErrorHandling, NO_STORE } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { hasValueRecipients } from '@/lib/util';

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
    // Podcast Index is the DIRECTORY here: it turns a positive id into a guid,
    // and a feed id into a feed URL. The windows come from the feed itself.
    //
    // Same `max` as /api/feed on purpose: an episode the list can show must be
    // one this route can find its tracks for.
    let itemGuid: string | undefined;
    if (episodeId > 0) {
      const episodes = await getEpisodes(feedId, PI_EPISODE_MAX);
      itemGuid = episodes.find((e) => e.id === episodeId)?.guid;
      if (!itemGuid) return NextResponse.json({ error: 'episode not found' }, { status: 404 });
    }
    // A NEGATIVE id PI does not hold is an item /api/feed read from the RSS
    // because PI had not crawled it yet (`getRssEpisodesNewerThan`). A 404 here
    // does not fail the boost: the modal falls back to the SHOW's block for a
    // boost pressed during a song, and streaming pays the show for the whole
    // track.
    const podcast = await getPodcast(feedId);
    if (!podcast?.url) return NextResponse.json({ error: 'episode not found' }, { status: 404 });
    const answer = await getRssItemValueTimeSplits(podcast.url, episodeId, itemGuid);
    // NOT a 404. `loadSplits` (lib/v4v/streaming.ts) caches a 404 as a miss for the
    // hour, so a host that blinked would stream every song window to the show.
    if (!answer.read) {
      return NextResponse.json({ error: 'the feed did not answer' }, { status: 502, headers: NO_STORE });
    }
    const raw = answer.splits;
    if (!raw) return NextResponse.json({ error: 'episode not found' }, { status: 404 });
    if (!raw.length) return NextResponse.json({ splits: [] });
    const splits = await withRemoteFeedMediums(await resolveValueTimeSplits(raw));
    // A window whose album feed did not answer has no payee YET. An hour of CDN
    // would keep that gap after the host came back, and each window is now a feed
    // read that can fail on its own.
    const complete = splits.every((s) => !s.remoteItem?.itemGuid || hasValueRecipients(s.value));
    return NextResponse.json(
      { splits },
      // Splits are effectively immutable per episode — let the CDN keep them.
      {
        headers: {
          'Cache-Control': complete
            ? 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400'
            : 'public, max-age=60, s-maxage=60',
        },
      },
    );
  }, 'value-splits fetch failed');
}
