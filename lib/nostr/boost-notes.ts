import type { Event, EventTemplate } from 'nostr-tools';
import type { Boostagram, Episode, Podcast, BoostResult } from '../types';
import { DEFAULT_RELAYS } from './relays';
import { signAndPublish, publishSignedEvent, type PublishedNote } from './publish';

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
 * Best public listen-link for a podcast, in preference order:
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

/**
 * BoostMeBitch in-app deep link for this podcast. Lands the Nostr reader on
 * the show page where they can boost back. Emitted alongside the listen-link
 * (not as a replacement) so readers get both affordances: listen elsewhere
 * via pod.link, boost back here via BMB.
 */
function bmbLandingUrl(podcast: Podcast): string | null {
  if (!podcast.podcastGuid) return null;
  return `https://boostmebitch.com/?podcast=${podcast.podcastGuid}`;
}

function formatContent(args: PublishArgs): string {
  const { podcast, episode, boostagram } = args;
  const totalSats = Math.round((boostagram.value_msat_total ?? 0) / 1000);

  const lines: string[] = ['⚡ Boost ⚡', ''];
  if (boostagram.message?.trim()) {
    lines.push(boostagram.message.trim(), '');
  }
  // Attribute the sender by their "From" name when set. Load-bearing for
  // site-signed notes (signed-out users): the note is authored by the site's
  // identity, so without this their name appears nowhere. Natural for the
  // self-signed case too ("ChadF boosted …").
  const sender = boostagram.sender_name?.trim();
  lines.push(`${sender ? `${sender} boosted` : 'Boosted'} ${totalSats} sats → ${podcast.title}`);
  if (episode?.title) lines.push(`📻 ${episode.title}`);
  const link = podcastLandingUrl(podcast);
  if (link) lines.push('', link);
  const bmbLink = bmbLandingUrl(podcast);
  if (bmbLink && bmbLink !== link) lines.push(bmbLink);
  return lines.join('\n');
}

// The unsigned kind:1 boost-note template — shared by the user-signed path
// (signAndPublish, via window.nostr) and the site-signed path (server route).
function buildBoostNoteTemplate(args: PublishArgs): EventTemplate {
  const { podcast, episode, boostagram, results } = args;
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
  const bmbUrl = bmbLandingUrl(podcast);
  if (bmbUrl && bmbUrl !== linkUrl) tags.push(['r', bmbUrl]);
  if (totalMsat > 0) tags.push(['amount', String(totalMsat)]);
  tags.push(['client', boostagram.app_name ?? 'BoostMeBitch']);
  tags.push(['t', 'boostagram']);
  tags.push(['t', 'value4value']);

  return {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: args.contentOverride ?? formatContent(args),
  };
}

export async function publishBoostNote(
  args: PublishArgs,
): Promise<PublishedNote> {
  const relays = args.relays ?? DEFAULT_RELAYS;
  return signAndPublish(buildBoostNoteTemplate(args), relays);
}

/**
 * Publish the boost note signed by the SITE's own Nostr identity, for users who
 * aren't signed into Nostr. The unsigned template is sent to /api/nostr/site-sign
 * (which holds the server-only key), and the signed event is published from here
 * to DEFAULT_RELAYS. Throws on a 503 (feature not configured) / 400 / network
 * error — callers (maybePublishNote) already swallow publish failures, so a boost
 * still succeeds even if the note can't be posted.
 */
export async function publishBoostNoteViaSite(
  args: PublishArgs,
): Promise<PublishedNote> {
  const template = buildBoostNoteTemplate(args);
  const res = await fetch('/api/nostr/site-sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(template),
  });
  if (!res.ok) {
    const msg = await res.json().catch(() => null);
    throw new Error(msg?.error ?? `site-sign ${res.status}`);
  }
  const { event } = (await res.json()) as { event: Event };
  return publishSignedEvent(event, DEFAULT_RELAYS);
}
