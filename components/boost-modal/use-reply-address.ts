'use client';
import { useEffect, useState } from 'react';
import type { NostrIdentity } from '@/lib/nostr';
import { lookupReplyTarget, replyFieldsFor, type ReplyFields } from '@/lib/v4v/keysend-lookup';

/**
 * The boostagram fields naming where this user can be sent a reply boost, or
 * `{}` when there is nowhere to send one.
 *
 * Helipad only offers a Reply button when the boostagram it received carries a
 * node it can keysend to, so this resolves the signed-in user's own lightning
 * address — `lud16` on their kind:0 — to that node. There is deliberately no
 * input for it: the address is already published on the profile every other
 * client reads, and a second copy in `localStorage` would be one more place to
 * go stale.
 *
 * **It must never gate the send button.** `useActiveSplit`'s `'loading'` state
 * is a money gate, because a boost sent before it resolves pays the wrong
 * person. This one is not: the worst an unresolved lookup costs is a boost
 * that carries no reply address, which is exactly what every boost carried
 * before this existed. So there is no loading state to read, nothing here is
 * awaited inside `go()`, and a slow provider delays nothing.
 *
 * The lookup is an OPTIMISATION, not a requirement. `replyFieldsFor` falls back
 * to the raw lightning address, which a receiver resolves for itself, so a
 * provider with no keysend document still gets a reply address. Resolving it
 * here is worth doing anyway: a pubkey is the only form an older receiver
 * understands.
 *
 * `lud06` is deliberately not a fallback. It is a bech32-encoded LNURL with no
 * `name@domain` to hand over or to build a `.well-known/keysend` path from.
 */
export function useReplyAddress(identity: NostrIdentity | null | undefined): ReplyFields {
  // Trimmed and lowercased here so a profile written with stray whitespace or
  // mixed case doesn't re-fire the effect against what is the same address.
  const address = identity?.profile?.lud16?.trim().toLowerCase() || '';
  const [fields, setFields] = useState<ReplyFields>({});

  useEffect(() => {
    if (!address) {
      setFields({});
      return;
    }
    let cancelled = false;
    // Not cleared first: while a re-resolve is in flight the previous answer is
    // still the right one, and blanking it would open a window where a boost
    // sent mid-lookup silently loses a reply address we already had.
    lookupReplyTarget(address)
      .then((target) => {
        if (!cancelled) setFields(replyFieldsFor(target, address));
      })
      // lookupReplyTarget never throws, but a caller that assumes so and is
      // wrong loses the fields silently — say what the empty result means.
      .catch(() => {
        // Still offer the address itself — the lookup failing says nothing
        // about whether the recipient can resolve it.
        if (!cancelled) setFields(replyFieldsFor(null, address));
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  return address ? fields : {};
}
