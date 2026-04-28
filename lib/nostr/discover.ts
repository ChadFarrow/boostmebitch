import { nip19, type Event } from 'nostr-tools';
import { withPool } from './pool';
import { DEFAULT_RELAYS } from './relays';
import type { ProfileMetadata } from './auth';

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
}

interface FetchOpts {
  relays?: string[];
  /** Cap on raw kind:1 events fetched; default 100. */
  limit?: number;
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
      });
    } catch {
      return [];
    }
    return await assembleNotes(pool, relays, events);
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
      });
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

  // Dedupe by id (relays often return overlapping copies) and sort newest first.
  const byId = new Map<string, Event>();
  for (const e of events) byId.set(e.id, e);
  const unique = Array.from(byId.values()).sort(
    (a, b) => b.created_at - a.created_at,
  );

  const authors = Array.from(new Set(unique.map((e) => e.pubkey)));
  const [profiles, quoted] = await Promise.all([
    fetchProfiles(pool, relays, authors),
    fetchQuotedEvents(pool, relays, unique),
  ]);

  return unique.map((e) =>
    buildNote(e, relays, profiles.get(e.pubkey) ?? null, quoted),
  );
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
  // Cap to keep latency bounded; the original relay set is always preferred,
  // hints fill in extras up to the cap.
  const queryRelays = Array.from(
    new Set([...relays, ...hintRelays]),
  ).slice(0, 12);
  let events: Event[] = [];
  try {
    events = await pool.querySync(queryRelays, {
      ids: Array.from(ids),
    });
  } catch {
    return out;
  } finally {
    const extras = queryRelays.filter((r) => !relays.includes(r));
    if (extras.length) {
      try {
        pool.close(extras);
      } catch {
        // ignore close errors
      }
    }
  }
  for (const e of events) out.set(e.id, e);
  return out;
}

async function fetchProfiles(
  pool: import('nostr-tools').SimplePool,
  relays: string[],
  authors: string[],
): Promise<Map<string, ProfileMetadata>> {
  const out = new Map<string, ProfileMetadata>();
  if (!authors.length) return out;
  let events: Event[] = [];
  try {
    events = await pool.querySync(relays, {
      kinds: [0],
      authors,
    });
  } catch {
    return out;
  }
  // Newest kind:0 wins per pubkey.
  const newest = new Map<string, Event>();
  for (const e of events) {
    const prev = newest.get(e.pubkey);
    if (!prev || e.created_at > prev.created_at) newest.set(e.pubkey, e);
  }
  for (const [pubkey, e] of newest) {
    try {
      out.set(pubkey, JSON.parse(e.content) as ProfileMetadata);
    } catch {
      // ignore unparseable content
    }
  }
  return out;
}
