// THE NOTE STAMP — every decision behind "the site signs a boost note only when
// someone paid for it", with every effect injected. IMPORT-FREE ON PURPOSE:
// `check:sitestamp` loads this file under plain Node and pins all of it, and
// `scripts/import-free.mjs` rejects any import (type-only included).
//
// WHY A STAMP. `/api/nostr/site-sign` signs under the site's NIP-05-verified
// name and is unauthenticated, so without proof of payment anyone with `curl`
// posts their own text as the site. A boost's own legs cannot prove anything to
// the site — a keysend preimage is made by the SENDER — so the proof is a payment
// to the site itself: a 1-sat invoice minted by the site's LNbits wallet, for
// exactly ONE event id. Asking twice for that id yields the same event (relays
// dedupe it), so a paid stamp cannot be replayed into many notes, while RETRY
// NOTE may ask as often as it needs. No server state.
//
// THE OTHER HALF IS THE LADDER (`signSiteNote`). It runs in the browser after
// the boost: ask for the stamp, pay it, ask for the signature. ANY failure signs
// the SAME template with a one-time key, so no real boost ever loses its note.
// It never throws and never pays twice. Reasoning: docs/money-boosts.md and
// docs/security.md, "the site-sign stamp".

/** The stamp's price. A change is a money change: the client refuses any other amount. */
export const STAMP_SATS = 1;
/** Spark's routing-fee cap for a stamp (Chad, 2026-11-17). NWC and WebLN set their own. */
export const STAMP_MAX_FEE_SATS = 10;
/** How long the stamp invoice can be paid. */
export const STAMP_INVOICE_EXPIRY_SECS = 600;
/** How long a token is honoured — a paid stamp's note may be re-signed until then. */
export const STAMP_TTL_SECS = 86_400;
/** How long the ladder waits for the wallet before it posts from a one-time key. */
export const STAMP_PAY_TIMEOUT_MS = 30_000;
/** Re-asks after a "not paid" answer: settlement can trail the payer's answer. */
export const STAMP_RECHECK_DELAYS_MS = [1500, 3000];
/** The route's 402 after LNbits says unpaid. The ladder re-asks on exactly this. */
export const STAMP_NOT_PAID = 'the note stamp is not paid';

const STAMP_REQUIRED = 'a note stamp is required';
const STAMP_INVALID = 'the note stamp is not valid';
const STAMP_EXPIRED = 'the note stamp has expired';
const STAMP_OTHER_NOTE = 'the note stamp is for a different note';

export interface StampClaims {
  v: 1;
  /** The NIP-01 id of the event the site key will sign. */
  id: string;
  /** The stamp invoice's payment hash. */
  ph: string;
  /** Unix seconds after which the token is refused. */
  exp: number;
}

/** base64url HMAC of `data` under the deploy's stamp key. Injected: this file imports nothing. */
export type Mac = (data: string) => string;

const HEX64 = /^[0-9a-f]{64}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LEN = 1024;

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
  const payload = toBase64Url(JSON.stringify({ v: claims.v, id: claims.id, ph: claims.ph, exp: claims.exp }));
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
  const { v, id, ph, exp } = c as Record<string, unknown>;
  if (v !== 1 || typeof id !== 'string' || !HEX64.test(id) || typeof ph !== 'string' || !HEX64.test(ph)
    || typeof exp !== 'number' || !Number.isInteger(exp)) {
    return { ok: false, reason: 'malformed' };
  }
  if (nowSecs >= exp) return { ok: false, reason: 'expired' };
  return { ok: true, claims: { v: 1, id, ph, exp } };
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
  | { kind: 'check'; paymentHash: string };

/**
 * What `/api/nostr/site-sign` does with a validated template whose event id is
 * `eventId`. `check` means: ask LNbits whether `paymentHash` is paid, then sign.
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
  return { kind: 'check', paymentHash: read.claims.ph };
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

export type StampFailure = 'not-configured' | 'no-invoice' | 'wallet' | 'unconfirmed' | 'not-signed';

/**
 * Why a note went out under a one-time key. None says the sat stayed in the
 * wallet: after a paid stamp whose signature failed, it did not.
 */
export const STAMP_FAILURE_TEXT: Record<StampFailure, string> = {
  'not-configured': 'note stamps are not set up on this site',
  'no-invoice': 'the site could not make the stamp invoice',
  wallet: 'your wallet did not confirm the 1-sat stamp',
  unconfirmed: 'the site could not confirm the 1-sat stamp',
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
  /** Pays the stamp invoice on the boost's rail. Rejects on any failure. */
  payStamp(bolt11: string): Promise<void>;
  /** Signs with a fresh key that is never stored. */
  signOneTime(template: NoteTemplate): E;
  sleep(ms: number): Promise<void>;
  /** Called just before the wallet is asked, so the screen can say so. */
  onStamp?(): void;
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
    const minted = await ask('/api/nostr/site-stamp', { template });
    if (minted.status === 503) return oneTime('not-configured');
    const invoice = field(minted.body, 'invoice');
    const stamp = field(minted.body, 'stamp');
    if (minted.status !== 200 || typeof invoice !== 'string' || typeof stamp !== 'string') {
      return oneTime('no-invoice');
    }
    deps.onStamp?.();
    // A marker, not a throwing timer: a timer that rejects after the wallet
    // already answered is an unhandled rejection with nobody listening.
    const TIMED_OUT = 'timed-out';
    let outcome: string;
    try {
      outcome = await Promise.race([
        deps.payStamp(invoice).then(() => 'paid', () => 'refused'),
        deps.sleep(STAMP_PAY_TIMEOUT_MS).then(() => TIMED_OUT),
      ]);
    } catch {
      outcome = 'refused';
    }
    // A wallet that never answered may still pay. That sat is lost, never paid
    // twice: this state is not re-stamped (boost invariant 11).
    if (outcome !== 'paid') return oneTime('wallet');
    state.stamp = stamp;
  }

  let notPaid = false;
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
    notPaid = signed.status === 402 && field(signed.body, 'error') === STAMP_NOT_PAID;
    if (!notPaid) break;
  }
  oneTime(notPaid ? 'unconfirmed' : 'not-signed');
}
