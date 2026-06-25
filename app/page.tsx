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

export default function Page() {
  return <HomePage />;
}
