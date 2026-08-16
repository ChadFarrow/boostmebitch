'use client';

import { useEffect, useRef } from 'react';
import { subscribeNwc } from './v4v/nwc';
import { subscribeSpark } from './v4v/spark';
import { subscribeWebln } from './v4v/webln';
import { subscribeRailPref } from './storage';

/**
 * Run `onChange` whenever the user's wallet situation changes — a rail
 * connecting or disconnecting, and optionally a change to the stored rail
 * preference.
 *
 * WHY THIS IS SHARED, AND WHAT IT FIXED. Four components hand-rolled this same
 * subscribe/unsubscribe-all effect, and they had drifted into three different
 * subscription sets:
 *
 *     auth-control     nwc spark webln railPref
 *     wallet-balance   nwc spark webln railPref
 *     wallet-modal     nwc spark webln
 *     BoostModal       nwc spark                 ← missing webln
 *     BoostAllModal    nwc spark                 ← missing webln
 *
 * The two at the bottom are the ones that spend money. Both render
 * `<RailPicker>`, whose `availableRails()` reads `hasNwc()`, `hasSpark()` AND
 * `hasWebln()` during render — and whose own doc comment claimed "both modals
 * re-render on subscribeNwc/subscribeSpark, so a wallet connected mid-modal
 * shows up without a remount". That was simply false for the third rail: a
 * WebLN extension becoming available while a boost modal sat open produced no
 * re-render, so the WebLN button never appeared and `pickRail()` was never
 * re-run. The user could not choose the wallet they had just enabled, and
 * nothing on screen explained why. Subscribing to all three here is what makes
 * that comment true.
 *
 * `railPref` is OPT-IN (`opts.railPref`) rather than always-on, because the
 * surfaces divide cleanly: a component that *displays* the effective rail
 * (the balance chip, the account-menu summary) must re-resolve when the
 * preference moves, while the boost modals own their `rail` in local state via
 * the picker and would be fighting the user's explicit per-boost override.
 *
 * The callback is held in a ref so callers can pass an inline closure without
 * re-subscribing on every render — resubscribing here means tearing down and
 * reopening four observable registrations, and `subscribeNwc` in particular is
 * how the modal learns about a wallet that connected a moment ago.
 */
export function useWalletChange(
  onChange: () => void,
  opts?: { railPref?: boolean },
): void {
  const cb = useRef(onChange);
  cb.current = onChange;

  const withRailPref = opts?.railPref ?? false;

  useEffect(() => {
    const bump = () => cb.current();
    const unsubs = [
      subscribeNwc(bump),
      subscribeSpark(bump),
      subscribeWebln(bump),
      ...(withRailPref ? [subscribeRailPref(bump)] : []),
    ];
    return () => { for (const u of unsubs) u(); };
  }, [withRailPref]);
}
