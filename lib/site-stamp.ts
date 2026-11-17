// THE NOTE STAMP — every decision behind "the site signs a boost note only when
// someone paid for it", with every effect injected. IMPORT-FREE ON PURPOSE:
// `check:sitestamp` loads this file under plain Node and pins all of it, and
// `scripts/import-free.mjs` rejects any import (type-only included).
//
// WHY A STAMP. `/api/nostr/site-sign` signs under the site's NIP-05-verified
// name and is unauthenticated, so without proof of payment anyone with `curl`
// posts their own text as the site. A boost's own legs cannot prove anything to
// the site — a keysend preimage is made by the SENDER — so the proof is a payment
// to the site itself: an invoice for 1% of the boost the note states, from the
// site's own Lightning address (`SITE_STAMP_LNADDRESS`), bound to exactly ONE
// event id, and confirmed by that invoice's LUD-21 verify link. Asking twice for that id yields the same event (relays
// dedupe it), so a paid stamp cannot be replayed into many notes, while RETRY
// NOTE may ask as often as it needs. No server state.
//
// THE OTHER HALF IS THE LADDER (`signSiteNote`). It runs in the browser after
// the boost: ask for the stamp, pay it, ask for the signature. ANY failure signs
// the SAME template with a one-time key, so no real boost ever loses its note.
// It never throws and never pays twice. Reasoning: docs/money-boosts.md and
// docs/security.md, "the site-sign stamp".

/** Spark's routing-fee cap for a stamp (Chad, 2026-11-17). NWC and WebLN set their own. */
export const STAMP_MAX_FEE_SATS = 10;
/** How long a token is honoured — a paid stamp's note may be re-signed until then. */
export const STAMP_TTL_SECS = 86_400;
/** How long the ladder waits for the wallet before it posts from a one-time key. */
export const STAMP_PAY_TIMEOUT_MS = 30_000;
/**
 * Re-asks after a "not paid" answer: settlement can trail the payer's answer.
 * ~17.5 s in all, because Spark's `payLightningInvoice` answers when the send
 * STARTS and its service pays the invoice after; a wallet that answers late
 * has paid the sat, and a shorter wait would post its note one-time anyway.
 */
export const STAMP_RECHECK_DELAYS_MS = [1500, 3000, 5000, 8000];
/** The route's 402 after the verify link says unsettled. The ladder re-asks on exactly this. */
export const STAMP_NOT_PAID = 'the note stamp is not paid';
/** The route's 502 when the verify link gave no answer it could read. The sat may have landed: "unconfirmed". */
export const STAMP_UNCONFIRMED = 'could not confirm the stamp';

const STAMP_REQUIRED = 'a note stamp is required';
const STAMP_INVALID = 'the note stamp is not valid';
const STAMP_EXPIRED = 'the note stamp has expired';
const STAMP_OTHER_NOTE = 'the note stamp is for a different note';

// The price.

/**
 * 1% of a boost of `boostMsat`, rounded UP to a whole sat, never under 1, with
 * no maximum (Chad, 2026-11-17). A change is a money change: the server asks
 * for exactly this and the client pays exactly this.
 */
export function stampSats(boostMsat: number): number {
  return Math.max(1, Math.ceil(boostMsat / 100_000));
}

