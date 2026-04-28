import { NextResponse } from 'next/server';
import { getEpisodes, getPodcast } from '@/lib/pi';
import { getErrorMessage } from '@/lib/util';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = Number(searchParams.get('id'));
  if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 });
  try {
    const [podcast, episodes] = await Promise.all([getPodcast(id), getEpisodes(id, 50)]);
    if (!podcast) return NextResponse.json({ error: 'not found' }, { status: 404 });
    // Episodes inherit the channel value block when they don't have their own.
    const filled = episodes.map((e) => ({ ...e, value: e.value ?? podcast.value }));
    return NextResponse.json({ podcast, episodes: filled });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e, 'feed fetch failed') }, { status: 500 });
  }
}
