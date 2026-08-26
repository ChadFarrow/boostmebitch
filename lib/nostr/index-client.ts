'use client';

// Client for the Nostr read index, reached through this origin's own
// `/api/nostr/index` proxy (the shared key is server-side and never here).
//
// EVERY function fails soft and returns `null`. The index is an accelerator,
// never a dependency: a caller that gets null runs the relay path it would have
// run anyway. `null` never means "there are no notes" — that distinction is the
// whole reason the proxy answers 503 rather than an empty body.

import { verifyEvent, type Event } from 'nostr-tools';

export interface IndexBundle {
  notes: Event[];
  replies: Event[];
  quoted: Event[];
  profiles: Event[];
  indexedThrough: number;
}

const REQUEST_TIMEOUT_MS = 8_000;

// How many notes a bundle asks for. Lower than the relay path's 100 on purpose:
// every event is signature-verified below at ~3ms each, so the bundle size is
// also a latency budget, and no feed surface renders more than this before the
// user scrolls.
export const INDEX_FEED_LIMIT = 50;

/**
 * Once the proxy says 503 (not configured, or the service is down) stop asking
 * for the rest of the tab.
 *
 * Without this every feed surface pays a wasted round trip on every mount for a
 * feature that is switched off — and a preview deploy with no index configured
 * is the normal case, not an edge one. Deliberately NOT persisted: a redeploy
 * that turns the index on must take effect on the next page load, not after
 * someone clears their storage.
 */
let indexOffForTab = false;

export function indexAvailable(): boolean {
  return !indexOffForTab;
}

