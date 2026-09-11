import { nip19, type Event, type EventTemplate } from 'nostr-tools';
import { signAndPublish, type PublishedNote } from './publish';
import { mentionParts, type MentionNpub } from './mention-tags';
import { BRAND } from '../brand';

/**
 * NIP-89 attribution, the same tag a boost note carries.
 *
 * `BRAND.wireName` and never a literal: one repo builds two deploys, and this
 * string is what a reader — ours and every other client — prints as "via …".
 * A hard-coded name here is the other brand's word appearing under a reply on
 * the family-friendly site. `boost-notes.ts` lets a boostagram override it with
 * its own `app_name`; a reply has no boostagram, so there is nothing to defer
 * to.
 *
 * Worth knowing it is READ BACK: `discover.ts` pulls `client` off an event to
 * render that line, so a reply gains the attribution in this app's own feed as
 * well as in other clients.
 */
const CLIENT_TAG: string[] = ['client', BRAND.wireName];

/**
 * `selfSigned` IS TRUE AT BOTH CALL SITES BELOW, and that is a fact about this
 * file rather than an assumption. `mentionParts`' gate exists because a boost
 * note has two signing paths: the user's key, or the site's key through the
 * UNAUTHENTICATED `/api/nostr/site-sign`, where a sender-chosen `p` tag is a
 * mention-spam blast at strangers from a NIP-05-verified identity. Replies and
 * quotes have no such path — both functions below go through `signAndPublish`,
 * which reads `activeNostr()` and throws without a signer, so the note is
 * always signed by the person who typed it. **If a site-signed reply is ever
 * added, this file answers that question differently on the same day.**
 *
 * The helper itself lives in the import-free leaf `mention-tags.ts`, with the
 * `p`-tag half and the body half composed there, because dropping the body half
 * is a bug that shipped once and `check:mentions` now pins the pair.
 */

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
  const { content: body, pTags } = mentionParts(content, mentions, true, parent.pubkey);

  const tags: string[][] = [
    ['e', parent.id, relayHint, 'reply'],
    ['p', parent.pubkey],
    ...pTags,
    ...inheritPodcastTags(parent),
    CLIENT_TAG,
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

  const { content: commentBody, pTags } = mentionParts(comment, mentions, true, parent.pubkey);

  const tags: string[][] = [
    ['q', parent.id, relayHint, parent.pubkey],
    ['p', parent.pubkey],
    ...pTags,
    ...inheritPodcastTags(parent),
    CLIENT_TAG,
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

  // A kind:6 carries no text of its own, so there is nothing to mention — but it
  // is still a note this app published, and the attribution belongs on all three
  // publishers or on none. Leaving one out is how "via BoostMeBitch" comes to
  // mean "…except when it was a repost".
  const tags: string[][] = [
    ['e', parent.id, relayHint],
    ['p', parent.pubkey],
    CLIENT_TAG,
  ];

  const template: EventTemplate = {
    kind: 6,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: JSON.stringify(parent),
  };
  return signAndPublish(template, relays);
}
