import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api-handler';

// Server-side proxy for the BoostBox metadata service.
// Defaults match the public reference instance so the integration works
// out of the box; override via env to point at a self-hosted deployment.
const BOOSTBOX_URL = process.env.BOOSTBOX_URL || 'https://tardbox.com';
const BOOSTBOX_API_KEY = process.env.BOOSTBOX_API_KEY || 'v4v4me';

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const payload = await req.json();
    const upstream = await fetch(`${BOOSTBOX_URL}/boost`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': BOOSTBOX_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      return NextResponse.json(
        { error: `BoostBox error: ${upstream.status}`, detail },
        { status: upstream.status },
      );
    }

    const data = await upstream.json();
    return NextResponse.json(data);
  }, 'BoostBox proxy failed');
}
