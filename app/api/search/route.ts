import { NextResponse } from 'next/server';
import { searchPodcasts } from '@/lib/pi';
import { getErrorMessage } from '@/lib/util';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q')?.trim();
  if (!q) return NextResponse.json({ feeds: [] });
  try {
    const feeds = await searchPodcasts(q, 20);
    return NextResponse.json({ feeds });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e, 'search failed') }, { status: 500 });
  }
}
