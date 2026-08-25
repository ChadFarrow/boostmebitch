import { nip19, type Event } from 'nostr-tools';
import { withPool, withExtraRelays, FEED_QUERY_MAX_WAIT_MS, FEED_QUIET_MS, QUERY_MAX_WAIT_MS } from './pool';
import { DEFAULT_RELAYS, PROFILE_RELAYS, sanitizeRelays } from './relays';
import { storage } from '../storage';
import { parseProfileContent, type ProfileMetadata } from './auth';
import { collectEventsByAuthors } from './event-queries';
import { warmRelays } from './relay-health';
import { parseZapReceipt, zapReceiptAmountMsat, type ZapReceipt } from './zap-receipt';
import { stripNostrUris, extractImages } from '../format';

export interface DiscoveredNote {
  id: string;
  pubkey: string;
  npub: string;
  nevent: string;          // bech32-encoded for client deep-links (njump.me/<nevent>)
  createdAt: number;       // unix seconds
  content: string;
  amountMsat: number | null;
  client: string | null;
  isBoost: boolean;        // `t:boostagram` tag OR a positive `amount` tag
  podcastGuid: string | null; // first podcast:guid: ref on the note (the show)
  episodeGuids: string[];  // any podcast:item:guid: refs on the note
  author: ProfileMetadata | null;
  rawEvent: Event;         // signed source event — needed to thread replies and to embed in NIP-18 reposts
  replies: DiscoveredNote[]; // direct replies (NIP-10), oldest-first; recursive
}

// Defensive caps so a single noisy thread can't blow up the relay query budget.
const MAX_THREAD_DEPTH = 6;
const MAX_REPLIES_PER_THREAD = 200;
const REPLY_QUERY_LIMIT = 500;

/**
 * Resolve the direct parent event id for a kind:1 reply per NIP-10:
 *  - `mention` markers are ignored.
 *  - If any e-tag has marker `reply`, that's the parent.
 *  - Else if any e-tag has marker `root`, that's the parent (direct reply to root).
 *  - Else (legacy positional), the last unmarked e-tag is the parent.
 *  - Returns null when the event has no e-tag — i.e. it's top-level.
 */
function getParentEventId(e: Event): string | null {
  const eTags = e.tags.filter(
    (t) =>
      t[0] === 'e' &&
      typeof t[1] === 'string' &&
      t[1].length === 64 &&
      t[3] !== 'mention',
  );
  if (eTags.length === 0) return null;
  const replyTag = eTags.find((t) => t[3] === 'reply');
  if (replyTag) return replyTag[1];
  const rootTag = eTags.find((t) => t[3] === 'root');
  if (rootTag) return rootTag[1];
  return eTags[eTags.length - 1][1];
}

interface FetchOpts {
  relays?: string[];
  /** Cap on raw kind:1 events fetched; default 100. */
  limit?: number;
  /** Unix seconds. Forwarded to the relay as `since`, so only events with
   *  `created_at >= since` are returned. Used by `useNostrFeed.refresh` to
   *  pull only new boosts on a manual refresh instead of re-downloading the
   *  entire feed. */
  since?: number;
  /** Fired once the root event resolves, before the (slower) reply-tree /
   *  profile / quote assembly runs — lets a caller paint the thread anchor
   *  immediately and stream replies in afterward. The root note is built from
   *  the per-pubkey profile cache only (no extra network). */
  onRoot?: (root: DiscoveredNote) => void;
}

// Pull every event id this note quote-references, plus relay hints. Sources:
// `q`/`e` tags (NIP-18) and any `nostr:nevent…` / `nostr:note…` URI inline in
// content. Used to resolve Fountain-style boosts where the kind:1 wrapper
// carries no `amount` tag and the actual payment lives in a quoted kind:9735
// zap receipt.
function parseQuoteRefs(e: Event): { ids: string[]; relayHints: string[] } {
  const ids = new Set<string>();
  const relays = new Set<string>();
  for (const t of e.tags) {
    if ((t[0] === 'q' || t[0] === 'e') && typeof t[1] === 'string' && t[1].length === 64) {
      ids.add(t[1]);
      if (typeof t[2] === 'string' && t[2].startsWith('wss://')) relays.add(t[2]);
    }
  }
  const NOSTR_RE = /nostr:(n(?:event|ote)1[023456789acdefghjklmnpqrstuvwxyz]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = NOSTR_RE.exec(e.content)) !== null) {
    try {
      const decoded = nip19.decode(m[1]);
      if (decoded.type === 'nevent') {
        ids.add(decoded.data.id);
        for (const r of decoded.data.relays ?? []) relays.add(r);
      } else if (decoded.type === 'note') {
        ids.add(decoded.data);
      }
    } catch {
      // skip malformed refs
    }
  }
  return { ids: [...ids], relayHints: [...relays] };
}

/**
 * Build a DiscoveredNote from a single freshly-known event for optimistic UI
 * insertion (a just-published reply) or a root-only progressive paint. A new
 * reply has no quote-refs and no children, so we pass empty inputs; the shape
 * is byte-identical to a note produced by the full feed pipeline so a later
 * revalidation replaces it cleanly.
 */
export function noteFromEvent(
  event: Event,
  relays: string[],
  profile: ProfileMetadata | null,
): DiscoveredNote {
  return buildNote(event, relays, profile, new Map(), []);
}

