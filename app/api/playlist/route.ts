import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { getPlaylistChannel } from '@/lib/pi';
import { batchEpisodes, episodeKey, MAX_BATCH } from '@/lib/pi-batch';
import { fnvHash } from '@/lib/util';
import type { Episode } from '@/lib/types';
import type { PlaylistItemRef } from '@/lib/feed-xml';

/**
 * One PAGE of a `<podcast:medium>musicL</podcast:medium>` playlist.
 *
 *   GET /api/playlist?url=<feedUrl>&offset=0&limit=100
 *     → { podcast, episodes, total, offset, notFound, couldNotAsk }
 *
 * A playlist publishes no `<item>` elements: its contents are channel-level
 * `<podcast:remoteItem>` references, one Podcast Index lookup each. The live
 * HGH playlist holds 1217 distinct ones, so the whole list is not a request
 * anybody can make — hence the page, and hence the client's "load more" being
 * a real fetch rather than the pure reveal `<EpisodeList>` uses for a feed it
 * already holds.
 *
 * **GET, not the existing POST /api/episode-by-guid/batch.** That route's body
 * is per-user, so it sets no cache header. A playlist page is public and
 * byte-identical for every viewer, so the whole point here is that a shared
 * cache can answer it — which is what keeps thirteen pages of one playlist off
 * PI's quota. That is also why the guids stay server-side: the URL is short and
 * cacheable, while a hundred item guids (routinely permalink URLs) are not.
 */

// Matches /api/publisher and the two batch routes: this fans out to PI, so it
// sits with the fan-out allowance rather than the by-guid hydration burst.
const PLAYLIST_RATE_LIMIT = 30;

/**
 * Same shape as /api/feed's: `max-age` so a reader paging back and forth does
 * not re-download a page the browser already has, `s-maxage` so the first
 * reader of a page pays for everyone.
 */
const PLAYLIST_CACHE = {
  'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
};

/**
 * Digits only — NOT `Number()`, and NOT `parseInt`.
 *
 * `Number('0x64')` is 100 and `Number('1e3')` is 1000; `parseInt('64abc')` is
 * 64. Each yields a plausible page from a parameter the caller never wrote,
 * and every distinct spelling of the same number is another CDN cache entry
 * for bytes we already hold — the amplification `artWidth` documents.
 */
function digits(raw: string | null, fallback: number): number | null {
  if (raw == null || raw === '') return fallback;
  if (!/^\d{1,9}$/.test(raw)) return null;
  return Number(raw);
}

export async function GET(req: Request) {
  const limited = rateLimit(req, 'playlist', PLAYLIST_RATE_LIMIT);
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const url = searchParams.get('url')?.trim();
  if (!url) return NextResponse.json({ error: 'missing url' }, { status: 400 });
  // Same cap every sibling proxy param carries.
  if (url.length > 2048) return NextResponse.json({ error: 'invalid url' }, { status: 400 });

  const offset = digits(searchParams.get('offset'), 0);
  const rawLimit = digits(searchParams.get('limit'), MAX_BATCH);
  if (offset === null || rawLimit === null) {
    return NextResponse.json({ error: 'invalid offset or limit' }, { status: 400 });
  }
  // One page is at most one `batchEpisodes` call, so the cap that route already
  // enforces is this one's cap too — there is no second ceiling to keep in sync.
  const limit = Math.min(Math.max(rawLimit, 1), MAX_BATCH);

  return withErrorHandling(async () => {
    const channel = await getPlaylistChannel(url);
    if (!channel) return NextResponse.json({ error: 'not found' }, { status: 404 });

    const { podcast, refs } = channel;
    const page = refs.slice(offset, offset + limit);
    if (!page.length) {
      return NextResponse.json(
        {
          podcast, episodes: [], total: refs.length, offset,
          nextOffset: null, notFound: 0, couldNotAsk: 0,
        },
        { headers: PLAYLIST_CACHE },
      );
    }

    const resolved = await batchEpisodes(page);

    // THE THREE-STATE ANSWER, carried through rather than flattened. See
    // lib/pi-batch.ts: a key with a value resolved, a key holding null is PI
    // saying "not found", and an ABSENT key is "we could not ask" — PI down, or
    // our own rate limit. Collapsing the third into the second is the
    // negative-cache poisoning lib/podcast-meta.ts's COULD_NOT_ASK set exists to
    // prevent, and here it would also be a lie on screen: a track nobody asked
    // about would render as one that does not exist.
    //
    // EVERY ref yields a row. A dropped row is invisible, and an invisible track
    // makes the playlist look shorter than the curator published it — with
    // nothing on screen to say so, and no way for the reader to reach it, since
    // `nextOffset` steps straight past.
    const episodes: Episode[] = [];
    let notFound = 0;
    let couldNotAsk = 0;
    for (const ref of page) {
      const key = episodeKey(ref);
      if (!(key in resolved)) {
        couldNotAsk++;
        episodes.push(placeholder(ref, podcast.id, 'could-not-ask'));
        continue;
      }
      const ep = resolved[key];
      if (ep) episodes.push(ep);
      else {
        notFound++;
        episodes.push(placeholder(ref, podcast.id, 'not-found'));
      }
    }

    // The server owns the next offset and the client uses it verbatim. Deriving
    // it client-side from `offset + limit` would desync the moment anything on
    // this side changes what a page contains — the ref cap, dedupe, or a future
    // row-shedding pass — and the symptom would be skipped tracks, which is
    // exactly the failure nobody can see.
    const nextOffset = offset + page.length < refs.length ? offset + page.length : null;

    return NextResponse.json(
      { podcast, episodes, total: refs.length, offset, nextOffset, notFound, couldNotAsk },
      {
        headers:
          // A page we could not fully ask about is not an answer, so it must not
          // be cached — the retry has to actually reach PI again. `notFound`
          // rows ARE cacheable: PI answered.
          couldNotAsk > 0 ? { 'Cache-Control': 'no-store' } : PLAYLIST_CACHE,
      },
    );
  }, 'playlist fetch failed');
}

/**
 * A row for a track that could not be resolved.
 *
 * It carries the two identifiers off the wire, which is the whole record — the
 * title and cover come from resolution and are merely nice. That is why the
 * favorite heart still renders on one of these (see `<FavTrackHeart>`'s note in
 * components/fav-heart.tsx): withholding it until PI has crawled the album
 * would hide the control on exactly the independent releases this app exists to
 * pay.
 *
 * `enclosureUrl` is empty, so the client must SUPPRESS every play control on
 * this row rather than disable it — `play()` with an empty enclosure puts a dead
 * track in the player. The negative `-fnvHash(key)` id is the repo's convention
 * for "not a real PI record", shared with RSS-derived episodes and live items,
 * and it is deterministic so the row keeps its React key across a retry.
 */
function placeholder(
  ref: PlaylistItemRef,
  feedId: number,
  unresolved: NonNullable<Episode['unresolved']>,
): Episode {
  return {
    id: -fnvHash(`${ref.feedGuid}:${ref.itemGuid}`),
    guid: ref.itemGuid,
    podcastGuid: ref.feedGuid,
    title: '',
    enclosureUrl: '',
    feedId,
    unresolved,
  };
}
