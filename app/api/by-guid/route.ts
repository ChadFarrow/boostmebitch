import { NextResponse } from 'next/server';
import { getPodcastByGuid } from '@/lib/pi';
import { getErrorMessage } from '@/lib/util';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const guid = searchParams.get('guid')?.trim();
  if (!guid) return NextResponse.json({ error: 'missing guid' }, { status: 400 });
  try {
    const podcast = await getPodcastByGuid(guid);
    if (!podcast) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ podcast });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e, 'lookup failed') }, { status: 500 });
  }
}
