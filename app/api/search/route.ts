import { NextResponse } from 'next/server';
import { searchPodcasts } from '@/lib/pi';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q')?.trim();
  if (!q) return NextResponse.json({ feeds: [] });
  try {
    const feeds = await searchPodcasts(q, 20);
    return NextResponse.json({ feeds });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'search failed' }, { status: 500 });
  }
}
