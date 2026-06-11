// Boost orchestrator. Walks the value block, splits sats by weight,
// and pays each recipient via the best available rail.
//
// Drop-in replacement target: when v4v-toolkit ships its boost helper,
// import from there and delete the bodies of the helpers below.

import type { Boostagram, ValueBlock, ValueRecipient, BoostResult } from '@/lib/types';
import { hasNwc, nwcKeysend, nwcPayInvoice } from './nwc';
import { hasWebln, weblnKeysend, weblnPayInvoice } from './webln';
import { hasSpark, sparkPayInvoice } from './spark';
import { fetchLnInvoice } from './lnaddr';
import { storeBoostMetadata } from './boostbox';
import { storage } from '@/lib/storage';

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

/** Distribute total sats across recipients by split weight. Floor + remainder to first non-fee recipient. */
export function splitSats(total: number, recipients: ValueRecipient[]): number[] {
  const totalWeight = recipients.reduce((s, r) => s + (r.split || 0), 0);
  if (totalWeight === 0) return recipients.map(() => 0);
  const allocated = recipients.map((r) =>
    Math.floor((total * (r.split || 0)) / totalWeight),
  );
  const remainder = total - allocated.reduce((a, b) => a + b, 0);
  if (remainder > 0) {
    const idx = recipients.findIndex((r) => !r.fee);
    allocated[idx >= 0 ? idx : 0] += remainder;
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

async function payOne(
  recipient: ValueRecipient,
  sats: number,
  rail: Rail,
  boostagram: Boostagram,
): Promise<BoostResult> {
  const base: BoostResult = { recipient, sats, ok: false };
  if (sats <= 0) return { ...base, ok: true };
  try {
    return recipient.type === 'lnaddress'
      ? await payLnurl(recipient, sats, rail, boostagram)
      : await payKeysend(recipient, sats, rail, boostagram);
  } catch (e: any) {
    return { ...base, ok: false, error: e?.message ?? String(e) };
  }
}

export async function sendBoost(args: {
  value: ValueBlock;
  totalSats: number;
  boostagram: Boostagram;
  rail?: Rail;
  onProgress?: (r: BoostResult, index: number, total: number) => void;
}): Promise<BoostResult[]> {
  const rail = args.rail ?? pickRail();
  if (!rail) throw new Error('No payment provider available (connect NWC, Spark, or WebLN)');

  const recipients = args.value.recipients;
  const splits = splitSats(args.totalSats, recipients);
  const results: BoostResult[] = [];

  for (let i = 0; i < recipients.length; i++) {
    const r = await payOne(recipients[i], splits[i], rail, args.boostagram);
    results.push(r);
    args.onProgress?.(r, i, recipients.length);
  }
  return results;
}
