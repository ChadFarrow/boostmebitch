// Which kind:9735 is the receipt for the zap WE just paid.
//
// This is a security boundary, not a lookup. A boost note quotes the receipt it
// matches here, under the user's own signature, in an event that can never be
// edited — so accepting the wrong 9735 publishes somebody else's payment claim
// as if it were this boost, permanently. The whole point of quoting a receipt
// rather than minting one is that the claim is the PROVIDER's; a loose match
// gives that away again.
//
// NIP-57 Appendix F is the spec half. A client "MUST" check that the receipt's
// `pubkey` is the recipient's lnurl provider's `nostrPubkey` — the value the
// same provider served in its lnurlp document, which `lib/v4v/zap.ts` reads and
// now keeps rather than discarding. Signature verification is NOT done here:
// nostr-tools verifies every event a subscription delivers, so by the time a
// receipt reaches this function the pubkey test is a real authorship test.
//
// The rest is correlation, and it is where the obvious version is wrong. A
// provider publishes one receipt per zap and a busy recipient has many, all
// `p`-tagged to the same person and all signed by the same zapper key. "A
// kind:9735 that p-tags the payee" — which is `naive()` in
// scripts/check-zap-receipt.mjs — therefore matches a stranger's payment made a
// second earlier just as happily as ours. Two fields tie a receipt to one zap:
// the `description` tag, which carries the kind:9734 we signed (so its `id` is
// ours), and the `bolt11` tag, which carries the invoice we paid.
//
// EITHER correlator is enough, NEITHER may contradict. Requiring both would
// drop the quote whenever a provider re-serializes the request or omits an
// optional tag; requiring one and ignoring the other would let a receipt whose
// bolt11 is plainly a different invoice through on a description match. So a
// present-and-wrong field rejects, a present-and-right field accepts, and a
// receipt carrying neither is not correlated to anything and is refused.
//
// Import-free on purpose: scripts/check-zap-receipt.mjs loads this exact module
// under `node --experimental-strip-types`, so the vectors run against shipping
// code rather than a copy. See scripts/import-free.mjs.

/** Everything the caller already knows about the zap it sent. */
export interface ZapReceiptExpectation {
  /** `nostrPubkey` from the recipient's lnurlp document — Appendix F rule 1. */
  zapperPubkey: string;
  /** Who we paid: the `p` tag we put on the kind:9734. */
  recipientPubkey: string;
  /** `id` of the kind:9734 this app signed for this leg. */
  requestId: string;
  /** The BOLT11 the provider handed back for this leg, and we paid. */
  bolt11: string;
  /** msat this leg asked for. */
  amountMsat: number;
}

/** A kind:9735 as it arrives off a relay, before anything trusts it. */
export interface RawZapReceipt {
  kind?: unknown;
  pubkey?: unknown;
  tags?: unknown;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** First value of `name`, or undefined when the tag is absent or malformed. */
function tagValue(tags: unknown, name: string): string | undefined {
  if (!Array.isArray(tags)) return undefined;
  for (const t of tags) {
    if (!Array.isArray(t) || t[0] !== name) continue;
    const v = t[1];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * The kind:9734 id inside the receipt's `description` tag.
 *
 * Three answers, and they are not the same: a 64-hex id, `null` for a
 * description that is present but unusable, and `undefined` for no description
 * at all. Only the last is "this correlator does not apply" — a description we
 * cannot read is a contradiction, because a real receipt for our zap always
 * carries one we can.
 *
 * The JSON is attacker-shaped (it reaches us through a relay), so every field
 * is checked rather than cast.
 */
export function requestIdInDescription(tags: unknown): string | null | undefined {
  const raw = tagValue(tags, 'description');
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const req = parsed as { id?: unknown; kind?: unknown };
  if (req.kind !== 9734) return null;
  return typeof req.id === 'string' && HEX64.test(req.id) ? req.id : null;
}

/**
 * May this receipt be quoted as the receipt for that zap?
 *
 * Total: every rejection is a rule above, and nothing is left to the caller.
 */
export function zapReceiptAccepts(
  receipt: RawZapReceipt,
  expect: ZapReceiptExpectation,
): boolean {
  if (receipt.kind !== 9735) return false;
  // Appendix F rule 1. Without it every other test here is a test on data an
  // attacker wrote, because anyone may publish a kind:9735 saying anything.
  if (typeof receipt.pubkey !== 'string' || receipt.pubkey !== expect.zapperPubkey) {
    return false;
  }
  // Appendix E: the receipt MUST carry the recipient. A receipt naming someone
  // else is not ours however well the rest correlates.
  if (tagValue(receipt.tags, 'p') !== expect.recipientPubkey) return false;

  const descId = requestIdInDescription(receipt.tags);
  if (descId !== undefined && descId !== expect.requestId) return false;

  const bolt11 = tagValue(receipt.tags, 'bolt11');
  // BOLT11 is bech32 and case-insensitive; providers return both cases.
  if (bolt11 !== undefined && bolt11.toLowerCase() !== expect.bolt11.toLowerCase()) {
    return false;
  }
  // Nothing ties it to this zap. Everything above is true of every receipt this
  // provider issued to this person today.
  if (descId === undefined && bolt11 === undefined) return false;

  // Appendix F rule 2, when the receipt states an amount at all. Fountain and
  // others ship no explicit `amount` tag, which is why this is conditional
  // rather than required — see zapReceiptAmountMsat in ./zap-receipt.ts.
  const amount = tagValue(receipt.tags, 'amount');
  if (amount !== undefined && Number(amount) !== expect.amountMsat) return false;

  return true;
}

/**
 * The relay hints a quoted receipt carries: the relays that actually DELIVERED
 * it first, then the ones the zap request asked for, at most three, each once.
 *
 * WHY NOT `request.relays.slice(0, 3)`, which is what shipped. A provider is
 * asked to publish to every relay in the request's `relays` tag and publishes
 * to the ones that take it. On the first production boost the request named
 * seven, the user's own NIP-65 write relay first, and Alby's receipt landed on
 * four of them — not the first. The `q` tag's hint therefore pointed at a relay
 * holding the note and neither receipt, which is a hint that sends every reader
 * that follows it to an empty answer. The waiter sees which relay each receipt
 * arrived from; that relay is known to hold it.
 *
 * Only `wss://` strings survive, in first-seen order. Pinned by
 * `check:zapreceipt`.
 */
export function receiptRelayHints(deliveredBy: readonly unknown[], requested: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const r of [...deliveredBy, ...requested]) {
    if (typeof r !== 'string' || !r.startsWith('wss://')) continue;
    if (out.includes(r)) continue;
    out.push(r);
    if (out.length === 3) break;
  }
  return out;
}
