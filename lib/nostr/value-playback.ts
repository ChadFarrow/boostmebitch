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

import type { EventTemplate } from 'nostr-tools';
import { DEFAULT_RELAYS } from './relays';
import { signAndPublish } from './publish';

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
  tags.push(['app', args.appName ?? 'BoostMeBitch']);
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
