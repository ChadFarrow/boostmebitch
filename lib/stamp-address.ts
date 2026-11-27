// SERVER-ONLY. The note stamp's two calls to the deploy's own Lightning address
// (`SITE_STAMP_LNADDRESS`, `name@domain`): get an invoice for the stamp's price, and ask
// that invoice's LUD-21 verify link whether it settled. No key: an address can
// be paid and asked, never spent from. What each answer must look like is in
// lib/site-stamp.ts (pure, pinned by check:sitestamp against Alby's real
// answers); this file only fetches.
//
//   GET <origin>/.well-known/lnurlp/<name>          → LUD-06 pay request
//   GET <callback>?amount=<msat>[&comment=…]         → { pr, verify }      (LUD-21)
//   GET <verify>                                     → { settled, preimage, pr }
//
// Every URL is on the configured address's own origin — the readers refuse a
// callback or a verify link anywhere else — so nothing a third party answers can
// aim these fetches, and they are plain `fetch` with redirects refused, a
// timeout and a capped read, not `safeFetch`. A hung address must cost a note
// its stamp, never the modal its answer — so the mint's two calls share ONE
// 8 s deadline: two of their own outlast the page's 15 s wait
// (`SITE_ROUTE_TIMEOUT_MS`).
//
// The operator cannot see a refusal on the client, so each one writes ONE fixed
// `console.warn` line naming what was wrong; nothing the address sent is echoed
// to a caller, and every throw is the same fixed text.
import { readCappedJson } from '@/lib/capped-body';
import { serverUserAgent } from '@/lib/user-agent';
import { bolt11AmountMsat } from '@/lib/v4v/bolt11';
import {
  stampAddress, readPayRequest, stampCallbackUrl, readCallbackAnswer, readVerifyAnswer,
  type StampAddress,
} from '@/lib/site-stamp';

const TIMEOUT_MS = 8_000;
const MAX_ANSWER_BYTES = 64 * 1024;

function address(): StampAddress | null {
  return stampAddress(process.env.SITE_STAMP_LNADDRESS ?? '');
}

export function stampAddressConfigured(): boolean {
  return address() !== null;
}

class StampAddressError extends Error {
  constructor() {
    super('stamp address request failed');
  }
}

function refuse(why: string): never {
  console.warn(`[site-stamp] ${why}`);
  throw new StampAddressError();
}

async function getJson(url: string, signal: AbortSignal): Promise<{ status: number; json: unknown }> {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'User-Agent': serverUserAgent() },
      redirect: 'error',
      signal,
      cache: 'no-store',
    });
    const json = await readCappedJson(res, MAX_ANSWER_BYTES).catch(() => null);
    return { status: res.status, json };
  } catch {
    return refuse('the address did not answer (timeout, network, or a redirect)');
  }
}

/** An invoice for exactly `sats` from the address, and its verify link. Throws on any refusal. */
export async function createStampInvoice(comment: string, sats: number): Promise<{ bolt11: string; verifyUrl: string }> {
  const a = address();
  if (!a || !Number.isSafeInteger(sats) || sats < 1) throw new StampAddressError();
  const msat = sats * 1000;
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const pay = readPayRequest((await getJson(a.wellKnown, deadline)).json, a.origin, msat);
  if (!pay.ok) refuse(pay.why);
  const answer = readCallbackAnswer(
    (await getJson(stampCallbackUrl(pay.callback, msat, comment, pay.commentAllowed), deadline)).json,
    a.origin,
  );
  if (!answer.ok) refuse(answer.why);
  if (bolt11AmountMsat(answer.pr) !== msat) refuse('the address sent an invoice for another amount');
  return { bolt11: answer.pr, verifyUrl: answer.verify };
}

/**
 * True when the verify link says settled, false when it says not yet. Throws
 * when it gave no answer that can be read, so the route says "could not
 * confirm" rather than "unpaid".
 */
export async function stampInvoicePaid(verifyUrl: string): Promise<boolean> {
  const verdict = readVerifyAnswer((await getJson(verifyUrl, AbortSignal.timeout(TIMEOUT_MS))).json);
  if (verdict === 'settled') return true;
  if (verdict === 'unsettled') return false;
  return refuse('the verify link gave no settled answer');
}
