// The ingest DECISIONS, kept pure and free of any database import so
// verify/check-ingest.mjs can load this exact module under plain Node and pin
// it. A reimplemented copy in the check would pass green while this drifted,
// which is the failure that shape exists to prevent.
//
// Nothing here writes anything. src/indexer.ts calls these and does the I/O.

import { verifyEvent, type Event } from 'nostr-tools';

/** NIP-73 identifier prefixes this app cares about, on `i` tags. */
export const PODCAST_GUID_PREFIX = 'podcast:guid:';
export const PODCAST_ITEM_PREFIX = 'podcast:item:guid:';

/** Kinds this index is allowed to store. Anything else is dropped at the door.
 *
 * The absences are the point and are enforced here rather than only in the
 * subscription filters: a relay may send whatever it likes on an open
 * subscription, so the filter is a request and this is the rule.
 *
 *   10333 favorites — a stale read would delete entries another app wrote
 *   10000 mutes     — the private half is NIP-04 ciphertext
 *       3 follows   — a blind republish wipes a follow list
 *   30078 backups   — encrypted wallet + settings
 *     4/1059 DMs    — private by construction
 */
export const STORABLE_KINDS = new Set([0, 1, 6, 9735, 30311]);

/** NIP-53 live activities. Addressable (30000-39999), so the newest event per
 *  `(pubkey, d)` is the current one and older versions are history — the
 *  dedupe lives in the query rather than at ingest, because a relay serves
 *  versions out of order and the newest may arrive first.
 *
 *  It is safe to index for the reason the FORBIDDEN list exists: nothing this
 *  app does WRITES a kind:30311. The forbidden kinds are all events a stale
 *  index read could talk a client into destroying; a live-stream announcement
 *  is published by the streamer and only ever read here. */
export const LIVE_STREAM_KIND = 30311;

/** kind:5 is consumed at ingest (it tombstones rows) and never stored. */
export const DELETION_KIND = 5;

export const FORBIDDEN_KINDS = new Set([3, 4, 1059, 10000, 10002, 10333, 30078]);

export type IngestAction =
  | { type: 'reject'; reason: string }
  | { type: 'store' }
  | { type: 'profile' }
  | { type: 'delete'; targets: string[] };

/**
 * Decide what to do with one event off the wire.
 *
 * Signature verification runs FIRST and unconditionally. Everything downstream
 * of this index trusts what it serves, so an unverified event here would let
 * anyone who can reach a relay put words in another person's mouth on our
 * surfaces. The client verifies again on read; this is the cheaper of the two
 * places to catch it and the only one that keeps the row out of the database.
 */
export function classify(event: Event): IngestAction {
  if (!isWellFormed(event)) return { type: 'reject', reason: 'malformed' };
  if (!verifyEvent(unmemoized(event))) return { type: 'reject', reason: 'bad-signature' };
  if (FORBIDDEN_KINDS.has(event.kind)) return { type: 'reject', reason: 'forbidden-kind' };
  if (event.kind === DELETION_KIND) {
    const targets = deletionTargets(event);
    return targets.length ? { type: 'delete', targets } : { type: 'reject', reason: 'empty-deletion' };
  }
  if (event.kind === 0) return { type: 'profile' };
  if (!STORABLE_KINDS.has(event.kind)) return { type: 'reject', reason: 'unindexed-kind' };
  return { type: 'store' };
}

/**
 * A copy with any Symbol-keyed properties removed.
 *
 * nostr-tools memoizes its own verification result on the event object under a
 * Symbol and `verifyEvent` short-circuits on it. Events off the wire arrive
 * through JSON.parse and can never carry one, so in normal operation this only
 * stops nostr-tools re-checking work it already did.
 *
 * It is here because this function's entire value is being unconditional.
 * Object spread copies symbol properties, so `{ ...trusted, id, sig }` — the
 * obvious way to construct a tampered event, and the way a check script writes
 * one — arrives carrying a `true` for a body it just replaced, and sails
 * through. Caught exactly that way: a forged vector was accepted and stored.
 * Strip them so the answer is always computed from the bytes.
 */
function unmemoized(event: Event): Event {
  const copy = { ...event } as Record<string | symbol, unknown>;
  for (const s of Object.getOwnPropertySymbols(copy)) delete copy[s];
  return copy as unknown as Event;
}

