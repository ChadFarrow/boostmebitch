import { NextResponse } from 'next/server';
import { getEpisodes, resolveValueTimeSplits } from '@/lib/pi';
import { getErrorMessage } from '@/lib/util';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const feedId = Number(searchParams.get('feedId'));
  const episodeId = Number(searchParams.get('episodeId'));
  if (!feedId || !episodeId) {
    return NextResponse.json({ error: 'missing feedId / episodeId' }, { status: 400 });
  }
  try {
    const episodes = await getEpisodes(feedId, 50);
    const episode = episodes.find((e) => e.id === episodeId);
    if (!episode) return NextResponse.json({ error: 'episode not found' }, { status: 404 });
    const raw = episode.valueTimeSplits ?? [];
    if (!raw.length) return NextResponse.json({ splits: [] });
    const splits = await resolveValueTimeSplits(raw);
    return NextResponse.json(
      { splits },
      { headers: { 'Cache-Control': 'public, max-age=3600' } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: getErrorMessage(e, 'value-splits fetch failed') },
      { status: 500 },
    );
  }
}
