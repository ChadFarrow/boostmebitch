// Boost orchestrator. Walks the value block, splits sats by weight,
// and pays each recipient via the best available rail.
//
// Drop-in replacement target: when v4v-toolkit ships its boost helper,
// import from there and delete the bodies of the helpers below.

import type { Boostagram, ValueBlock, ValueRecipient, BoostResult } from '@/lib/types';
import {
  failureBlamesDestination,
  hasNwc,
  nwcFetchCapabilities,
  nwcGetMethods,
  nwcKeysend,
  nwcPayInvoice,
  NwcNotAttemptedError,
  NwcIndeterminateError,
} from './nwc';
import { hasWebln, weblnKeysend, weblnPayInvoice } from './webln';
import { hasSpark, sparkPayInvoice } from './spark';
import { fetchLnInvoice } from './lnaddr';
import {
  lookupKeysendTarget,
  isLnurlOnlyAddress,
  keysendRecentlyFailed,
  noteKeysendFailure,
} from './keysend-lookup';
import { storeBoostMetadata } from './boostbox';
import { storage } from '@/lib/storage';
import { recipientOrder, isLnAddressRecipient, splitSats } from '@/lib/util';

// TLV custom record number for podcast boostagrams (Podcasting 2.0 spec).
// The boostagram JSON already carries `sender_id`, so we don't add a separate
// sender TLV — that key (696969) is also reused by some shared nodes (e.g.
// getalby.com) for sub-account routing, and would collide with recipient
// customKey/customValue pairs.
const TLV_BOOSTAGRAM = 7629169;

export type Rail = 'nwc' | 'webln' | 'spark';

// Re-export so callers can import from one place
export type { BoostResult };

// The user's rail pref (last-used boost rail / wallet-modal switch choice)
// wins when that rail is still available; otherwise fall back to priority:
// NWC (explicit user setup) > Spark (auto-provisioned self-custodial) >
// WebLN (browser extension fallback). Users can override per-boost in the
// modal; this is just the default.
export function pickRail(): Rail | null {
  const pref = storage.railPref.get();
  if (pref === 'nwc' && hasNwc()) return 'nwc';
  if (pref === 'spark' && hasSpark()) return 'spark';
  if (pref === 'webln' && hasWebln()) return 'webln';
  if (hasNwc()) return 'nwc';
  if (hasSpark()) return 'spark';
  if (hasWebln()) return 'webln';
  return null;
}

// splitSats now lives in lib/util.ts (with recipientOrder, for the same
// reason: <SplitsPreview> renders an allocation and must not import the
// payment engine to do it). Re-exported here so every existing call site and
// the v4v swap-out boundary are unchanged.
export { splitSats } from '@/lib/util';

// NIP-47 pay_keysend expects { type, value } where value is hex-encoded.
function tlvHexFor(
  boostagram: Boostagram,
  recipient: ValueRecipient,
): { type: number; value: string }[] {
  const records: { type: number; value: string }[] = [
    {
      type: TLV_BOOSTAGRAM,
      value: Buffer.from(JSON.stringify(boostagram), 'utf8').toString('hex'),
    },
  ];
  if (recipient.customKey && recipient.customValue) {
    const ck = Number(recipient.customKey);
    if (Number.isFinite(ck)) {
      records.push({
        type: ck,
        value: Buffer.from(recipient.customValue, 'utf8').toString('hex'),
      });
    }
  }
  return records;
}

// WebLN providers (Alby, Mutiny) hex-encode customRecords values internally
// before putting them on the wire. Pass plain UTF-8 strings — pre-hexing
// here causes double-encoding and Helipad can't JSON.parse the boostagram.
function recordsForKeysend(
  boostagram: Boostagram,
  recipient: ValueRecipient,
): Record<string, string> {
  const records: Record<string, string> = {
    [String(TLV_BOOSTAGRAM)]: JSON.stringify(boostagram),
  };
  if (recipient.customKey && recipient.customValue) {
    records[recipient.customKey] = recipient.customValue;
  }
  return records;
}

