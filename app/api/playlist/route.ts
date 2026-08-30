import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { getFeedTitle, getPlaylistChannel, getPodcastByFeedUrl } from '@/lib/pi';
import { resolvePlaylistTracks } from '@/lib/playlist-db';
import { batchEpisodes, episodeKey, fillTrackValues, MAX_BATCH } from '@/lib/pi-batch';
import { fnvHash, hasValueRecipients, mergeRssOverPi } from '@/lib/util';
import type { Episode, Podcast } from '@/lib/types';
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

/**
 * Podcast Index's record for this playlist feed, or null when it holds none.
 *
 * **A playlist can be in Podcast Index, and this route used to assert it was
 * not.** `getPlaylistChannel` builds its podcast from the RSS alone and stamps
 * `isPreview: true` unconditionally — an absence nobody had observed. PI holds
 * every playlist in ChadF's collection (It's A Mood is feed 7443544, guid
 * 30b31f6c-…), so opening one from there replaced a real record with a preview:
 * the header read "NOT IN PI · PREVIEW" over a feed PI resolves by guid, and
 * `<FavHeart>` — which renders nothing without a `podcastGuid` — withheld the
 * show favorite altogether. Both faults are silent, and the second is the
 * expensive one: a control that is absent reads as a feature that does not
 * exist, not as a bug.
 *
 * A THROW IS NOT A MISS, and is swallowed anyway. It means PI is unreachable,
 * and this page must still render its rows rather than 500 into the client's PI
 * breaker and disable metadata resolution for the whole tab. The record we fall
 * back to is genuinely preview-shaped then — synthetic id, no guid, not
 * restorable from a URL — which is what the flag gates; only the stamp's wording
 * over-claims, for one page, which `batchEpisodes` fails in the same breath so
 * every row already says PI could not be asked, and which is answered
 * `no-store` and therefore never cached.
 */