function buildNote(
  e: Event,
  relays: string[],
  profile: ProfileMetadata | null,
  quoted: Map<string, Event>,
  replies: DiscoveredNote[] = [],
): DiscoveredNote {
  const amountTag = e.tags.find((t) => t[0] === 'amount')?.[1];
  let amountMsat: number | null = amountTag ? Number(amountTag) : null;
  if (!Number.isFinite(amountMsat) || (amountMsat ?? 0) <= 0) amountMsat = null;
  const client = e.tags.find((t) => t[0] === 'client')?.[1] ?? null;

  // Fountain et al. publish the payment as a kind:9735 zap receipt and post
  // a separate kind:1 narrative note that quote-references the receipt. The
  // wrapper note carries the NIP-73 podcast tags but no amount of its own,
  // so we resolve the first quoted zap receipt and adopt its amount.
  let viaZapReceipt = false;
  if (amountMsat === null) {
    const { ids } = parseQuoteRefs(e);
    for (const id of ids) {
      const q = quoted.get(id);
      if (!q) continue;
      const m = zapReceiptAmountMsat(q);
      if (m !== null) {
        amountMsat = m;
        viaZapReceipt = true;
        break;
      }
    }
  }

  // Different apps tag boosts differently: BoostMeBitch and Helipad-style
  // aggregators emit `t:boostagram`; some clients (Fountain, Wavlake
  // variants) may omit it but still emit a positive `amount` tag, or wrap
  // a kind:9735 zap receipt as above. Treat any of those as a boost so the
  // ⚡ stamp shows up consistently.
  const isBoost =
    e.tags.some((t) => t[0] === 't' && (t[1] === 'boostagram' || t[1] === 'value4value')) ||
    (amountMsat !== null && amountMsat > 0) ||
    viaZapReceipt;
  const podcastGuid =
    e.tags
      .find((t) => t[0] === 'i' && t[1]?.startsWith('podcast:guid:'))
      ?.[1]
      ?.slice('podcast:guid:'.length) ?? null;
  const episodeGuids = e.tags
    .filter((t) => t[0] === 'i' && t[1]?.startsWith('podcast:item:guid:'))
    .map((t) => t[1].slice('podcast:item:guid:'.length));
  return {
    id: e.id,
    pubkey: e.pubkey,
    npub: nip19.npubEncode(e.pubkey),
    nevent: nip19.neventEncode({
      id: e.id,
      relays: relays.slice(0, 3),
      author: e.pubkey,
    }),
    createdAt: e.created_at,
    content: e.content,
    amountMsat,
    client,
    isBoost,
    podcastGuid,
    episodeGuids,
    author: profile,
    rawEvent: e,
    replies,
  };
}

/**
 * Whether a note shows the reader something a human actually wrote. Boosts
 * always qualify — the ⚡ amount is the point. Otherwise we strip nostr: refs
 * and image URLs the way <NoteCard> does and require either non-empty body
 * text or at least one image.
 *
 * This drops the empty auto-cards some clients (notably Amplify) publish once
 * per listen: they carry the NIP-73 podcast `i`/`k` tags but `content: ""`, so
 * they render as a bare podcast chip and — at ~1/3 of all podcast-tagged
 * kind:1 traffic — drown out the real posts people send. Filtering on content
 * (not the `client` tag) keeps genuine human comments made via those same
 * clients, and matches what Fountain surfaces. Applied at render time in the
 * feed components, alongside the mute filter.
 */
export function noteHasSubstance(note: DiscoveredNote): boolean {
  if (note.isBoost) return true;
  const { body, images } = extractImages(stripNostrUris(note.content));
  return body.length > 0 || images.length > 0;
}

/**
 * Fetch every kind:1 note tagged with NIP-73 `podcast:guid:<podcastGuid>` from
 * the given relays. Resolves each unique author's kind:0 metadata in a single
 * follow-up query so the UI can render avatar + display_name without N+1
 * round-trips. Returns notes sorted newest-first, deduped by event id.
 *
 * `episodeGuids` widens the `#i` filter to also match those tracks'
 * `podcast:item:guid:<guid>` tags (OR semantics in one filter). Music album
 * pages pass every track guid so the show feed surfaces per-track boosts even
 * when a client tagged only the item guid — there are no per-track pages.
 */
export async function fetchPodcastNotes(
  podcastGuid: string,
  opts: FetchOpts = {},
  episodeGuids: string[] = [],
): Promise<DiscoveredNote[]> {
  const relays = opts.relays ?? DEFAULT_RELAYS;
  const limit = opts.limit ?? 100;
  const iTags = [
    `podcast:guid:${podcastGuid}`,
    ...episodeGuids.map((g) => `podcast:item:guid:${g}`),
  ];

  return withPool(relays, async (pool) => {
    // Drop dead/penalty-boxed relays so the scan isn't pinned by one of them,
    // then race the live set with a quiet-period early resolve.
    const live = await warmRelays(pool, relays);
    let events: Event[] = [];
    try {
      ({ events } = await collectEventsByAuthors(pool, live, {
        kinds: [1],
        '#i': iTags,
        limit,
        ...(opts.since !== undefined ? { since: opts.since } : {}),
      }, [], FEED_QUERY_MAX_WAIT_MS, FEED_QUIET_MS));
    } catch {
      return [];
    }
    return await assembleNotes(pool, live, events);
  });
}

