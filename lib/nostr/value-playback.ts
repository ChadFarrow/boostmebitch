'use client';

// NIP-XX Value Playback Receipts — kind:3369.
//
// A receipt for sats that moved during ONE interval of playback, published so
// the payment is visible to something other than the receiving Lightning node.
// Today the only artifact a streaming settle produces is TLV record `7629169`
// riding on the payment itself, which nothing but the recipient can read.
//
// **This is deliberately not a kind:1, and that is the whole reason the feature
// is allowed to exist at all.** `lib/v4v/streaming.ts` publishes nothing to
// Nostr, on purpose: a note per ten-minute settle would bury the user's own feed
// under machine output. A 3369 is queryable by any client and rendered by none,
// so the prohibition on kind:1 stands unchanged and this sits beside it. Do not
// "improve" this into a note.
//
// Scope is UNATTENDED payments — `stream` and `auto`. A boost the user pressed
// already has a first-class social artifact (the kind:1 in ./boost-notes.ts, or
// a NIP-57 zap receipt on a live stream) and does not need a second one.
//
// The wire format is an external spec shared with other Podcasting 2.0 apps and
// is NOT ours to change here — see docs/value-playback.md.

import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { storage } from '../storage';
import { BRAND } from '../brand';
import { DEFAULT_RELAYS } from './relays';
import { signAndPublish } from './publish';
import { canSignUnattended, activeNostr } from './signer';
import { collectEventsDetailed, fetchLatestEventDetailed } from './event-queries';
import {
  VALUE_PLAYBACK_SUMMARY_KIND,
  deriveSummary,
  parseStoredSummary,
  receiptFacts,
  receiptMatchesId,
  summaryPublishDecision,
  walkReceiptHistory,
  createAddressGate,
  type ReceiptFacts,
} from './value-playback-summary';

/** Kind for one interval's receipt. The sibling kinds in the spec — 23369
 *  (ephemeral ticker) and 33369 (addressable summary) — are not emitted yet. */
export const VALUE_PLAYBACK_RECEIPT_KIND = 3369;

/**
 * How long the whole sign-and-publish may take before we give up.
 *
 * A signer that goes away does NOT reject, it hangs — the reason
 * `withDecryptTimeout` exists one module over, and it applies just as much to
 * `signEvent`. This runs on a timer during playback, so an un-capped hang is a
 * promise that never settles for the rest of the session, with nothing in the
 * console. The number is generous: nothing waits on this.
 */
const RECEIPT_PUBLISH_TIMEOUT_MS = 15_000;

export interface ValuePlaybackReceiptArgs {
  /** Feed guid the payment was for — `podcast:guid:<feedGuid>`. */
  feedGuid?: string;
  /** Item guid the payment was for — `podcast:item:guid:<itemGuid>`. */
  itemGuid?: string;
  /**
   * Millisats that actually SETTLED, never what was owed.
   *
   * The distinction is the one open question in the draft and it has a real
   * answer. A kind:1 boost note carries INTENT — `value_msat_total`, so
   * "boosted 100 sats" survives one failed leg (see invariant 7 in CLAUDE.md).
   * A receipt asserts that money moved. Publishing the intended figure here
   * produces a public record that overstates payment, and nothing downstream
   * can tell it apart from a true one.
   */
  msat: number;
  /** Mirrors the boostagram's `action`. */
  action: 'stream' | 'auto';
  /** Unix seconds, wall clock, start of the interval this covers. */
  startSec: number;
  /** Unix seconds, wall clock, end of the interval. */
  endSec: number;
  /** Playback position in seconds — the boostagram's `ts`. */
  positionSec?: number;
  /** Groups consecutive intervals of one listen. */
  session?: string;
  /** Human-readable label for the `alt` tag, e.g. the track or episode title. */
  label?: string;
  appName?: string;
  relays?: string[];
}

