import { SimplePool, type Event, type EventTemplate } from 'nostr-tools';
import { LIVE_STREAM_RELAYS } from './live-streams';
import { FEED_QUERY_MAX_WAIT_MS } from './pool';
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
 * tears down too early). Two phases:
 *  1. querySync the recent history in one batch — relays trickle stored events
 *     in slowly over a `subscribeMany`, so on reload you'd see only a handful;
 *     querySync waits up to maxWait and collects a complete snapshot.
 *  2. subscribeMany from now on for live messages.
 * `onEvent` fires for every message; de-dup/sort is the caller's (overlap between
 * the two phases is fine).
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

  // Phase 1 — backfill the recent history as a complete batch.
  pool
    .querySync(relays, { ...filter, limit: 200 }, { maxWait: FEED_QUERY_MAX_WAIT_MS })
    .then((events) => { if (!closed) for (const e of events) onEvent(e); })
    .catch(() => { /* ignore — phase 2 still streams live */ });

  // Phase 2 — keep a live subscription open for new messages. Also carries a
  // `limit` so recent stored events trickle in immediately (fast first paint)
  // while phase-1's querySync guarantees the complete history lands. Overlap is
  // de-duped by id in the caller.
  try {
    sub = pool.subscribeMany(
      relays,
      { ...filter, limit: 100 },
      {
        onevent(e: Event) {
          if (!closed) onEvent(e);
        },
      },
    );
  } catch {
    // A malformed relay URL makes nostr-tools throw synchronously here; the
    // relay set is sanitized, but if one slips through we just yield no live
    // updates rather than abort (the backfill above already ran).
  }
  return () => {
    closed = true;
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