/**
 * Fetch every kind:1 note tagged with NIP-73 `podcast:item:guid:<episodeGuid>` from
 * the given relays. Mirrors fetchPodcastNotes but scoped to a single episode.
 */
export async function fetchEpisodeNotes(
  episodeGuid: string,
  opts: FetchOpts = {},
): Promise<DiscoveredNote[]> {
  const relays = opts.relays ?? DEFAULT_RELAYS;
  const limit = opts.limit ?? 100;

  return withPool(relays, async (pool) => {
    const live = await warmRelays(pool, relays);
    let events: Event[] = [];
    try {
      ({ events } = await collectEventsByAuthors(pool, live, {
        kinds: [1],
        '#i': [`podcast:item:guid:${episodeGuid}`],
        limit,
        ...(opts.since !== undefined ? { since: opts.since } : {}),
      }, [], FEED_QUERY_MAX_WAIT_MS, FEED_QUIET_MS));
    } catch {
      return [];
    }
    return await assembleNotes(pool, live, events);
  });
}

/**
 * Fetch the Nostr thread referenced by a `<podcast:socialInteract>` URI.
 * Decodes a `nostr:note1…` or `nostr:nevent1…` URI, fetches the root event
 * (using any relay hints embedded in the nevent), then assembles the full
 * reply tree exactly like the per-podcast feed does.
 *
 * Returns `[]` for a URI we can't decode or a root event no relay carries, so
 * callers can render a graceful empty state. THROWS when the relay query
 * itself fails, so callers can distinguish a transient outage (offer retry)
 * from a genuine "nothing there".
 */
export async function fetchSocialInteractThread(
  nostrUri: string,
  opts: FetchOpts = {},
): Promise<DiscoveredNote[]> {
  const bech32 = nostrUri.startsWith('nostr:') ? nostrUri.slice(6) : nostrUri;
  let eventId: string;
  let hintRelays: string[] = [];
  try {
    const decoded = nip19.decode(bech32);
    if (decoded.type === 'note') {
      eventId = decoded.data;
    } else if (decoded.type === 'nevent') {
      eventId = decoded.data.id;
      hintRelays = decoded.data.relays ?? [];
    } else {
      return [];
    }
  } catch {
    return [];
  }

  const baseRelays = opts.relays ?? DEFAULT_RELAYS;
  // sanitizeRelays the nevent hints — a malformed relay hint embedded in the
  // URI would otherwise crash normalizeURL when we query allRelays.
  const allRelays = Array.from(
    new Set([...baseRelays, ...sanitizeRelays(hintRelays).slice(0, 4)]),
  );

  return withPool(allRelays, async (pool) => {
    let rootEvents: Event[] = [];
    try {
      rootEvents = await pool.querySync(
        allRelays,
        { ids: [eventId] },
        { maxWait: QUERY_MAX_WAIT_MS },
      );
    } catch (e) {
      throw new Error('socialInteract thread fetch failed', { cause: e });
    }
    if (!rootEvents.length) return [];
    // Paint the thread anchor immediately; the reply tree + profile/quote
    // resolution below is the slow part and streams in afterward.
    if (opts.onRoot) {
      const r = rootEvents[0];
      opts.onRoot(noteFromEvent(r, allRelays, storage.profile.get(r.pubkey) ?? null));
    }
    return assembleNotes(pool, allRelays, rootEvents);
  });
}

/**
 * Fetch the global stream of every kind:1 note tagged with NIP-73 podcast
 * identifiers across ALL podcasts. Filters by `#k: ['podcast:guid',
 * 'podcast:item:guid']` so any client that follows the Podcasting 2.0 NIP-73
 * convention is included regardless of which show.
 */
export async function fetchAllPodcastNotes(
  opts: FetchOpts = {},
): Promise<DiscoveredNote[]> {
  const relays = opts.relays ?? DEFAULT_RELAYS;
  const limit = opts.limit ?? 100;

  return withPool(relays, async (pool) => {
    const live = await warmRelays(pool, relays);
    let events: Event[] = [];
    try {
      ({ events } = await collectEventsByAuthors(pool, live, {
        kinds: [1],
        '#k': ['podcast:guid', 'podcast:item:guid'],
        limit,
        ...(opts.since !== undefined ? { since: opts.since } : {}),
      }, [], FEED_QUERY_MAX_WAIT_MS, FEED_QUIET_MS));
    } catch {
      return [];
    }
    return await assembleNotes(pool, live, events);
  });
}

/**
 * A boost, judged from the RAW event — before assembleNotes runs.
 *
 * Deliberately wider than `buildNote`'s `isBoost`, which can also adopt the
 * amount off a quoted kind:9735 and therefore needs the assembled note plus a
 * second relay round-trip. The wrapper notes that do that still carry the
 * NIP-73 podcast `i` tags, so the third clause below keeps them, and the
 * `isBoost` post-filter in each fetcher makes the final call.
 *
 * Its job is to keep `assembleNotes`' reply-tree BFS off events that were never
 * going to be shown: a `#p` query returns every ordinary mention and reply
 * addressed to that person, and running the tree walk over all of them costs a
 * relay query per depth level for nothing.
 */
