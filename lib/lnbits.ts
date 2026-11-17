// SERVER-ONLY. The two LNbits calls the note stamp makes, against the deploy's
// OWN wallet: mint a 1-sat invoice, and ask whether it was paid. Configured by
// LNBITS_URL and LNBITS_INVOICE_KEY — an invoice/read key, which can mint and
// read but never spend. Use a wallet that holds only stamps, so the key on
// Vercel reads nothing else (docs/ops.md).
//
// The wire shape is LNbits `main` (lnbits/core/views/payment_api.py, read
// 2026-11-17; the site's own instance did not answer that day):
//   POST /api/v1/payments  { out: false, amount, unit: 'sat', memo, expiry }
//     → 201 Payment { payment_hash, bolt11, payment_request?, amount (msat), ... }
//     Older LNbits answers { payment_hash, payment_request }; both are read.
//   GET /api/v1/payments/{hash}
//     → { paid, status?, preimage?, details?: Payment }
//     `details` is present ONLY when the key's wallet owns the payment. Without
//     a key LNbits answers `{ paid: true }` for ANY hash on the instance, so
//     `details.amount` is what proves the payment is ours. A missing field is
//     "not paid", never a guess: the failure is a one-time-key note, not a
//     signature nobody paid for.
//
// The URL comes from env, not from a feed, so this is not a `safeFetch` case;
// every answer is still read capped and under a timeout, because a hung LNbits
// must cost a note its stamp, never the modal its answer.
import { readCappedJson } from '@/lib/capped-body';

const TIMEOUT_MS = 8_000;
const MAX_ANSWER_BYTES = 64 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

function config(): { base: string; key: string } | null {
  const raw = process.env.LNBITS_URL?.trim();
  const key = process.env.LNBITS_INVOICE_KEY?.trim();
  if (!raw || !key) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return { base: url.origin + url.pathname.replace(/\/+$/, ''), key };
  } catch {
    return null;
  }
}

export function lnbitsConfigured(): boolean {
  return config() !== null;
}

/** Every throw is this fixed text: nothing LNbits says reaches a caller. */
class LnbitsError extends Error {
  constructor() {
    super('lnbits request failed');
  }
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const c = config();
  if (!c) throw new LnbitsError();
  let res: Response;
  try {
    res = await fetch(`${c.base}${path}`, {
      method,
      headers: { 'X-Api-Key': c.key, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    const json = await readCappedJson(res, MAX_ANSWER_BYTES).catch(() => null);
    return { status: res.status, json };
  } catch {
    throw new LnbitsError();
  }
}

const field = (o: unknown, k: string): unknown =>
  o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined;

export async function createStampInvoice(
  sats: number,
  memo: string,
  expirySecs: number,
): Promise<{ paymentHash: string; bolt11: string }> {
  const { status, json } = await call('POST', '/api/v1/payments', {
    out: false, amount: sats, unit: 'sat', memo, expiry: expirySecs,
  });
  const paymentHash = field(json, 'payment_hash');
  const bolt11 = field(json, 'bolt11') ?? field(json, 'payment_request');
  if (status < 200 || status >= 300 || typeof paymentHash !== 'string' || !HEX64.test(paymentHash)
    || typeof bolt11 !== 'string' || !/^ln/i.test(bolt11)) {
    throw new LnbitsError();
  }
  return { paymentHash, bolt11 };
}

/**
 * True only when THIS wallet holds an incoming payment for `paymentHash` of at
 * least `minSats`, settled. A 404 (not this wallet's) is false; any other
 * failure throws, so the route can say "could not confirm" rather than "unpaid".
 */
export async function stampInvoicePaid(paymentHash: string, minSats: number): Promise<boolean> {
  if (!HEX64.test(paymentHash)) return false;
  const { status, json } = await call('GET', `/api/v1/payments/${paymentHash}`);
  if (status === 404) return false;
  if (status < 200 || status >= 300) throw new LnbitsError();
  const details = field(json, 'details');
  const amountMsat = field(details, 'amount');
  return field(json, 'paid') === true
    && field(details, 'payment_hash') === paymentHash
    && typeof amountMsat === 'number'
    && amountMsat > 0
    && amountMsat >= minSats * 1000;
}