// A positive whole number of sats, in msat, short enough to stay a safe integer.
const WHOLE_SATS_MSAT = /^[1-9][0-9]{0,11}000$/;
// "boosted N sats" — the sentence's own words (boostSentence, boostAllLines) —
// with the separators and digit forms a reader would take for the same number.
// Read over NFKC, so full-width digits are digits. The number's class already
// holds whitespace, so nothing sits between it and "sat": a `\s*` there shares
// every space with the lazy group, and a run of spaces then costs its SQUARE
// on a route with no login (1.2 s for 50,000, timed by check:sitestamp).
const BOOST_CLAIM = /\bboosted\s+([0-9][0-9.,'_\s]*?)sat(?:s|oshis?)?\b/gi;

export type StampDue = { ok: true; sats: number } | { ok: false; why: string };

/**
 * What a note's stamp costs: 1% of its ONE `amount` tag — and only when every
 * "boosted N sats" in its text states that same number, so the sentence a
 * person reads cannot claim a larger boost than the one the stamp was priced
 * at. Text in other words ("sent a million sats") is the writer's own, as on
 * any Nostr note; this binds the tag apps read and the sentence the note opens
 * with. Every `why` is a fixed literal: the route answers it as a 400.
 */
export function stampDue(template: { content: string; tags: string[][] }): StampDue {
  const amounts = template.tags.filter((tag) => tag[0] === 'amount');
  if (amounts.length !== 1) return { ok: false, why: 'a site note needs exactly one amount tag' };
  const raw = amounts[0]![1] ?? '';
  if (!WHOLE_SATS_MSAT.test(raw)) return { ok: false, why: 'the amount tag is not a whole number of sats' };
  const msat = Number(raw);
  const claims = [...template.content.normalize('NFKC').matchAll(BOOST_CLAIM)]
    .map((m) => Number((m[1] ?? '').replace(/[^0-9]/g, '')));
  if (!claims.length) return { ok: false, why: 'the note does not say how many sats it boosted' };
  if (claims.some((n) => n !== msat / 1000)) {
    return { ok: false, why: 'the note claims a different amount than its amount tag' };
  }
  return { ok: true, sats: stampSats(msat) };
}

// The token.

export interface StampClaims {
  v: 1;
  /** The NIP-01 id of the event the site key will sign. */
  id: string;
  /**
   * The stamp invoice's LUD-21 verify link. One link per invoice, so it binds
   * the event to the invoice as tightly as a payment hash; the route minted it
   * from the configured address's own origin, and the MAC keeps it that way.
   */
  vu: string;
  /** Unix seconds after which the token is refused. */
  exp: number;
}

/** base64url HMAC of `data` under the deploy's stamp key. Injected: this file imports nothing. */
export type Mac = (data: string) => string;

const HEX64 = /^[0-9a-f]{64}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LEN = 1024;
const MAX_VERIFY_URL_LEN = 512;
const HTTP_URL = /^https?:\/\//;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Constant-time for equal lengths, so the MAC is not guessable byte by byte. */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function encodeStamp(claims: StampClaims, mac: Mac): string {
  const payload = toBase64Url(JSON.stringify({ v: claims.v, id: claims.id, vu: claims.vu, exp: claims.exp }));
  return `${payload}.${mac(payload)}`;
}

export type StampRead =
  | { ok: true; claims: StampClaims }
  | { ok: false; reason: 'malformed' | 'forged' | 'expired' };

export function readStamp(token: unknown, mac: Mac, nowSecs: number): StampRead {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LEN) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2 || !B64URL.test(parts[0]) || !B64URL.test(parts[1])) return { ok: false, reason: 'malformed' };
  const [payload, sig] = parts;
  // The MAC before the parse: nothing an attacker wrote is decoded until the
  // site's own key has vouched for it.
  if (!sameString(mac(payload), sig)) return { ok: false, reason: 'forged' };
  let c: unknown;
  try {
    c = JSON.parse(fromBase64Url(payload));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!c || typeof c !== 'object') return { ok: false, reason: 'malformed' };
  const { v, id, vu, exp } = c as Record<string, unknown>;
  if (v !== 1 || typeof id !== 'string' || !HEX64.test(id)
    || typeof vu !== 'string' || vu.length > MAX_VERIFY_URL_LEN || !HTTP_URL.test(vu)
    || typeof exp !== 'number' || !Number.isInteger(exp)) {
    return { ok: false, reason: 'malformed' };
  }
  if (nowSecs >= exp) return { ok: false, reason: 'expired' };
  return { ok: true, claims: { v: 1, id, vu, exp } };
}

/**
 * A body with a `template` key is the stamped shape `{ template, stamp }`.
 * Anything else is the legacy bare template a page loaded before the stamp
 * shipped still sends — signed in phase 1, refused once the switch is on.
 */
export function splitSignBody(body: unknown): { template: unknown; stamp: unknown; legacy: boolean } {
  if (body && typeof body === 'object' && !Array.isArray(body) && Object.prototype.hasOwnProperty.call(body, 'template')) {
    const b = body as { template: unknown; stamp?: unknown };
    return { template: b.template, stamp: b.stamp, legacy: false };
  }
  return { template: body, stamp: undefined, legacy: true };
}

export type SignGate =
  | { kind: 'sign' }
  | { kind: 'refuse'; status: 400 | 402; error: string }
  | { kind: 'check'; verifyUrl: string };

/**
 * What `/api/nostr/site-sign` does with a validated template whose event id is
 * `eventId`. `check` means: ask `verifyUrl` whether the stamp settled, then sign.
 * Only a LEGACY body with the switch OFF signs without a stamp.
 */
export function stampGate(
  stamp: unknown,
  legacy: boolean,
  eventId: string,
  o: { requireStamp: boolean; mac: Mac; nowSecs: number },
): SignGate {
  if (stamp === undefined || stamp === null) {
    return legacy && !o.requireStamp
      ? { kind: 'sign' }
      : { kind: 'refuse', status: 402, error: STAMP_REQUIRED };
  }
  const read = readStamp(stamp, o.mac, o.nowSecs);
  if (!read.ok) {
    return { kind: 'refuse', status: 400, error: read.reason === 'expired' ? STAMP_EXPIRED : STAMP_INVALID };
  }
  if (read.claims.id !== eventId) return { kind: 'refuse', status: 400, error: STAMP_OTHER_NOTE };
  return { kind: 'check', verifyUrl: read.claims.vu };
}