function eventLooksLikeBoost(e: Event): boolean {
  if (e.kind !== 1) return false;
  if (e.tags.some((t) => t[0] === 't' && (t[1] === 'boostagram' || t[1] === 'value4value'))) return true;
  const amount = Number(e.tags.find((t) => t[0] === 'amount')?.[1]);
  if (Number.isFinite(amount) && amount > 0) return true;
  return e.tags.some((t) => t[0] === 'i' && t[1]?.startsWith('podcast:'));
}

/** How many of an author's own NIP-65 write relays a lookup may add. */
const MAX_AUTHOR_RELAYS = 6;

/**
 * Boosts this npub PUBLISHED, newest first.
 *
 * **This under-reports, by construction, and the UI must say so.** A boost note
 * is only authored by the sender when they chose "post to my Nostr feed";
 * `publishBoostNoteViaSite` signs everything else with the site's own key, and
 * an anonymous boost drops `sender_id`/`sender_name` on top of that. There is
 * no filter that recovers those — the sender is not on the wire.
 *
 * Takes the author's whole kind:1 timeline rather than filtering by tag at the
 * relay: `authors` already bounds the scan to one person, and a tag filter
 * would silently drop any client whose boost tags we haven't thought of.
 * `eventLooksLikeBoost` then trims it before the reply-tree walk.
 *
 * Queries DEFAULT_RELAYS unioned with the author's own NIP-65 write relays —
 * an artist who publishes to their own relay is exactly the person whose page
 * this is, and their notes may reach none of the defaults.
 */
export async function fetchBoostsSentBy(
  pubkey: string,
  opts: FetchOpts = {},
): Promise<DiscoveredNote[]> {
  const relays = opts.relays ?? DEFAULT_RELAYS;
  const limit = opts.limit ?? 100;

  return withPool(relays, async (pool) => {
    const live = await warmRelays(pool, relays);
    // QUERY_MAX_WAIT_MS, not the 8 s feed window: this is a single-author
    // replaceable-event lookup, which is exactly what lib/nostr/pool.ts
    // documents that constant for. It also runs BEFORE the boost query rather
    // than as a fallback after one, so every second spent here is a second the
    // user waits before the real scan even opens.
    const extras = (await fetchAuthorWriteRelays(pool, live, [pubkey], QUERY_MAX_WAIT_MS))
      .slice(0, MAX_AUTHOR_RELAYS);
    let events: Event[] = [];
    try {
      ({ events } = await withExtraRelays(pool, live, extras, (queryRelays) =>
        collectEventsByAuthors(pool, queryRelays, {
          kinds: [1],
          authors: [pubkey],
          limit,
          ...(opts.since !== undefined ? { since: opts.since } : {}),
        }, [], FEED_QUERY_MAX_WAIT_MS, FEED_QUIET_MS)));
    } catch {
      return [];
    }
    const notes = await assembleNotes(pool, live, events.filter(eventLooksLikeBoost));
    return notes.filter((n) => n.isBoost);
  });
}

/**
 * Boosts that `p`-tagged this npub, newest first — "who boosted me".
 *
 * Unlike the sent half this is complete: `buildBoostNoteTemplate` writes the
 * recipient's `p` tag whoever signs the note, deliberately un-gated on the
 * share picker's Anonymous (an anonymous boost should still reach the artist).
 * So a site-signed boost lands here even though its sender is unrecoverable.
 *
 * TWO filters, unioned, because neither alone is right. A bare
 * `{kinds:[1], '#p':[pubkey]}` would spend the whole limit on ordinary replies
 * and mentions before a single boost arrived. The `#k` filter catches every
 * client following the Podcasting 2.0 NIP-73 convention; the `#t` filter
 * catches a Helipad-style aggregator that tagged the boost but no podcast.
 * They run in parallel, so this costs one query window, not two.
 *
 * DEFAULT_RELAYS only: these notes are written by OTHER people, so the target's
 * own write relays are the wrong hint set.
 */
export async function fetchBoostsReceivedBy(
  pubkey: string,
  opts: FetchOpts = {},
): Promise<DiscoveredNote[]> {
  const relays = opts.relays ?? DEFAULT_RELAYS;
  const limit = opts.limit ?? 100;
  const since = opts.since !== undefined ? { since: opts.since } : {};

  return withPool(relays, async (pool) => {
    const live = await warmRelays(pool, relays);
    let events: Event[] = [];
    try {
      const [tagged, boosted] = await Promise.all([
        collectEventsByAuthors(pool, live, {
          kinds: [1],
          '#p': [pubkey],
          '#k': ['podcast:guid', 'podcast:item:guid'],
          limit,
          ...since,
        }, [], FEED_QUERY_MAX_WAIT_MS, FEED_QUIET_MS),
        collectEventsByAuthors(pool, live, {
          kinds: [1],
          '#p': [pubkey],
          '#t': ['boostagram', 'value4value'],
          limit,
          ...since,
        }, [], FEED_QUERY_MAX_WAIT_MS, FEED_QUIET_MS),
      ]);
      events = [...tagged.events, ...boosted.events];
    } catch {
      return [];
    }
    // assembleNotes dedupes by id, so the overlap between the two filters —
    // which is most of a BoostMeBitch note, carrying both `k` and `t` tags —
    // costs nothing here.
    const notes = await assembleNotes(pool, live, events.filter(eventLooksLikeBoost));
    return notes.filter((n) => n.isBoost);
  });
}

