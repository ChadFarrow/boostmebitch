import type { Metadata } from 'next';
import { HomePage } from '@/components/home-page';
import { getPodcastByGuid, getPodcast, getEpisodeByGuid } from '@/lib/pi';
import { stripHtml } from '@/lib/util';

// Trim show notes / descriptions to a card-sized blurb. stripHtml first so we
// never emit raw markup into og:description.
function ogDescription(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const text = stripHtml(raw).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > 200 ? text.slice(0, 197).trimEnd() + '…' : text;
}

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// Per-show / per-episode Open Graph tags so a shared ?podcast=&episode= link
// unfurls on Nostr with the real artwork + title instead of the static site
// card. Best-effort: any failure returns {} and the page inherits the static
// metadata from app/layout.tsx. Reading searchParams opts this route into
// dynamic rendering, which is fine — the page is already fully client-driven.
export async function generateMetadata(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
): Promise<Metadata> {
  try {
    const sp = await searchParams;
    const podcastGuid = firstParam(sp.podcast);
    const feedId = firstParam(sp.feed);
    const episodeGuid = firstParam(sp.episode);

    // Resolve the show: by podcast guid, else by feed id.
    let podcast = podcastGuid ? await getPodcastByGuid(podcastGuid) : null;
    if (!podcast && feedId && /^\d+$/.test(feedId)) {
      podcast = await getPodcast(Number(feedId));
    }
    if (!podcast) return {};

    // Episode-level card when ?episode= is present and we have the podcast guid
    // (PI's /episodes/byguid requires the podcast guid).
    let title = podcast.title;
    let description = ogDescription(podcast.description);
    let image = podcast.image ?? podcast.artwork;

    const guidForEpisode = podcast.podcastGuid ?? podcastGuid;
    if (episodeGuid && guidForEpisode) {
      const episode = await getEpisodeByGuid(guidForEpisode, episodeGuid);
      if (episode) {
        title = `${episode.title} — ${podcast.title}`;
        description = ogDescription(episode.description) ?? description;
        image = episode.image ?? podcast.image ?? podcast.artwork;
      }
    }

    const images = image ? [image] : undefined;
    return {
      title,
      description,
      openGraph: { title, description, images, type: 'website' },
      twitter: { card: 'summary_large_image', title, description, images },
    };
  } catch {
    return {};
  }
}

/**
 * The first request a deep link is CERTAIN to make, started from the HTML head
 * instead of from an effect.
 *
 * Everything about a `?podcast=` or `?feed=` link is resolved client-side, so
 * the request that opens the show could not begin until the bundle had
 * downloaded, parsed, hydrated and run `<HomePage>`'s mount effect. Measured
 * against a stubbed API on a production build, that first request left the
 * browser 277 ms after navigation with nothing else in flight — and on a phone
 * over mobile data the parse-and-hydrate half of that is several times longer.
 * The URL is fully known from `searchParams` at render time, so the wait buys
 * nothing.
 *
 * `<link rel="preload" as="fetch">` moves it to the head, where the browser
 * starts it while the JavaScript is still downloading. React 19 hoists the tag
 * from anywhere in the tree, and by the time `resolveVia` (or `loadFeed`) calls
 * `fetch` the response is already in the preload cache.
 *
 * **The href must be spelled EXACTLY as the client spells it, or the browser
 * fetches twice** — a hint that misses is a wasted request, not a broken page,
 * but it is also silent. `lib/podcast-meta.ts` owns both spellings; these two
 * mirror them, and nothing else here may build an API URL.
 *
 * `?playlist=` is deliberately absent. Its request carries a `limit` this file
 * would have to keep in step with `PLAYLIST_PAGE_SIZE`, and a hint that drifts
 * is the one failure mode this whole tag has.
 */
function preloadHref(sp: Record<string, string | string[] | undefined>): string | null {
  const guid = firstParam(sp.podcast);
  if (guid) return `/api/by-guid?guid=${encodeURIComponent(guid)}`;
  const feedId = firstParam(sp.feed);
  if (feedId && /^\d+$/.test(feedId)) return `/api/feed?id=${Number(feedId)}`;
  return null;
}

export default async function Page(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  // Already a dynamic route — `generateMetadata` reads the same params — so
  // this awaits a value the server holds and costs no round trip.
  const href = preloadHref(await searchParams);
  return (
    <>
      {href && <link rel="preload" as="fetch" href={href} crossOrigin="anonymous" />}
      <HomePage />
    </>
  );
}
