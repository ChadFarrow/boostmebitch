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
// The module now answers TWO questions off the same document, and keeping them
// apart is load-bearing. `lookupKeysendTarget` answers "may we PAY this
// address as a keysend recipient" and applies the two divert rules below.
// `lookupReplyTarget` answers "what is this address's node id", for the
// sender's OWN address going into a boostagram's `reply_address`, and applies
// neither — see the note on that function for why each rule is wrong there.
//
// Two deliberate exceptions run the other way, both sending an address BACK to
// LNURL after it qualified for the upgrade. LNURL_ONLY_DOMAINS is knowledge we
// hold in advance: a few providers accept keysend perfectly well but never show
// the recipient what rode in the TLV, so the upgrade's whole justification is
// void for them. `noteKeysendFailure` is knowledge we learn: a published target
// that does not actually pay.

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

// How long one failed keysend keeps an address on LNURL. Matches the hit TTL
// because it answers the same question with the same shelf life — "is this
// address's keysend target usable right now" — and because the cost of holding
// it too long is one lost inline boostagram per leg, while the cost of dropping
// it too early is the failed leg coming back.
const FAILURE_TTL_MS = 6 * 60 * 60 * 1000;

// Module-scope so a boost-all run over 20 tracks sharing an artist address
// probes it once, not twice per track.
const cache = new Map<string, { value: KeysendTarget | null; expires: number }>();

// Addresses whose keysend target has been TRIED and failed, with the time the
// demotion lapses. Separate from `cache` on purpose: `cache` answers "does this
// address publish a keysend target", which is a fact about the document, and
// this answers "did paying that target work", which is a fact about the node.
// Folding the failure back in as a cached null would erase the difference, and
// the log in `payOne` could then no longer say why a leg went to LNURL.
const failedTargets = new Map<string, number>();

