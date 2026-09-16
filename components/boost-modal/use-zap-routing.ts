'use client';
import { useEffect, useMemo, useState } from 'react';
import type { ValueRecipient } from '@/lib/types';
import { zapRoutingKey, type ZapRouting, type ZapLegTarget } from '@/lib/v4v/boost';
import { lnaddrZapSupport } from '@/lib/v4v/zap';
import { resolveNip05 } from '@/lib/nostr/nip05';
import { isLnAddressRecipient } from '@/lib/util';

/**
 * Which of a boost's lnaddress legs can go out as a real NIP-57 zap.
 *
 * WHY A BOOST WANTS ONE AT ALL. Fountain renders a boost's sat amount from a
 * quoted kind:9735 receipt. Only the recipient's own LNURL server can publish
 * one, and only for a payment made as a zap — so a leg that wants to be
 * readable there has to be paid that way. See lib/nostr/zap-receipt-match.ts.
 *
 * A leg qualifies on ONE answer: the lnurlp document advertises `allowsNostr` +
 * `nostrPubkey`. That key is who signs the receipt, and it is what the zap
 * request's `p` tag names when nothing better is known — which is exactly what
 * Fountain writes: both receipts captured in lib/nostr/zap-request.ts carry
 * `["p", <Fountain's own nostrPubkey>]`, from two different senders. NIP-05 is
 * asked too, and PREFERRED when it answers, because it names the artist's own
 * pubkey and so lands the receipt in their zap feed rather than the provider's.
 *
 * It used to be REQUIRED, and that rule silently disabled the feature for the
 * commonest host in a value block: `podcastindex@getalby.com` advertises
 * `allowsNostr` and has no NIP-05 name (measured 2026-09-16 — Alby answers 404
 * for a name with none set, 200 for `chadf`), so every such leg paid the
 * ordinary way and quoted nothing. Alby's callback was then asked for an
 * invoice with `p` set to its own nostrPubkey and it issued one, so the
 * fallback is a shape the provider accepts, not a guess.
 *
 * PREFETCHED WHILE THE MODAL IS OPEN, which is the point. Two GETs per address
 * on the money path would sit in front of the payment with the user watching a
 * SENDING… button; here they run while the amount is still being chosen. It is
 * deliberately NOT a gate on the send button, unlike `useActiveSplit`: a lookup
 * that has not landed costs the quoted receipt, not a payment to the wrong
 * person, so the send proceeds without it.
 *
 * It also does not consult the share picker. That gate lives at the send site,
 * because it decides whether to USE this — a zap request is signed by the user's
 * key, so an anonymous boost must not take the path. Resolving the pairing is
 * two reads at a host we are about to pay either way and carries no identity.
 */

/**
 * Cap on addresses probed per boost. A value block with more lnaddress payees
 * than this still pays them all; the tail just pays the ordinary way. The cap
 * exists because this fans out two requests per address at once, and a feed
 * chooses the list.
 */
const MAX_ZAP_LEGS = 8;

export function useZapRouting(
  recipients: ValueRecipient[],
  relays: string[],
  /**
   * The send-site gate (`mayZap`), so the lookups only run when their answer
   * can be used. Without it a signed-out or Anonymous boost fired two GETs per
   * address — a NIP-05 lookup among them, a request this app otherwise never
   * makes — and discarded every one.
   */
  enabled: boolean,
): ZapRouting | null {
  const [routing, setRouting] = useState<ZapRouting | null>(null);

  // A stable primitive key, so this re-runs when the ADDRESSES change and not
  // when a parent hands down a fresh array with the same contents — which the
  // boost modal does on every keystroke in the message box.
  const addresses = useMemo(() => {
    const seen = new Set<string>();
    for (const r of recipients) {
      if (!isLnAddressRecipient(r)) continue;
      // The same normalizer `payOne` looks the table up with. Two spellings of
      // "lowercase the address" is a key that never matches its own entry.
      const a = zapRoutingKey(r.address);
      if (a) seen.add(a);
      if (seen.size >= MAX_ZAP_LEGS) break;
    }
    return [...seen];
  }, [recipients]);
  const key = addresses.join(',');

  useEffect(() => {
    if (!key || !enabled) { setRouting(null); return; }
    let live = true;
    (async () => {
      const list = key.split(',');
      const entries = await Promise.all(
        list.map(async (address): Promise<[string, ZapLegTarget] | null> => {
          const [support, nip05Pubkey] = await Promise.all([
            lnaddrZapSupport(address),
            resolveNip05(address),
          ]);
          if (!support) return null;
          // NIP-05 first, the provider's own key otherwise — see the header.
          const recipientPubkey = nip05Pubkey ?? support.nostrPubkey;
          return [address, { recipientPubkey, meta: support.meta }];
        }),
      );
      if (!live) return;
      const byAddress = new Map(entries.filter((e): e is [string, ZapLegTarget] => e !== null));
      setRouting(byAddress.size ? { byAddress, relays } : null);
    })();
    return () => { live = false; };
    // `key` stands in for `addresses`; `relays` is memoized by both callers.
  }, [key, relays, enabled]);

  return routing;
}
