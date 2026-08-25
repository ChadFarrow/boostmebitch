// The arithmetic behind a kind:33369 Value Playback Summary, and the one
// predicate that decides whether to publish it.
//
// **IMPORT-FREE ON PURPOSE.** `scripts/check-value-playback-summary.mjs` loads
// THIS module under `node --experimental-strip-types`, so a reimplemented copy
// in the script cannot drift away from what ships. `scripts/import-free.mjs`
// enforces it and rejects type-only relative imports too — see its header for
// why the harmless-looking version is the dangerous one.
//
// ── What a summary is ────────────────────────────────────────────────────────
//
// A summary is **DERIVED, never accumulated**: a pure function of the author's
// own kind:3369 receipts for one NIP-73 id. That is not a style preference, it
// is what makes the kind safe to share. A 33369 is ADDRESSABLE, so there is one
// event per `(pubkey, kind, d)` — and a person signed into two apps on one key
// has two writers at that single address. An app keeping a running counter has
// built a number nobody else can reproduce, which is exactly why the other
// app's next publish destroys it. Two apps that DERIVE read the same receipts,
// compute the same total, and the second one finds nothing to say.
//
// Spec: https://github.com/ChadFarrow/PC20-Nostr (nip-value-playback-events.md)
// Reasoning: docs/value-playback.md

/** Kind for the addressable summary. The receipt kind lives in ./value-playback.ts. */
export const VALUE_PLAYBACK_SUMMARY_KIND = 33369;

/** The only two things a summary needs from one receipt. */
export interface ReceiptFacts {
  amountMsat: number;
  createdAt: number;
}

/** The derived aggregate, before it becomes tags. */
export interface DerivedSummary {
  amount: number;
  count: number;
  /** Unix seconds of the earliest receipt counted. 0 when count is 0. */
  first: number;
  /** Unix seconds of the latest receipt counted. 0 when count is 0. */
  last: number;
}

/** What a previously-published summary claims. */
export interface StoredSummary {
  amount: number;
  count: number;
}

/** Read one tag value. First match wins, mirroring how every reader here works. */
function tagValue(tags: string[][], name: string): string | undefined {
  for (const t of tags) if (t[0] === name) return t[1];
  return undefined;
}

/**
 * A non-negative integer, or null.
 *
 * Deliberately strict: `Number('')` is 0 and `Number(' 12 ')` is 12, so a
 * missing amount would sum as a real zero-sat receipt and inflate `count`
 * without moving `amount`. That is not a harmless rounding difference — `count`
 * is what a consumer compares against the receipts it can see to decide whether
 * a summary is behind, so a phantom entry makes an accurate summary look stale
 * forever.
 */
function nonNegativeInt(raw: string | undefined): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * The facts one kind:3369 contributes, or null if it contributes nothing.
 *
 * A receipt with no readable `amount` is DROPPED rather than counted as zero.
 * It is either malformed or written by a future revision whose amount lives
 * somewhere we cannot read, and in both cases guessing zero states a total this
 * app cannot support.
 */
export function receiptFacts(tags: string[][], createdAt: number): ReceiptFacts | null {
  const amountMsat = nonNegativeInt(tagValue(tags, 'amount'));
  if (amountMsat === null) return null;
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) return null;
  return { amountMsat, createdAt };
}

/**
 * Does this receipt belong under the summary addressed by `id`?
 *
 * Checked HERE rather than trusted from the relay filter. A `#i` filter is the
 * right way to ask, and it is not proof: a relay may over-answer, a
 * subscription may be shared across two ids as an efficiency, and nothing in
 * the protocol stops either. This is the same reasoning `acceptsEvent` states
 * for single-event reads, applied to a sum — where an over-answer does not
 * produce a visibly wrong event, it produces a total that is quietly too big.
 *
 * Compares the WHOLE identifier. A prefix test would let
 * `podcast:guid:abc-extra` count toward `podcast:guid:abc`.
 */
