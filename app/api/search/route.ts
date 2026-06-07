import { NextResponse } from 'next/server';
import { searchPodcasts } from '@/lib/pi';
import { withErrorHandling } from '@/lib/api-handler';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q')?.trim();
  if (!q) return NextResponse.json({ feeds: [] });
  return withErrorHandling(async () => {
    const feeds = await searchPodcasts(q, 20);
    return NextResponse.json({ feeds });
  }, 'search failed');
}