/**
 * The unsigned kind:3369 template.
 *
 * Split out from the publisher so it is pure and inspectable — the same
 * arrangement `buildBoostNoteTemplate` uses, and for the same reason: the tag
 * array is the contract, and a builder that also does IO is one nobody reads.
 *
 * **The `i`/`k` pairs must be the SAME identifiers the boostagram carried.** In
 * `lib/v4v/streaming.ts` that means the bucket's split `remoteItem` when a
 * `<podcast:valueTimeSplit>` track earned the sats, and the show/episode
 * otherwise. Re-deriving them here from whatever is currently playing is how a
 * track's receipt comes to name the playlist instead: the settle is a lump for
 * time already listened, so by the time it fires the player has usually moved
 * on. Identifiers matching the payment is the entire point — a consumer filters
 * `#i` once and gets the boost note and the streaming receipts for one track
 * together.
 *
 * `content` is the empty string for an unattended payment. It exists in the
 * spec for a boostagram message, and an unattended payment has none.
 *
 * There is deliberately NO `name` tag. The event's author pubkey IS the sender,
 * so a display name would be a second answer to a question the signature has
 * already settled — and a drifting one, since it is user-editable text. Nor is
 * there a `p` tag: streaming pays value-block recipients by node pubkey or
 * lnaddress, and this app learns no Nostr identity for them.
 */
export function buildValuePlaybackReceipt(args: ValuePlaybackReceiptArgs): EventTemplate {
  const tags: string[][] = [];
  // NIP-73 external content ids, in the same order and the same pairing
  // ./boost-notes.ts emits them.
  if (args.feedGuid) {
    tags.push(['i', `podcast:guid:${args.feedGuid}`]);
    tags.push(['k', 'podcast:guid']);
  }
  if (args.itemGuid) {
    tags.push(['i', `podcast:item:guid:${args.itemGuid}`]);
    tags.push(['k', 'podcast:item:guid']);
  }
  tags.push(['amount', String(Math.max(0, Math.round(args.msat)))]);
  tags.push(['action', args.action]);
  tags.push(['start', String(Math.floor(args.startSec))]);
  tags.push(['end', String(Math.floor(args.endSec))]);
  if (args.positionSec !== undefined && args.positionSec >= 0) {
    tags.push(['position', String(Math.floor(args.positionSec))]);
  }
  if (args.session) tags.push(['session', args.session]);
  tags.push(['app', args.appName ?? BRAND.wireName]);
  // NIP-31. No client renders this kind — that is the design — so without an
  // `alt` a general-purpose client shows an empty box rather than a sentence.
  tags.push(['alt', altText(args)]);

  return {
    kind: VALUE_PLAYBACK_RECEIPT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
}

function altText(args: ValuePlaybackReceiptArgs): string {
  const sats = Math.round(args.msat / 1000);
  const what = args.label ? ` to ${args.label}` : '';
  return `${sats} sats streamed${what} (value playback receipt)`;
}

/**
 * Sign and publish one receipt. Resolves either way and NEVER throws.
 *
 * Three rules the caller depends on, all of them about this being bookkeeping
 * that sits beside money rather than money itself:
 *
 *  - **It cannot fail a payment.** The sats have already moved by the time this
 *    runs. A relay outage must not read as a settle failure — in the streaming
 *    engine two of those stop the engine for the item, so conflating them would
 *    let a relay problem stop somebody's payments.
 *  - **No `assertPublished`.** That guard exists for callers that record
 *    durable state on the strength of a publish, because recording success is
 *    what stops the next attempt retrying. Nothing is recorded here, so an
 *    event that reached nobody costs one missing receipt and nothing else. The
 *    accepted count is logged instead, so "why are there no receipts?" stays
 *    answerable.
 *  - **It is time-capped**, per RECEIPT_PUBLISH_TIMEOUT_MS above.
 *
 * The caller is responsible for deciding WHETHER to publish at all — the opt-in
 * setting, the anonymity signal and the signer check all live at the call site,
 * because they are answers about the listener rather than about the event.
 */
export async function publishValuePlaybackReceipt(
  args: ValuePlaybackReceiptArgs,
): Promise<void> {
  const relays = args.relays?.length ? args.relays : DEFAULT_RELAYS;
  try {
    const note = await Promise.race([
      signAndPublish(buildValuePlaybackReceipt(args), relays),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('value playback receipt timed out')),
          RECEIPT_PUBLISH_TIMEOUT_MS,
        ),
      ),
    ]);
    console.log(
      `[3369] receipt published to ${note.acceptedRelays.length}/${relays.length} relays`,
      { id: note.id, msat: args.msat, action: args.action },
    );
  } catch (e) {
    console.warn('[3369] receipt not published', e);
  }
}