async function ask<T>(path: string, params?: Record<string, string>): Promise<T | null> {
  if (indexOffForTab) return null;
  const qs = new URLSearchParams({ path, ...(params ?? {}) });
  try {
    const res = await fetch(`/api/nostr/index?${qs}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 503) {
      indexOffForTab = true;
      return null;
    }
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    // Offline, aborted, timed out. Not an answer about anything — and NOT a
    // reason to switch the index off for the tab, which 503 alone means.
    return null;
  }
}

/**
 * Drop any event whose signature does not check out.
 *
 * The index verified all of this before storing it, so a failure here means
 * that service or its database has been tampered with. Checking again is what
 * stops a compromised index putting words and sat amounts under someone else's
 * npub on our surfaces.
 *
 * **Chunked, with a yield between chunks.** Verification is ~3ms per event, so
 * a full bundle is close to a second of arithmetic. The relay path pays exactly
 * the same cost — nostr-tools verifies every event it receives — but spreads it
 * across an 8-second collection window, so it never lands in one lump. Arriving
 * all at once, unchunked, it would freeze the main thread for the length of a
 * frame budget many times over, on the very surfaces this work exists to speed
 * up.
 */
async function verifyAll(events: Event[]): Promise<Event[]> {
  const CHUNK = 15;
  const out: Event[] = [];
  for (let i = 0; i < events.length; i += CHUNK) {
    for (const e of events.slice(i, i + CHUNK)) {
      try {
        if (verifyEvent(e)) out.push(e);
      } catch {
        // A malformed event throws rather than returning false. Same verdict.
      }
    }
    if (i + CHUNK < events.length) await yieldToMain();
  }
  return out;
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function isBundle(v: unknown): v is IndexBundle {
  if (!v || typeof v !== 'object') return false;
  const b = v as Partial<IndexBundle>;
  return Array.isArray(b.notes) && Array.isArray(b.replies) &&
    Array.isArray(b.quoted) && Array.isArray(b.profiles);
}

async function bundleFrom(path: string, limit: number): Promise<IndexBundle | null> {
  const raw = await ask<unknown>(path, { limit: String(limit) });
  if (!isBundle(raw)) return null;
  const [notes, replies, quoted, profiles] = await Promise.all([
    verifyAll(raw.notes), verifyAll(raw.replies), verifyAll(raw.quoted), verifyAll(raw.profiles),
  ]);
  return { notes, replies, quoted, profiles, indexedThrough: Number(raw.indexedThrough) || 0 };
}

export function indexGlobalFeed(limit = INDEX_FEED_LIMIT): Promise<IndexBundle | null> {
  return bundleFrom('/feed/global', limit);
}

/**
 * NIP-53 live activities from the index.
 *
 * Not a `bundleFrom`: a stream card renders from the event plus its host's
 * profile and has no reply forest or quoted events, so `/feed/live` answers a
 * different shape and this reads it directly.
 *
 * The route REFUSES with 503 when the index is more than five minutes behind,
 * and that is load-bearing rather than defensive. Every other thing this client
 * fetches is public history, where an hour-old answer is still true and a
 * behind index just means a slightly shorter feed. A live list is a claim about
 * right now: served stale it puts a finished broadcast on air, which is worse
 * than answering nothing, because the relay fallback would have been correct.
 *
 * `ask` already latches `indexOffForTab` on a 503, which is the right response
 * to "not configured" and the wrong one to "temporarily behind" — but the two
 * are indistinguishable from here, and erring toward the relay path is the
 * direction that cannot be wrong.
 */
export async function indexedLiveStreams(limit = 200): Promise<NostrLiveStream[] | null> {
  const raw = await ask<unknown>('/feed/live', { limit: String(limit) });
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as { streams?: unknown; profiles?: unknown };
  if (!Array.isArray(body.streams)) return null;

  const [streams, profiles] = await Promise.all([
    verifyAll(body.streams as Event[]),
    verifyAll(Array.isArray(body.profiles) ? (body.profiles as Event[]) : []),
  ]);

  // Seed the shared per-pubkey cache before returning, so the caller's own
  // profile pass finds them already there rather than re-fetching every host.
  for (const p of profiles) {
    const meta = parseProfileContent(p.content);
    if (meta) storage.profile.set(p.pubkey, meta);
  }

  const shaped = shapeLiveStreams(streams);
  // Same rule as every other fetcher here: empty is not an answer this may
  // make. Nobody being live right now and the index not having crawled a
  // broadcast look identical from this side, so let the relay pass speak.
  return shaped.length ? shaped : null;
}

export function indexPodcastFeed(guid: string, limit = INDEX_FEED_LIMIT): Promise<IndexBundle | null> {
  return bundleFrom(`/feed/podcast/${encodeURIComponent(guid)}`, limit);
}

export function indexEpisodeFeed(guid: string, limit = INDEX_FEED_LIMIT): Promise<IndexBundle | null> {
  return bundleFrom(`/feed/episode/${encodeURIComponent(guid)}`, limit);
}

export function indexBoostsSentBy(pubkey: string, limit = INDEX_FEED_LIMIT): Promise<IndexBundle | null> {
  return bundleFrom(`/feed/by-author/${pubkey}`, limit);
}

export function indexBoostsReceivedBy(pubkey: string, limit = INDEX_FEED_LIMIT): Promise<IndexBundle | null> {
  return bundleFrom(`/feed/mentioning/${pubkey}`, limit);
}

export interface IndexZaps {
  receipts: Event[];
  profiles: Event[];
}

export async function indexZapsReceivedBy(pubkey: string, limit = INDEX_FEED_LIMIT): Promise<IndexZaps | null> {
  const raw = await ask<{ receipts?: unknown; profiles?: unknown }>(
    `/zaps/received/${pubkey}`, { limit: String(limit) },
  );
  if (!raw || !Array.isArray(raw.receipts) || !Array.isArray(raw.profiles)) return null;
  const [receipts, profiles] = await Promise.all([
    verifyAll(raw.receipts as Event[]), verifyAll(raw.profiles as Event[]),
  ]);
  return { receipts, profiles };
}

// --- assembled note helpers -------------------------------------------------
//
// These are what a feed surface passes as `indexFetcher`. They return
// `DiscoveredNote[] | null`, matching the hook's contract: null means "no
// answer" and never "no notes".
//
// `assembleFromBundle` does the rest with no relay traffic at all, which is the
// point — the same shape `assembleNotes` builds out of four serial relay
// stages.

import { nip19 } from 'nostr-tools';
import { assembleFromBundle, type DiscoveredNote, type ReceivedZap } from './discover';
import { shapeLiveStreams, type NostrLiveStream } from './live-streams';
import { DEFAULT_RELAYS } from './relays';
import { parseProfileContent } from './auth';
import { parseZapReceipt, type ZapReceipt } from './zap-receipt';
import { storage } from '../storage';

function assemble(bundle: IndexBundle | null): DiscoveredNote[] | null {
  if (!bundle) return null;
  // An empty bundle is a real answer from a working index — the show simply has
  // no notes yet — but returning [] would let it count as a result and suppress
  // nothing, so hand back null and let the relay pass speak. The index is
  // deliberately never the source of a "there are none" claim.
  if (!bundle.notes.length) return null;
  // DEFAULT_RELAYS only feeds the `nevent` relay hints inside each note, the
  // same value the relay path passes. It is not queried here.
  return assembleFromBundle(bundle, DEFAULT_RELAYS);
}

export async function indexedGlobalNotes(): Promise<DiscoveredNote[] | null> {
  return assemble(await indexGlobalFeed());
}

export async function indexedPodcastNotes(guid: string): Promise<DiscoveredNote[] | null> {
  return assemble(await indexPodcastFeed(guid));
}

export async function indexedEpisodeNotes(guid: string): Promise<DiscoveredNote[] | null> {
  return assemble(await indexEpisodeFeed(guid));
}

export async function indexedBoostsSentBy(pubkey: string): Promise<DiscoveredNote[] | null> {
  return assemble(await indexBoostsSentBy(pubkey));
}

export async function indexedBoostsReceivedBy(pubkey: string): Promise<DiscoveredNote[] | null> {
  return assemble(await indexBoostsReceivedBy(pubkey));
}

/**
 * Zap receipts this npub received, assembled from the index.
 *
 * The zapper is the kind:9734 author inside the receipt's `description`, never
 * `rawEvent.pubkey` — that is the recipient's LNURL server. `parseZapReceipt`
 * is the one place that knows this, and it stays the one place: a receipt with
 * no usable request is DROPPED rather than attributed to the server, exactly as
 * the relay path does.
 *
 * This closes the gap the boost explorer documents at its zaps section: that
 * panel has no localStorage warm paint, so on a revisit it sits on "searching
 * nostr relays…" while the two boost panels come back within a frame.
 */
export async function indexedZapsReceivedBy(pubkey: string): Promise<ReceivedZap[] | null> {
  const raw = await indexZapsReceivedBy(pubkey);
  if (!raw) return null;

  const receipts: ZapReceipt[] = [];
  for (const e of raw.receipts) {
    const parsed = parseZapReceipt(e);
    if (parsed) receipts.push(parsed);
  }
  // No usable receipts is not an answer this may make — the index may simply
  // not have crawled them. Let the relay pass speak.
  if (!receipts.length) return null;
  receipts.sort((a, b) => b.createdAt - a.createdAt);

  const profiles = new Map<string, ReturnType<typeof parseProfileContent>>();
  for (const p of raw.profiles) {
    const meta = parseProfileContent(p.content);
    if (!meta) continue;
    profiles.set(p.pubkey, meta);
    // Feed the shared per-pubkey cache so every other surface in the tab skips
    // the lookup too.
    storage.profile.set(p.pubkey, meta);
  }

  return receipts.map((r) => ({
    ...r,
    zapperNpub: nip19.npubEncode(r.zapper),
    zapperProfile: profiles.get(r.zapper) ?? null,
  }));
}
