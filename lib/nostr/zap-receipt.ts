import type { Event } from 'nostr-tools';
import { bolt11AmountMsat } from '../v4v/bolt11';

/**
 * NIP-57 kind:9735 zap receipt, parsed.
 *
 * The receipt is published by the RECIPIENT'S LNURL SERVER, so `rawEvent.pubkey`
 * is the zap provider — never the person who paid. Everything that identifies
 * the sender lives inside the kind:9734 zap request the server echoed into the
 * `description` tag, which is why this parser exists at all: the two things you
 * need from a receipt (who paid, and how much) come from two different places.
 *
 * Shared because two half-parsers had grown independently and neither could
 * answer both questions: `zapReceiptAmountMsat` below (formerly private to
 * discover.ts) read the amount and never opened the request, and `zapInfo` in
 * components/live-chat.tsx read the request and never fell back to the invoice.
 * A boost explorer needs the union, and a third copy is how the live chat and
 * the explorer would come to disagree about who sent the same zap.
 *
 * Imports stay at nostr-tools types + the pure bolt11 HRP parser. Nothing here
 * reaches ../storage, which would close the cycle CLAUDE.md warns about.
 */
export interface ZapReceipt {
  /** The receipt's own event id. */
  id: string;
  createdAt: number;
  /** Who PAID — the kind:9734 author, not the receipt author. */
  zapper: string;
  /** Who was paid — the receipt's own `p` tag. */
  recipient: string | null;
  /** Amount in msat, or null when neither the tags nor the invoice carry one. */
  msat: number | null;
  /** The zap request's content — the message the sender typed. */
  comment: string;
  /** The event that was zapped, when the zap targeted one. */
  targetEventId: string | null;
  /** NIP-73 podcast refs, when a podcast client authored the zap request. */
  podcastGuid: string | null;
  episodeGuids: string[];
  rawEvent: Event;
}

/** The embedded kind:9734 zap request, or null when it's missing/unparseable. */
function zapRequest(e: Event): { pubkey?: unknown; content?: unknown; tags?: unknown } | null {
  const desc = e.tags.find((t) => t[0] === 'description')?.[1];
  if (!desc) return null;
  try {
    const req = JSON.parse(desc) as { pubkey?: unknown; content?: unknown; tags?: unknown };
    return req && typeof req === 'object' ? req : null;
  } catch {
    return null;
  }
}

/** `description` is attacker-shaped JSON — never trust its tag array's shape. */
function tagsOf(req: { tags?: unknown } | null): string[][] {
  if (!req || !Array.isArray(req.tags)) return [];
  return req.tags.filter(
    (t): t is string[] => Array.isArray(t) && t.every((v) => typeof v === 'string'),
  );
}

function positiveMsat(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Returns msat amount from a kind:9735 zap receipt. NIP-57 says receipts
 * SHOULD include an `amount` tag and MUST include a `bolt11` tag; many
 * implementations (Fountain among them) skip the explicit `amount` and
 * only ship the invoice. Read `amount` first, fall back to parsing the
 * invoice HRP, and only then to the amount the zap REQUEST asked for.
 *
 * That third source is last on purpose and is the only thing this gained when
 * it moved out of discover.ts: the request states what the sender intended,
 * while the first two state what the invoice was actually written for. They
 * agree in practice, but the receipt is the settled fact and keeps precedence.
 */
export function zapReceiptAmountMsat(e: Event): number | null {
  if (e.kind !== 9735) return null;
  const fromTag = positiveMsat(e.tags.find((t) => t[0] === 'amount')?.[1]);
  if (fromTag !== null) return fromTag;
  const bolt11 = e.tags.find((t) => t[0] === 'bolt11')?.[1];
  if (typeof bolt11 === 'string' && bolt11.length > 0) {
    const fromInvoice = bolt11AmountMsat(bolt11);
    if (fromInvoice !== null) return fromInvoice;
  }
  return positiveMsat(tagsOf(zapRequest(e)).find((t) => t[0] === 'amount')?.[1]);
}

/**
 * Parse a kind:9735 into everything a card needs. Returns null when the event
 * isn't a receipt or carries no usable zap request — without the request there
 * is no sender to name, and a card attributing the payment to the LNURL
 * server's pubkey would be worse than showing nothing.
 */
export function parseZapReceipt(e: Event): ZapReceipt | null {
  if (e.kind !== 9735) return null;
  const req = zapRequest(e);
  if (!req || typeof req.pubkey !== 'string' || req.pubkey.length !== 64) return null;
  const reqTags = tagsOf(req);

  // NIP-73 refs ride on the zap REQUEST (the podcast client wrote it), never on
  // the receipt the LNURL server generated.
  const podcastGuid =
    reqTags
      .find((t) => t[0] === 'i' && t[1]?.startsWith('podcast:guid:'))
      ?.[1]
      ?.slice('podcast:guid:'.length) ?? null;
  const episodeGuids = reqTags
    .filter((t) => t[0] === 'i' && t[1]?.startsWith('podcast:item:guid:'))
    .map((t) => t[1].slice('podcast:item:guid:'.length));

  return {
    id: e.id,
    createdAt: e.created_at,
    zapper: req.pubkey,
    recipient: e.tags.find((t) => t[0] === 'p')?.[1] ?? null,
    msat: zapReceiptAmountMsat(e),
    comment: typeof req.content === 'string' ? req.content : '',
    targetEventId: e.tags.find((t) => t[0] === 'e')?.[1] ?? null,
    podcastGuid,
    episodeGuids,
    rawEvent: e,
  };
}

/** Whole sats, floored — what every surface renders. */
export function zapSats(z: ZapReceipt): number {
  return Math.floor((z.msat ?? 0) / 1000);
}
