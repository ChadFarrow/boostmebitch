import { NextResponse } from 'next/server';
import { fetchAndParseRss } from '@/lib/rss';
import { getErrorMessage } from '@/lib/util';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get('url');
  if (!url) return NextResponse.json({ error: 'missing url' }, { status: 400 });
  if (!/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: 'url must be http(s)' }, { status: 400 });
  }
  try {
    const { podcast, episodes } = await fetchAndParseRss(url);
    return NextResponse.json({ podcast, episodes });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e, 'rss fetch failed') }, { status: 500 });
  }
}
