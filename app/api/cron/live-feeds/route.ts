import { NextResponse } from 'next/server';
import { withErrorHandling, NO_STORE } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { runLiveFeedsCheck } from '@/lib/live-feeds';

// The 15-minute check of the known-live list (lib/live-feeds.ts), called by
// Vercel Cron (vercel.json, `*/15 * * * *`). Both Vercel projects build from
// this repo, so both fire it; the run's atomic claim in the database makes the
// two one run, and a stranger's GET can at most move a run up — it changes no
// answer, because the check only reads public feeds and writes bookkeeping.
//
// When the project sets CRON_SECRET, Vercel sends it as a bearer token and
// nothing else may run the check.

export const dynamic = 'force-dynamic';
// One run reads at most NEW_PER_RUN + CHECK_PER_RUN feeds (lib/live-feeds.ts,
// sized under this), FEED_FANOUT at a time, each capped at 8 s.
export const maxDuration = 120;

export async function GET(req: Request) {
  const limited = rateLimit(req, 'cron-live-feeds', 6);
  if (limited) return limited;
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }
  return withErrorHandling(async () => {
    const run = await runLiveFeedsCheck();
    return NextResponse.json(run, { headers: NO_STORE });
  }, 'live-feeds check failed');
}
