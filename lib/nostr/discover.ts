import { nip19, type Event } from 'nostr-tools';
import { withPool, withExtraRelays, FEED_QUERY_MAX_WAIT_MS, QUERY_MAX_WAIT_MS } from './pool';
import { DEFAULT_RELAYS, PROFILE_RELAYS } from './relays';
import { storage } from '../storage';
import { parseProfileContent, type ProfileMetadata } from './auth';

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

// Returns msat amount from a kind:9735 zap receipt. NIP-57 says receipts
// SHOULD include an `amount` tag and MUST include a `bolt11` tag; many
// implementations (Fountain among them) skip the explicit `amount` and
// only ship the invoice. Read `amount` first, fall back to parsing the
// invoice HRP.
function zapReceiptAmountMsat(e: Event): number | null {
  if (e.kind !== 9735) return null;
  const amountTag = e.tags.find((t) => t[0] === 'amount')?.[1];
  const fromTag = amountTag ? Number(amountTag) : NaN;
  if (Number.isFinite(fromTag) && fromTag > 0) return fromTag;
  const bolt11 = e.tags.find((t) => t[0] === 'bolt11')?.[1];
  if (typeof bolt11 === 'string' && bolt11.length > 0) {
    const fromInvoice = bolt11AmountMsat(bolt11);
    if (fromInvoice !== null) return fromInvoice;
  }
  return null;
}

