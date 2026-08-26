import { NextResponse } from 'next/server';
import { PI_EPISODE_MAX, getEpisodes, getFeedFromRss, getLiveItemsForFeed, getLiveItemsFromRss, getPodcast, getRssEpisodeEnrichment } from '@/lib/pi';
import type { Episode } from '@/lib/types';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { isMusicMedium, compareEpisodeOrder } from '@/lib/util';

const LIVE_RANK: Partial<Record<NonNullable<Episode['liveStatus']>, number>> = {
  live: 0,
  pending: 1,
};

/**
 * Ceiling for the serialized `episodes` array.
 *
 * Vercel's Node runtime refuses a non-streamed response body over 4.5 MB, and
 * this route now asks PI for up to `PI_EPISODE_MAX` items, so an archive show
 * with long notes can build a payload the platform will not send — which
 * arrives as a 500 and a blank show page, i.e. a feed that worked while it was
 * truncated breaking outright once it isn't. 3.5 MB leaves room for `podcast`
 * and the headers.
 */
const EPISODES_BUDGET_BYTES = 3.5 * 1024 * 1024;

/**
 * Shrink `episodes` to {@link EPISODES_BUDGET_BYTES}, oldest first.
 *
 * Prose is shed before rows are, because the two costs are not the same thing.
 * `contentEncoded` (the full show notes) and `description` are nearly all the
 * bytes and **no list row reads either** — only the detail view does, and it
 * already renders a notes-less episode. An episode stripped of both still
 * lists, plays, favorites and boosts. A dropped one is invisible, which is the
 * truncation this whole change exists to remove, so it happens only when
 * shedding every word in the feed still isn't enough.
 *
 * Order is load-bearing: `episodes` is already sorted (live first, then the
 * feed's own order), so trimming from the end takes the rows a reader reaches
 * last, and live items at the front are never touched.
 */
const SHEDDABLE: readonly (keyof Episode)[] = ['contentEncoded', 'description'];

function fitEpisodesToBudget(episodes: Episode[]): Episode[] {
  const out = episodes.slice();
  const sizes = out.map((e) => Buffer.byteLength(JSON.stringify(e)));
  let total = sizes.reduce((a, b) => a + b, 0);
  if (total <= EPISODES_BUDGET_BYTES) return episodes;

  let shed = 0;
  for (const field of SHEDDABLE) {
    for (let i = out.length - 1; i >= 0 && total > EPISODES_BUDGET_BYTES; i--) {
      if (out[i][field] == null) continue;
      const stripped = { ...out[i], [field]: undefined };
      const size = Buffer.byteLength(JSON.stringify(stripped));
      total -= sizes[i] - size;
      sizes[i] = size;
      out[i] = stripped;
      shed++;
    }
  }
  // `> 1`, not `> 0`: a single episode whose own notes are past the budget has
  // already been stripped above, and answering with an empty list would read
  // as a feed with no episodes rather than as one very large one.
  while (out.length > 1 && total > EPISODES_BUDGET_BYTES) {
    total -= sizes.pop() ?? 0;
    out.pop();
  }
  console.warn(
    `[feed] response over budget: shed prose from ${shed} field(s), kept ${out.length} of ${episodes.length} episodes`,
  );
  return out;
}