function addressKey(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Remember that a keysend to `address`'s published target failed, so later legs
 * pay it over LNURL instead.
 *
 * This is the fix for a recipient whose `.well-known/keysend` is published and
 * correct while the node behind it cannot be reached — an unreachable node, a
 * node with `accept-keysend` off, or one no route reaches from this wallet.
 * Nothing in the document says so, the probe succeeds, and every boost pays a
 * failed leg to that recipient forever. A value block's fee recipients are the
 * common case, because they ride on EVERY show and every track: a boost-all
 * over 20 tracks failed the same leg 20 times.
 *
 * **It does not, and must not, rescue the leg that failed.** That leg has
 * already been attempted and may have paid — see `failureBlamesDestination` and
 * `payOne`. This only changes where the NEXT one goes, which is why it can be
 * this liberal: it costs at most the inline boostagram, never a second payment.
 *
 * Rescuing the failed leg is a separate decision with a separate, far stricter
 * predicate — `routingFailureProvesUnpaid` (`nwc-errors.ts`), which fires only
 * when the wallet reported a finished route search that found nothing. Do not
 * read this paragraph as a repo-wide ban on retrying: it is a statement about
 * what THIS function is allowed to conclude from an unexplained failure.
 *
 * Deliberately memory-only, and so lost on reload. A wrong demotion should
 * expire on its own rather than needing a user to find a setting, and the case
 * it exists for reproduces on the first leg of the next boost anyway.
 */
export function noteKeysendFailure(address: string): void {
  const key = addressKey(address);
  if (!key) return;
  failedTargets.set(key, Date.now() + FAILURE_TTL_MS);
}

/** Whether a keysend to `address` failed recently enough to still skip it. */
export function keysendRecentlyFailed(address: string): boolean {
  const until = failedTargets.get(addressKey(address));
  if (until == null) return false;
  if (until > Date.now()) return true;
  failedTargets.delete(addressKey(address));
  return false;
}

// Lightning node ids are compressed secp256k1 pubkeys: 33 bytes hex-encoded,
// always prefixed 02 or 03. Validating strictly here is load-bearing — a
// keysend attempt is retried over LNURL only when the wallet PROVES it paid
// nothing (see payOne), and a malformed pubkey does not produce that proof, so
// one that slipped through would fail the leg outright rather than falling
// back.
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
 * Fetch and parse `address`'s `.well-known/keysend` document, memoized.
 *
 * The shared core of the two questions below. It answers only "does this
 * address publish a usable keysend target", which is a fact about the
 * DOCUMENT, and deliberately holds no opinion about whether we should route
 * anything to it.
 *
 * Never throws: a missing endpoint, a timeout, a non-2xx, junk JSON and a
 * malformed pubkey all resolve to null.
 */
async function fetchKeysendDocument(address: string): Promise<KeysendTarget | null> {
  const [name, domain] = address.split('@');
  if (!name || !domain) return null;

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

/**
 * Resolve `name@domain` to a keysend target we may PAY, or null when the
 * address doesn't publish one (the common case — most LN providers are
 * LNURL-only) or when one of the two divert rules above sends it back to
 * LNURL.
 *
 * Never throws — see fetchKeysendDocument.
 */
export async function lookupKeysendTarget(address: string): Promise<KeysendTarget | null> {
  // Ahead of the cache, not just the fetch: these domains DO answer the probe,
  // so a cached hit would be a real keysend target we then have to remember to
  // ignore at every read. Refusing to look is the only version with one place
  // to get wrong.
  if (isLnurlOnlyAddress(address)) return null;

  // Same placement, and for the same reason: a demoted address still publishes
  // a perfectly valid keysend document, so a cached hit would be a real target
  // that every reader then has to remember not to use. One refusal, one place.
  if (keysendRecentlyFailed(address)) return null;

  return fetchKeysendDocument(address);
}

/**
 * Resolve the SENDER's own lightning address to the node a recipient can send
 * a reply boost to, or null when it publishes no keysend document.
 *
 * **It deliberately skips `lookupKeysendTarget`'s two divert rules, and that is
 * the whole reason this exists instead of a second call to it.** Both of those
 * rules answer "should we PAY this address as a recipient", which is a
 * different question from "what is this address's node id":
 *
 *   - `isLnurlOnlyAddress` is there because Fountain never shows the RECIPIENT
 *     the TLV that arrived, so the upgrade's justification is void when we pay
 *     them. Nothing is being paid here — we are naming a node in a field
 *     somebody else may later keysend to — so a Fountain user would lose their
 *     reply address for a reason that is not about them.
 *   - `keysendRecentlyFailed` is a demotion learned from a keysend WE sent to
 *     that address while paying it. It would drop the reply address for six
 *     hours with nothing on screen to explain it, and the failure it recorded
 *     says nothing about whether the address's owner can be replied to.
 *
 * It shares the one `cache` on purpose: that map answers a question about the
 * document, which is the same question both callers ask. `failedTargets` is
 * the map that answers a question about the node, and only the paying caller
 * reads it — the same split this file already draws where the two are declared.
 */
export async function lookupReplyTarget(address: string): Promise<KeysendTarget | null> {
  return fetchKeysendDocument(address);
}

/** The boostagram fields naming where a recipient may send a reply boost. */
export interface ReplyFields {
  reply_address?: string;
  reply_custom_key?: string;
  reply_custom_value?: string;
}

/**
 * Turn a resolved reply target into the boostagram fields that carry it.
 *
 * `reply_address` is a NODE PUBKEY, never the lightning address it was
 * resolved from. That is the shape Helipad's own documented example carries,
 * and an email-shaped string in that field cannot be keysent to at all.
 *
 * The custom pair goes on the wire together or not at all — the same rule
 * `firstCustomPair` obeys above, for the same reason: on a shared custodial
 * node that pair IS the sub-account routing, so half of it names the wrong
 * account rather than no account.
 *
 * Returns `{}` rather than fields set to undefined, so an address that
 * resolves to nothing leaves the boostagram byte-identical to one sent before
 * this existed.
 */
export function replyFieldsFor(target: KeysendTarget | null | undefined): ReplyFields {
  if (!target?.pubkey) return {};
  const pair =
    target.customKey && target.customValue
      ? { reply_custom_key: target.customKey, reply_custom_value: target.customValue }
      : {};
  return { reply_address: target.pubkey, ...pair };
}

/** Test seam — drops the memoized lookups AND the failure demotions. */
export function clearKeysendLookupCache(): void {
  cache.clear();
  failedTargets.clear();
}