async function piRecordFor(feedUrl: string): Promise<Podcast | null> {
  try {
    return await getPodcastByFeedUrl(feedUrl);
  } catch {
    return null;
  }
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
    const [channel, piRecord] = await Promise.all([getPlaylistChannel(url), piRecordFor(url)]);
    if (!channel) return NextResponse.json({ error: 'not found' }, { status: 404 });

    // The feed's own title, medium, art and value block win — the document was
    // read moments ago and cannot be stale — while PI keeps the numeric id and
    // the guid, which only it can supply and which every other device resolves
    // by. Same precedence /api/search and /api/publisher already apply.
    //
    // No blank-record test guards this, unlike those two: `mergeRssOverPi` takes
    // the title from the RSS either way, so PI's EMPTY one still contributes its
    // guid — which is the case that matters most here, since a playlist PI
    // registered but never parsed (ChadF's Greatest Hits, feed 7683902) is
    // exactly the feed whose favorite heart would otherwise stay hidden.
    const podcast = piRecord ? mergeRssOverPi(piRecord, channel.podcast) : channel.podcast;
    const { refs } = channel;
    // The show the playlist was built from. Its episode markers are bare titles
    // — "Saddle Up" — so without this the heading above a run of tracks is a
    // word with no stated relationship to anything. Resolved AFTER the channel
    // because it is a second document, and awaited rather than raced with the
    // page: it is one cached read (see `getFeedTitle`) and the heading is part
    // of the answer, not an enrichment that can arrive later.
    const sourceShow = channel.sourceFeedUrl ? await getFeedTitle(channel.sourceFeedUrl) : null;
    const page = refs.slice(offset, offset + limit);
    if (!page.length) {
      return NextResponse.json(
        {
          podcast, episodes: [], total: refs.length, offset,
          nextOffset: null, notFound: 0, couldNotAsk: 0, sourceShow,
        },
        { headers: PLAYLIST_CACHE },
      );
    }

    // ── The accelerator, in front of Podcast Index ──────────────────────────
    // A page is 100 refs and every one of them is a PI lookup. The StableKraft
    // database already holds 13,783 of these tracks with their value blocks, so
    // it is asked first and PI is left with the misses — measured on It's A
    // Mood, 319 of 342 refs answered by ONE 117 ms query.
    //
    // It is an accelerator and never an authority, which is three separate
    // things (see lib/playlist-db.ts): the FEED still decides membership and
    // order, so there is no playlist-id mapping to keep in sync; a miss is not
    // an answer, so months-stale data is harmless rather than wrong; and any
    // failure is `null`, which reverts to asking PI for everything. Unset
    // `PLAYLIST_DB_URL` and this whole branch disappears.
    //
    // It answers with the tracks and their value blocks HELD APART, and that
    // separation is the money rule: `payableValue` reads `episode.value` first,
    // so a block carried straight through here would outrank the live one
    // `fillTrackValues` reads below. See `PlaylistDbTracks.values`.
    const db = await resolvePlaylistTracks(page, podcast.id);
    const stillNeeded = db
      ? page.filter((ref) => !db.tracks.has(episodeKey(ref)))
      : page;

    // `batchEpisodes({})` would be a wasted round trip on a fully-cached page.
    const resolved = stillNeeded.length ? await batchEpisodes(stillNeeded) : {};

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
      // A database hit is a resolved row and is NOT counted as `notFound` or
      // `couldNotAsk` — those two describe what Podcast Index said, and PI was
      // never asked about this ref.
      const cached = db?.tracks.get(key);
      if (cached) { episodes.push(cached); continue; }
      if (!(key in resolved)) {
        couldNotAsk++;
        episodes.push(placeholder(ref, podcast.id, 'could-not-ask'));
        continue;

      }
      const ep = resolved[key];
      if (ep) episodes.push(ref.episode ? { ...ep, playlistGroup: ref.episode } : ep);
      else {
        notFound++;
        episodes.push(placeholder(ref, podcast.id, 'not-found'));
      }
    }

    // ── The value block every row's BOOST depends on ────────────────────────
    // PI's episode record carries one only when the ITEM declares it, and most
    // music feeds declare `<podcast:value>` once on the album's channel. So
    // without this pass a playlist's rows arrive payable-in-principle and
    // unpayable in fact: BOOST greys out on every track, on every playlist, and
    // the disabled button is indistinguishable from a feature this app does not
    // have. The container's own block is NOT the fallback — it belongs to the
    // curator; see `payableValue` in lib/util.ts.
    //
    // Placed after the row loop so placeholders are already in the array and
    // keep their positions: `fillTrackValues` fills by index and passes an
    // unresolved row through untouched.
    const { episodes: valued, unasked: unaskedValues } = await fillTrackValues(episodes);

    // ── The accelerator's own value block, as the LAST resort ───────────────
    // Applied only to rows the live sources could not value, never over one
    // they could. This database is a crawl and is months behind, so it is the
    // worst answer available about who gets paid — but it is still better than
    // no BOOST button at all on a track Podcast Index cannot resolve, which is
    // what this page showed before the accelerator existed.
    //
    // Index-aligned with `page`: `episodes` pushes exactly one row per ref in
    // order and `fillTrackValues` fills by index and returns the same length,
    // which is the property the row loop above already depends on.
    //
    // `unaskedValues` is deliberately NOT decremented for a row filled here. It
    // means "we could not ask", and we still could not — the cache header must
    // keep saying so, or a page served while PI was unreachable freezes a
    // months-old payee into the CDN for the window.
    if (db?.values.size) {
      for (let i = 0; i < valued.length; i++) {
        if (hasValueRecipients(valued[i].value)) continue;
        const snapshot = db.values.get(episodeKey(page[i]));
        if (snapshot) valued[i] = { ...valued[i], value: snapshot };
      }
    }

    // The server owns the next offset and the client uses it verbatim. Deriving
    // it client-side from `offset + limit` would desync the moment anything on
    // this side changes what a page contains — the ref cap, dedupe, or a future
    // row-shedding pass — and the symptom would be skipped tracks, which is
    // exactly the failure nobody can see.
    const nextOffset = offset + page.length < refs.length ? offset + page.length : null;

    return NextResponse.json(
      { podcast, episodes: valued, total: refs.length, offset, nextOffset, notFound, couldNotAsk, sourceShow },
      {
        headers:
          // A page we could not fully ask about is not an answer, so it must not
          // be cached — the retry has to actually reach PI again. `notFound`
          // rows ARE cacheable: PI answered.
          //
          // `unaskedValues` is the same rule one level down, and it is NOT added
          // to the client-visible `couldNotAsk`: that number labels rows on
          // screen as "couldn't be looked up", and these rows resolved fine —
          // only their album's value block did not. Cached, they would freeze a
          // dead BOOST button into the CDN for the window, which is the negative
          // cache this route's three-state contract exists to refuse.
          couldNotAsk > 0 || unaskedValues > 0 ? { 'Cache-Control': 'no-store' } : PLAYLIST_CACHE,
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
    // Carried even here, so an unresolved row keeps its place under the right
    // heading instead of silently moving the episode boundary.
    playlistGroup: ref.episode,
  };
}
