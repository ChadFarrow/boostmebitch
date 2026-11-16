import { NextResponse } from 'next/server';
import { getDemuRoster } from '@/lib/pi';
import { withErrorHandling, NO_STORE } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';

// Every self-hosted (DeMu) music album, for the /demu page — the slim rows
// `demuRosterRows` builds (lib/demu.ts), from the six-hour roster in lib/pi.ts.
// Design: docs/superpowers/specs/2026-11-15-demu-page-design.md.
//
// `answered: false` is "not loaded yet" (a cold roster past its bound, or a PI
// failure with no earlier roster), NEVER "there is no DeMu music": the page
// renders "Could not load the DeMu list" for it, and it goes out `no-store` so
// no CDN serves it after the roster loads.
//
// A loaded answer is cacheable for well under the roster's six hours: the
// browser keeps it five minutes, the CDN half an hour, then serves it stale
// for an hour while it asks again.
const DEMU_CACHE = { 'Cache-Control': 'public, max-age=300, s-maxage=1800, stale-while-revalidate=3600' };

export async function GET(req: Request) {
  const limited = rateLimit(req, 'demu', 30);
  if (limited) return limited;
  return withErrorHandling(async () => {
    const roster = await getDemuRoster();
    return NextResponse.json(roster, { headers: roster.answered ? DEMU_CACHE : NO_STORE });
  }, 'demu roster failed');
}
