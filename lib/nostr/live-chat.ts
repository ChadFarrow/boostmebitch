import { SimplePool, type Event, type EventTemplate } from 'nostr-tools';
import { LIVE_STREAM_RELAYS } from './live-streams';
import { signAndPublish, type PublishedNote } from './publish';

// NIP-53 live chat. Messages are kind:1311 events tagged with the stream's
// NIP-33 address: `a` = `30311:<pubkey>:<dTag>`. A NostrLiveStream's `id` is
// already `<pubkey>:<dTag>`, so the address is just `30311:${stream.id}`.
export function streamChatAddr(streamId: string): string {
  return `30311:${streamId}`;
}

/**
 * Subscribe to a live stream's kind:1311 chat. The subscription stays open for
 * the lifetime of the returned unsubscribe — so it owns its own SimplePool
 * (withPool is for request/response and tears the pool down too early). Relays
 * backfill the most recent messages on connect (the `limit`) and then stream
 * new ones live. `onEvent` fires for every message; de-dup/sort is the caller's.
 */
export function subscribeLiveChat(
  streamId: string,
  onEvent: (e: Event) => void,
): () => void {
  const pool = new SimplePool();
  const relays = LIVE_STREAM_RELAYS;
  let closed = false;
  let sub: { close: () => void } | undefined;
  try {
    sub = pool.subscribeMany(
      relays,
      { kinds: [1311], '#a': [streamChatAddr(streamId)], limit: 100 },
      {
        onevent(e: Event) {
          if (!closed) onEvent(e);
        },
      },
    );
  } catch {
    // A malformed relay URL makes nostr-tools throw synchronously here; the
    // relay set is sanitized, but if one slips through we just yield no chat
    // rather than abort.
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
