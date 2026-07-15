'use client';

// Shared wallet-balance hook + display components. Used by:
//   - <WalletBalanceChip> inside the AccountMenu trigger button (always-on
//     glance at the top corner)
//   - <BoostModalBalance> inside the boost modal footer (with insufficient-
//     funds coloring when balance < amount-being-sent)
//
// Priority is NWC > Spark in `useWalletBalance` so the displayed balance
// reflects whichever rail actually pays per `pickRail()` in lib/v4v/boost.ts.
//
// Spark: live updates via subscribeSparkEvents (paymentSucceeded /
// claimedDeposits / newDeposits / synced) plus a 2s/5s/12s retry schedule so
// a fresh restore doesn't sit on a stale 0 (mirrors <ReadyPanel>).
//
// NWC: live updates via subscribeNwcNotifications when the wallet supports
// notifications, plus visibilitychange/focus refresh as a fallback for
// wallets that don't. NIP-47 returns msat; helper floors to whole sats.

import { useEffect, useMemo, useState } from 'react';
import type { Rail } from '@/lib/v4v/boost';
import {
  hasSpark,
  sparkGetInfo,
  subscribeSpark,
  subscribeSparkEvents,
} from '@/lib/v4v/spark';
import {
  hasNwc,
  nwcGetBalance,
  subscribeNwc,
  subscribeNwcNotifications,
} from '@/lib/v4v/nwc';
import {
  isWeblnEnabled,
  subscribeWebln,
  weblnGetBalance,
} from '@/lib/v4v/webln';
import {
  hasLibre,
  isLibreRunning,
  libreGetBalance,
  subscribeLibre,
} from '@/lib/v4v/libre';
import { useApp } from '@/lib/store';
import { storage, subscribeRailPref } from '@/lib/storage';

/**
 * Returns the active rail's balance + the rail it came from. Pass a
 * `railOverride` to force a specific rail (e.g. the boost modal passes its
 * picker selection so the displayed balance matches the rail that will pay).
 * When omitted, follows the user's rail pref when that rail is connected,
 * else NWC > Spark > WebLN (WebLN only counted as "ready" once the user has
 * explicitly enabled it via the wallet sub-card, since fetching balance
 * otherwise would prompt them). Mirrors pickRail() in lib/v4v/boost.ts.
 */