export async function GET(req: Request) {
  const limited = rateLimit(req, 'feed', 60);
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  // Non-PI preview feed: build the whole { podcast, episodes } from raw RSS.
  // The synthetic id can't be re-resolved server-side to a URL, so the client
  // passes the feed URL directly for these.
  const url = searchParams.get('url');
  // Length cap, as every sibling route has (chapters/transcript 2000,
  // by-guid 2048). This one was the only proxy param without one.
  if (url && url.length > 2048) {
    return NextResponse.json({ error: 'invalid url' }, { status: 400 });
  }
  if (url) {
    return withErrorHandling(async () => {
      const parsed = await getFeedFromRss(url);
      if (!parsed) return NextResponse.json({ error: 'not found' }, { status: 404 });
      // Same budget as the PI path: this one reads every <item> in a document
      // `safeFetch` accepts up to 8 MB, so it has always been able to build a
      // body the platform will not send.
      const fitted = fitEpisodesToBudget(parsed.episodes);
      return NextResponse.json({ ...parsed, episodes: fitted, truncated: fitted.length < parsed.episodes.length }, {
        headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
      });
    }, 'feed fetch failed');
  }
  const id = Number(searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'missing or invalid id' }, { status: 400 });
  }
  return withErrorHandling(async () => {
    // Live-items lookup is best-effort — a PI hiccup on /episodes/live should
    // not blank out the whole feed page.
    const [podcast, episodes, piLive] = await Promise.all([
      getPodcast(id),
      // Ask for everything PI will give: the client reveals rows a page at a
      // time, so a long feed costs the reader nothing until they scroll, while
      // an episode we never requested is one no later call can fetch.
      getEpisodes(id, PI_EPISODE_MAX),
      getLiveItemsForFeed(id).catch(() => [] as Episode[]),
    ]);
    // PI's episode API doesn't expose <podcast:socialInteract> or full show
    // notes, so we fetch the RSS and parse both in one pass. Best-effort:
    // failure leaves episodes without socialInteract/contentEncoded rather
    // than breaking the whole feed.
    const { episodes: enrichMap, feedMedium, feedPodroll, feedFunding, feedNostrNpubs } = podcast?.url
      ? await getRssEpisodeEnrichment(podcast.url).catch(() => ({ episodes: new Map(), feedMedium: undefined, feedPodroll: undefined, feedFunding: undefined, feedNostrNpubs: undefined }))
      : { episodes: new Map(), feedMedium: undefined, feedPodroll: undefined, feedFunding: undefined, feedNostrNpubs: undefined };
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
        // <podcast:transcript> — PI sometimes indexes one; RSS carries the full
        // set (with types) so the best timed transcript can be chosen.
        transcriptUrl: e.transcriptUrl ?? rss?.transcriptUrl,
        transcriptType: e.transcriptType ?? rss?.transcriptType,
        // Episode web page — where the full write-up lives when the feed's
        // notes are abbreviated.
        link: e.link ?? rss?.link,
        // <podcast:alternateEnclosure> — alternate renditions (e.g. video). PI
        // doesn't index the tag, so it only comes from the RSS pass.
        alternateEnclosures: e.alternateEnclosures ?? rss?.alternateEnclosures,
        // <podcast:txt purpose="nostr"> — this track's/episode's own artist.
        // RSS-only (PI indexes no <podcast:txt>), so there's no PI value to
        // prefer, same as contentEncoded.
        nostrNpubs: rss?.nostrNpubs,
      };
    });
    // Live first (live > pending), then regular by datePublished desc.
    // Within `pending`, sort ascending — the next-to-air show should be at
    // the top of the list. Within `live`, sort descending (most recent
    // broadcast first) on the off chance more than one stream is live.
    // Music album feeds (medium=music) sort by disc (podcast:season) then
    // track (podcast:episode) ascending instead of by date.
    const isMusic = isMusicMedium(podcast) || feedMedium === 'music';
    // Live ranking is this route's own concern; the non-live tail is the shared
    // rule in lib/util.ts, which lib/pi.ts's raw-RSS path sorts by too. It used
    // to be a second copy inlined here.
    const byEpisodeOrder = compareEpisodeOrder(isMusic);
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
      return byEpisodeOrder(a, b);
    });
    // Backfill the channel-level medium so the client gets the same music
    // signal the sort used (PI doesn't reliably index `medium`).
    if (!podcast.medium && feedMedium) podcast.medium = feedMedium;
    // <podcast:podroll> — host-recommended shows. PI doesn't index it, so it
    // comes only from the RSS pass above; attach it for the client to resolve.
    if (feedPodroll) podcast.podroll = feedPodroll;
    // <podcast:funding> — non-Lightning support links. Prefer PI's value, fall
    // back to the RSS channel parse (same backfill pattern as podroll/medium).
    if (!podcast.funding?.length && feedFunding) podcast.funding = feedFunding;
    // <podcast:txt purpose="nostr"> — the show's own npub, p-tagged on boost
    // notes. RSS-only like podroll, so it's an unconditional attach.
    if (feedNostrNpubs) podcast.nostrNpubs = feedNostrNpubs;
    const fitted = fitEpisodesToBudget(merged);
    // Two ways this list can be short of the feed, and neither is visible from
    // the rows: PI has no more to give past its own ceiling, or the response
    // budget above dropped the tail. The client says so at the end of the list
    // rather than just stopping — "the app only had part of the feed" is the
    // report this whole cap exists to answer, and a list that simply ends is
    // indistinguishable from a show that ended. Hitting the ceiling exactly is
    // read as truncation on purpose: a feed of exactly PI_EPISODE_MAX items
    // over-reports, which costs a sentence, while under-reporting costs the
    // reader the answer.
    const truncated = episodes.length >= PI_EPISODE_MAX || fitted.length < merged.length;
    return NextResponse.json(
      { podcast, episodes: fitted, truncated },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
    );
  }, 'feed fetch failed');
}