// ---------------------------------------------------------------------------
// The site's Lightning address: what the SERVER reads on the wire. Pure, so
// `check:sitestamp` pins it against the answers Alby gave on 2026-11-17; the
// fetching is `lib/stamp-address.ts`.
//
// ONE RULE CARRIES THE SECURITY: the callback and the verify link must be on the
// SAME ORIGIN as the configured address. The address is operator config, so a
// third party's answer can never aim a server fetch somewhere else — which is
// why those fetches need no `safeFetch`. A provider that keeps either on another
// domain is refused (the note posts one-time, and the log says why).

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/i;

export interface StampAddress {
  origin: string;
  wellKnown: string;
}

/**
 * `name@domain` (LUD-16) → where its pay request lives. `https` always, except
 * plain `http` on a loopback host, which only a test fake ever is. Null when
 * the setting is not exactly one address.
 */
export function stampAddress(raw: string): StampAddress | null {
  const m = /^([a-z0-9._+-]+)@([a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?$/i.exec(String(raw).trim());
  if (!m) return null;
  const [, name, host, port] = m;
  try {
    const scheme = LOOPBACK_HOST.test(host) ? 'http' : 'https';
    const origin = new URL(`${scheme}://${host}${port ? `:${port}` : ''}`).origin;
    return { origin, wellKnown: `${origin}/.well-known/lnurlp/${name.toLowerCase()}` };
  } catch {
    return null;
  }
}

function onOrigin(url: unknown, origin: string): url is string {
  if (typeof url !== 'string') return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

const record = (json: unknown): Record<string, unknown> | null =>
  json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : null;

export type PayRequestRead =
  | { ok: true; callback: string; commentAllowed: number }
  | { ok: false; why: string };

/** The address's LUD-06 pay request, for an amount of `msat`. */
export function readPayRequest(json: unknown, origin: string, msat: number): PayRequestRead {
  const o = record(json);
  if (!o || o.status === 'ERROR') return { ok: false, why: 'the address answered an error' };
  if (o.tag !== 'payRequest') return { ok: false, why: 'the address is not a pay request' };
  if (!onOrigin(o.callback, origin)) return { ok: false, why: "the callback is not on the address's own domain" };
  const { minSendable: min, maxSendable: max } = o;
  if (typeof min !== 'number' || typeof max !== 'number' || msat < min || msat > max) {
    return { ok: false, why: 'the address does not take this amount' };
  }
  const allowed = typeof o.commentAllowed === 'number' && o.commentAllowed > 0 ? Math.floor(o.commentAllowed) : 0;
  return { ok: true, callback: o.callback, commentAllowed: allowed };
}

/** The callback for `msat`, with `comment` only where the address takes that many characters. */
export function stampCallbackUrl(callback: string, msat: number, comment: string, commentAllowed: number): string {
  const url = new URL(callback);
  url.searchParams.set('amount', String(msat));
  if (comment && comment.length <= commentAllowed) url.searchParams.set('comment', comment);
  return url.toString();
}

export type CallbackRead = { ok: true; pr: string; verify: string } | { ok: false; why: string };

/** The callback's answer: an invoice, and the LUD-21 verify link the stamp is bound to. */
export function readCallbackAnswer(json: unknown, origin: string): CallbackRead {
  const o = record(json);
  if (!o || o.status === 'ERROR') return { ok: false, why: 'the address refused to make the invoice' };
  if (typeof o.pr !== 'string' || !/^ln/i.test(o.pr)) return { ok: false, why: 'the address sent no invoice' };
  if (o.verify === undefined || o.verify === null) return { ok: false, why: 'the address has no LUD-21 verify link' };
  if (!onOrigin(o.verify, origin)) return { ok: false, why: "the verify link is not on the address's own domain" };
  return { ok: true, pr: o.pr, verify: o.verify };
}

/**
 * The verify link's LUD-21 answer. Only a literal `settled: true` is paid and
 * only `settled: false` is unpaid; an error or any other shape is "unknown" —
 * the route says it could not confirm, rather than re-asking a link that is
 * not answering the question.
 */
export function readVerifyAnswer(json: unknown): 'settled' | 'unsettled' | 'unknown' {
  const o = record(json);
  if (!o || o.status === 'ERROR') return 'unknown';
  if (o.settled === true) return 'settled';
  if (o.settled === false) return 'unsettled';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// The client ladder.

/** The unsigned boost note. Declared here, not imported: this file imports nothing. */
export interface NoteTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export type StampFailure = 'amount' | 'not-configured' | 'no-invoice' | 'wallet' | 'unconfirmed' | 'not-signed';

/**
 * Why a note went out under a one-time key. None says the sats stayed in the
 * wallet: after a paid stamp whose signature failed, they did not.
 */
export const STAMP_FAILURE_TEXT: Record<StampFailure, string> = {
  amount: 'the note names a different amount than the boost',
  'not-configured': 'note stamps are not set up on this site',
  'no-invoice': 'the site could not make the stamp invoice',
  wallet: 'your wallet did not confirm the stamp payment',
  unconfirmed: 'the site could not confirm the stamp payment',
  'not-signed': 'the site did not sign the note',
};

/**
 * One boost's site note across RETRY NOTE. Keep the SAME object for every
 * attempt: once `stamp` is set nothing pays again, and once `signed` is set
 * nothing is asked again.
 */
export interface SiteNoteState<E> {
  template?: NoteTemplate;
  stamp?: string;
  signed?: E;
  signer?: 'site' | 'one-time';
  why?: StampFailure;
}

export type SitePath = '/api/nostr/site-stamp' | '/api/nostr/site-sign';

export interface LadderDeps<E> {
  /** POST JSON. A network error or timeout is `status: 0` — never a throw. */
  post(path: SitePath, body: unknown): Promise<{ status: number; body: unknown }>;
  /**
   * Pays the stamp invoice on the boost's rail — and refuses one that is not
   * for exactly `sats`, the price this page read from its own note. Rejects on
   * any failure.
   */
  payStamp(bolt11: string, sats: number): Promise<void>;
  /** Signs with a fresh key that is never stored. */
  signOneTime(template: NoteTemplate): E;
  sleep(ms: number): Promise<void>;
  /** Called just before the wallet is asked, with the price, so the screen can say so. */
  onStamp?(sats: number): void;
}

const field = (body: unknown, key: string): unknown =>
  body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;

/**
 * Leaves `state.signed` and `state.signer` set, always. Never throws, never
 * pays a stamp twice for one state, and signs a one-time note over the SAME
 * template the site would have signed.
 */
export async function signSiteNote<E>(
  state: SiteNoteState<E> & { template: NoteTemplate },
  deps: LadderDeps<E>,
): Promise<void> {
  if (state.signed) return;
  const { template } = state;
  const ask = async (path: SitePath, body: unknown) => {
    try {
      return await deps.post(path, body);
    } catch {
      return { status: 0, body: null };
    }
  };
  const oneTime = (why: StampFailure) => {
    state.signed = deps.signOneTime(template);
    state.signer = 'one-time';
    state.why = why;
  };

  if (!state.stamp) {
    // The route prices the note the same way and refuses what this refuses, so
    // a note it would refuse costs nobody a request, an invoice or a payment.
    const due = stampDue(template);
    if (!due.ok) return oneTime('amount');
    const minted = await ask('/api/nostr/site-stamp', { template });
    if (minted.status === 503) return oneTime('not-configured');
    const invoice = field(minted.body, 'invoice');
    const stamp = field(minted.body, 'stamp');
    if (minted.status !== 200 || typeof invoice !== 'string' || typeof stamp !== 'string') {
      return oneTime('no-invoice');
    }
    deps.onStamp?.(due.sats);
    // A marker, not a throwing timer: a timer that rejects after the wallet
    // already answered is an unhandled rejection with nobody listening.
    const TIMED_OUT = 'timed-out';
    let outcome: string;
    try {
      outcome = await Promise.race([
        deps.payStamp(invoice, due.sats).then(() => 'paid', () => 'refused'),
        deps.sleep(STAMP_PAY_TIMEOUT_MS).then(() => TIMED_OUT),
      ]);
    } catch {
      outcome = 'refused';
    }
    // A wallet that never answered may still pay. Those sats are lost, never paid
    // twice: this state is not re-stamped (boost invariant 11).
    if (outcome !== 'paid') return oneTime('wallet');
    state.stamp = stamp;
  }

  let unconfirmed = false;
  for (const delay of [0, ...STAMP_RECHECK_DELAYS_MS]) {
    if (delay) await deps.sleep(delay);
    const signed = await ask('/api/nostr/site-sign', { template, stamp: state.stamp });
    const event = field(signed.body, 'event');
    if (signed.status === 200 && event && typeof event === 'object') {
      state.signed = event as E;
      state.signer = 'site';
      state.why = undefined;
      return;
    }
    const error = field(signed.body, 'error');
    const notPaid = signed.status === 402 && error === STAMP_NOT_PAID;
    // Re-ask only "not paid": a settle trailing the payer's answer clears in a
    // second or two. "Could not confirm" is not re-asked — each ask of a hung
    // verify link costs the route's whole timeout.
    unconfirmed = notPaid || (signed.status === 502 && error === STAMP_UNCONFIRMED);
    if (!notPaid) break;
  }
  oneTime(unconfirmed ? 'unconfirmed' : 'not-signed');
}
