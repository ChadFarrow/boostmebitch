import { nip19, type Event, type EventTemplate } from 'nostr-tools';
import { signAndPublish, type PublishedNote } from './publish';

// Carry NIP-73 `i`/`k` pairs forward so derived events (replies, quotes) stay
// discoverable inside the same per-podcast filter we use for the global feed.
function inheritPodcastTags(parent: Event): string[][] {
  return parent.tags.filter(
    (t) =>
      (t[0] === 'i' || t[0] === 'k') &&
      typeof t[1] === 'string' &&
      t[1].startsWith('podcast:'), // subsumes the exact podcast:guid / :item:guid k-values
  );
}

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

  const tags: string[][] = [
    ['e', parent.id, relayHint, 'reply'],
    ['p', parent.pubkey],
    ...inheritPodcastTags(parent),
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
 * Publish a NIP-18 quote repost — kind:1 with a `q` tag pointing at the source
 * event plus an inline `nostr:nevent1...` reference at the bottom so clients
 * that don't render `q` tags still surface the quoted note. The user's typed
 * commentary goes above the reference.
 */
export async function publishQuoteRepost(args: {
  parent: Event;
  comment: string;
  relays: string[];
}): Promise<PublishedNote> {
  const { parent, comment, relays } = args;
  const relayHint = relays[0] ?? '';

  const nevent = nip19.neventEncode({
    id: parent.id,
    relays: relays.slice(0, 3),
    author: parent.pubkey,
  });

  const tags: string[][] = [
    ['q', parent.id, relayHint, parent.pubkey],
    ['p', parent.pubkey],
    ...inheritPodcastTags(parent),
  ];

  const trimmed = comment.trim();
  const content = trimmed ? `${trimmed}\n\nnostr:${nevent}` : `nostr:${nevent}`;

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
