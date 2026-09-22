import { NextResponse } from 'next/server';
import { NO_STORE, withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { getEpisodesSinceForFeeds } from '@/lib/pi';
import { isPiMiss } from '@/lib/pi-error';
import { mapLimit, NEW_EPISODES_MAX_FEEDS, PI_FANOUT } from '@/lib/util';
import type { Episode } from '@/lib/types';

/**
 * What came out on these feeds since `since`.
 *
 * **There is no detection step, and that is the whole design.** The obvious
 * shape — ask whether each feed changed, then fetch the ones that did — is what
 * this replaced. `/episodes/byfeedid` takes a comma-separated id list plus
 * `since`, so one upstream call answers both questions at once and returns the
 * records. That also sidesteps the trap the first attempt hit: `bmb:pmeta` and
 * the read index each cache a podcast record for SEVEN DAYS, so any freshness
 * field of ours would have been read through a week of staleness and reported
 * "nothing new" confidently.
 *
 * **PI TRUNCATES AN ID LIST AT 200, SILENTLY** (measured 2026-09-12 — see
 * `PI_FEED_IDS_MAX`). This route never comes close, because the chunk below is
 * set by a different and tighter limit: latency. Cold response time scales with
 * the id count at roughly 60 ms per feed, and `PI_TIMEOUT_MS` is 8 s — so a
 * 200-id call would abort, surface as a 500 and trip the client's PI breaker.
 * `CHUNK` is what keeps one upstream call inside that clock; it is not taste.
 *
 * **`max` is GLOBAL across a chunk**, applied after a newest-first sort, so
 * hitting it drops the OLDEST rows across every feed in that chunk at once. The
 * caller has to know: the rows it did not see lie between its mark and the ones
 * it did. `truncated` carries that, and `advanceMarks` refuses to move any mark
 * in a truncated pass rather than skipping the middle for ever.
 *
 * `covered` is the third piece of the same contract, and it is the reason this
 * does not just return rows. A chunk that THREW is not a chunk with no new
 * episodes. Its ids are absent from `covered`, their marks stay put, and the
 * section says it could not check them — never "nothing new".
 *
 * **PROBE FIRST, and let the probe throw** (CLAUDE.md, "a route that fans out
 * to PI"). The first chunk runs alone. If it fails with anything but a MISS,
 * Podcast Index is down or our key is bad, and that reaches the client as a
 * 5xx — or verbatim as 429/408 through `withErrorHandling`, so nothing reads a
 * rate limit as an outage — and it reaches the server log. Swallowing it, as
 * every chunk used to be, made an expired key look like "could not check" on
 * every pass with nothing logged anywhere. The caller loses nothing: it treats
 * any non-OK answer as "these shows were not checked", per request, never as
 * "nothing new". A miss (`isPiMiss`, a 400/404) is an answer about those ids,
 * not an outage, so it stays out of `covered` and the rest are still asked.
 * After a good probe the rest run bounded and are swallowed per chunk, as
 * before: one bad chunk after a good probe is not an outage.
 */
const CHUNK = 50;
/** A security cap, shared with the section that batches by it — see the constant. */
const MAX_FEEDS = NEW_EPISODES_MAX_FEEDS;
/** Per chunk. Generous for a personal library, and bounded so one request
 *  cannot pull an unbounded body. */
const MAX_ROWS = 200;
/** The furthest back a caller may ask. `since=0` over a hundred feeds is the
 *  one lever this route hands an attacker, and it is the expensive one. */
const MAX_LOOKBACK_SECS = 30 * 24 * 60 * 60;

export async function GET(req: Request) {
  const limited = rateLimit(req, 'new-episodes', 30);
  if (limited) return limited;

  const { searchParams } = new URL(req.url);

  // `feeds` is attacker-controlled length and content. Positive integers only,
  // deduped, capped — the same shape `/api/live-shows` validates its own
  // favourite-feed list with, for the same reason: every entry past the cap is
  // one more Podcast Index call on our quota.
  const feeds = Array.from(new Set(
    (searchParams.get('feeds') ?? '')
      .split(',')
      .map((n) => strictInt(n.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  )).slice(0, MAX_FEEDS);
  if (!feeds.length) return NextResponse.json({ error: 'missing feeds' }, { status: 400 });

  const nowSec = Math.floor(Date.now() / 1000);
  const asked = strictInt(searchParams.get('since') ?? '');
  if (!Number.isInteger(asked)) return NextResponse.json({ error: 'missing since' }, { status: 400 });
  // Clamped rather than rejected: a client whose clock is wrong, or whose mark
  // predates the window, should get the window rather than an error it cannot
  // act on. The floor is what stops `since=0` becoming a full-archive request.
  const since = Math.min(Math.max(asked, nowSec - MAX_LOOKBACK_SECS), nowSec);

  return withErrorHandling(async () => {
    const chunks: number[][] = [];
    for (let i = 0; i < feeds.length; i += CHUNK) chunks.push(feeds.slice(i, i + CHUNK));

    const episodes: Episode[] = [];
    const covered: number[] = [];
    let truncated = false;
    const take = (ids: number[], res: { episodes: Episode[]; truncated: boolean }) => {
      episodes.push(...res.episodes);
      covered.push(...ids);
      if (res.truncated) truncated = true;
    };

    // The probe — see the header. Only a miss is caught here.
    const [probe, ...rest] = chunks;
    try {
      take(probe!, await getEpisodesSinceForFeeds(probe!, since, MAX_ROWS));
    } catch (e) {
      if (!isPiMiss(e)) throw e;
    }

    // Bounded concurrency, not `Promise.all`. A count is not a cap on the
    // fan-out — `mapLimit` at `PI_FANOUT` is what composes, and it is the same
    // number every other route protecting Podcast Index uses.
    await mapLimit(rest, PI_FANOUT, async (ids) => {
      try {
        take(ids, await getEpisodesSinceForFeeds(ids, since, MAX_ROWS));
      } catch {
        // Deliberately swallowed, and the ids stay OUT of `covered`. A chunk
        // that could not be asked is not a chunk with nothing new, and the
        // difference is the whole contract — see the header.
      }
    });

    return NextResponse.json(
      { episodes, covered, truncated, since },
      {
        headers: {
        // PRIVATE, because the id list is somebody's favourites. A shared cache
        // keyed on that URL would hand one person's library to anyone who
        // guessed it, and `/api/live-shows` marks its own answers `personal`
        // for exactly this. Short, because the point is freshness — and
        // `no-store` when anything went unasked, so a partial answer is never
        // the one a reload gets back.
          ...(covered.length === feeds.length && !truncated
            ? { 'Cache-Control': 'private, max-age=30' }
            : NO_STORE),
        },
      },
    );
  }, 'new-episode lookup failed');
}

/** Digits only. `parseInt` reads `"12abc"` as 12, which is a request nobody made. */
function strictInt(s: string): number {
  return /^\d{1,15}$/.test(s) ? Number(s) : Number.NaN;
}
