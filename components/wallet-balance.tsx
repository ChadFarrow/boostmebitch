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

import { useEffect, useState } from 'react';
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

/**
 * Returns the active rail's balance + the rail it came from. Pass a
 * `railOverride` to force a specific rail (e.g. the boost modal passes its
 * picker selection so the displayed balance matches the rail that will pay).
 * When omitted, falls back to NWC > Spark > WebLN (only counted as "ready"
 * once the user has explicitly enabled it via the wallet sub-card, since
 * fetching balance otherwise would prompt them).
 */
export function useWalletBalance(
  railOverride?: Rail | null,
): { balance: number | null; rail: Rail | null } {
  const [sparkReady, setSparkReady] = useState(hasSpark());
  const [nwcReady, setNwcReady] = useState(hasNwc());
  const [weblnReady, setWeblnReady] = useState(isWeblnEnabled());
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    const unsubSpark = subscribeSpark(() => setSparkReady(hasSpark()));
    const unsubNwc = subscribeNwc(() => setNwcReady(hasNwc()));
    const unsubWebln = subscribeWebln(() => setWeblnReady(isWeblnEnabled()));
    return () => { unsubSpark(); unsubNwc(); unsubWebln(); };
  }, []);

  // Resolve effective rail. If the caller forced one, we still gate on it
  // being actually available; an override that points at a disconnected
  // rail collapses to null so the chip hides instead of showing a stale 0.
  let rail: Rail | null;
  if (railOverride === undefined) {
    rail = nwcReady ? 'nwc' : sparkReady ? 'spark' : weblnReady ? 'webln' : null;
  } else if (railOverride === 'nwc') {
    rail = nwcReady ? 'nwc' : null;
  } else if (railOverride === 'spark') {
    rail = sparkReady ? 'spark' : null;
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

  return { balance, rail };
}

/** Compact balance pill for the header. Hidden when no rail is connected. */
export function WalletBalanceChip() {
  const { balance, rail } = useWalletBalance();
  if (rail === null || balance === null) return null;
  const formatted = balance.toLocaleString();
  const railName = rail === 'nwc' ? 'NWC' : 'Spark';
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
  const railName = rail === 'nwc' ? 'NWC' : rail === 'spark' ? 'Spark' : 'WebLN';
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
