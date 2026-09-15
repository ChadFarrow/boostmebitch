'use client';
import { useEffect, useMemo, useState } from 'react';
import type { ValueRecipient } from '@/lib/types';
import type { ZapRouting, ZapLegTarget } from '@/lib/v4v/boost';
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
 * A leg qualifies on two answers from the SAME domain: the lnurlp document
 * advertises `allowsNostr` + `nostrPubkey`, and NIP-05 names a pubkey for the
 * address. Both, or the leg pays the ordinary way.
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
): ZapRouting | null {
  const [routing, setRouting] = useState<ZapRouting | null>(null);

  // A stable primitive key, so this re-runs when the ADDRESSES change and not
  // when a parent hands down a fresh array with the same contents — which the
  // boost modal does on every keystroke in the message box.
  const addresses = useMemo(() => {
    const seen = new Set<string>();
    for (const r of recipients) {
      if (!isLnAddressRecipient(r)) continue;
      const a = r.address.trim().toLowerCase();
      if (a) seen.add(a);
      if (seen.size >= MAX_ZAP_LEGS) break;
    }
    return [...seen];
  }, [recipients]);
  const key = addresses.join(',');

  useEffect(() => {
    if (!key) { setRouting(null); return; }
    let live = true;
    (async () => {
      const list = key.split(',');
      const entries = await Promise.all(
        list.map(async (address): Promise<[string, ZapLegTarget] | null> => {
          const [support, recipientPubkey] = await Promise.all([
            lnaddrZapSupport(address),
            resolveNip05(address),
          ]);
          if (!support || !recipientPubkey) return null;
          return [address, { recipientPubkey, meta: support.meta }];
        }),
      );
      if (!live) return;
      const byAddress = new Map(entries.filter((e): e is [string, ZapLegTarget] => e !== null));
      setRouting(byAddress.size ? { byAddress, relays } : null);
    })();
    return () => { live = false; };
    // `key` stands in for `addresses`; `relays` is memoized by both callers.
  }, [key, relays]);

  return routing;
}
