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

export interface KeysendTarget {
  pubkey: string;
  customKey?: string;
  customValue?: string;
}

const LOOKUP_TIMEOUT_MS = 5000;
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

  const key = address.toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  let value: KeysendTarget | null = null;
  try {
    const res = await fetch(
      `https://${domain}/.well-known/keysend/${encodeURIComponent(name)}`,
      { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) },
    );
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
