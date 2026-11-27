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

// ── The receipt walk ────────────────────────────────────────────────────────

/**
 * One page of ONE relay's answer, as the walk needs it. `reached: false` is a
 * relay that never connected: it is left out of the verdict, as every
 * per-relay read here leaves it out (`readIsTrustworthy`). `answered: false` is
 * a relay that connected and did not finish answering — that one makes the
 * whole walk incomplete.
 */
export interface ReceiptPage<E extends { id: string; created_at: number }> {
  reached: boolean;
  answered: boolean;
  events: E[];
}

/** Ask one relay for the page at or before `until` (undefined: the newest). */
export type ReceiptPageFetch<E extends { id: string; created_at: number }> =
  (until: number | undefined) => Promise<ReceiptPage<E>>;

export interface ReceiptWalk<E> {
  events: E[];
  /** Every relay that connected walked to the END of its history. */
  complete: boolean;
  reached: number;
  /** Pages asked for, across every relay. */
  pages: number;
}

/**
 * Every receipt the relays hold, walked backwards PAGE BY PAGE AND RELAY BY
 * RELAY, and whether the walk can prove it saw the whole history.
 *
 * Two rules, and each was a way the summary stayed low (full-code review,
 * 2026-11-19, finding 17):
 *
 * - **A cursor per relay, never one for the union.** One `until` taken from the
 *   oldest event of ANY relay jumps past what a denser relay still holds: relay
 *   A answers its newest 500, relay B (which missed the recent ones) answers
 *   500 reaching months further back, and the next page starts below every
 *   receipt A holds between the two — never asked for, never counted.
 * - **A short page is not the end.** A relay caps a REQ at a number of its own
 *   choosing and says nothing, so 200 events against a `limit` of 500 is either
 *   the whole history or a relay whose cap is 200. The end is a page that adds
 *   NOTHING new: `until` is inclusive, so the walk re-asks for the boundary
 *   second and stops when that answer holds only receipts it has already seen.
 *   That costs one extra page per relay, which is the price of not guessing.
 *
 * And it FAILS CLOSED, because a sum over a partial set published once pins the
 * monotonic address below the truth. Each of these makes the walk incomplete:
 *
 * - a relay that hits `maxPages`;
 * - a relay that answers events NEWER than the `until` it was given (it ignores
 *   the cursor, so its "end" proves nothing);
 * - a relay that connects and stops answering;
 * - a relay that answered a page and is gone on a later one — only a relay that
 *   was never reached at all is left out, since what it holds was never part
 *   of this walk, while a relay lost mid-walk leaves its history half read;
 * - a page that adds receipts but cannot move the cursor, because every event
 *   on it sits in the cursor's second, and that is at least as large as any
 *   page this relay has returned. NIP-01 has no cursor finer than a second, so
 *   a relay whose cap is at or below the receipts it holds in one second
 *   cannot be paged past that second, and the next page would repeat this one
 *   and read as the end.
 *
 * One shape it cannot see: a relay whose FIRST page already lies wholly in one
 * second and is exactly its cap. That page and a relay holding exactly that
 * many receipts in that second are the same bytes, and refusing the second
 * would refuse every one-receipt history. A receipt is one settle of one
 * device, so a cap's worth of them in one second is not a history this app
 * writes.
 *
 * Not publishing is the safe side. `maxPages` is PER RELAY at that relay's own
 * cap, so a relay capping at 100 is walked for 100 × `maxPages` receipts.
 *
 * Relays are walked in parallel; each relay's pages are serial.
 */
export async function walkReceiptHistory<E extends { id: string; created_at: number }>(
  relays: ReceiptPageFetch<E>[],
  maxPages: number,
  stopped: () => boolean = () => false,
): Promise<ReceiptWalk<E>> {
  const walks = await Promise.all(relays.map(async (fetchPage) => {
    const seen = new Map<string, E>();
    let until: number | undefined;
    let pages = 0;
    let biggest = 0;
    while (pages < maxPages) {
      if (stopped()) return { reached: true, complete: false, seen, pages };
      const page = await fetchPage(until);
      pages++;
      if (!page.reached) {
        // Never reached: left out. Reached once and lost: half read.
        return pages === 1
          ? { reached: false, complete: true, seen, pages }
          : { reached: true, complete: false, seen, pages };
      }
      if (!page.answered) return { reached: true, complete: false, seen, pages };
      const cursor = until;
      if (cursor !== undefined && page.events.some((e) => e.created_at > cursor)) {
        return { reached: true, complete: false, seen, pages };
      }
      let added = 0;
      let oldest = Infinity;
      for (const e of page.events) {
        if (e.created_at < oldest) oldest = e.created_at;
        if (seen.has(e.id)) continue;
        seen.set(e.id, e);
        added++;
      }
      if (added === 0) return { reached: true, complete: true, seen, pages };
      const full = page.events.length >= biggest;
      biggest = Math.max(biggest, page.events.length);
      if (cursor !== undefined && oldest === cursor && full) {
        return { reached: true, complete: false, seen, pages };
      }
      until = oldest;
    }
    return { reached: true, complete: false, seen, pages };
  }));
  const byId = new Map<string, E>();
  for (const w of walks) for (const [id, e] of w.seen) if (!byId.has(id)) byId.set(id, e);
  const reached = walks.filter((w) => w.reached).length;
  return {
    events: [...byId.values()],
    complete: reached > 0 && walks.every((w) => !w.reached || w.complete),
    reached,
    pages: walks.reduce((n, w) => n + w.pages, 0),
  };
}

// ── One cycle per address ───────────────────────────────────────────────────

/**
 * Holds an address (one NIP-73 id) from the moment its read-decide-publish
 * cycle STARTS until that cycle SETTLES — not until the caller stops waiting.
 *
 * The flush caps each cycle with a timeout so one hung relay or signer cannot
 * stall the batch. Before 2026-11-26 the timeout released the address too, so
 * the next flush started a second cycle for it while the first was still
 * running: two cycles reading the same stored summary, both deciding
 * 'publish', two signatures and two events at one address — the churn the
 * CHANGED-BY-VALUE rule exists to prevent (full-code review, 2026-11-19).
 *
 * `start` returns `busy` with the running cycle's promise when the address is
 * held, so the caller can queue the id again once THAT cycle ends.
 */
export function createAddressGate() {
  const running = new Map<string, Promise<void>>();
  return {
    start(id: string, cycle: () => Promise<void>):
      { started: true; done: Promise<void> } | { started: false; busy: Promise<void> } {
      const busy = running.get(id);
      if (busy) return { started: false, busy };
      // Async-wrapped so a cycle that throws before its first await is held
      // and released like any other.
      const done = (async () => cycle())().catch(() => {}).finally(() => {
        if (running.get(id) === done) running.delete(id);
      });
      running.set(id, done);
      return { started: true, done };
    },
    held(id: string): boolean {
      return running.has(id);
    },
  };
}