export function receiptMatchesId(tags: string[][], id: string): boolean {
  if (!id) return false;
  for (const t of tags) if (t[0] === 'i' && t[1] === id) return true;
  return false;
}

/**
 * Sum the receipts. Pure, total, and order-independent.
 *
 * Order-independence is worth stating because it is what lets two writers with
 * the same receipts agree without agreeing on anything else: relays return
 * events in no particular order, and `first`/`last` are taken by comparison
 * rather than by position for that reason.
 */
export function deriveSummary(facts: ReceiptFacts[]): DerivedSummary {
  let amount = 0;
  let first = 0;
  let last = 0;
  for (const f of facts) {
    amount += f.amountMsat;
    if (first === 0 || f.createdAt < first) first = f.createdAt;
    if (f.createdAt > last) last = f.createdAt;
  }
  return { amount, count: facts.length, first, last };
}

/**
 * What a stored summary claims, or null when it claims nothing readable.
 *
 * Null means "treat this address as empty", which by the predicate below allows
 * the first publish. That is the right direction: an unreadable stored value
 * cannot bound anything, and refusing to publish over it would let one
 * malformed event freeze an address permanently.
 */
export function parseStoredSummary(tags: string[][]): StoredSummary | null {
  const amount = nonNegativeInt(tagValue(tags, 'amount'));
  const count = nonNegativeInt(tagValue(tags, 'count'));
  if (amount === null || count === null) return null;
  return { amount, count };
}

export type SummaryPublishReason =
  | 'no-receipts'
  | 'unchanged'
  | 'would-shrink'
  | 'publish';

export interface SummaryPublishDecision {
  publish: boolean;
  reason: SummaryPublishReason;
}

/**
 * THE decision. Two rules in one expression, and both are easy to get wrong in
 * ways that look fine until a second writer exists.
 *
 * **MONOTONIC.** `amount` and `count` must never decrease at an address. A
 * writer that derives less than what is stored has an incomplete view, not a
 * smaller truth — relays lose events, a query hits a narrower relay set, a page
 * truncates, and not one of those can be told apart, at the reader, from a
 * genuine reduction. Payments are append-only in reality, so a shrinking
 * derived total can only mean receipts were missed. Picking the safe direction is also
 * what settles the pathological case: two apps with PARTIAL AND DIFFERENT views
 * would otherwise rewrite the address against each other forever, each publish
 * locally reasonable, the only symptom being that it never stops.
 *
 * Note the guard is `>=` on BOTH fields and not `!==` on either. An amount that
 * grew while the count shrank is not progress — it is a partial read that
 * happened to include a large receipt — and publishing it would lower `count`,
 * which is the field a consumer uses to tell whether a summary is behind.
 *
 * **CHANGED, BY VALUE.** Publishing an unchanged summary is pure relay churn on
 * a kind whose own spec names rate limits as the binding constraint. The
 * comparison is on these two numbers and NEVER on the event bytes, because the
 * rest of the event legitimately differs between writers: `alt` is free text
 * that two implementations will not word identically, and `first`/`last` are
 * optional so one writer emits them and another does not. Under a byte test
 * each app sees a "changed" event, rewrites it, and hands the other app the
 * same trigger — the same never-stops failure, reached from the other side.
 *
 * `no-receipts` is separate from `unchanged` because it is a different claim: a
 * derivation over zero receipts is not a total of zero, it is the absence of
 * anything to say, and creating an empty summary would put a claim on the wire
 * that nothing backs.
 */
export function summaryPublishDecision(
  derived: DerivedSummary,
  stored: StoredSummary | null,
): SummaryPublishDecision {
  if (derived.count <= 0) return { publish: false, reason: 'no-receipts' };
  if (!stored) return { publish: true, reason: 'publish' };
  if (derived.amount < stored.amount || derived.count < stored.count) {
    return { publish: false, reason: 'would-shrink' };
  }
  if (derived.amount === stored.amount && derived.count === stored.count) {
    return { publish: false, reason: 'unchanged' };
  }
  return { publish: true, reason: 'publish' };
}