// Parse the HRP of a bolt11 invoice and return msat. Format:
// `ln<chain><amount?><multiplier?>1<data>`. Multipliers convert to BTC,
// then to msat (1 BTC = 1e11 msat). Returns null if the invoice has no
// embedded amount or doesn't parse — many invoices are amountless.
function bolt11AmountMsat(invoice: string): number | null {
  const lower = invoice.toLowerCase();
  const sep = lower.lastIndexOf('1');
  if (sep < 4) return null;
  const hrp = lower.slice(0, sep);
  // Longest-match chain prefixes first so `bcrt` doesn't get truncated to `bc`.
  const m = /^ln(?:bcrt|tbs|bc|tb|sb)(\d+)([munp]?)$/.exec(hrp);
  if (!m) return null;
  const digits = Number(m[1]);
  if (!Number.isFinite(digits) || digits <= 0) return null;
  const factors: Record<string, number> = {
    '': 1e11, // BTC
    m: 1e8, // milli-BTC
    u: 1e5, // micro-BTC
    n: 1e2, // nano-BTC (1 sat = 1000 msat = 10n)
    p: 0.1, // pico-BTC
  };
  const factor = factors[m[2] ?? ''];
  if (factor === undefined) return null;
  const msat = Math.round(digits * factor);
  return msat > 0 ? msat : null;
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
 * Fetch every kind:1 note tagged with NIP-73 `podcast:guid:<podcastGuid>` from
 * the given relays. Resolves each unique author's kind:0 metadata in a single
 * follow-up query so the UI can render avatar + display_name without N+1
 * round-trips. Returns notes sorted newest-first, deduped by event id.
 */
export async function fetchPodcastNotes(
  podcastGuid: string,
  opts: FetchOpts = {},
): Promise<DiscoveredNote[]> {
  const relays = opts.relays ?? DEFAULT_RELAYS;
  const limit = opts.limit ?? 100;

  return withPool(relays, async (pool) => {
    let events: Event[] = [];
    try {
      events = await pool.querySync(relays, {
        kinds: [1],
        '#i': [`podcast:guid:${podcastGuid}`],
        limit,
        ...(opts.since !== undefined ? { since: opts.since } : {}),
      }, { maxWait: FEED_QUERY_MAX_WAIT_MS });
    } catch {
      return [];
    }
    return await assembleNotes(pool, relays, events);
  });
}

/**
 * Fetch the Nostr thread referenced by a `<podcast:socialInteract>` URI.
 * Decodes a `nostr:note1…` or `nostr:nevent1…` URI, fetches the root event
 * (using any relay hints embedded in the nevent), then assembles the full
 * reply tree exactly like the per-podcast feed does.
 *
 * Returns `[]` on any decode/fetch failure so callers can render a graceful
 * empty state instead of throwing.
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
  const allRelays = Array.from(new Set([...baseRelays, ...hintRelays.slice(0, 4)]));

  return withPool(allRelays, async (pool) => {
    let rootEvents: Event[] = [];
    try {
      rootEvents = await pool.querySync(
        allRelays,
        { ids: [eventId] },
        { maxWait: QUERY_MAX_WAIT_MS },
      );
    } catch {
      return [];
    }
    if (!rootEvents.length) return [];
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
    let events: Event[] = [];
    try {
      events = await pool.querySync(relays, {
        kinds: [1],
        '#k': ['podcast:guid', 'podcast:item:guid'],
        limit,
        ...(opts.since !== undefined ? { since: opts.since } : {}),
      }, { maxWait: FEED_QUERY_MAX_WAIT_MS });
    } catch {
      return [];
    }
    return await assembleNotes(pool, relays, events);
  });
}

async function assembleNotes(
  pool: import('nostr-tools').SimplePool,
  relays: string[],
  events: Event[],
): Promise<DiscoveredNote[]> {
  if (!events.length) return [];

  // Dedupe by id (relays often return overlapping copies).
  const byId = new Map<string, Event>();
  for (const e of events) byId.set(e.id, e);
  const uniqueEvents = Array.from(byId.values());

  // Split into top-level (no e-tag) and reply candidates. publishReply()
  // inherits the parent's NIP-73 i/k tags, so replies authored by this app
  // arrive on the same `#i: podcast:guid:` query as their parent boost — we
  // pull them out of the top-level list here so they only render nested.
  const topLevelEvents: Event[] = [];
  const seedReplies: Event[] = [];
  for (const e of uniqueEvents) {
    if (getParentEventId(e) === null) topLevelEvents.push(e);
    else seedReplies.push(e);
  }
  topLevelEvents.sort((a, b) => b.created_at - a.created_at);

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

  function build(e: Event): DiscoveredNote {
    const children = childrenByParent.get(e.id) ?? [];
    const replies = [...children]
      .sort((a, b) => a.created_at - b.created_at)
      .map(build);
    return buildNote(e, relays, profiles.get(e.pubkey) ?? null, quoted, replies);
  }

  return topLevelEvents.map(build);
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
  // dozens of niche relays. The base relays are always preferred.
  const cappedHints = Array.from(hintRelays).slice(0, Math.max(0, 12 - relays.length));
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
): Promise<string[]> {
  const events = await withExtraRelays(pool, relays, PROFILE_RELAYS, async (queryRelays) => {
    try {
      return await pool.querySync(queryRelays, {
        kinds: [10002],
        authors,
      }, { maxWait: FEED_QUERY_MAX_WAIT_MS });
    } catch {
      return [] as Event[];
    }
  });
  const newest = new Map<string, Event>();
  for (const e of events) {
    const prev = newest.get(e.pubkey);
    if (!prev || e.created_at > prev.created_at) newest.set(e.pubkey, e);
  }
  const urls = new Set<string>();
  for (const e of newest.values()) {
    for (const tag of e.tags) {
      if (tag[0] !== 'r' || !tag[1]) continue;
      const url = tag[1].trim().replace(/\/$/, '');
      if (!url || !url.startsWith('wss://')) continue;
      const marker = tag[2];
      if (!marker || marker === 'write') urls.add(url);
    }
  }
  return Array.from(urls);
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

  // 2. First pass: batch-query the standard relay set unioned with the
  //    profile-outbox relays (purplepag.es etc.). The outbox relays exist
  //    specifically to host kind:0 for arbitrary authors, so this catches
  //    the common case where an author's profile isn't on DEFAULT_RELAYS.
  let firstPassOk = false;
  const events = await withExtraRelays(pool, relays, PROFILE_RELAYS, async (queryRelays) => {
    try {
      const r = await pool.querySync(queryRelays, {
        kinds: [0],
        authors: toFetch,
      }, { maxWait: FEED_QUERY_MAX_WAIT_MS });
      firstPassOk = true;
      return r;
    } catch {
      // swallow — fall through to NIP-65 pass below
      return [] as Event[];
    }
  });
  for (const [pubkey, profile] of newestProfilesByAuthor(events)) {
    out.set(pubkey, profile);
    storage.profile.set(pubkey, profile);
  }

  // 3. NIP-65 fallback: for any author still missing, look up their write
  //    relays via kind:10002 and re-query kind:0 against the union. Cap the
  //    extra relay set so latency stays bounded.
  const missing = toFetch.filter((p) => !out.has(p));
  let fallbackRan = false;
  if (missing.length) {
    const extras = await fetchAuthorWriteRelays(pool, relays, missing);
    const cappedExtras = extras.slice(0, Math.max(0, 12 - relays.length));
    if (cappedExtras.length) {
      const fbEvents = await withExtraRelays(pool, relays, cappedExtras, async (queryRelays) => {
        try {
          const r = await pool.querySync(queryRelays, {
            kinds: [0],
            authors: missing,
          }, { maxWait: FEED_QUERY_MAX_WAIT_MS });
          fallbackRan = true;
          return r;
        } catch {
          // ignore — leave still-missing authors for negative caching below
          return [] as Event[];
        }
      });
      for (const [pubkey, profile] of newestProfilesByAuthor(fbEvents)) {
        out.set(pubkey, profile);
        storage.profile.set(pubkey, profile);
      }
    }
  }

  // 4. Negative-cache anything still missing so a returning visitor doesn't
  //    re-issue the same lookups within the miss-TTL. Only do this when at
  //    least one pass actually completed — if both threw we genuinely don't
  //    know whether the profile exists.
  if (firstPassOk || fallbackRan) {
    for (const p of toFetch) {
      if (!out.has(p)) storage.profile.setMiss(p);
    }
  }

  return out;
}