// ───────────────────────────────────────────────────────────────────────────
// Kind 33369 — Value Playback Summary
//
// The addressable aggregate over the receipts above, so a consumer answers
// "what has this person paid this feed" with one fetch instead of pulling and
// summing hundreds of events.
//
// The arithmetic and the publish predicate live in ./value-playback-summary.ts,
// which is import-free so `npm run check:vpsummary` pins the real thing. What
// lives HERE is the IO: which relays, which filters, and the order the two
// reads happen in.
// ───────────────────────────────────────────────────────────────────────────

/** How long the receipt scan may run. Longer than a single-event read: this
 *  has to see the WHOLE set, and there is no early exit to shorten it. */
const SUMMARY_RECEIPT_SCAN_MS = 8_000;

/**
 * Page size for the receipt scan, and the ceiling on how many pages it walks.
 *
 * An unlimited REQ is not an unlimited answer: relays cap it at a default of
 * their own choosing, commonly a few hundred, and say nothing about having done
 * so. `DetailedCollect.complete` cannot see that — it reports that every reached
 * relay sent EOSE, not that every matching event came back — so a scan that has
 * been silently truncated looks exactly like a complete one. At roughly six
 * receipts an hour a feed passes a 500-event cap after about 83 hours of
 * listening, and from then on every scan derives the same newest-N sum: the
 * total plateaus, `summaryPublishDecision` answers 'unchanged' forever, and the
 * monotonic rule pins the public number below the truth permanently.
 *
 * So the scan asks for an explicit page and walks each relay backwards with its
 * own `until` until a page adds nothing new — never until a page comes back
 * short, because a relay whose own cap is below this one answers every page
 * short (`walkReceiptHistory`). `MAX_RECEIPT_PAGES` bounds the work per relay
 * for an account with a very long history; hitting it is one of the cases where
 * the view really is partial, and the scan reports that rather than publishing
 * a low total.
 */
const RECEIPT_PAGE_LIMIT = 500;
const MAX_RECEIPT_PAGES = 20;

/** How long the whole read-decide-publish cycle may take before we give up. */
const SUMMARY_PUBLISH_TIMEOUT_MS = 25_000;

/**
 * Wait this long after a listen ends before deriving summaries for it.
 *
 * The last settles' receipts are published fire-and-forget, so deriving the
 * moment the item is released reads the relays before those receipts arrive.
 * The delay is not a correctness requirement — a receipt that has not landed is
 * simply not counted yet, and the monotonic rule means the next listen's
 * derivation picks it up and the total only ever climbs. It is here so the
 * common case is right the first time rather than one listen behind.
 */
const SUMMARY_FLUSH_DELAY_MS = 30_000;

export interface SummaryUpdateArgs {
  /** The NIP-73 id this summary addresses, e.g. `podcast:guid:<feedGuid>`. */
  id: string;
  /** Identifier kind for the `k` tag, matching `id`'s prefix. */
  idKind: string;
  /** The author. Both the read filter and the signature are scoped to it. */
  pubkey: string;
  /** Publish set. Also the read set — see the note in updateValuePlaybackSummary. */
  relays: string[];
  /** Human label for `alt`, e.g. the show or album title. */
  label?: string;
}

/**
 * The unsigned kind:33369 template.
 *
 * `alt` says "by me" deliberately. A summary speaks for ONE person's payments,
 * and a bare "1420 sats streamed to this show" reads as a global figure — wrong
 * by however many other listeners there are, in the one field a human actually
 * sees.
 */