/**
 * Every event id the given notes quote-reference.
 *
 * Exists for one job: a Fountain-style boost is TWO events for ONE payment — a
 * kind:9735 receipt and a kind:1 wrapper that quotes it — and both can `p`-tag
 * the recipient. Without this the same payment renders twice on the same page,
 * once in the boosts section as the wrapper and once in the zaps section as the
 * receipt, and the zaps total double-counts money the boosts panel already
 * showed.
 *
 * Goes through `parseQuoteRefs` rather than an inline `e`/`q` tag scan, because
 * Fountain publishes the reference as a `nostr:nevent1…` URI inside the note
 * body, which a tag scan does not see.
 */
export function quotedEventIds(notes: DiscoveredNote[]): Set<string> {
  const out = new Set<string>();
  for (const n of notes) {
    for (const id of parseQuoteRefs(n.rawEvent).ids) out.add(id);
  }
  return out;
}

/** A kind:9735 zap to this npub, with its sender's profile already resolved. */
export interface ReceivedZap extends ZapReceipt {
  zapperNpub: string;
  zapperProfile: ProfileMetadata | null;
}

/**
 * NIP-57 zaps this npub RECEIVED, newest first.
 *
 * The other half of "who paid me". BoostMeBitch itself pays boostagrams over
 * keysend/LNURL and publishes a kind:1, so most of this comes from elsewhere —
 * the Fountain, zap.stream and Wavlake senders, whose payment IS the receipt —
 * plus this app's own live-stream boosts, which go out as real NIP-57 zaps.
 * Without them an artist's page shows a fraction of what they were sent.
 *
 * **The bare `#p` here is not the widening the two kind:1 filters above are
 * forbidden from doing.** That rule exists because `{kinds:[1], '#p':[pubkey]}`
 * is the person's whole mentions firehose and the limit would be spent on
 * ordinary replies. A kind:9735 is not a conversational kind: every event this
 * filter returns is a payment to them.
 *
 * The zapper is the kind:9734 author inside the receipt's `description`, never
 * `rawEvent.pubkey` (that is the recipient's LNURL server) — see
 * `parseZapReceipt`. A receipt with no usable request is dropped rather than
 * attributed to the server, which is a guard that withholds, so the surface has
 * to say so.
 */
export async function fetchZapsReceivedBy(
  pubkey: string,
  opts: FetchOpts = {},
): Promise<ReceivedZap[]> {
  const relays = opts.relays ?? DEFAULT_RELAYS;
  const limit = opts.limit ?? 100;

  return withPool(relays, async (pool) => {
    const live = await warmRelays(pool, relays);
    let events: Event[] = [];
    try {
      ({ events } = await collectEventsByAuthors(pool, live, {
        kinds: [9735],
        '#p': [pubkey],
        limit,
        ...(opts.since !== undefined ? { since: opts.since } : {}),
      }, [], FEED_QUERY_MAX_WAIT_MS, FEED_QUIET_MS));
    } catch {
      return [];
    }

    const receipts: ZapReceipt[] = [];
    for (const e of events) {
      const parsed = parseZapReceipt(e);
      if (parsed) receipts.push(parsed);
    }
    if (!receipts.length) return [];
    receipts.sort((a, b) => b.createdAt - a.createdAt);

    // Same batch profile path the feeds use, so zapper avatars come out of the
    // shared bmb:profile4 cache instead of a second lookup per card.
    const profiles = await fetchProfiles(
      pool,
      live,
      Array.from(new Set(receipts.map((r) => r.zapper))),
    );
    return receipts.map((r) => ({
      ...r,
      zapperNpub: nip19.npubEncode(r.zapper),
      zapperProfile: profiles.get(r.zapper) ?? null,
    }));
  });
}

async function assembleNotes(
  pool: import('nostr-tools').SimplePool,
  relays: string[],
  events: Event[],
): Promise<DiscoveredNote[]> {
  if (!events.length) return [];

  // Dedupe by id (relays often return overlapping copies) and split top-level
  // notes from replies. Shared with assembleFromBundle so the two paths cannot
  // disagree about what counts as a top-level note.
  const { topLevel: topLevelEvents, replies: seedReplies } = splitTopLevel(events);

  const childrenByParent = await fetchReplyTree(
    pool,
    relays,
    topLevelEvents.map((e) => e.id),
    seedReplies,
  );

  // Flatten the entire tree so profile + quoted resolution covers every
  // author once, not N+1.
  const allTreeEvents: Event[] = [...topLevelEvents];
  function collectChildren(parentId: string): void {
    const children = childrenByParent.get(parentId);
    if (!children) return;
    for (const c of children) {
      allTreeEvents.push(c);
      collectChildren(c.id);
    }
  }
  for (const e of topLevelEvents) collectChildren(e.id);

  const authors = Array.from(new Set(allTreeEvents.map((e) => e.pubkey)));
  const [profiles, quoted] = await Promise.all([
    fetchProfiles(pool, relays, authors),
    fetchQuotedEvents(pool, relays, allTreeEvents),
  ]);

  return buildTree(topLevelEvents, childrenByParent, profiles, quoted, relays);
}

