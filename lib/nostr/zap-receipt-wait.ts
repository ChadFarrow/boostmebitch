// Wait, briefly, for the kind:9735 the provider publishes after a zap leg pays.
//
// A boost note quotes its receipts, and the receipt does not exist when the
// invoice settles — the recipient's LNURL server publishes it a moment later.
// So there is a gap between "the sats moved" and "we can name the event", and
// this is the only thing that closes it.
//
// WHAT THIS MAY NOT DO. It may not hold up the boost. Confetti, the sound, the
// stored-boost log and the modal close all fire before the note is published
// (see the ordering in components/boost-modal/index.tsx), so this wait sits
// inside the note path where the user cannot see it. It resolves with whatever
// it has at the ceiling and never rejects: a receipt that does not arrive costs
// the quote, which is a rendering nicety, while the payment already happened.
//
// ONE SUBSCRIPTION FOR THE WHOLE BOOST, not one per leg. A split pays several
// legs and each may be a zap, so the per-leg version would spend the ceiling
// serially — four legs, sixteen seconds, for a note nobody is waiting on. The
// filter takes every payee at once and the ceiling is spent once. This is not
// the "never parallelize" rule: that governs PAYMENTS, and these are reads.
//
// THE RELAY SET IS THE REQUEST'S OWN. Each kind:9734 carries a `relays` tag
// naming where its receipt should be published, so those are the relays that
// will hold it. Adding more is not free — a relay that connects and then
// answers nothing costs a query its whole ceiling (docs/nostr.md), and here the
// ceiling is the user's own latency budget.

import type { Event } from 'nostr-tools';
import { newPool, withExtraRelays } from './pool';
import { receiptRelayHints, zapReceiptAccepts, type ZapReceiptExpectation } from './zap-receipt-match';

/** One zap this app paid, waiting for its receipt. */
export interface PendingZapReceipt extends ZapReceiptExpectation {
  /** The `relays` tag of the kind:9734 — where the provider was asked to post. */
  relays: string[];
}

/** A receipt that passed `zapReceiptAccepts`, ready to be quoted. */
export interface QuotedZapReceipt {
  id: string;
  /** The provider's key. Goes in the `q` tag and the `nevent` author hint. */
  pubkey: string;
  /**
   * Hints, so a reader can find it. The relay that DELIVERED it comes first —
   * a relay the request merely asked for may never have taken the receipt, and
   * a hint naming one of those sends every reader to an empty answer. Never
   * more than three. See `receiptRelayHints`.
   */
  relays: string[];
}

/**
 * How long the note waits. Long enough for a provider that publishes promptly,
 * short enough that a note nobody is watching still lands while the modal's
 * close animation is running.
 */
export const ZAP_RECEIPT_WAIT_MS = 4000;

/**
 * How far back the filter looks. The receipt is seconds old by construction;
 * the window is wide only so a provider that stamps `created_at` with the
 * invoice's `paid_at` (which Appendix E says it SHOULD) is not cut off by clock
 * skew between them and us.
 */
const SINCE_SLACK_SECS = 120;

/**
 * Collect the receipts for `pending`, keyed by the kind:9734 id of each zap.
 *
 * A missing key means no receipt arrived in time — never that the leg failed.
 */
export async function awaitZapReceipts(
  pending: PendingZapReceipt[],
  timeoutMs: number = ZAP_RECEIPT_WAIT_MS,
): Promise<Map<string, QuotedZapReceipt>> {
  const found = new Map<string, QuotedZapReceipt>();
  if (pending.length === 0) return found;

  const relays = [...new Set(pending.flatMap((p) => p.relays))];
  const recipients = [...new Set(pending.map((p) => p.recipientPubkey))];
  if (relays.length === 0 || recipients.length === 0) return found;

  const pool = newPool();
  // Record which relay each event arrived from (`seenOn`, filled before
  // `onevent` fires), so the receipt's hint can name a relay known to hold it.
  pool.trackRelays = true;
  // Base is empty on purpose: every relay here is an "extra", so `withExtraRelays`
  // closes all of them in its own `finally`. This pool is built for one wait and
  // must not outlive it — an unclosed socket per boost is how the tab runs out.
  return withExtraRelays(pool, [], relays, (merged) =>
    new Promise<Map<string, QuotedZapReceipt>>((resolve) => {
      let settled = false;
      let sub: { close: () => void } | undefined;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { sub?.close(); } catch { /* the pool close below is the real teardown */ }
        resolve(found);
      };
      const timer = setTimeout(finish, timeoutMs);

      const onevent = (e: Event) => {
        for (const p of pending) {
          if (found.has(p.requestId)) continue;
          // The matcher is the whole security boundary — a `p` tag is not a
          // claim anybody had to earn. See lib/nostr/zap-receipt-match.ts.
          if (!zapReceiptAccepts(e, p)) continue;
          found.set(p.requestId, {
            id: e.id,
            pubkey: e.pubkey,
            relays: receiptRelayHints(
              [...(pool.seenOn.get(e.id) ?? [])].map((r) => r.url),
              p.relays,
            ),
          });
          break;
        }
        if (found.size === pending.length) finish();
      };

      try {
        sub = pool.subscribeMany(
          merged,
          {
            kinds: [9735],
            '#p': recipients,
            since: Math.floor(Date.now() / 1000) - SINCE_SLACK_SECS,
          },
          { onevent },
        );
      } catch {
        // nostr-tools throws synchronously on a malformed relay URL. Nothing to
        // wait for, so do not spend the ceiling finding that out.
        finish();
      }
    }),
  );
}
