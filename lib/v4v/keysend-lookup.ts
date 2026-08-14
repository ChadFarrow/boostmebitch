// Lightning Address → keysend upgrade.
//
// Some LN providers publish `/.well-known/keysend/<name>` alongside the usual
// `/.well-known/lnurlp/<name>`, exposing the node pubkey plus the custom TLV
// record that routes a keysend to that specific account. When an address
// serves it we can pay a `type="lnaddress"` recipient as a real keysend and
// carry the boostagram inline in TLV 7629169 — instead of degrading it to an
// LNURL LUD-21 comment, which loses `sender_id`, the remote-feed correlation
// ids, and the recipient's own customKey/customValue routing.
//
// Everything here is best-effort: any failure returns null and the caller
// falls back to the LNURL path that has always worked.
//
// One deliberate exception runs the other way — see LNURL_ONLY_DOMAINS. A few
// providers accept keysend perfectly well but never show the recipient what
// rode in the TLV, so the upgrade's whole justification is void for them.

export interface KeysendTarget {
  pubkey: string;
  customKey?: string;
  customValue?: string;
}

// Kept tight because this runs *inside* a boost the user is waiting on, and
// it's an optimization with a working fallback — losing the upgrade on a slow
// network is much cheaper than stalling the payment. Slightly above the
// proxy's own 3.5s upstream budget so the route can answer "no endpoint"
// rather than having the caller abort first.
const LOOKUP_TIMEOUT_MS = 4500;
const HIT_TTL_MS = 6 * 60 * 60 * 1000;
const MISS_TTL_MS = 15 * 60 * 1000;

// Module-scope so a boost-all run over 20 tracks sharing an artist address
// probes it once, not twice per track.
const cache = new Map<string, { value: KeysendTarget | null; expires: number }>();

// Lightning node ids are compressed secp256k1 pubkeys: 33 bytes hex-encoded,
// always prefixed 02 or 03. Validating strictly here is load-bearing — we
// never retry LNURL after a keysend attempt (see payOne), so a malformed
// pubkey that slipped through would fail the leg outright rather than
// falling back.
const NODE_PUBKEY = /^0[23][0-9a-f]{64}$/i;

/**
 * Providers we deliberately pay over LNURL even though they publish a
 * `.well-known/keysend` document.
 *
 * Fountain is the reason this list exists, and the reason is NOT that it lacks
 * keysend. It has keysend, it publishes the well-known, the payment arrives and
 * the sats land — **it just doesn't surface the TLV boostagram to the person
 * who received it.** So the upgrade fired on every `@fountain.fm` leg, did
 * exactly what it was designed to do, and dropped the metadata anyway. Its
 * whole justification — "carry the boostagram inline instead of degrading it to
 * a comment" — is void against a recipient that never reads the inline copy.
 * The LUD-21 comment is the only channel Fountain actually shows.
 *
 * Do not "correct" this by checking whether the domain serves the well-known:
 * it does, and that is the trap. Nothing observable from our side distinguishes
 * a provider that renders the TLV from one that discards it — the payment
 * succeeds identically either way, which is why this went unnoticed for as long
 * as it did. Membership here is knowledge about the provider, not a probe.
 *
 * Strictly non-regressive, the same rule the upgrade itself is held to: LNURL
 * works on every rail and keysend does not, so moving a leg BACK to LNURL can
 * only make it more likely to pay. Spark users gain outright — that rail is
 * BOLT11-only, so `payKeysend` threw for these recipients before.
 *
 * Adding a domain here is the whole change; nothing else needs to know.
 */
const LNURL_ONLY_DOMAINS = ['fountain.fm'];

/**
 * Whether `address`'s domain is one we always pay over LNURL.
 *
 * Matches the domain exactly or as a parent of it (`x@wallet.fountain.fm`), and
 * deliberately NOT as a bare suffix: `endsWith('fountain.fm')` would also match
 * `notfountain.fm`, handing any third party the ability to opt other people's
 * recipients out of keysend by registering a hostname. The value block is
 * attacker-authored text, so the domain is lowercased and a trailing root dot
 * stripped first — `USER@Fountain.FM.` is the same host to DNS, and
 * `app/api/keysend/route.ts` already lowercases on its side.
 */
export function isLnurlOnlyAddress(address: string): boolean {
  const domain = address.split('@')[1]?.trim().toLowerCase().replace(/\.$/, '');
  if (!domain) return false;
  return LNURL_ONLY_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * Pull the routing pair out of a keysend response. The documented shape is
 * `customData: [{ customKey, customValue }]`; some providers put the pair at
 * the top level instead, so both are accepted.
 *
 * Key and value are only ever taken together from the same object — pairing a
 * key from one source with a value from another would misroute the payment to
 * the wrong sub-account on a shared node.
 */
function firstCustomPair(data: any): { customKey?: string; customValue?: string } {
  const entries: any[] = Array.isArray(data?.customData) ? data.customData : [];
  for (const entry of [...entries, data]) {
    const k = entry?.customKey;
    const v = entry?.customValue;
    if (k == null || v == null) continue;
    const customKey = String(k).trim();
    const customValue = String(v).trim();
    // The key is a TLV record number; a non-numeric one can't go on the wire.
    if (!customKey || !customValue || !/^\d+$/.test(customKey)) continue;
    return { customKey, customValue };
  }
  return {};
}

export function parseKeysendResponse(data: any): KeysendTarget | null {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.status === 'string' && data.status.toUpperCase() === 'ERROR') return null;
  // `pubkey` is the documented field; `destination` and `nodeId` appear in the
  // wild. We deliberately don't require `tag: "keysend"` — the strict pubkey
  // check below is the real gate, and custom self-hosted endpoints are looser
  // about the envelope than Alby's.
  const raw = data.pubkey ?? data.destination ?? data.nodeId;
  const pubkey = typeof raw === 'string' ? raw.trim() : '';
  if (!NODE_PUBKEY.test(pubkey)) return null;
  return { pubkey: pubkey.toLowerCase(), ...firstCustomPair(data) };
}

/**
 * Resolve `name@domain` to a keysend target, or null when the address doesn't
 * publish one (the common case — most LN providers are LNURL-only).
 *
 * Never throws: a missing endpoint, a timeout, a non-2xx, junk JSON and a
 * malformed pubkey all resolve to null so the boost leg stays on LNURL.
 */
export async function lookupKeysendTarget(address: string): Promise<KeysendTarget | null> {
  const [name, domain] = address.split('@');
  if (!name || !domain) return null;

  // Ahead of the cache, not just the fetch: these domains DO answer the probe,
  // so a cached hit would be a real keysend target we then have to remember to
  // ignore at every read. Refusing to look is the only version with one place
  // to get wrong.
  if (isLnurlOnlyAddress(address)) return null;

  const key = address.toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  let value: KeysendTarget | null = null;
  try {
    // Through our own origin, never the provider directly: the keysend
    // well-known carries no CORS headers, so a direct fetch is blocked and
    // every address would silently look LNURL-only. See app/api/keysend.
    const res = await fetch(`/api/keysend?addr=${encodeURIComponent(address)}`, {
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (res.ok) value = parseKeysendResponse(await res.json());
  } catch {
    value = null;
  }
  // Cache misses too, on a shorter TTL — an LNURL-only address shouldn't cost
  // a failed round trip on every leg of every boost.
  cache.set(key, { value, expires: Date.now() + (value ? HIT_TTL_MS : MISS_TTL_MS) });
  return value;
}

/** Test seam — drops the memoized lookups. */
export function clearKeysendLookupCache(): void {
  cache.clear();
}