/**
 * Turn a resolved set of events into the nested `DiscoveredNote[]` a feed
 * surface renders.
 *
 * Extracted so `assembleNotes` (which resolves its inputs from relays, in four
 * serial stages) and `assembleFromBundle` (which gets the same inputs from the
 * read index in one request) cannot disagree about how a thread is shaped. Two
 * copies of this is how the same boost comes to render differently depending on
 * where its replies happened to come from.
 */
function buildTree(
  topLevelEvents: Event[],
  childrenByParent: Map<string, Event[]>,
  profiles: Map<string, ProfileMetadata>,
  quoted: Map<string, Event>,
  relays: string[],
): DiscoveredNote[] {
  function build(e: Event): DiscoveredNote {
    const children = childrenByParent.get(e.id) ?? [];
    const replies = [...children]
      .sort((a, b) => a.created_at - b.created_at)
      .map(build);
    return buildNote(e, relays, profiles.get(e.pubkey) ?? null, quoted, replies);
  }
  return topLevelEvents.map(build);
}

/** Split events into top-level notes and replies, exactly as `assembleNotes`
 *  does. `publishReply` inherits the parent's NIP-73 i/k tags, so a reply
 *  authored by this app arrives on the same tag query as its parent boost and
 *  must be pulled out of the top-level list or it renders twice. */
function splitTopLevel(events: Event[]): { topLevel: Event[]; replies: Event[] } {
  const byId = new Map<string, Event>();
  for (const e of events) byId.set(e.id, e);
  const topLevel: Event[] = [];
  const replies: Event[] = [];
  for (const e of byId.values()) {
    if (getParentEventId(e) === null) topLevel.push(e);
    else replies.push(e);
  }
  topLevel.sort((a, b) => b.created_at - a.created_at);
  return { topLevel, replies };
}

/**
 * Build the same `DiscoveredNote[]` from a read-index bundle — no relay queries
 * at all.
 *
 * This is the seam the whole index exists for. `assembleNotes` costs four
 * serial relay stages: the notes, then one query PER REPLY DEPTH, then profiles
 * in three passes (kind:0, then a NIP-65 outbox lookup for whoever is missing,
 * then kind:0 again against those relays). Every one of those has its own
 * multi-second ceiling and nothing paints until the last one resolves. The
 * bundle carries all of it in one response.
 *
 * Reply nesting is recomputed here from NIP-10 rather than taken from the
 * server's shape: the index finds a reply by walking `e` tags in either
 * direction, so a note carrying both a `root` and a `reply` marker is reachable
 * from two parents. `getParentEventId` is the one place that decides which is
 * the real one, and it stays the one place.
 */
export function assembleFromBundle(
  bundle: { notes: Event[]; replies: Event[]; quoted: Event[]; profiles: Event[] },
  relays: string[],
): DiscoveredNote[] {
  if (!bundle.notes.length) return [];
  const { topLevel, replies: seedReplies } = splitTopLevel(bundle.notes);

  const known = new Set(topLevel.map((e) => e.id));
  const allReplies = new Map<string, Event>();
  for (const e of [...seedReplies, ...bundle.replies]) allReplies.set(e.id, e);

  // Place replies against their parents, repeating until nothing new attaches.
  // A reply can only be placed once its own parent is, and the bundle is not
  // ordered by depth, so one pass would silently drop everything below depth 1.
  const childrenByParent = new Map<string, Event[]>();
  let placedSomething = true;
  while (placedSomething) {
    placedSomething = false;
    for (const [id, e] of allReplies) {
      const parent = getParentEventId(e);
      if (!parent || !known.has(parent)) continue;
      const list = childrenByParent.get(parent) ?? [];
      list.push(e);
      childrenByParent.set(parent, list);
      known.add(id);
      allReplies.delete(id);
      placedSomething = true;
    }
  }
  // Anything left in `allReplies` replies to a note outside this bundle. It is
  // deliberately dropped rather than promoted to top level: rendering a reply
  // as if it were a standalone boost is worse than not showing it.

  const profiles = new Map<string, ProfileMetadata>();
  for (const p of bundle.profiles) {
    const meta = parseProfileContent(p.content);
    if (meta) {
      profiles.set(p.pubkey, meta);
      // Feed the app's own per-pubkey cache, so the relay pass that runs after
      // this one — and every other surface in the tab — skips the lookup.
      storage.profile.set(p.pubkey, meta);
    }
  }

  const quoted = new Map<string, Event>();
  for (const q of bundle.quoted) quoted.set(q.id, q);

  return buildTree(topLevel, childrenByParent, profiles, quoted, relays);
}

/**
 * Breadth-first reply discovery. Starting from the top-level note ids, batch
 * one relay query per depth level: `{ kinds:[1], '#e': [...idsAtThisLevel] }`.
 * Stops when no new ids are found, when MAX_THREAD_DEPTH is hit, or when a
 * single root subtree exceeds MAX_REPLIES_PER_THREAD events.
 *
 * `seedReplies` are events that came in on the original tag-based query and
 * are themselves replies; they're placed iteratively against known ancestors
 * before BFS so we don't refetch them.
 */
