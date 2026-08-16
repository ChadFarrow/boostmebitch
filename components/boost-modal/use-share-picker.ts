'use client';

import { useState } from 'react';
import { storage, type ShareNostrAs } from '@/lib/storage';
import type { NostrIdentity } from '@/lib/nostr';

/**
 * The share-picker state both boost modals run on: whether to post a Nostr note,
 * whose identity signs it, and — derived from those two — whether this boost is
 * ANONYMOUS.
 *
 * Shared because `<BoostModal>` and `<BoostAllModal>` each carried a verbatim
 * copy: the same two `useState`s seeded from the same two storage keys, the same
 * two write-through handlers, and the same `anonymous` expression. That is not a
 * cosmetic duplication. `anonymous` is a promise made to the user on screen, and
 * it has to hold across three separate wire sites (the boostagram's `sender_id`,
 * its `sender_name`, and the note body `formatContent` builds). This app has
 * already shipped that promise broken TWICE, each time because one surface
 * learned a rule the other didn't:
 *
 *   - `sender_id` (the user's pubkey, which recipient aggregators resolve to a
 *     profile picture) rode along on an "anonymous" boost while the note itself
 *     was correctly site-signed.
 *   - `sender_name` then leaked the same way, and `<BoostAllModal>`'s
 *     hand-built summary `contentOverride` leaked it a second time after the
 *     single-boost path was fixed.
 *
 * One definition of `anonymous` is the structural fix for that class of bug.
 *
 * WHY THE `!!identity` GATE IS LOAD-BEARING. Signed out, the picker degrades to
 * a bare checkbox with no anonymous option, every note is site-signed, and the
 * typed "From" name is that note's ONLY attribution. But `bmb:share_nostr_as` is
 * a single GLOBAL key, not per-identity — so without the gate, a user who chose
 * Anonymous while signed in would sign out and silently have their typed name
 * replaced by the default, with no control anywhere on screen to turn it back
 * on. `sender_id` is unaffected by the gate either way: it's `identity?.pubkey`,
 * already absent when signed out.
 *
 * `senderName` is deliberately NOT returned. It needs the modal's own "From"
 * input state, so it stays at the call site as
 * `resolveSenderName(name, anonymous)` — the flag is the invariant worth
 * centralizing; the string is just formatting.
 *
 * Both setters write through to storage on every change, so the choice persists
 * across modal opens. That write-through is why they're handlers rather than the
 * raw setters.
 */
export function useSharePicker(identity: NostrIdentity | null | undefined) {
  const [shareNostr, setShareNostrState] = useState(() => storage.shareNostr.get());
  const [shareAs, setShareAsState] = useState<ShareNostrAs>(() => storage.shareNostrAs.get());

  function setShareNostr(v: boolean) {
    setShareNostrState(v);
    storage.shareNostr.set(v);
  }

  function setShareAs(v: ShareNostrAs) {
    setShareAsState(v);
    storage.shareNostrAs.set(v);
  }

  // "Anonymous" has to anonymize the PAYMENT too, not just who signs the note:
  //  - sender_id is the user's nostr pubkey, which recipient aggregators
  //    (Helipad/Fountain) resolve to their profile — avatar + name.
  //  - sender_name is the "From" field, which recipients display verbatim AND
  //    which formatContent turns into "<name> boosted N sats" in the note body,
  //    so a site-signed "anonymous" note still named the sender.
  // The pubkey is dropped outright; the name is REPLACED by DEFAULT_SENDER_NAME
  // rather than omitted, so an anonymous boost still presents consistently
  // instead of rendering blank in one aggregator and "Unknown" in the next.
  const anonymous = !!identity && shareNostr && shareAs === 'site';

  return { shareNostr, setShareNostr, shareAs, setShareAs, anonymous };
}
