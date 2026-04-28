import type { Event, EventTemplate } from 'nostr-tools';
import { signAndPublish, type PublishedNote } from './publish';

/**
 * Publish a NIP-10 reply to `parent`. The reply inherits the parent's NIP-73
 * `i`/`k` podcast tags so the same `podcast:guid:` discovery query surfaces
 * both the original note and its replies. Marks the parent with the modern
 * `reply` marker per NIP-10's "marked tags" recommendation.
 */
export async function publishReply(args: {
  parent: Event;
  content: string;
  relays: string[];
}): Promise<PublishedNote> {
  const { parent, content, relays } = args;
  const relayHint = relays[0] ?? '';

  // Carry NIP-73 `i`/`k` pairs forward so replies remain discoverable inside
  // the same per-podcast filter.
  const podcastTags = parent.tags.filter(
    (t) =>
      (t[0] === 'i' || t[0] === 'k') &&
      typeof t[1] === 'string' &&
      (t[1].startsWith('podcast:') || t[1] === 'podcast:guid' || t[1] === 'podcast:item:guid'),
  );

  const tags: string[][] = [
    ['e', parent.id, relayHint, 'reply'],
    ['p', parent.pubkey],
    ...podcastTags,
  ];

  const template: EventTemplate = {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
  };
  return signAndPublish(template, relays);
}

/**
 * Publish a NIP-18 repost (kind:6) of `parent`. Content is the stringified
 * source event so legacy clients can render it without a follow-up fetch.
 */
export async function publishRepost(args: {
  parent: Event;
  relays: string[];
}): Promise<PublishedNote> {
  const { parent, relays } = args;
  const relayHint = relays[0] ?? '';

  const tags: string[][] = [
    ['e', parent.id, relayHint],
    ['p', parent.pubkey],
  ];

  const template: EventTemplate = {
    kind: 6,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: JSON.stringify(parent),
  };
  return signAndPublish(template, relays);
}
