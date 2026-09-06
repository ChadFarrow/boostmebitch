import { nip19, type Event, type EventTemplate } from 'nostr-tools';
import { signAndPublish, type PublishedNote } from './publish';
import { inlineMentions, noteMentionTags, withMentionRun, type MentionNpub } from './mention-tags';

/**
 * Turn the sender's picked mentions into `p` tags and inline `nostr:` refs.
 *
 * **`selfSigned` IS HARDCODED TRUE HERE, and that is a fact about this file
 * rather than an assumption.** `noteMentionTags`' gate exists because a boost
 * note has two signing paths: the user's key, or the site's key through the
 * UNAUTHENTICATED `/api/nostr/site-sign`, where a sender-chosen `p` tag is a
 * mention-spam blast at strangers from a NIP-05-verified identity. Replies and
 * quotes have no such path — both functions below go through `signAndPublish`,
 * which reads `activeNostr()` and throws without a signer, so the note is
 * always signed by the person who typed it. **If a site-signed reply is ever
 * added, this must become a parameter on the same day.**
 *
 * The parent's own pubkey is passed in as `already` so replying to someone you
 * also @mentioned does not emit two `p` tags for them — a duplicate is not
 * harmful, but it is the kind of thing a relay or client dedupes differently
 * and it makes the event's tag list a poor record of what the sender chose.
 */
function mentionParts(
  content: string,
  mentions: readonly MentionNpub[] | undefined,
  already: string,
): { content: string; pTags: string[][] } {
  const { tagged, inBody } = noteMentionTags(null, mentions, true);
  // BOTH HALVES, and dropping the second is the bug the mentions e2e caught.
  // `inlineMentions` can only place a mention that has a display name to match
  // on — a pasted npub has none — so it hands back what it could not place, and
  // `withMentionRun` appends those. Taking only `content` gave those people a
  // `p` tag and no trace in the body: named in the event, invisible in the note.
  const { content: inlined, remaining } = inlineMentions(content, inBody);
  const body = withMentionRun(inlined, remaining);
  const pTags = tagged
    .filter((m) => m.pubkey !== already)
    .map((m) => ['p', m.pubkey]);
  return { content: body, pTags };
}

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
  /** People the sender picked with `@`. See `mentionParts`. */
  mentions?: readonly MentionNpub[];
}): Promise<PublishedNote> {
  const { parent, content, relays, mentions } = args;
  const relayHint = relays[0] ?? '';
  const { content: body, pTags } = mentionParts(content, mentions, parent.pubkey);

  const tags: string[][] = [
    ['e', parent.id, relayHint, 'reply'],
    ['p', parent.pubkey],
    ...pTags,
    ...inheritPodcastTags(parent),
  ];

  const template: EventTemplate = {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: body,
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
  /** People the sender picked with `@`. See `mentionParts`. */
  mentions?: readonly MentionNpub[];
}): Promise<PublishedNote> {
  const { parent, comment, relays, mentions } = args;
  const relayHint = relays[0] ?? '';

  const nevent = nip19.neventEncode({
    id: parent.id,
    relays: relays.slice(0, 3),
    author: parent.pubkey,
  });

  const { content: commentBody, pTags } = mentionParts(comment, mentions, parent.pubkey);

  const tags: string[][] = [
    ['q', parent.id, relayHint, parent.pubkey],
    ['p', parent.pubkey],
    ...pTags,
    ...inheritPodcastTags(parent),
  ];

  // The mention pass runs BEFORE the nevent is appended, so a name that happens
  // to look like part of the reference cannot be rewritten inside it.
  const trimmed = commentBody.trim();
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