async function fetchReplyTree(
  pool: import('nostr-tools').SimplePool,
  relays: string[],
  rootIds: string[],
  seedReplies: Event[],
): Promise<Map<string, Event[]>> {
  const childrenByParent = new Map<string, Event[]>();
  const allEventsById = new Map<string, Event>();
  const rootByEventId = new Map<string, string>();
  const eventsPerRoot = new Map<string, number>();

  for (const id of rootIds) rootByEventId.set(id, id);

  function addReply(parentId: string, replyEvent: Event): boolean {
    if (allEventsById.has(replyEvent.id)) return false;
    const root = rootByEventId.get(parentId);
    if (!root) return false; // orphan — parent unknown
    if ((eventsPerRoot.get(root) ?? 0) >= MAX_REPLIES_PER_THREAD) return false;
    allEventsById.set(replyEvent.id, replyEvent);
    rootByEventId.set(replyEvent.id, root);
    eventsPerRoot.set(root, (eventsPerRoot.get(root) ?? 0) + 1);
    const arr = childrenByParent.get(parentId) ?? [];
    arr.push(replyEvent);
    childrenByParent.set(parentId, arr);
    return true;
  }

  // Iteratively place seed replies whose ancestor chain is already known.
  // Repeats until a pass makes no progress so depth-N seeds find their depth-(N-1)
  // seed parents.
  let progress = true;
  while (progress) {
    progress = false;
    for (const e of seedReplies) {
      if (allEventsById.has(e.id)) continue;
      const parentId = getParentEventId(e);
      if (!parentId) continue;
      if (rootByEventId.has(parentId) && addReply(parentId, e)) progress = true;
    }
  }

  // BFS down. Frontier on each round = ids whose direct replies we still need
  // to fetch. Start from every event we currently know about.
  let frontier = new Set<string>(rootByEventId.keys());
  for (let depth = 0; depth < MAX_THREAD_DEPTH; depth++) {
    if (frontier.size === 0) break;
    let events: Event[] = [];
    try {
      events = await pool.querySync(relays, {
        kinds: [1],
        '#e': Array.from(frontier),
        limit: REPLY_QUERY_LIMIT,
      }, { maxWait: FEED_QUERY_MAX_WAIT_MS });
    } catch {
      break;
    }
    const nextFrontier = new Set<string>();
    for (const e of events) {
      const parentId = getParentEventId(e);
      if (!parentId) continue;
      if (addReply(parentId, e)) nextFrontier.add(e.id);
    }
    frontier = nextFrontier;
  }

  return childrenByParent;
}

// Batch-fetch every event quote-referenced by the given notes. Used to
// resolve kind:9735 zap receipts that wrapper kind:1 notes (Fountain) point
// at — see the kind:9735 fallback in buildNote.
async function fetchQuotedEvents(
  pool: import('nostr-tools').SimplePool,
  relays: string[],
  notes: Event[],
): Promise<Map<string, Event>> {
  const out = new Map<string, Event>();
  const ids = new Set<string>();
  const hintRelays = new Set<string>();
  for (const e of notes) {
    const refs = parseQuoteRefs(e);
    for (const id of refs.ids) ids.add(id);
    for (const r of refs.relayHints) hintRelays.add(r);
  }
  if (ids.size === 0) return out;
  // Cap the hint extras so a noisy quote-ref payload doesn't fan out to
  // dozens of niche relays. The base relays are always preferred. sanitizeRelays
  // first so a malformed `q`/`e`/nevent relay hint can't crash normalizeURL.
  const cappedHints = sanitizeRelays(Array.from(hintRelays)).slice(0, Math.max(0, 12 - relays.length));
  const events = await withExtraRelays(pool, relays, cappedHints, async (queryRelays) => {
    try {
      return await pool.querySync(queryRelays, {
        ids: Array.from(ids),
      }, { maxWait: FEED_QUERY_MAX_WAIT_MS });
    } catch {
      return [] as Event[];
    }
  });
  for (const e of events) out.set(e.id, e);
  return out;
}

// Reduce a list of kind:0 events to "newest per pubkey, parsed". Skips events
// whose content isn't valid JSON.
function newestProfilesByAuthor(
  events: Event[],
): Map<string, ProfileMetadata> {
  const newest = new Map<string, Event>();
  for (const e of events) {
    const prev = newest.get(e.pubkey);
    if (!prev || e.created_at > prev.created_at) newest.set(e.pubkey, e);
  }
  const out = new Map<string, ProfileMetadata>();
  for (const [pubkey, e] of newest) {
    const profile = parseProfileContent(e.content);
    if (profile) out.set(pubkey, profile);
  }
  return out;
}