export function buildValuePlaybackSummary(
  args: SummaryUpdateArgs,
  derived: { amount: number; count: number; first: number; last: number },
): EventTemplate {
  const tags: string[][] = [
    ['d', args.id],
    ['i', args.id],
    ['k', args.idKind],
    ['amount', String(derived.amount)],
    ['count', String(derived.count)],
  ];
  if (derived.first > 0) tags.push(['first', String(derived.first)]);
  if (derived.last > 0) tags.push(['last', String(derived.last)]);
  const sats = Math.round(derived.amount / 1000);
  const what = args.label ? ` to ${args.label}` : '';
  tags.push(['alt', `${sats} sats streamed${what} by me in total (value playback summary)`]);
  return {
    kind: VALUE_PLAYBACK_SUMMARY_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
}

/**
 * Derive one summary from the author's own receipts and publish it if the rules
 * allow. Resolves either way and NEVER throws.
 *
 * Order matters and is the whole function:
 *
 *  1. **Scan the receipts.** `#i` narrows it at the relay, and every event is
 *     re-checked with `receiptMatchesId` because a filter is how you ask, not
 *     proof of what you got — an over-answering relay produces a total that is
 *     quietly too big rather than an obviously wrong event.
 *  2. **Refuse an incomplete scan.** `complete` is deliberately stricter than
 *     the `trustworthy` a single-event read uses; see `DetailedCollect`. A sum
 *     over a partial set is an understatement, and publishing one would pin the
 *     address low until some later read happens to see more.
 *  3. **Read what is already stored**, and refuse if THAT read is degraded too.
 *     Without the stored value there is nothing to enforce monotonicity
 *     against, so publishing would be a blind write over a number that may be
 *     larger. `dTag` is pinned at intake so a different `d` sharing the
 *     subscription cannot pose as this address's value.
 *  4. **Ask the predicate**, and publish only if it says so.
 *
 * The read set is the publish set. That is the spec's relay rule and it is a
 * correctness requirement rather than a convenience: receipts have to be
 * readable by anything deriving a summary, or two apps derive from different
 * subsets and the monotonic rule silences whichever one has the narrower view.
 */
/**
 * Every receipt this pubkey published for one identifier, walked page by page
 * and RELAY BY RELAY (`walkReceiptHistory`, pinned by check:vpsummary).
 *
 * `complete` here is stricter than `DetailedCollect.complete`: it also requires
 * that every relay that connected was walked to the end of its own history,
 * rather than to a page ceiling, a cap of its own, or the cursor of a relay
 * with a longer history. A sum is only as good as its narrowest input, and
 * publishing a truncated one is permanent — see RECEIPT_PAGE_LIMIT.
 */
async function scanReceipts(
  relays: string[],
  pubkey: string,
  id: string,
  signal?: AbortSignal,
): Promise<{ events: NostrEvent[]; complete: boolean; reached: number; pages: number }> {
  return walkReceiptHistory<NostrEvent>(
    relays.map((relay) => async (until) => {
      const page = await collectEventsDetailed(
        [relay],
        {
          kinds: [VALUE_PLAYBACK_RECEIPT_KIND],
          authors: [pubkey],
          '#i': [id],
          limit: RECEIPT_PAGE_LIMIT,
          ...(until === undefined ? {} : { until }),
        },
        SUMMARY_RECEIPT_SCAN_MS,
        { pubkey, kinds: [VALUE_PLAYBACK_RECEIPT_KIND] },
      );
      return { reached: page.reached > 0, answered: page.complete, events: page.events };
    }),
    MAX_RECEIPT_PAGES,
    () => !!signal?.aborted,
  );
}

/**
 * `signal` is the flush's: once it aborts (the cycle's timeout, or a sign-out
 * through `cancelQueuedSummaries`) this cycle stops before its next read and
 * never signs. Until 2026-11-26 the timeout only stopped the WAITING, so an
 * abandoned cycle could still sign minutes later — beside a second cycle for
 * the same address, or after the account it was derived for had signed out.
 */
export async function updateValuePlaybackSummary(args: SummaryUpdateArgs, signal?: AbortSignal): Promise<void> {
  const relays = args.relays.length ? args.relays : DEFAULT_RELAYS;
  try {
    const scan = await scanReceipts(relays, args.pubkey, args.id, signal);
    if (signal?.aborted) return;
    if (!scan.complete) {
      console.warn(
        `[33369] receipt scan incomplete (${scan.reached}/${relays.length} relays reached, ${scan.pages} pages) — not publishing`,
        { id: args.id },
      );
      return;
    }
    const facts: ReceiptFacts[] = [];
    for (const ev of scan.events) {
      if (!receiptMatchesId(ev.tags, args.id)) continue;
      const f = receiptFacts(ev.tags, ev.created_at);
      if (f) facts.push(f);
    }
    const derived = deriveSummary(facts);

    const current = await fetchLatestEventDetailed(
      relays,
      { kinds: [VALUE_PLAYBACK_SUMMARY_KIND], authors: [args.pubkey], '#d': [args.id], limit: 1 },
      undefined,
      { pubkey: args.pubkey, kinds: [VALUE_PLAYBACK_SUMMARY_KIND], dTag: args.id },
    );
    if (signal?.aborted) return;
    if (!current.trustworthy) {
      console.warn('[33369] could not read the stored summary — not publishing', { id: args.id });
      return;
    }
    const stored = current.event ? parseStoredSummary(current.event.tags) : null;

    const decision = summaryPublishDecision(derived, stored);
    if (!decision.publish) {
      console.log(`[33369] no publish (${decision.reason})`, { id: args.id, derived, stored });
      return;
    }
    if (signal?.aborted) return;
    // `signal` also drops a signature that arrives after the abort, unpublished.
    const note = await signAndPublish(buildValuePlaybackSummary(args, derived), relays, { signal });
    console.log(
      `[33369] summary published to ${note.acceptedRelays.length}/${relays.length} relays`,
      { id: args.id, amount: derived.amount, count: derived.count },
    );
  } catch (e) {
    console.warn('[33369] summary not published', e);
  }
}

// ── the debounce ────────────────────────────────────────────────────────────
//
// Summaries are derived once per listen, not once per settle. Re-reading every
// receipt to add one is O(all of them) work for a +1 change, six times an hour
// on an ordinary show and once per song on a live one.

interface PendingSummaries {
  ids: Map<string, { idKind: string; label?: string }>;
  pubkey: string;
  relays: string[];
}

let pending: PendingSummaries | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** One cycle per address, held until the cycle SETTLES (`createAddressGate`). */
const addressGate = createAddressGate();
/** The running cycles' abort handles, so a sign-out can stop every one. */
const cycleAborts = new Set<AbortController>();
/** Bumped by `cancelQueuedSummaries`: a re-queue from before a sign-out is dropped. */
let queueGeneration = 0;
/** True while `flushSummaries` is awaiting publishes. See its re-entrancy note. */
let flushing = false;

/**
 * Queue one or more ids for a summary update, coalescing repeats.
 *
 * Flushes SERIALLY. A twelve-track album listen can touch several album feeds,
 * and each id is two relay reads plus a possible write — firing them at once is
 * a burst against a kind whose own spec names rate limits as the binding
 * constraint, from the one client that knows better.
 *
 * The timer is restarted on every call, so a listener skipping between items
 * gets one flush after they settle rather than one per skip.
 */
export function queueSummaryUpdate(args: {
  ids: { id: string; idKind: string; label?: string }[];
  pubkey: string;
  relays: string[];
}) {
  if (!args.ids.length || !args.pubkey) return;
  if (!pending) pending = { ids: new Map(), pubkey: args.pubkey, relays: args.relays };
  // A signed-in-as-someone-else flush would derive one account's totals and
  // sign them with another's key. Drop what was queued for the old identity.
  if (pending.pubkey !== args.pubkey) {
    pending = { ids: new Map(), pubkey: args.pubkey, relays: args.relays };
  }
  pending.relays = args.relays;
  for (const entry of args.ids) {
    if (entry.id) pending.ids.set(entry.id, { idKind: entry.idKind, label: entry.label });
  }
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushSummaries, SUMMARY_FLUSH_DELAY_MS);
}