// LNURL recipients: park metadata in BoostBox (so the desc URL rides in the
// LUD-21 comment), fetch a BOLT11 from the LNURL-pay callback, then pay it
// on whichever rail the boost is using. Failure of BoostBox is non-fatal —
// the user's typed message becomes the comment instead.
async function payLnurl(
  recipient: ValueRecipient,
  sats: number,
  rail: Rail,
  boostagram: Boostagram,
): Promise<BoostResult> {
  const stored = await storeBoostMetadata({
    boostagram,
    recipient,
    splitWeight: recipient.split,
    legMsat: sats * 1000,
  });
  // Handed over separately, NOT pre-joined: the two truncate differently and
  // fetchLnInvoice is the only place that knows the recipient's commentAllowed.
  // `desc` is the rss::payment descriptor — Fountain authored that spec and
  // parses it, so on an LNURL leg it is the metadata channel and is worth
  // nothing clipped; the message is prose and reads fine short. Joining here
  // and letting the far end slice would cut the URL, not the prose. See
  // buildLnurlComment.
  const invoice = await fetchLnInvoice({
    address: recipient.address,
    amount_msat: sats * 1000,
    desc: stored?.desc,
    message: boostagram.message,
  });
  let preimage: string;
  if (rail === 'nwc') preimage = await nwcPayInvoice(invoice);
  else if (rail === 'spark') preimage = await sparkPayInvoice(invoice);
  else preimage = await weblnPayInvoice(invoice);
  return {
    recipient,
    sats,
    ok: true,
    preimage,
    boostboxUrl: stored?.url,
    boostboxId: stored?.url?.split('/').pop() || undefined,
  };
}

// Keysend (type === 'node'): boostagram TLV rides inline on the payment.
// Spark has no keysend path, so node-pubkey legs surface a clear error
// rather than silently failing the boost — caught by payOne's wrapper.
async function payKeysend(
  recipient: ValueRecipient,
  sats: number,
  rail: Rail,
  boostagram: Boostagram,
): Promise<BoostResult> {
  if (rail === 'spark') {
    throw new Error('Spark rail does not support keysend (node-pubkey recipient)');
  }
  const recPerRecipient: Boostagram = {
    ...boostagram,
    value_msat: sats * 1000,
    name: recipient.name,
  };
  if (rail === 'nwc') {
    const preimage = await nwcKeysend({
      pubkey: recipient.address,
      amount_msat: sats * 1000,
      tlv_records: tlvHexFor(recPerRecipient, recipient),
    });
    return { recipient, sats, ok: true, preimage };
  }
  const preimage = await weblnKeysend({
    pubkey: recipient.address,
    amount_sat: sats,
    customRecords: recordsForKeysend(recPerRecipient, recipient),
  });
  return { recipient, sats, ok: true, preimage };
}

/**
 * Whether the wallet can keysend — the gate on the whole lnaddress upgrade.
 *
 * Tri-state on purpose, because the three answers want three behaviours:
 *
 * - `'no'`   — provably can't. Skip the address probe entirely; those users pay
 *              nothing for a feature they can't use.
 * - `'yes'`  — provably can. Upgrade, and if the keysend then errors, fail the
 *              leg (it may already have paid — no LNURL retry).
 * - `'unknown'` — the wallet never told us. **Attempt it anyway**, and fall
 *              back to LNURL only on a NOT_IMPLEMENTED refusal (see payOne).
 *
 * That last arm is why this isn't a boolean. Plenty of NWC wallets simply omit
 * `methods` from `get_info`, or grant `get_balance` but not `get_info` — and
 * folding those in with "no" meant the upgrade could never fire for them, no
 * matter what the recipient's address published. Silently, since both gates
 * fall back by design. A refusal costs one round trip; being wrong the other
 * way cost the feature entirely.
 *
 * The answer is normally settled long before a boost: NWC records its method
 * list at connect time (nwcValidate → storage.nwcMethods) and WebLN is a plain
 * property read, so this resolves without network in the common case.
 */
type KeysendCapability = 'yes' | 'no' | 'unknown';

async function railCanKeysend(rail: Rail): Promise<KeysendCapability> {
  if (rail === 'spark') return 'no'; // BOLT11-only by design
  if (rail === 'webln') {
    // Reading the method off the provider doesn't require wl.enable(), so this
    // costs no permission prompt. The provider either exposes keysend or it
    // doesn't — there's no unknown here.
    const ok =
      typeof window !== 'undefined' && typeof window.webln?.keysend === 'function';
    return ok ? 'yes' : 'no';
  }
  // nwcGetMethods() returns null for both "never asked" and "asked, got an
  // empty list" — an empty list is no evidence either way.
  let methods = nwcGetMethods();
  if (!methods) {
    await nwcFetchCapabilities();
    methods = nwcGetMethods();
  }
  if (!methods) return 'unknown';
  return methods.includes('pay_keysend') ? 'yes' : 'no';
}

/**
 * Turn a `type="lnaddress"` recipient into a keysend recipient when its
 * address publishes a `.well-known/keysend` endpoint. Returns null when it
 * doesn't — the caller then pays LNURL exactly as before.
 *
 * The endpoint's routing pair wins over the feed's: for an lnaddress recipient
 * the feed rarely carries customKey/customValue at all (the LNURL path ignores
 * them entirely), while the endpoint's pair is what routes to the right
 * sub-account on a shared node. The feed's pair is used only as a fallback.
 */
