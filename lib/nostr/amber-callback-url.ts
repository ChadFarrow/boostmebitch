// ---------------------------------------------------------------------------
// The `nostrsigner:` wire format, and the fragment Amber returns a result in.
//
// Split out of lib/nostr/amber.ts and kept IMPORT-FREE so `npm run check:amber`
// can load this exact module under `node --experimental-strip-types`. A
// reimplemented copy in the check script would stay green while the shipping
// bytes drifted, which is the failure the arrangement exists to prevent — see
// scripts/import-free.mjs. Nothing here may import anything, type-only included.
//
// EVERYTHING BELOW WAS MEASURED, 2026-08-21, against Amber 6.3.0 on a Pixel 6
// (Android 17, Brave the default browser, no Chrome installed). It is not read
// off the NIP-55 text, because the NIP-55 text does not say most of it.
//
// ## Why there is a callbackUrl at all
//
// With NO callbackUrl, NIP-55 says only that the signer "will copy the result
// to the clipboard" — returning to the page is the USER's job. On this phone
// that never happens: Brave dispatches the intent with LAUNCH_SINGLE_TASK, so
// Amber opens in its own task, and approving finishes that task and drops the
// user on the LAUNCHER. The tab never sees `visibilitychange`, the promise
// never resolves, the caller retries, and the prompt comes straight back. With
// a callbackUrl, Amber fires an ACTION_VIEW back at the browser every time.
//
// ## Why the callback URL may contain NO `?` and NO `&`
//
// Amber URL-decodes the WHOLE `nostrsigner:` URI and only then splits it — on
// `?` first, then on `&` — to recover the payload and the parameters. So a
// callback URL carrying either character is silently truncated there:
//
//     sent      …/amber-callback?rid=SPIKE123#result=
//     Amber →   …/amber-callback<result>          ← the terminator was eaten
//
// This is why commit 9a9330f ("Terminate Amber callbackUrl with &event= per
// NIP-55 spec") could not have worked either: `&` is eaten the same way. The
// first attempt at this feature failed for two reasons and only one was ever
// written down. `assertCallbackUrlSafe` is that mistake, in shipping code.
//
// ## Why the terminator is a FRAGMENT
//
// A fragment survives Amber's parser byte-for-byte, and it is the only
// terminator that does — `#` is not a delimiter anywhere in that parser:
//
//     sent      …/amber-callback#r=<32 hex>;event=
//     Amber →   …/amber-callback#r=<32 hex>;event=<percent-encoded result>
//     page read location.hash === the whole thing
//     server saw GET /amber-callback     ← no query, no fragment
//
// So correctness and privacy point the same way, which is rare and worth
// saying out loud. The privacy half is not decorative: a `nip04_decrypt`
// result is the user's PLAINTEXT, and `Referrer-Policy:
// strict-origin-when-cross-origin` (next.config.mjs) sends the full URL as
// `Referer` on same-origin requests — so a query-borne result would reach our
// own server once in the request line and again on every subresource, besides
// sitting in Vercel's access log and the address bar.
//
// ## Why `;` is a safe separator
//
// Amber appends the result through Android's `Uri.encode`, which escapes
// everything outside `A-Za-z0-9_-!.~'()*`. `;`, `#`, `?`, `&`, `%` and every
// multi-byte character come back percent-encoded, so an appended result can
// neither terminate the fragment nor forge a second separator. Verified on the
// wire: a signed event arrived as `%7B%22id%22%3A…`.
//
// ## What this does NOT fix
//
// A literal `?` ANYWHERE in the event JSON breaks `sign_event` outright, today,
// on the clipboard path this file does not touch — same split-on-`?` cause.
// Measured: `"does this work. yes"` signs; `"does this work? yes"` returns
// "Invalid request. Amber received a malformed nostrsigner request." `&` is
// fine (`"Mutton & Mead — track 3"` round-tripped intact, em-dash included).
// It needs an upstream Amber fix; NIP-55's URL scheme gives us no way to keep
// the payload out of the URI. It surfaces as "Amber didn't come back", which is
// indistinguishable from the bug this file DOES fix — so do not read a report
// of that symptom as evidence about this code.
// ---------------------------------------------------------------------------

/** The six NIP-55 methods this app asks for. */
export type AmberRequestType =
  | 'get_public_key'
  | 'sign_event'
  | 'nip04_encrypt'
  | 'nip04_decrypt'
  | 'nip44_encrypt'
  | 'nip44_decrypt';

export interface AmberUrlOptions {
  type: AmberRequestType;
  /** event JSON, plaintext, or ciphertext — encoded after `nostrsigner:`. */
  payload?: string;
  /** Peer pubkey for nip04/nip44 operations. */
  pubkey?: string;
  /** Amber's returnType param. `event` returns the signed event JSON for
   *  sign_event; `signature` returns just the bare signature. We always use
   *  `event` for sign_event so the caller gets a complete `Event`. */
  returnType?: 'signature' | 'event';
}

/** The in-scope route Amber navigates back to. `scope: "/"` in
 *  android/twa-manifest.json already covers it, so the TWA needs no change. */
export const AMBER_CALLBACK_PATH = '/amber-callback';

/** Separates the request id from the result inside the fragment. Safe because
 *  Amber's `Uri.encode` escapes `;` in whatever it appends. */
export const AMBER_RESULT_SEPARATOR = ';event=';

/** Request ids are exactly this many lowercase hex characters. */
const RID_HEX_LENGTH = 32;

const RID_RE = /^[0-9a-f]{32}$/;