export function useWalletBalance(
  railOverride?: Rail | null,
): { balance: number | null; rail: Rail | null } {
  const npub = useApp((s) => s.identity?.npub) ?? null;
  const [sparkReady, setSparkReady] = useState(hasSpark());
  const [nwcReady, setNwcReady] = useState(hasNwc());
  const [weblnReady, setWeblnReady] = useState(isWeblnEnabled());
  const [libreReady, setLibreReady] = useState(isLibreRunning());
  const [balance, setBalance] = useState<number | null>(null);

  const [, setPrefTick] = useState(0);

  useEffect(() => {
    const unsubSpark = subscribeSpark(() => setSparkReady(hasSpark()));
    const unsubNwc = subscribeNwc(() => setNwcReady(hasNwc()));
    const unsubWebln = subscribeWebln(() => setWeblnReady(isWeblnEnabled()));
    const unsubLibre = subscribeLibre(() => setLibreReady(isLibreRunning()));
    // Rail-pref switches change the effective rail without any readiness
    // flag moving — bump so the chip re-resolves and refetches.
    const unsubPref = subscribeRailPref(() => setPrefTick((t) => t + 1));
    return () => { unsubSpark(); unsubNwc(); unsubWebln(); unsubLibre(); unsubPref(); };
  }, []);

  // Resolve effective rail. If the caller forced one, we still gate on it
  // being actually available; an override that points at a disconnected
  // rail collapses to null so the chip hides instead of showing a stale 0.
  let rail: Rail | null;
  if (railOverride === undefined) {
    const pref = storage.railPref.get();
    rail =
      (pref === 'nwc' && nwcReady) || (pref === 'spark' && sparkReady)
      || (pref === 'libre' && libreReady) || (pref === 'webln' && weblnReady)
        ? pref
        : nwcReady ? 'nwc'
        : sparkReady ? 'spark'
        : libreReady ? 'libre'
        // While opted into Libre, window.webln IS the Libre provider —
        // never surface it under the WebLN label (mirrors pickRail).
        : weblnReady && !hasLibre() ? 'webln'
        : null;
  } else if (railOverride === 'nwc') {
    rail = nwcReady ? 'nwc' : null;
  } else if (railOverride === 'spark') {
    rail = sparkReady ? 'spark' : null;
  } else if (railOverride === 'libre') {
    rail = libreReady ? 'libre' : null;
  } else if (railOverride === 'webln') {
    rail = weblnReady ? 'webln' : null;
  } else {
    rail = null;
  }

  useEffect(() => {
    setBalance(null);
    if (rail === null) return;
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    const refresh = async () => {
      if (cancelled) return;
      if (rail === 'spark') {
        const info = await sparkGetInfo();
        if (!cancelled && info) setBalance(info.balanceSats);
      } else if (rail === 'nwc') {
        const sats = await nwcGetBalance();
        if (!cancelled && sats !== null) setBalance(sats);
      } else if (rail === 'libre') {
        const sats = await libreGetBalance();
        if (!cancelled && sats !== null) setBalance(sats);
      } else {
        const sats = await weblnGetBalance();
        if (!cancelled && sats !== null) setBalance(sats);
      }
    };

    if (rail === 'spark') {
      let unsubEvents: (() => void) | null = null;
      const retryTimers: ReturnType<typeof setTimeout>[] = [];
      subscribeSparkEvents((e) => {
        if (e.type === 'paymentSucceeded'
          || e.type === 'claimedDeposits'
          || e.type === 'newDeposits'
          || e.type === 'synced') {
          refresh();
        }
      }).then((fn) => {
        if (cancelled) { fn(); return; }
        unsubEvents = fn;
        refresh();
        for (const delay of [2000, 5000, 12000]) {
          retryTimers.push(setTimeout(refresh, delay));
        }
      });
      cleanups.push(() => {
        retryTimers.forEach(clearTimeout);
        if (unsubEvents) unsubEvents();
      });
    } else if (rail === 'nwc') {
      let unsubNotifs: (() => void) | null = null;
      refresh();
      subscribeNwcNotifications((e) => {
        if (e.notification_type === 'payment_received' || e.notification_type === 'payment_sent') {
          refresh();
        }
      }).then((fn) => {
        if (cancelled) { fn(); return; }
        unsubNotifs = fn;
      });
      const onFocus = () => { if (document.visibilityState === 'visible') refresh(); };
      document.addEventListener('visibilitychange', onFocus);
      window.addEventListener('focus', onFocus);
      cleanups.push(() => {
        if (unsubNotifs) unsubNotifs();
        document.removeEventListener('visibilitychange', onFocus);
        window.removeEventListener('focus', onFocus);
      });
    } else if (rail === 'libre') {
      // Libre: same shape as WebLN — the libre observable fires on state
      // transitions and after every payment we send through it.
      refresh();
      const unsubLibre = subscribeLibre(refresh);
      const onFocus = () => { if (document.visibilityState === 'visible') refresh(); };
      document.addEventListener('visibilitychange', onFocus);
      window.addEventListener('focus', onFocus);
      cleanups.push(() => {
        unsubLibre();
        document.removeEventListener('visibilitychange', onFocus);
        window.removeEventListener('focus', onFocus);
      });
    } else {
      // WebLN: no notifications API. Refresh on tab return + every webln
      // event we emit (post-payment notify, enable transitions).
      refresh();
      const unsubWebln = subscribeWebln(refresh);
      const onFocus = () => { if (document.visibilityState === 'visible') refresh(); };
      document.addEventListener('visibilitychange', onFocus);
      window.addEventListener('focus', onFocus);
      cleanups.push(() => {
        unsubWebln();
        document.removeEventListener('visibilitychange', onFocus);
        window.removeEventListener('focus', onFocus);
      });
    }

    return () => {
      cancelled = true;
      cleanups.forEach((fn) => fn());
    };
  }, [rail]);

  // Cache successful fetches per-npub so the next page load can paint the
  // chip instantly while the SDK / NWC client reconnects in the background.
  // The Breez Spark restore alone (relay query for kind:30078 → NIP-44
  // decrypt → WASM load → SDK connect → initial sync) routinely takes 5-10 s
  // on cold load, which leaves the chip blank for far too long otherwise.
  useEffect(() => {
    if (balance !== null && rail !== null) {
      storage.walletBalance.set(npub, rail, balance);
    }
  }, [balance, rail, npub]);

  // Fall back to the cached value while the live balance hasn't landed yet.
  // Two cases we honor the cache:
  //   1. Cold load (rail === null) — we don't yet know which rail will come
  //      online; trust the cache's rail + balance to paint the chip.
  //   2. Live rail is set but its first fetch hasn't returned yet AND the
  //      cached rail matches — show the last-known balance for that rail.
  // We never pair the cached balance with a *different* live rail (e.g.
  // showing a stale Spark balance after the user just disconnected Spark
  // and only NWC remains) — that would be actively misleading.
  const cached = useMemo(() => {
    const c = storage.walletBalance.get(npub);
    if (!c) return null;
    if (railOverride && c.rail !== railOverride) return null;
    return c;
  }, [npub, railOverride]);

  let displayBalance: number | null = null;
  let displayRail: Rail | null = null;
  if (rail !== null) {
    displayRail = rail;
    if (balance !== null) displayBalance = balance;
    else if (cached && cached.rail === rail) displayBalance = cached.balance;
  } else if (cached) {
    // WebLN session state resets on page reload, so a cached webln balance
    // is only valid if WebLN is currently enabled.
    if (cached.rail !== 'webln' || weblnReady) {
      displayRail = cached.rail;
      displayBalance = cached.balance;
    }
  }

  return { balance: displayBalance, rail: displayRail };
}

