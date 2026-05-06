import { NextResponse } from 'next/server';
import { getEpisodes, getLiveItemsForFeed, getPodcast } from '@/lib/pi';
import type { Episode } from '@/lib/types';
import { getErrorMessage } from '@/lib/util';

const LIVE_RANK: Partial<Record<NonNullable<Episode['liveStatus']>, number>> = {
  live: 0,
  pending: 1,
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = Number(searchParams.get('id'));
  if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 });
  try {
    // Live-items lookup is best-effort — a PI hiccup on /episodes/live should
    // not blank out the whole feed page.
    const [podcast, episodes, liveItems] = await Promise.all([
      getPodcast(id),
      getEpisodes(id, 50),
      getLiveItemsForFeed(id).catch(() => [] as Episode[]),
    ]);
    if (!podcast) return NextResponse.json({ error: 'not found' }, { status: 404 });
    // Merge: live items take precedence over a same-guid regular episode (they
    // carry the liveStatus tag we want to surface).
    const liveGuids = new Set(liveItems.map((e) => e.guid).filter(Boolean) as string[]);
    const liveIds = new Set(liveItems.map((e) => e.id));
    const regular = episodes.filter((e) => !(e.guid && liveGuids.has(e.guid)) && !liveIds.has(e.id));
    const merged = [...liveItems, ...regular].map((e) => ({
      ...e,
      // Episodes inherit the channel value block when they don't have their own.
      value: e.value ?? podcast.value,
    }));
    // Live first (live > pending > ended), then regular by datePublished desc.
    merged.sort((a, b) => {
      const ra = a.liveStatus ? LIVE_RANK[a.liveStatus] ?? 3 : 3;
      const rb = b.liveStatus ? LIVE_RANK[b.liveStatus] ?? 3 : 3;
      if (ra !== rb) return ra - rb;
      if (a.liveStatus && b.liveStatus) {
        return (b.liveStartTime ?? 0) - (a.liveStartTime ?? 0);
      }
      return (b.datePublished ?? 0) - (a.datePublished ?? 0);
    });
    return NextResponse.json({ podcast, episodes: merged });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e, 'feed fetch failed') }, { status: 500 });
  }
}
