// Mint the summary receipt for a boost: the ONE kind:9735 the note quotes.
//
// The sender signs a kind:9734 for the sats the boost actually paid, addressed
// to the site's key; the site derives and signs the 9735 (app/api/nostr/
// zap-receipt-sign); this publishes it and hands back the quote. Why a receipt
// for the total exists at all, and what it does and does not claim, is in
// lib/nostr/zap-request.ts.
//
// NEVER THROWS AND NEVER HOLDS UP THE BOOST. Every failure — no signer, a signer
// that declined, the oracle unconfigured, no relay accepting — is `null`, and
// the note then quotes nothing. The sats have already moved by the time this
// runs; a missing quote costs Fountain's ⚡ figure and nothing else.
//
// FOR EVERY BOOST THAT POSTS TO NOSTR — "Don't post" is the only thing that
// skips it. `as: 'self'` when the user's key publishes the note: the user signs
// the 9734 and the receipt's `P` names them. `as: 'site'` when the note is
// site-published (signed out, or Anonymous): the site authors the 9734 from a
// bounded spec, so the receipt's sender is the site, as the note's author is,
// and nothing names the user. A caller decides `as` by the same rule it picks
// the note's signer with; this checks the signer again because it is not
// reactive.

import { nip19, type Event } from 'nostr-tools';
import { BRAND, type Brand } from '@/lib/brand';
import { activeNostr } from './signer';
import { publishSignedEvent } from './publish';
import { zapRequestTags, type Nip73Refs, type SummarySpec } from './zap-request';

/** The summary receipt, ready to be quoted by the boost note. */
export interface QuotedZapReceipt {
  id: string;
  /** The site's key. Goes in the `q` tag and the `nevent` author hint. */
  pubkey: string;
  /**
   * Hints, so a reader can find it: relays that ACCEPTED the receipt, never
   * more than three. A hint naming a relay that never took it sends every
   * reader to an empty answer.
   */
  relays: string[];
}

/** The site's pubkey in hex, from the per-brand pinned npub. */
export function siteHexPubkey(brand: Brand = BRAND): string | null {
  try {
    const d = nip19.decode(brand.siteNpub);
    return d.type === 'npub' ? d.data : null;
  } catch {
    return null;
  }
}

export async function mintSummaryReceipt(args: {
  /** Sats the legs actually settled — never the typed amount. */
  paidSats: number;
  /** The show and item the boost was for; mirrored onto the receipt. */
  refs: Nip73Refs;
  /** Where the receipt is published, and what its request names. */
  relays: string[];
  /** Who authors the request — the same answer as who signs the note. */
  as: 'self' | 'site';
  /**
   * The NOTE's brand (`PublishArgs.brand`). Its deploy mints the receipt and its
   * site key is the one the request names, so the note and the receipt it
   * quotes come from ONE deploy: a site-signed note may only quote a receipt
   * its own key signed (site-sign's `q` rule). Defaults to this deploy's.
   */
  brand?: Brand;
}): Promise<QuotedZapReceipt | null> {
  try {
    if (!Number.isFinite(args.paidSats) || args.paidSats <= 0) return null;
    const brand = args.brand ?? BRAND;
    const site = siteHexPubkey(brand);
    if (!site) return null;
    const relays = [...new Set(args.relays.filter((r) => r.startsWith('wss://')))].slice(0, 8);
    if (relays.length === 0) return null;
    const amountMsat = Math.floor(args.paidSats) * 1000;

    let payload: { request: Event } | { spec: SummarySpec };
    if (args.as === 'self') {
      const nostr = activeNostr();
      if (!nostr) return null;
      const request = await nostr.signEvent({
        kind: 9734,
        created_at: Math.floor(Date.now() / 1000),
        content: '',
        tags: zapRequestTags({ relays, amountMsat, recipientPubkey: site, refs: args.refs }),
      });
      payload = { request };
    } else {
      payload = { spec: { amountMsat, relays, refs: args.refs } };
    }

    // Another brand's deploy is asked across origins (it answers this one with
    // CORS); when it cannot be reached this is `null` like any other failure,
    // never this deploy's route — its key is not the one the request names.
    const route = brand.id === BRAND.id
      ? '/api/nostr/zap-receipt-sign'
      : `${brand.origin}/api/nostr/zap-receipt-sign`;
    const res = await fetch(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    const { event } = (await res.json()) as { event?: Event };
    // Only a receipt signed by the key the request named — the brand's own site
    // key — is quoted. A note citing a receipt from any other key would claim an
    // attestation that brand never made (and site-sign's `q` rule refuses one).
    if (!event || event.kind !== 9735 || event.pubkey !== site) return null;

    const published = await publishSignedEvent(event, relays);
    // A receipt nobody holds is not worth quoting: the quote would point every
    // reader at an empty answer. Same rule as `assertPublished`, without the
    // throw, because nothing here may fail the boost.
    if (published.acceptedRelays.length === 0) return null;
    return {
      id: event.id,
      pubkey: event.pubkey,
      relays: published.acceptedRelays.slice(0, 3),
    };
  } catch {
    return null;
  }
}
