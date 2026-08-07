'use client';

// The Split Kit live-value channel.
//
// `<podcast:liveValue uri="…" protocol="socket.io"/>` inside a
// <podcast:liveItem> is how the V4V live music shows actually switch wallets.
// The show runs The Split Kit (thesplitkit.com), which holds an ordered list of
// "blocks" — one per track, each with its own value destinations — and pushes
// the currently broadcasting block to every listener over socket.io. The host
// clicks a track; every app's payment target moves within a second.
//
// This is a PUSH channel, which is why it gets its own module rather than
// riding the RSS poller: there is nothing to poll, and polling would be both
// slower and ruder. The RSS signals in live-value.ts remain the fallback for
// shows that don't run Split Kit.
//
// Wire contract, read off thesplitkit's own client (src/routes/(main)/live):
//   connect  io(uri)                       — uri carries ?event_id=<eventGuid>
//   event    'remoteValue'  → a block      — the target changed
//   event    'playerPause'                 — ignored here
// An empty object means "back to the show's default block".

import type { ValueBlock, ValueRecipient } from '../types';

/** One Split Kit block — a track, with the wallets it pays. */
export interface LiveBlock {
  title?: string;
  image?: string;
  blockGuid?: string;
  eventGuid?: string;
  /** Where a recipient's aggregator can look the event up (Split Kit's own
   *  correlation channel). Passed through onto the boostagram verbatim. */
  eventAPI?: string;
  feedGuid?: string;
  itemGuid?: string;
  value: ValueBlock;
  /** The share redirected to this block; the remainder stays with the show. */
  remotePercentage?: number;
}

type Handler = (block: LiveBlock | null) => void;

/**
 * Split Kit's `split` is a percentage its own sender divides by 100, while a
 * PC2.0 `split` is a weight over the recipient total. For destinations that sum
 * to 100 the two are identical, and `splitSats` uses the total as denominator
 * either way — so the number carries across unchanged.
 */
/** A present-but-empty routing field is absent. Numbers survive (`696969`). */
function blank(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function toRecipients(destinations: unknown): ValueRecipient[] {
  if (!Array.isArray(destinations)) return [];
  const out: ValueRecipient[] = [];
  for (const d of destinations) {
    const address = typeof d?.address === 'string' ? d.address.trim() : '';
    if (!address) continue;
    out.push({
      name: typeof d?.name === 'string' ? d.name : undefined,
      // Split Kit infers the same way in its own sender: an address with an @
      // is a Lightning address whatever the stored type says.
      type: address.includes('@') ? 'lnaddress' : (d?.type === 'lnaddress' ? 'lnaddress' : 'node'),
      address,
      // Empty strings are dropped, not carried. Split Kit really does send
      // `customKey: "", customValue: ""` for a destination with no sub-account
      // (seen live on Homegrown Hits), and `String("")` would store a present
      // -but-blank pair. Every wire site guards with `customKey && customValue`
      // so a blank is inert today — but "inert because every reader happens to
      // use a truthy check" is one `!= null` away from a TLV record with an
      // empty key, on a shared node, where the key IS the routing.
      customKey: blank(d?.customKey),
      customValue: blank(d?.customValue),
      split: Number(d?.split) || 0,
      fee: !!d?.fee,
    });
  }
  return out;
}

/** Map a raw socket payload to a block, or null if it names no payee. */
export function parseLiveBlock(data: unknown): LiveBlock | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, any>;
  const recipients = toRecipients(d.value?.destinations);
  if (!recipients.length) return null;
  const pct = Number(d.settings?.split);
  return {
    title: typeof d.title === 'string' ? d.title : undefined,
    image: typeof d.image === 'string' ? d.image : undefined,
    blockGuid: typeof d.blockGuid === 'string' ? d.blockGuid : undefined,
    eventGuid: typeof d.eventGuid === 'string' ? d.eventGuid : undefined,
    eventAPI: typeof d.eventAPI === 'string' ? d.eventAPI : undefined,
    feedGuid: typeof d.feedGuid === 'string' ? d.feedGuid : undefined,
    itemGuid: typeof d.itemGuid === 'string' ? d.itemGuid : undefined,
    remotePercentage: Number.isFinite(pct) ? pct : undefined,
    value: {
      type: typeof d.value?.type === 'string' ? d.value.type : 'lightning',
      method: typeof d.value?.method === 'string' ? d.value.method : 'keysend',
      recipients,
    },
  };
}

/**
 * Connect to a show's live-value channel. Returns a disposer.
 *
 * socket.io-client is DYNAMICALLY imported — most shows publish no liveValue
 * tag, and this keeps ~40 kB out of the initial bundle for everyone who never
 * plays one (the same treatment hls.js and the Spark SDK get).
 *
 * Every failure path calls `onBlock(null)`, which the caller reads as "no live
 * redirect" and falls back to the show's own block. Connecting to a third-party
 * socket must never be able to strand a payment target.
 */
export function connectLiveValue(uri: string, onBlock: Handler): () => void {
  let disposed = false;
  let socket: { disconnect: () => void } | null = null;

  void (async () => {
    try {
      const { io } = await import('socket.io-client');
      if (disposed) return;
      // The uri carries its own ?event_id= query, exactly as the feed
      // published it — socket.io forwards the query string on the handshake,
      // which is how the server knows which show this is.
      const s = io(uri, {
        transports: ['websocket', 'polling'],
        reconnectionDelayMax: 30_000,
      });
      socket = s;
      if (process.env.NODE_ENV !== 'production') {
        s.on('connect', () => console.debug('[live-value] socket connected:', uri));
        s.on('disconnect', (r: string) => console.debug('[live-value] socket disconnected:', r));
      }
      s.on('remoteValue', (data: unknown) => {
        if (disposed) return;
        if (process.env.NODE_ENV !== 'production') {
          console.debug('[live-value] remoteValue payload:', data);
        }
        onBlock(parseLiveBlock(data));
      });
      s.on('connect_error', (e: Error) => {
        if (process.env.NODE_ENV !== 'production') {
          console.debug('[live-value] socket connect_error:', e?.message ?? e);
        }
        if (!disposed) onBlock(null);
      });
    } catch {
      // Import or connect failed — the RSS fallback owns it from here.
      if (!disposed) onBlock(null);
    }
  })();

  return () => {
    disposed = true;
    try { socket?.disconnect(); } catch { /* already gone */ }
  };
}