const RAIL_NAMES: Record<Rail, string> = {
  nwc: 'NWC',
  spark: 'Spark',
  webln: 'WebLN',
  libre: 'Libre',
};

/** Compact balance pill for the header. Hidden when no rail is connected. */
export function WalletBalanceChip() {
  const { balance, rail } = useWalletBalance();
  if (rail === null || balance === null) return null;
  const formatted = balance.toLocaleString();
  const railName = RAIL_NAMES[rail];
  return (
    <span
      className="text-bolt text-[11px] font-mono tabular-nums whitespace-nowrap"
      title={`${formatted} sats (${railName})`}
    >
      ⚡{formatted}
    </span>
  );
}

/**
 * Balance display for the boost modal footer. Shows the user-selected rail's
 * balance (so it tracks the boost-modal picker, not the global priority
 * order), switching to nostr-magenta when `amountSats > balance`. Hidden when
 * no rail is connected (the modal already surfaces a "no wallet connected"
 * hint elsewhere).
 */
export function BoostModalBalance({
  amountSats,
  rail: railOverride,
}: {
  amountSats: number;
  rail: Rail | null;
}) {
  const { balance, rail } = useWalletBalance(railOverride);
  if (rail === null || balance === null) return null;
  const insufficient = amountSats > balance;
  const railName = RAIL_NAMES[rail];
  return (
    <span
      className={`text-[11px] font-mono tabular-nums whitespace-nowrap ${
        insufficient ? 'text-nostr' : 'text-muted'
      }`}
      title={`${balance.toLocaleString()} sats available on ${railName}`}
    >
      <span className={insufficient ? 'text-nostr' : 'text-bolt'}>⚡</span>
      {balance.toLocaleString()}
    </span>
  );
}