// Pull NIP-65 (kind:10002) for the given authors and return the union of
// their write-marked / unmarked relay URLs. Used as a fallback hint set when
// the default-relay batch couldn't find a profile — the author may publish
// their kind:0 only to their personal write relays. Queries the union of
// the caller's relays + PROFILE_RELAYS so authors whose NIP-65 only lives
// on purplepag.es still get resolved.
async function fetchAuthorWriteRelays(
  pool: import('nostr-tools').SimplePool,
  relays: string[],
  authors: string[],
  maxWait = FEED_QUERY_MAX_WAIT_MS,
): Promise<string[]> {
  // Stream-collect (early-exit once every author's kind:10002 is in hand) so a
  // dead relay in the union can't pin this fallback at the full maxWait. Health
  // signal is unused here — absent write relays aren't cached, so we just need
  // the events.
  //
  // `maxWait` is a parameter because the early exit only fires when the author
  // HAS a kind:10002. An author with none waits out the whole window, so a
  // caller that runs this BEFORE its own query (rather than as a fallback
  // after one) stacks two windows back to back and doubles its worst case.
  // Measured against a relay that accepts the socket and then says nothing:
  // 16 s for the sent panel against 8 s for the other two.
  const res = await withExtraRelays(pool, relays, PROFILE_RELAYS, (queryRelays) =>
    collectEventsByAuthors(pool, queryRelays, { kinds: [10002], authors }, authors, maxWait),
  );
  const newest = new Map<string, Event>();
  for (const e of res.events) {
    const prev = newest.get(e.pubkey);
    if (!prev || e.created_at > prev.created_at) newest.set(e.pubkey, e);
  }
  const urls: string[] = [];
  for (const e of newest.values()) {
    for (const tag of e.tags) {
      if (tag[0] !== 'r' || !tag[1]) continue;
      const marker = tag[2];
      if (!marker || marker === 'write') urls.push(tag[1]);
    }
  }
  // sanitizeRelays (not a bare startsWith('wss://') check) drops garbage r-tag
  // values — e.g. a spammer's `wss://SOLUTION TO ALL PHONE HACKING…, …` ad —
  // that merely *start* with wss:// but fail `new URL()`. Without this they
  // reach nostr-tools' normalizeURL when this set is queried, which throws
  // `Invalid URL` synchronously and aborts the whole feed load. Dedupes +
  // strips trailing slashes too.
  return sanitizeRelays(urls);
}

async function fetchProfiles(
  pool: import('nostr-tools').SimplePool,
  relays: string[],
  authors: string[],
): Promise<Map<string, ProfileMetadata>> {
  const out = new Map<string, ProfileMetadata>();
  if (!authors.length) return out;

  // 1. Serve from per-pubkey localStorage cache where possible. `null` means
  //    "we recently looked and they have no kind:0" — skip the fetch.
  //    `undefined` means stale or never cached — fetch.
  const toFetch: string[] = [];
  for (const pubkey of authors) {
    const cached = storage.profile.get(pubkey);
    if (cached === undefined) toFetch.push(pubkey);
    else if (cached !== null) out.set(pubkey, cached);
  }
  if (!toFetch.length) return out;

  // 2. First pass: stream kind:0 from the standard relay set unioned with the
  //    profile-outbox relays (purplepag.es etc.). The outbox relays exist
  //    specifically to host kind:0 for arbitrary authors, so this catches the
  //    common case where an author's profile isn't on DEFAULT_RELAYS.
  //    `collectEventsByAuthors` early-exits the moment all `toFetch` authors are
  //    seen, otherwise resolves at aggregate EOSE or maxWait — so one stalled
  //    relay can no longer pin or empty the whole batch (the old querySync did).
  const firstRes = await withExtraRelays(pool, relays, PROFILE_RELAYS, (queryRelays) =>
    collectEventsByAuthors(pool, queryRelays, { kinds: [0], authors: toFetch }, toFetch),
  );
  for (const [pubkey, profile] of newestProfilesByAuthor(firstRes.events)) {
    out.set(pubkey, profile);
    storage.profile.set(pubkey, profile);
  }

  // 3. NIP-65 fallback: for any author still missing, look up their write
  //    relays via kind:10002 and re-query kind:0 against the union. Cap the
  //    extra relay set so latency stays bounded.
  const missing = toFetch.filter((p) => !out.has(p));
  let fallbackRan = false;
  let fallbackHealthy = false;
  if (missing.length) {
    const extras = await fetchAuthorWriteRelays(pool, relays, missing);
    const cappedExtras = extras.slice(0, Math.max(0, 12 - relays.length));
    if (cappedExtras.length) {
      fallbackRan = true;
      const fbRes = await withExtraRelays(pool, relays, cappedExtras, (queryRelays) =>
        collectEventsByAuthors(pool, queryRelays, { kinds: [0], authors: missing }, missing),
      );
      fallbackHealthy = fbRes.allEosed && fbRes.gotAnyEvent;
      for (const [pubkey, profile] of newestProfilesByAuthor(fbRes.events)) {
        out.set(pubkey, profile);
        storage.profile.set(pubkey, profile);
      }
    }
  }

  // 4. Negative-cache anything still missing so a returning visitor doesn't
  //    re-issue the same lookups within the miss-TTL — but ONLY when the query
  //    responsible for that author was demonstrably healthy. "Healthy" =
  //    aggregate EOSE fired (not a maxWait timeout, so the absence is real) AND
  //    at least one event came back (so a relay blackout isn't mistaken for
  //    "nobody has a profile"). Without this gate a transient outage poisons
  //    every author with a 15-min miss and the feed shows raw npubs long after
  //    relays recover. An author carried into the NIP-65 fallback is gated on
  //    the fallback's health (its own write relays are authoritative); one that
  //    wasn't is gated on the first pass.
  const firstHealthy = firstRes.allEosed && firstRes.gotAnyEvent;
  for (const p of toFetch) {
    if (out.has(p)) continue;
    const wentToFallback = fallbackRan && missing.includes(p);
    if (wentToFallback ? fallbackHealthy : firstHealthy) storage.profile.setMiss(p);
  }

  return out;
}