/** Shape check before the (relatively expensive) signature check. */
export function isWellFormed(e: unknown): e is Event {
  if (!e || typeof e !== 'object') return false;
  const ev = e as Record<string, unknown>;
  return (
    typeof ev.id === 'string' && ev.id.length === 64 &&
    typeof ev.pubkey === 'string' && ev.pubkey.length === 64 &&
    typeof ev.sig === 'string' && ev.sig.length === 128 &&
    typeof ev.kind === 'number' && Number.isInteger(ev.kind) &&
    typeof ev.created_at === 'number' && Number.isFinite(ev.created_at) &&
    typeof ev.content === 'string' &&
    Array.isArray(ev.tags) &&
    (ev.tags as unknown[]).every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))
  );
}

/** Event ids a kind:5 asks to delete. Only `e` tags; `a` tags address
 *  replaceable events, which this index does not tombstone. */
export function deletionTargets(event: Event): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of event.tags) {
    if (t[0] !== 'e') continue;
    const id = t[1];
    if (typeof id !== 'string' || id.length !== 64 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The single-letter (NIP-01 indexable) tags, with their ordinal in the
 * ORIGINAL tags array.
 *
 * `pos` is deliberately the original index and not a counter over the returned
 * rows. Tag order is data in this project, and a consumer reading these rows
 * back must be able to see that positions 1 and 4 were adjacent `i` tags with
 * something unindexable between them — a renumbered `pos` would silently claim
 * they were neighbours.
 */
export function indexableTags(event: Event): { name: string; value: string; pos: number }[] {
  const out: { name: string; value: string; pos: number }[] = [];
  event.tags.forEach((t, pos) => {
    const name = t[0];
    const value = t[1];
    if (typeof name !== 'string' || !/^[a-zA-Z]$/.test(name)) return;
    if (typeof value !== 'string' || !value) return;
    out.push({ name, value, pos });
  });
  return out;
}

export interface PodcastRefs {
  feedGuids: string[];
  items: { feedGuid: string; itemGuid: string }[];
}

/**
 * The Podcast Index identifiers a note carries, for the warm-fill queue.
 *
 * An item guid is only useful with its parent feed guid — Podcast Index cannot
 * look an item up without one — so an item is emitted only when the note also
 * names a feed. That mirrors the same requirement in the app's own
 * `resolveEpisodeByGuid` and `<FavEpisodeHeart>`.
 */
export function podcastRefs(event: Event): PodcastRefs {
  const feedGuids: string[] = [];
  const itemGuids: string[] = [];
  for (const t of event.tags) {
    if (t[0] !== 'i' || typeof t[1] !== 'string') continue;
    if (t[1].startsWith(PODCAST_ITEM_PREFIX)) {
      const v = t[1].slice(PODCAST_ITEM_PREFIX.length);
      if (v && !itemGuids.includes(v)) itemGuids.push(v);
    } else if (t[1].startsWith(PODCAST_GUID_PREFIX)) {
      const v = t[1].slice(PODCAST_GUID_PREFIX.length);
      if (v && !feedGuids.includes(v)) feedGuids.push(v);
    }
  }
  const parent = feedGuids[0];
  return {
    feedGuids,
    items: parent ? itemGuids.map((itemGuid) => ({ feedGuid: parent, itemGuid })) : [],
  };
}

/**
 * Pubkeys worth subscribing to after seeing this event: its author, and
 * anyone it p-tags.
 *
 * This is what scopes the kind:9735 subscription. Zap receipts are only ever
 * needed for a pubkey some surface is already showing, so growing the set from
 * observed notes gives exactly the right coverage without ever asking a relay
 * for every zap on the network.
 */
export function trackedFrom(event: Event): { pubkey: string; reason: string }[] {
  const out: { pubkey: string; reason: string }[] = [];
  const seen = new Set<string>();
  const add = (pk: unknown, reason: string) => {
    if (typeof pk !== 'string' || pk.length !== 64 || seen.has(pk)) return;
    seen.add(pk);
    out.push({ pubkey: pk, reason });
  };
  add(event.pubkey, 'author');
  for (const t of event.tags) if (t[0] === 'p') add(t[1], 'p-tagged');
  return out;
}