async function keysendRecipientFor(
  recipient: ValueRecipient,
): Promise<ValueRecipient | null> {
  const target = await lookupKeysendTarget(recipient.address);
  if (!target) return null;
  const pair =
    target.customKey && target.customValue
      ? { customKey: target.customKey, customValue: target.customValue }
      : { customKey: recipient.customKey, customValue: recipient.customValue };
  return { ...recipient, type: 'node', address: target.pubkey, ...pair };
}

async function payOne(
  recipient: ValueRecipient,
  sats: number,
  rail: Rail,
  boostagram: Boostagram,
  canKeysend: KeysendCapability,
): Promise<BoostResult> {
  const base: BoostResult = { recipient, sats, ok: false };
  if (sats <= 0) return { ...base, ok: true };
  try {
    // Not `type !== 'lnaddress'`: an address with an @ is a Lightning address
    // whatever the feed declared. See isLnAddressRecipient — a keysend at an
    // email-shaped string cannot route on any rail, so this only ever turns a
    // certain failure into a working LNURL leg.
    if (!isLnAddressRecipient(recipient)) {
      return await payKeysend(recipient, sats, rail, boostagram);
    }
    const upgraded =
      canKeysend === 'no' ? null : await keysendRecipientFor(recipient);
    if (!upgraded) {
      // Every gate here falls back silently by design, which makes a
      // mis-detected wallet capability, an address with no endpoint and a
      // provider we route to LNURL on purpose look identical from the outside —
      // say which one sent this leg to LNURL. The third arm is not decoration:
      // an @fountain.fm leg matches none of the other two, and a log naming the
      // wrong cause is worse than no log at all.
      console.info(
        `[keysend] ${recipient.address} → LNURL (${
          canKeysend === 'no'
            ? `${rail} wallet cannot keysend`
            : isLnurlOnlyAddress(recipient.address)
              ? 'LNURL-only provider'
              : keysendRecentlyFailed(recipient.address)
                ? 'a keysend to this address failed earlier'
                : 'no .well-known/keysend endpoint'
        })`,
      );
      return await payLnurl(recipient, sats, rail, boostagram);
    }
    console.info(
      `[keysend] ${recipient.address} → keysend ${upgraded.address.slice(0, 12)}…` +
        (canKeysend === 'unknown' ? ' (capability unknown — attempting)' : ''),
    );
    try {
      const res = await payKeysend(upgraded, sats, rail, boostagram);
      // Report the recipient the feed listed, not the resolved node pubkey, so
      // the modal's per-leg rows and the stored boost log stay readable.
      return { ...res, recipient };
    } catch (e) {
      // Two separate decisions, in this order, and they must not be merged.
      //
      // FIRST: is this evidence about the RECIPIENT? If so, remember it, so the
      // next leg to this address — the next track of a boost-all, the next
      // boost — skips the upgrade and pays LNURL. This is the only thing that
      // helps an address whose `.well-known/keysend` is published and correct
      // while the node behind it cannot be paid: nothing in the document says
      // so, the probe keeps succeeding, and a fee recipient rides on every show
      // and every track, so the same leg fails on every boost forever. It costs
      // at most the inline boostagram if the attribution is wrong, and it never
      // re-pays anything, which is what lets it be this liberal. See
      // failureBlamesDestination for why a wallet-side or socket failure is
      // excluded — those say nothing about the recipient.
      if (failureBlamesDestination(e)) {
        noteKeysendFailure(recipient.address);
        console.warn(
          `[keysend] ${recipient.address} keysend FAILED at ` +
            `${upgraded.address.slice(0, 12)}… — later legs to this address will use LNURL: ` +
            (e instanceof Error ? e.message : String(e)),
        );
      }
      // SECOND: may THIS leg be paid again, right now, over LNURL? Only when the
      // wallet refused the request *instead of* executing it — NOT_IMPLEMENTED,
      // UNAUTHORIZED, RESTRICTED — because then nothing left the wallet and
      // LNURL cannot double-pay. Every other failure stays fatal to the leg: a
      // keysend that errors after the money moved (see the Zeus no-preimage case
      // in nwcKeysend) would otherwise pay twice, and a failed leg is the
      // cheaper wrong answer. `PAYMENT_FAILED` is deliberately NOT in the class,
      // however final it reads — a wallet's own report cannot prove an HTLC
      // never settled. The demotion above is what fixes that case instead, one
      // leg later and with no second payment.
      //
      // Deliberately not gated on `canKeysend === 'unknown'`: a wallet that
      // advertised pay_keysend and then refuses it has simply mis-advertised,
      // and the refusal is equally proof-of-no-payment either way.
      if (!(e instanceof NwcNotAttemptedError)) throw e;
      console.info(
        `[keysend] ${recipient.address} → LNURL (wallet refused keysend: ${e.code})`,
      );
      return await payLnurl(recipient, sats, rail, boostagram);
    }
  } catch (e: any) {
    // A wallet that never answered is not a wallet that refused. `ok` stays
    // false (we hold no preimage), but the flag stops every consumer — the
    // modal's ✗, the stored log, the user's decision to boost again — from
    // asserting a failure that may have been a payment. See
    // NwcIndeterminateError; the LNURL retry above is already gated on
    // NwcNotAttemptedError alone, so this can never be retried.
    const indeterminate = e instanceof NwcIndeterminateError;
    return { ...base, ok: false, indeterminate, error: e?.message ?? String(e) };
  }
}

