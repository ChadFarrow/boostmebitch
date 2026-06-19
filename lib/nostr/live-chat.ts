import { SimplePool, type Event, type EventTemplate } from 'nostr-tools';
import { LIVE_STREAM_RELAYS } from './live-streams';
import { FEED_QUERY_MAX_WAIT_MS, QUERY_MAX_WAIT_MS } from './pool';
import { signAndPublish, type PublishedNote } from './publish';

// NIP-53 live chat. Messages are kind:1311 events tagged with the stream's
// NIP-33 address: `a` = `30311:<pubkey>:<dTag>`. A NostrLiveStream's `id` is
// already `<pubkey>:<dTag>`, so the address is just `30311:${stream.id}`.
export function streamChatAddr(streamId: string): string {
  return `30311:${streamId}`;
}

/**
 * Subscribe to a live stream's kind:1311 chat. Owns its own SimplePool (it stays
 * open for the returned unsubscribe's lifetime; withPool is request/response and
 * tears down too early). Three phases on the one pool:
 *  1. querySync the recent history in one batch — relays trickle stored events
 *     in slowly over a `subscribeMany`, so on reload you'd see only a handful;
 *     querySync waits up to maxWait and collects a complete snapshot.
 *  2. subscribeMany from now on for live messages (instant updates when healthy).
 *  3. periodic + on-focus incremental re-sync — the persistent subscription goes
 *     stale when a device backgrounds or a relay socket drops, so new messages
 *     stop arriving and the chat diverges across devices / from other clients
 *     (Fountain etc.). A lightweight `since`-bounded re-query on the same open
 *     pool catches whatever the subscription missed.
 * `onEvent` fires for every message; de-dup/sort is the caller's (overlap is fine).
 */
export function subscribeLiveChat(
  streamId: string,
  onEvent: (e: Event) => void,
): () => void {
  const pool = new SimplePool();
  const relays = LIVE_STREAM_RELAYS;
  const filter = { kinds: [1311], '#a': [streamChatAddr(streamId)] };
  let closed = false;
  let sub: { close: () => void } | undefined;
  let newest = 0; // created_at of the newest delivered message — bounds re-syncs

  const deliver = (e: Event) => {
    if (closed) return;
    if (e.created_at > newest) newest = e.created_at;
    onEvent(e);
  };

  // Phase 1 — complete backfill snapshot.
  pool
    .querySync(relays, { ...filter, limit: 200 }, { maxWait: FEED_QUERY_MAX_WAIT_MS })
    .then((events) => events.forEach(deliver))
    .catch(() => { /* ignore — later phases still stream */ });

  // Phase 2 — live subscription (carries a limit so recent ones also paint fast).
  try {
    sub = pool.subscribeMany(relays, { ...filter, limit: 100 }, { onevent: deliver });
  } catch {
    // A malformed relay URL makes nostr-tools throw synchronously; the relay set
    // is sanitized, but if one slips through we just rely on the re-sync below.
  }

  // Phase 3 — re-sync backstop.
  const pollOnce = async () => {
    if (closed) return;
    try {
      const since = newest ? newest - 30 : Math.floor(Date.now() / 1000) - 3600;
      const events = await pool.querySync(
        relays,
        { ...filter, since, limit: 200 },
        { maxWait: QUERY_MAX_WAIT_MS },
      );
      events.forEach(deliver);
    } catch { /* ignore */ }
  };
  const interval = setInterval(pollOnce, 12_000);
  const onVisible = () => { if (document.visibilityState === 'visible') pollOnce(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);

  return () => {
    closed = true;
    clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', onVisible);
    try { sub?.close(); } catch { /* already closed */ }
    try { pool.close(relays); } catch { /* ignore */ }
  };
}

/**
 * Publish a kind:1311 live chat message to the stream. Interoperates with
 * zap.stream and other NIP-53 clients. Returns the signed event so the caller
 * can append it optimistically (publish relays may not echo it back quickly).
 */
export async function publishLiveChat(
  streamId: string,
  content: string,
): Promise<PublishedNote> {
  const template: EventTemplate = {
    kind: 1311,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['a', streamChatAddr(streamId), '', 'root']],
    content,
  };
  return signAndPublish(template, LIVE_STREAM_RELAYS);
}