async function flushSummaries() {
  flushTimer = null;
  // **One flush at a time.** Each id is awaited serially with up to
  // SUMMARY_PUBLISH_TIMEOUT_MS of budget, so a three-id batch can run for over a
  // minute — long enough for a fresh `queueSummaryUpdate` to set another timer
  // and fire it underneath this one. Two flushes holding the same id would read
  // the same stored summary, derive the same numbers, both decide 'publish', and
  // write two events to one address back to back: the relay churn the
  // CHANGED-BY-VALUE rule exists to avoid, plus a signature the user did not
  // expect. The re-arm below means nothing queued is dropped, only deferred.
  if (flushing) {
    if (pending) flushTimer = setTimeout(flushSummaries, SUMMARY_FLUSH_DELAY_MS);
    return;
  }
  const batch = pending;
  pending = null;
  if (!batch) return;

  // **Re-read the switches, do not trust the ones that queued this.** Up to
  // SUMMARY_FLUSH_DELAY_MS separates the queue from the flush, and a listener
  // who turns either switch off inside that window means "stop", not "finish
  // what was queued" — a kind:33369 is permanent and monotonic, so an event
  // published after the opt-out cannot be undone by turning the switch off
  // again. `maybeQueueSummaries` reads them too, but that is QUEUE time; this is
  // the one that matches what the user last chose.
  if (!storage.streamReceipts.get()) return;
  if (!storage.streamSummaries.get()) return;

  // **Re-check the signer, do not trust the one that queued this.** Up to
  // SUMMARY_FLUSH_DELAY_MS separates the queue from the flush, and a sign-out
  // or an account switch inside that window would otherwise derive one
  // account's totals from its receipts and sign them with somebody else's key
  // — a permanent, addressable, monotonic claim on the wrong pubkey, which no
  // later publish can lower.
  //
  // `cancelQueuedSummaries` on the sign-out paths handles the ordinary case.
  // This is the backstop, here rather than at those call sites because a third
  // exit added later inherits it instead of having to remember it.
  //
  // Order matters: `canSignUnattended` is what rules out Amber and a bunker, so
  // it must run BEFORE `getPublicKey` — on Amber that call is an intent
  // dispatch and an approval sheet, which is the thing this whole feature
  // refuses to do on a timer.
  if (!canSignUnattended()) return;
  let signer: string;
  try {
    signer = await activeNostr()!.getPublicKey();
  } catch {
    return;
  }
  if (signer !== batch.pubkey) return;

  flushing = true;
  try {
    for (const [id, meta] of batch.ids) {
      const abort = new AbortController();
      const gate = addressGate.start(id, async () => {
        cycleAborts.add(abort);
        try {
          await updateValuePlaybackSummary({
            id,
            idKind: meta.idKind,
            label: meta.label,
            pubkey: batch.pubkey,
            relays: batch.relays,
          }, abort.signal);
        } finally {
          cycleAborts.delete(abort);
        }
      });
      if (!gate.started) {
        // A cycle for this address is still running — one a timeout gave up
        // WAITING for, which aborting stops only at its next step. Starting a
        // second one beside it is the double write `createAddressGate`
        // exists for, so the id waits for that cycle to end and is queued
        // again then, unless the user signed out or switched account since.
        const generation = queueGeneration;
        void gate.busy.then(() => {
          if (generation !== queueGeneration) return;
          if (pending && pending.pubkey !== batch.pubkey) return;
          queueSummaryUpdate({ ids: [{ id, ...meta }], pubkey: batch.pubkey, relays: batch.relays });
        });
        continue;
      }
      await withTimeout(gate.done, SUMMARY_PUBLISH_TIMEOUT_MS, abort);
    }
  } finally {
    flushing = false;
    // Anything queued while this ran gets its own timer — the early return above
    // only fires when a timer was already pending, so without this a batch that
    // arrived mid-flush would sit in `pending` with nothing scheduled to send it.
    if (pending && !flushTimer) flushTimer = setTimeout(flushSummaries, SUMMARY_FLUSH_DELAY_MS);
  }
}

/**
 * Cap one id's cycle so a hung signer or relay cannot stall the rest of the
 * batch. A signer that goes away does not reject, it hangs — the same reason
 * `withDecryptTimeout` exists — and here that would strand every id queued
 * behind it, silently.
 */
async function withTimeout(p: Promise<void>, ms: number, abort: AbortController): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      p,
      // Stop the cycle, not only the waiting: aborted, it never signs.
      new Promise<void>((resolve) => { timer = setTimeout(() => { abort.abort(); resolve(); }, ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Drop anything queued without flushing it, and stop every running cycle. For sign-out. */
export function cancelQueuedSummaries() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  pending = null;
  queueGeneration++;
  for (const abort of cycleAborts) abort.abort();
}