/**
 * A boost "succeeded" only when at least one leg paid a POSITIVE amount. A
 * zero-sat leg returns `ok: true` on purpose (a recipient rounded out of a
 * multi-recipient split isn't a failure) — but if EVERY leg is a zero-sat
 * ok (e.g. a feed whose recipients all have `split: 0`), no Lightning traffic
 * left the wallet, so we must not celebrate, log, or post a "Boosted N sats"
 * note. Gate all of those on this, not on a bare `.some(r => r.ok)`.
 */
export function paidAny(results: BoostResult[]): boolean {
  return results.some((r) => r.ok && r.sats > 0);
}

export async function sendBoost(args: {
  value: ValueBlock;
  totalSats: number;
  boostagram: Boostagram;
  rail?: Rail;
  // `index` is the recipient's position in `value.recipients` — NOT the order
  // the legs settle in (see the traversal below). Callers tracking progress
  // must write `results[index]`, never push, or every ✓/✗ lands on the wrong
  // recipient mid-send.
  onProgress?: (r: BoostResult, index: number, total: number) => void;
}): Promise<BoostResult[]> {
  const rail = args.rail ?? pickRail();
  if (!rail) throw new Error('No payment provider available (connect NWC, Spark, or WebLN)');

  const recipients = args.value.recipients;
  const splits = splitSats(args.totalSats, recipients);
  // Pre-sized, not pushed: every slot is written by the index it belongs to, so
  // results[i], recipients[i] and splits[i] stay the same payee no matter what
  // order the loop visits them in — which is what lets it visit them out of
  // order below. Do NOT "simplify" this back to results.push(r); it type-checks,
  // lints and builds while pairing every leg with the wrong recipient.
  const results: BoostResult[] = new Array(recipients.length);

  // Resolved once per boost, not per leg, and only when there's actually an
  // UPGRADEABLE lnaddress recipient. All four halves matter: a node-only value
  // block (still the common case) must not pay for a capability check it can't
  // use; an LNURL-only provider is never upgraded whatever the wallet can do, so
  // a fountain-only block shouldn't probe either; an address demoted by an
  // earlier failed keysend is in the same position, which is what keeps the
  // rest of a boost-all cheap once one has failed; and on the NWC rail
  // `nwcFetchCapabilities` does NOT populate its cache when get_info fails — so
  // calling it per leg would re-fire a relay round trip for every recipient
  // against an unreachable wallet.
  const canKeysend: KeysendCapability = recipients.some(
    (r) =>
      isLnAddressRecipient(r) &&
      !isLnurlOnlyAddress(r.address) &&
      !keysendRecentlyFailed(r.address),
  )
    ? await railCanKeysend(rail)
    : 'no';

  // Biggest share first — the same order <SplitsPreview> and <ValueSplitRows>
  // list. Feed order is AUTHORING order: a real block buried a 94.1% artist
  // under four 1-sat housekeeping payees, so all four settled with a ✓ while
  // the artist was still pending. The modal said one thing and the wallet did
  // another. Legs are sequential and a rail can die mid-boost, so paying
  // descending by weight also means a partial failure drops the dust rather
  // than the leg that mattered.
  //
  // This reorders the TRAVERSAL, never the array — `recipientOrder` returns
  // indices for exactly this reason. Sorting `recipients` instead would perturb
  // splitSats' largest-remainder tie-breaking by a sat per payee and repoint
  // every positional read downstream.
  //
  // Still strictly sequential: NWC is one relay connection, WebLN prompts per
  // payment, and streaming.ts settles serially by design. Never parallelize.
  for (const i of recipientOrder(recipients)) {
    const r = await payOne(recipients[i], splits[i], rail, args.boostagram, canKeysend);
    results[i] = r;
    args.onProgress?.(r, i, recipients.length);
  }
  return results;
}
