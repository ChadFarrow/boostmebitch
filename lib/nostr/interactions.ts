import { nip19, type Event, type EventTemplate } from 'nostr-tools';
import { signAndPublish, type PublishedNote } from './publish';
import { mentionParts, type MentionNpub } from './mention-tags';
import { clientTag } from '../brand';
import { siteLandingUrl } from './boost-notes';

/**
 * NIP-89 attribution, the same tag a boost note and a live chat message carry.
 *
 * Built by `clientTag` (`lib/brand.ts`) rather than written here, so the four
 * publishers of it cannot drift: the cost of a second copy is not a wrong tag,
 * it is a publisher quietly left without one. A reply has no boostagram, so
 * there is nothing to defer to and the brand's own wire name is the answer.
 *
 * Worth knowing it is READ BACK: `discover.ts` pulls `client` off an event to
 * render that line, so a reply gains the attribution in this app's own feed as
 * well as in other clients.
 */
const CLIENT_TAG: string[] = clientTag();

/**
 * `selfSigned` IS TRUE AT EVERY CALL SITE BELOW, and that is a fact about this
 * file rather than an assumption. `mentionParts`' gate exists because a boost
 * note has two signing paths: the user's key, or the site's key through the
 * UNAUTHENTICATED `/api/nostr/site-sign`, where a sender-chosen `p` tag is a
 * mention-spam blast at strangers from a NIP-05-verified identity. Replies and
 * quotes and comments have no such path — every function below goes through `signAndPublish`,
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
 * Publish a top-level COMMENT on an episode: a kind:1 carrying the episode's
 * NIP-73 tags and no payment. It is the same note Fountain writes for a comment,
 * and the one `isPodcastComment` stamps `💬 COMMENT`.
 *
 * The tag pairs are the ones `buildBoostNoteTemplate` writes, URL hints
 * included, so the feed queries that find a boost note (`#i` on either guid)
 * find this too — in this app and in every app reading the same tags.
 *
 * Three things a boost note carries are LEFT OUT on purpose:
 *  - `t:boostagram` / `t:value4value`. Either one makes `buildNote` read the
 *    note as a boost, so a comment would be stamped `⚡` for sats nobody sent.
 *  - `amount`, for the same reason.
 *  - The feed's own npubs as `p` tags. A boost tags them because it PAYS them;
 *    a comment that did would notify the artist of every remark about their
 *    show. Only the people the sender picked with `@` are tagged.
 *
 * The body is the text, then the episode's deep link on this site — a reader in
 * a general client otherwise sees a sentence with no idea what it is about. The
 * mention run stays last, as every compose box writes it.
 *
 * Self-signed only, through `signAndPublish`: there is no site-signed comment,
 * and `/api/nostr/site-sign` would refuse one (no `⚡ Boost ⚡` prefix).
 */
export async function publishEpisodeComment(args: {
  feedGuid?: string;
  itemGuid: string;
  content: string;
  relays: string[];
  /** People the sender picked with `@`. See `mentionParts`. */
  mentions?: readonly MentionNpub[];
}): Promise<PublishedNote> {
  const { feedGuid, itemGuid, relays, mentions } = args;
  const text = args.content.trim();
  if (!text) throw new Error('empty comment');

  const tags: string[][] = [];
  if (feedGuid) {
    tags.push(['i', `podcast:guid:${feedGuid}`, siteLandingUrl(feedGuid)]);
    tags.push(['k', 'podcast:guid']);
  }
  const itemHint = feedGuid ? siteLandingUrl(feedGuid, itemGuid) : null;
  // The same 512 bound the boost note's track hint keeps: an item guid is
  // feed-chosen text, and a hint is optional where the identifier is not.
  tags.push(itemHint && itemHint.length <= 512
    ? ['i', `podcast:item:guid:${itemGuid}`, itemHint]
    : ['i', `podcast:item:guid:${itemGuid}`]);
  tags.push(['k', 'podcast:item:guid']);

  const withLink = itemHint ? `${text}\n\n${itemHint}` : text;
  const { content, pTags } = mentionParts(withLink, mentions, true);
  tags.push(...pTags);
  if (itemHint) tags.push(['r', itemHint]);
  tags.push(CLIENT_TAG);

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
