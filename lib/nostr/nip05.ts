// Lightning address → Nostr pubkey, over NIP-05, for the zap path.
//
// A NIP-57 zap request must name its recipient with a `p` tag, and the receipt
// the provider publishes copies it. So routing a boost leg as a real zap needs
// the payee's Nostr pubkey — and a value block gives us a Lightning address and
// nothing else. `<podcast:txt purpose="nostr">` is the FEED's own npub, not the
// payee's, so it cannot answer this: a value block routinely pays a producer, a
// fee recipient and Podcastindex.org alongside the show.
//
// WHY THIS PAIRING AND NOT A GUESS. `name@domain` is the same shape for lud16
// and for NIP-05, and the pieces all come from one origin: `domain` serves the
// lnurlp document that advertises `allowsNostr`/`nostrPubkey`, `domain` signs
// the kind:9735 receipt, and `domain` answers this lookup. So the claim "this
// address belongs to this pubkey" is the provider's own, about its own users,
// and the receipt we end up quoting is that same provider's statement. We
// assert nothing. If a provider pairs an address to somebody who never claimed
// it, it is already free to sign whatever receipt it likes.
//
// That is also why the fetch refuses redirects instead of following them. A
// redirect off-origin would answer this question from a host that neither signs
// the receipt nor serves the invoice, which is the entire argument gone.
//
// lib/nostr/npub-input.ts REFUSES to resolve a NIP-05, and the two are not in
// conflict: there the string is typed into a search box by a person, so
// resolving it turns a paste into a fetch at an attacker-named host. Here the
// address came out of a value block the app is already fetching an lnurlp
// document from, on its way to paying it — the request exists either way.
//
// Browser-only, like the rest of lib/v4v's LNURL reads.

import { createBoundedCache } from '@/lib/bounded-cache';
import { readCappedJson } from '@/lib/capped-body';

/** A resolved pairing is stable; re-asking on every leg of every boost is not. */
const HIT_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * A miss is cached far more briefly. Most addresses in a value block will never
 * have a NIP-05, so the miss is the common answer and must not be re-fetched per
 * leg; but a provider that has just added one should not be written off for six
 * hours. Same split, and the same reasoning, as lib/v4v/keysend-lookup.ts.
 */
const MISS_TTL_MS = 15 * 60 * 1000;

/**
 * This sits on the money path — the boost modal prefetches it, but a leg can
 * still reach it cold — and losing the lookup costs the quoted receipt, not the
 * payment. So it gives up quickly rather than holding a boost open.
 */
const TIMEOUT_MS = 2500;

/**
 * `?name=` is a request, not a guarantee: a provider may ignore it and return
 * its whole directory, and some are very large. Never `res.json()`.
 */
const MAX_BYTES = 256 * 1024;

/** Local part per NIP-05: `a-z0-9-_.`, case-insensitive here. */
const LOCAL_RE = /^[a-z0-9._-]+$/i;
/** No userinfo, no port, no path, no uppercase games — a plain hostname. */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const HEX64 = /^[0-9a-f]{64}$/;

const cache = createBoundedCache<string | null>({
  maxAgeMs: HIT_TTL_MS,
  maxEntries: 300,
});

/** `name@domain` split and validated, or null when it is not one. */
export function splitLnAddress(address: string): { name: string; domain: string } | null {
  const parts = address.trim().split('@');
  if (parts.length !== 2) return null;
  const name = parts[0];
  const domain = parts[1].toLowerCase();
  if (!LOCAL_RE.test(name) || !DOMAIN_RE.test(domain)) return null;
  return { name, domain };
}

/** The pubkey `names` claims for `name`, tolerating a lowercase-keyed map. */
function pubkeyFor(doc: unknown, name: string): string | null {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const names = (doc as { names?: unknown }).names;
  if (!names || typeof names !== 'object' || Array.isArray(names)) return null;
  const table = names as Record<string, unknown>;
  const hit = table[name] ?? table[name.toLowerCase()];
  return typeof hit === 'string' && HEX64.test(hit.toLowerCase())
    ? hit.toLowerCase()
    : null;
}

/**
 * The Nostr pubkey the address's own domain claims for it, or null.
 *
 * Never throws and never reports a guess: every failure — a malformed address, a
 * refused redirect, a timeout, an oversized document, a name the map does not
 * hold — is the same `null`, and the caller pays the leg the ordinary way.
 */
export async function resolveNip05(address: string): Promise<string | null> {
  const parsed = splitLnAddress(address);
  if (!parsed) return null;
  const key = `${parsed.name}@${parsed.domain}`;
  const now = Date.now();

  const hit = cache.get(key, now);
  // A cached miss expires on the short clock; a cached hit rides the cache's own
  // horizon. Both live under one key so a provider that starts answering
  // replaces its own miss.
  if (hit && !(hit.value === null && hit.ageMs >= MISS_TTL_MS)) return hit.value;

  let pubkey: string | null = null;
  try {
    const url =
      `https://${parsed.domain}/.well-known/nostr.json` +
      `?name=${encodeURIComponent(parsed.name)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    if (res.ok) pubkey = pubkeyFor(await readCappedJson(res, MAX_BYTES), parsed.name);
  } catch {
    // CORS refusal, DNS, timeout, oversized body, bad JSON — all the same answer.
    pubkey = null;
  }
  cache.set(key, pubkey, now);
  return pubkey;
}
