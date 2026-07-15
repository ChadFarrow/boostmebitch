import { NextResponse } from 'next/server';
import { getEpisodes, getLiveItemsForFeed, getLiveItemsFromRss, getPodcast, getRssEpisodeEnrichment } from '@/lib/pi';
import type { Episode } from '@/lib/types';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { isMusicMedium } from '@/lib/util';

const LIVE_RANK: Partial<Record<NonNullable<Episode['liveStatus']>, number>> = {
  live: 0,
  pending: 1,
};

export async function GET(req: Request) {
  const limited = rateLimit(req, 'feed', 60);
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const id = Number(searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'missing or invalid id' }, { status: 400 });
  }
  return withErrorHandling(async () => {
    // Live-items lookup is best-effort — a PI hiccup on /episodes/live should
    // not blank out the whole feed page.
    const [podcast, episodes, piLive] = await Promise.all([
      getPodcast(id),
      getEpisodes(id, 50),
      getLiveItemsForFeed(id).catch(() => [] as Episode[]),
    ]);
    // PI's episode API doesn't expose <podcast:socialInteract> or full show
    // notes, so we fetch the RSS and parse both in one pass. Best-effort:
    // failure leaves episodes without socialInteract/contentEncoded rather
    // than breaking the whole feed.
    const { episodes: enrichMap, feedMedium, feedPodroll } = podcast?.url
      ? await getRssEpisodeEnrichment(podcast.url).catch(() => ({ episodes: new Map(), feedMedium: undefined, feedPodroll: undefined }))
      : { episodes: new Map(), feedMedium: undefined, feedPodroll: undefined };
    if (!podcast) return NextResponse.json({ error: 'not found' }, { status: 404 });
    // PI's /episodes/live only returns currently-broadcasting items; pending
    // liveItems live in the RSS itself, so we additionally parse the feed XML.
    const rssLive = podcast.url
      ? await getLiveItemsFromRss(podcast.url, id, podcast.podcastGuid).catch(() => [] as Episode[])
      : [];
    // Dedupe by guid across sources. PI wins on collision (it carries the
    // canonical 'live' transition the publisher's RSS may lag on).
    const seenGuid = new Set<string>();
    const liveItems: Episode[] = [];
    for (const e of [...piLive, ...rssLive]) {
      if (e.guid && seenGuid.has(e.guid)) continue;
      if (e.guid) seenGuid.add(e.guid);
      liveItems.push(e);
    }
    // Live items take precedence over a same-guid regular episode (they carry
    // the liveStatus tag we want to surface).
    const liveIds = new Set(liveItems.map((e) => e.id));
    // Deduplicate regular episodes by guid then id — PI occasionally returns
    // duplicate records when a feed has non-unique or missing guids.
    const seenRegularGuid = new Set<string>();
    const seenRegularId = new Set<number>();
    const seenTitleDate = new Set<string>();
    const regular = episodes.filter((e) => {
      if (e.guid && seenGuid.has(e.guid)) return false;   // collides with a live item
      if (liveIds.has(e.id)) return false;
      if (e.guid && seenRegularGuid.has(e.guid)) return false;
      if (seenRegularId.has(e.id)) return false;
      // Last-resort: same title + publish date = same episode regardless of GUID/ID
      const titleDateKey = `${e.title}|${e.datePublished ?? ''}`;
      if (seenTitleDate.has(titleDateKey)) return false;
      if (e.guid) seenRegularGuid.add(e.guid);
      seenRegularId.add(e.id);
      seenTitleDate.add(titleDateKey);
      return true;
    });
    const merged = [...liveItems, ...regular].map((e) => {
      const rss = e.guid ? enrichMap.get(e.guid) : undefined;
      return {
        ...e,
        // Episodes inherit the channel value block when they don't have their own.
        value: e.value ?? podcast.value,
        // socialInteract and contentEncoded come from RSS — PI doesn't index them.
        socialInteract: e.socialInteract ?? rss?.socialInteract,
        contentEncoded: rss?.contentEncoded,
        // RSS-parsed season/episode fill in when PI doesn't return them.
        season: e.season ?? rss?.season ?? null,
        episode: e.episode ?? rss?.episode ?? null,
      };
    });
    // Live first (live > pending), then regular by datePublished desc.
    // Within `pending`, sort ascending — the next-to-air show should be at
    // the top of the list. Within `live`, sort descending (most recent
    // broadcast first) on the off chance more than one stream is live.
    // Music album feeds (medium=music) sort by disc (podcast:season) then
    // track (podcast:episode) ascending instead of by date.
    const isMusic = isMusicMedium(podcast) || feedMedium === 'music';
    merged.sort((a, b) => {
      const ra = a.liveStatus ? LIVE_RANK[a.liveStatus] ?? 3 : 3;
      const rb = b.liveStatus ? LIVE_RANK[b.liveStatus] ?? 3 : 3;
      if (ra !== rb) return ra - rb;
      if (a.liveStatus === 'pending' && b.liveStatus === 'pending') {
        return (a.liveStartTime ?? 0) - (b.liveStartTime ?? 0);
      }
      if (a.liveStatus && b.liveStatus) {
        return (b.liveStartTime ?? 0) - (a.liveStartTime ?? 0);
      }
      if (isMusic) {
        const seasonDiff = (a.season ?? 1) - (b.season ?? 1);
        if (seasonDiff !== 0) return seasonDiff;
        return (a.episode ?? 0) - (b.episode ?? 0);
      }
      return (b.datePublished ?? 0) - (a.datePublished ?? 0);
    });
    // Backfill the channel-level medium so the client gets the same music
    // signal the sort used (PI doesn't reliably index `medium`).
    if (!podcast.medium && feedMedium) podcast.medium = feedMedium;
    // <podcast:podroll> — host-recommended shows. PI doesn't index it, so it
    // comes only from the RSS pass above; attach it for the client to resolve.
    if (feedPodroll) podcast.podroll = feedPodroll;
    return NextResponse.json(
      { podcast, episodes: merged },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
    );
  }, 'feed fetch failed');
}
