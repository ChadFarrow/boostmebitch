// Boost orchestrator. Walks the value block, splits sats by weight,
// and pays each recipient via the best available rail.
//
// Drop-in replacement target: when v4v-toolkit ships its boost helper,
// import from there and delete the bodies of the helpers below.

import type { Boostagram, ValueBlock, ValueRecipient, BoostResult } from '@/lib/types';
import {
  hasNwc,
  nwcFetchCapabilities,
  nwcGetMethods,
  nwcKeysend,
  nwcPayInvoice,
  NwcMethodUnsupportedError,
} from './nwc';
import { hasWebln, weblnKeysend, weblnPayInvoice } from './webln';
import { hasSpark, sparkPayInvoice } from './spark';
import { fetchLnInvoice } from './lnaddr';
import { lookupKeysendTarget } from './keysend-lookup';
import { storeBoostMetadata } from './boostbox';
import { storage } from '@/lib/storage';
import { recipientOrder } from '@/lib/util';

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

/**
 * Distribute total sats across recipients by split weight, using the
 * largest-remainder (Hamilton) method: floor every share, then hand the
 * leftover sats out one at a time to the recipients whose exact share was
 * rounded down the most (fee recipients broken last on a tie).
 *
 * The naive "floor everyone, dump all remainder on the first recipient"
 * approach silently mispays small splits: a 100-sat boost to a 98%/1%/1%
 * block whose 1% legs are really ~0.8% floors both to 0 sats, then sends the
 * whole 100 to the artist and nothing to the other two. Largest-remainder
 * gives those legs their 1 sat each (→ 98/1/1) instead.
 *
 * Finally, every weighted recipient is guaranteed at least 1 sat — that's the
 * whole reason for the 100-sat minimum boost. If largest-remainder still left
 * a positive-weight recipient at 0, pull the make-up sat from the largest
 * allocation (which never drops below 1), so the total is preserved. When
 * there are more recipients than sats to go round it tops up as many as it
 * can and leaves the rest at 0.
 */
export function splitSats(total: number, recipients: ValueRecipient[]): number[] {
  // Clamp weights at 0: a malformed feed with a negative `split` would
  // otherwise poison totalWeight (even flip it negative) and produce nonsensical
  // — including negative — allocations.
  const w = (r: ValueRecipient) => Math.max(0, r.split || 0);
  const totalWeight = recipients.reduce((s, r) => s + w(r), 0);
  if (totalWeight === 0) return recipients.map(() => 0);
  const exact = recipients.map((r) => (total * w(r)) / totalWeight);
  const allocated = exact.map((x) => Math.floor(x));
  let remainder = total - allocated.reduce((a, b) => a + b, 0);
  if (remainder > 0) {
    const order = recipients
      .map((_, i) => i)
      .sort((a, b) => {
        const frac = exact[b] - allocated[b] - (exact[a] - allocated[a]);
        if (Math.abs(frac) > 1e-9) return frac;
        // Tie on fractional part: prefer non-fee recipients.
        return (recipients[a].fee ? 1 : 0) - (recipients[b].fee ? 1 : 0);
      });
    for (let k = 0; k < order.length && remainder > 0; k++, remainder--) {
      allocated[order[k]] += 1;
    }
  }
  // Floor of 1 sat per weighted recipient. Taking from the largest allocation
  // (only ever one with >1 sat) keeps the total constant and can't create a
  // new zero, so this terminates.
  const needy = () =>
    recipients.findIndex((r, i) => w(r) > 0 && allocated[i] === 0);
  for (let i = needy(); i !== -1; i = needy()) {
    let maxIdx = -1;
    for (let j = 0; j < allocated.length; j++) {
      if (allocated[j] > 1 && (maxIdx === -1 || allocated[j] > allocated[maxIdx])) maxIdx = j;
    }
    if (maxIdx === -1) break; // not enough sats to give everyone a sat
    allocated[maxIdx] -= 1;
    allocated[i] += 1;
  }
  return allocated;
}

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
  // Concat desc + user message so recipients without BoostBox-aware tooling
  // still see the typed message. fetchLnInvoice truncates to commentAllowed
  // if the combined string exceeds the recipient's cap.
  const userMsg = boostagram.message?.trim() || undefined;
  const comment = stored?.desc
    ? userMsg ? `${stored.desc} — ${userMsg}` : stored.desc
    : userMsg;
  const invoice = await fetchLnInvoice({
    address: recipient.address,
    amount_msat: sats * 1000,
    comment,
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
    if (recipient.type !== 'lnaddress') {
      return await payKeysend(recipient, sats, rail, boostagram);
    }
    const upgraded =
      canKeysend === 'no' ? null : await keysendRecipientFor(recipient);
    if (!upgraded) {
      // Both gates fall back silently by design, which makes a mis-detected
      // wallet capability and an address with no endpoint look identical from
      // the outside — say which one sent this leg to LNURL.
      console.info(
        `[keysend] ${recipient.address} → LNURL (${
          canKeysend === 'no'
            ? `${rail} wallet cannot keysend`
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
      // The ONLY error we may retry over LNURL. A NIP-47 NOT_IMPLEMENTED is the
      // wallet declining the method *instead of* executing it, so no payment
      // left the wallet and LNURL cannot double-pay. Every other failure stays
      // fatal to the leg — a keysend that errors after the money moved (see the
      // Zeus no-preimage case in nwcKeysend) would otherwise pay twice, and a
      // failed leg is the cheaper wrong answer.
      //
      // Deliberately not gated on `canKeysend === 'unknown'`: a wallet that
      // advertised pay_keysend and then refuses it has simply mis-advertised,
      // and the refusal is equally proof-of-no-payment either way.
      if (!(e instanceof NwcMethodUnsupportedError)) throw e;
      console.info(
        `[keysend] ${recipient.address} → LNURL (wallet refused keysend: NOT_IMPLEMENTED)`,
      );
      return await payLnurl(recipient, sats, rail, boostagram);
    }
  } catch (e: any) {
    return { ...base, ok: false, error: e?.message ?? String(e) };
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
  // lnaddress recipient to upgrade. Both halves matter: a node-only value
  // block (still the common case) must not pay for a capability check it
  // can't use, and on the NWC rail `nwcFetchCapabilities` does NOT populate
  // its cache when get_info fails — so calling it per leg would re-fire a
  // relay round trip for every recipient against an unreachable wallet.
  const canKeysend: KeysendCapability = recipients.some((r) => r.type === 'lnaddress')
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
