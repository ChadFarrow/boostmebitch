import type { EventTemplate } from 'nostr-tools';
import type { Boostagram, Episode, Podcast, BoostResult } from '../types';
import { DEFAULT_RELAYS } from './relays';
import { signAndPublish, type PublishedNote } from './publish';

interface PublishArgs {
  podcast: Podcast;
  episode?: Episode;        // omit for show-level boosts
  boostagram: Boostagram;
  results: BoostResult[];
  relays?: string[];
  /** Override the note body. Otherwise we auto-format. */
  contentOverride?: string;
}

/**
 * Best public landing page for a podcast, in preference order:
 *  1. pod.link smart-link by Apple iTunes ID — auto-routes the visitor to
 *     their preferred podcast app on click
 *  2. Podcast Index page — human-readable feed metadata
 *  3. raw RSS feed URL
 */
function podcastLandingUrl(podcast: Podcast): string | null {
  if (podcast.itunesId) return `https://pod.link/${podcast.itunesId}`;
  if (podcast.id) return `https://podcastindex.org/podcast/${podcast.id}`;
  return podcast.url ?? null;
}

function formatContent(args: PublishArgs): string {
  const { podcast, episode, boostagram } = args;
  const totalSats = Math.round((boostagram.value_msat_total ?? 0) / 1000);

  const lines: string[] = ['⚡ Boost ⚡', ''];
  if (boostagram.message?.trim()) {
    lines.push(boostagram.message.trim(), '');
  }
  lines.push(`Boosted ${totalSats} sats → ${podcast.title}`);
  if (episode?.title) lines.push(`📻 ${episode.title}`);
  const link = podcastLandingUrl(podcast);
  if (link) lines.push('', link);
  return lines.join('\n');
}

export async function publishBoostNote(
  args: PublishArgs,
): Promise<PublishedNote> {
  const { podcast, episode, boostagram, results } = args;
  const relays = args.relays ?? DEFAULT_RELAYS;
  const totalMsat =
    boostagram.value_msat_total ??
    results.reduce((sum, r) => sum + r.sats * 1000, 0);

  // NIP-73 external content tags + boost-specific metadata
  const tags: string[][] = [];
  if (podcast.podcastGuid) {
    tags.push(['i', `podcast:guid:${podcast.podcastGuid}`]);
    tags.push(['k', 'podcast:guid']);
  }
  if (episode?.guid) {
    tags.push(['i', `podcast:item:guid:${episode.guid}`]);
    tags.push(['k', 'podcast:item:guid']);
  }
  const linkUrl = podcastLandingUrl(podcast);
  if (linkUrl) tags.push(['r', linkUrl]);
  if (totalMsat > 0) tags.push(['amount', String(totalMsat)]);
  tags.push(['client', boostagram.app_name ?? 'BoostMeBitch']);
  tags.push(['t', 'boostagram']);
  tags.push(['t', 'value4value']);

  const template: EventTemplate = {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: args.contentOverride ?? formatContent(args),
  };

  return signAndPublish(template, relays);
}