/**
 * 128 bits of randomness as lowercase hex, used to bind a callback to the
 * request that asked for it.
 *
 * It never leaves the client: it is written to sessionStorage, transmitted
 * only in a fragment, and compared only in the browser. That is what makes a
 * forged navigation to /amber-callback inert — anyone can open the route, but
 * without the id no pending record matches.
 *
 * `crypto` is a global in browsers and in Node >= 19, so this needs no import
 * and the module stays loadable by the check script.
 */
export function newAmberRequestId(): string {
  const bytes = new Uint8Array(RID_HEX_LENGTH / 2);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * Throw if a callback URL is one Amber will damage.
 *
 * This is the regression that killed the first attempt at this feature, twice —
 * once with no terminator at all and once with `&event=`. It is an assertion
 * rather than a comment because both mistakes look correct in review: the
 * second one is literally the example in the NIP-55 text.
 */
export function assertCallbackUrlSafe(url: string): void {
  if (url.includes('?')) {
    throw new Error(
      `Amber callback URL must not contain "?" — Amber splits the decoded URI on it and would truncate the URL there: ${url}`,
    );
  }
  if (url.includes('&')) {
    throw new Error(
      `Amber callback URL must not contain "&" — Amber splits the decoded URI on it and would truncate the URL there: ${url}`,
    );
  }
  if (!url.endsWith(AMBER_RESULT_SEPARATOR)) {
    throw new Error(
      `Amber callback URL must end with "${AMBER_RESULT_SEPARATOR}" — Amber appends the result verbatim, with no param name of its own: ${url}`,
    );
  }
}

/**
 * `<origin>/amber-callback#r=<rid>;event=` — the URL Amber appends its result
 * to. `origin` is `window.location.origin` at the call site; it is a parameter
 * so this module needs no browser global and stays testable.
 */
export function buildAmberCallbackUrl(origin: string, rid: string): string {
  if (!RID_RE.test(rid)) {
    throw new Error(`Amber request id must be ${RID_HEX_LENGTH} lowercase hex characters: ${rid}`);
  }
  const url = `${origin}${AMBER_CALLBACK_PATH}#r=${rid}${AMBER_RESULT_SEPARATOR}`;
  assertCallbackUrlSafe(url);
  return url;
}

/**
 * The `nostrsigner:` URI. Byte layout matches the NIP-55 example: params
 * written raw, payload URI-encoded after the colon.
 *
 * `callbackUrl` is optional and goes LAST, matching the spec example. Amber
 * splits parameters on `&` so position carries no meaning, but a reader
 * comparing this against the NIP should not have to reconcile the order.
 * Omitting it selects Amber's clipboard return, which is still the right
 * choice for any request whose caller cannot survive a page reload.
 */
export function buildSignerUrl(opts: AmberUrlOptions, callbackUrl?: string): string {
  let url = `nostrsigner:${encodeURIComponent(opts.payload ?? '')}`;
  url += `?compressionType=none`;
  url += `&returnType=${opts.returnType ?? 'signature'}`;
  url += `&type=${opts.type}`;
  if (opts.pubkey) url += `&pubkey=${opts.pubkey}`;
  if (callbackUrl) {
    assertCallbackUrlSafe(callbackUrl);
    url += `&callbackUrl=${encodeURIComponent(callbackUrl)}`;
  }
  return url;
}

export interface AmberCallback {
  /** The request id the fragment claims to answer. Still has to match a
   *  pending record — this function only proves the shape. */
  rid: string;
  /** The decoded result: a hex pubkey, a signed event JSON, or a
   *  ciphertext/plaintext. NOT validated here; the caller shape-checks with
   *  `looksLikeAmberResult` and `AmberSigner.signEvent` still runs
   *  `verifyEvent` plus the signed-in-key comparison. */
  raw: string;
}

/**
 * Read `#r=<rid>;event=<result>` back out of `window.location.hash`.
 *
 * Returns null on anything malformed rather than throwing, because the input
 * is an attacker-reachable URL: any app or page can navigate to
 * /amber-callback. Null means "this is not a callback for us" and the page
 * says so on screen.
 */
export function parseAmberCallback(hash: string): AmberCallback | null {
  if (!hash.startsWith('#r=')) return null;
  const body = hash.slice(3);
  const sep = body.indexOf(AMBER_RESULT_SEPARATOR);
  if (sep < 0) return null;
  const rid = body.slice(0, sep);
  if (!RID_RE.test(rid)) return null;
  const encoded = body.slice(sep + AMBER_RESULT_SEPARATOR.length);
  if (!encoded) return null;
  let raw: string;
  try {
    // Amber appends through Android's `Uri.encode`, so this is always
    // percent-encoded — including every multi-byte character. A malformed
    // sequence throws, which for our purposes is just "not a callback".
    raw = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed ? { rid, raw: trimmed } : null;
}

/**
 * Best-effort shape check on a returned value, so an unrelated string can't
 * resolve a request. Different types have different shapes:
 *   - get_public_key: 64-hex-char or starts with `npub1`
 *   - sign_event: JSON object with a `sig` field
 *   - nip04/nip44: opaque ciphertext/plaintext — can't validate, accept anything
 *
 * It was written for the clipboard path, where the risk is whatever the user
 * happened to copy. It now also gates a callback result, where the risk is a
 * forged navigation — so it guards two things and is pinned for both.
 */
export function looksLikeAmberResult(text: string, type: AmberRequestType): boolean {
  const t = text.trim();
  if (!t) return false;
  if (type === 'get_public_key') {
    return /^[0-9a-f]{64}$/i.test(t) || t.startsWith('npub1');
  }
  if (type === 'sign_event') {
    if (!t.startsWith('{')) return false;
    try {
      const parsed = JSON.parse(t);
      return typeof parsed === 'object' && parsed && typeof parsed.sig === 'string';
    } catch {
      return false;
    }
  }
  // nip04/nip44 — no reliable shape check. Trust the caller.
  return true;
}
