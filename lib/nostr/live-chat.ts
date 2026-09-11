import { type Event, type EventTemplate } from 'nostr-tools';
import { LIVE_STREAM_RELAYS } from './live-streams';
import { FEED_QUERY_MAX_WAIT_MS, newPool, QUERY_MAX_WAIT_MS } from './pool';
import { signAndPublish, type PublishedNote } from './publish';
import { mentionParts, type MentionNpub } from './mention-tags';
import { clientTag } from '../brand';

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
  const pool = newPool();
  const relays = LIVE_STREAM_RELAYS;
  // kind:1311 = chat messages, kind:9735 = zap receipts (boosts from Fountain /
  // zap.stream / any NIP-57 client) — both tagged with the stream's `a` address.
  const filter = { kinds: [1311, 9735], '#a': [streamChatAddr(streamId)] };
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
    // Every other poller in the app gates on `document.hidden`
    // (lib/use-live-status-poll.ts is the house pattern); a backgrounded tab
    // otherwise keeps issuing a `querySync` across the live relays every 12 s
    // for as long as it is open. The `visibilitychange` listener below does
    // the catch-up poll the moment the tab comes back.
    if (closed || (typeof document !== 'undefined' && document.hidden)) return;
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
 *
 * `mentions` are the people the sender picked with `@` in `<MessageInput>`.
 * They reach the event two ways and both are needed: `nostr:npub…` in the body
 * where the sender typed the name, which is what every client renders, and a
 * `p` tag, which is the only thing that puts the message in the mentioned
 * person's notifications. A body reference with no `p` tag reads correctly to
 * everybody except the one person it names.
 *
 * `selfSigned` is TRUE here, and it is a fact about this function rather than
 * an assumption: `signAndPublish` reads `activeNostr()` and throws without a
 * signer, and there is no site-signed path for kind:1311 — `<LiveChat>` renders
 * the composer only when `identity` is set, and the boost modal's chat fallback
 * is gated on the same. **A site-signed chat message would have to answer that
 * question differently on the day it is added.**
 *
 * The `a` root tag stays FIRST. NIP-53 addresses the message to the stream with
 * it, and appending the `p` tags and the `client` tag after it leaves that shape
 * untouched for every other client reading the room.
 *
 * The NIP-89 `client` tag is the same one a reply, a quote and a boost note
 * carry, from `clientTag` (`lib/brand.ts`) and never a literal. A chat message
 * is user-authored public prose like any of those, and this is the one
 * publisher of it that went without: a reader printing "via …" under the boost
 * note and nothing under the message the same person typed into the room is the
 * drift that rule exists to stop. What any particular client renders is its own
 * business and is not asserted here — an ignored tag costs nothing.
 *
 * `relays` defaults to `LIVE_STREAM_RELAYS` and no app caller passes it. It
 * exists so `e2e:mentions` can drive this function against the local relay: a
 * publisher that takes no `relays` argument cannot be exercised without putting
 * test events on the public set permanently, which is why that script already
 * SKIPS the one section whose publisher has none. A default rather than a
 * required argument, so no caller can quietly publish a chat message somewhere
 * the room is not reading.
 */
export async function publishLiveChat(
  streamId: string,
  content: string,
  mentions?: readonly MentionNpub[],
  relays: string[] = LIVE_STREAM_RELAYS,
): Promise<PublishedNote> {
  const { content: body, pTags } = mentionParts(content, mentions, true);
  const template: EventTemplate = {
    kind: 1311,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['a', streamChatAddr(streamId), '', 'root'], ...pTags, clientTag()],
    content: body,
  };
  return signAndPublish(template, relays);
}
