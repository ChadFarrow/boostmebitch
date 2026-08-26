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
//
// The NWC number is `nwcGetSpendable()`, NOT `get_balance` — on a connection
// to your own node the wallet's balance is the NODE's, while the grant this
// app holds is whatever budget the connection was created with. Showing the
// balance there advertised nine million spendable sats over a budget that
// would refuse the next boost.

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
  nwcGetSpendable,
  subscribeNwc,
  subscribeNwcNotifications,
  type NwcBudget,
} from '@/lib/v4v/nwc';
import {
  isWeblnEnabled,
  subscribeWebln,
  weblnGetBalance,
} from '@/lib/v4v/webln';
import { useApp } from '@/lib/store';
import { storage, subscribeRailPref } from '@/lib/storage';

/**
 * How long to sit on event-driven balance refreshes before firing one.
 *
 * Sized against two things: a multi-leg boost's `payment_sent` burst, which it
 * must collapse, and the Spark retry ladder (2s/5s/12s), whose gaps it must
 * stay below so those still land as three separate reads.
 */
const BALANCE_DEBOUNCE_MS = 1200;

/**
 * Stands in for a budget we know applies but haven't re-read yet — the cached
 * paint on page load. Every figure is 0 because none of them is known; the
 * surfaces below render the caveat off `budget !== null` and only print the
 * numbers when `totalSats > 0`.
 */
const PLACEHOLDER_BUDGET: NwcBudget = { usedSats: 0, totalSats: 0, remainingSats: 0 };

/**
 * Returns the active rail's balance + the rail it came from. Pass a
 * `railOverride` to force a specific rail (e.g. the boost modal passes its
 * picker selection so the displayed balance matches the rail that will pay).
 * When omitted, follows the user's rail pref when that rail is connected,
 * else NWC > Spark > WebLN (WebLN only counted as "ready" once the user has
 * explicitly enabled it via the wallet sub-card, since fetching balance
 * otherwise would prompt them). Mirrors pickRail() in lib/v4v/boost.ts.
 *
 * `balance` is what the rail can SEND, which on NWC is the smaller of the
 * wallet's balance and the connection's remaining budget. `budget` is non-null
 * only when that budget is the BINDING limit, so a surface can say why the
 * number is smaller than the wallet holds; it is always null on Spark and
 * WebLN, neither of which has such a grant.
 */
export function useWalletBalance(
  railOverride?: Rail | null,
): { balance: number | null; rail: Rail | null; budget: NwcBudget | null } {
  const npub = useApp((s) => s.identity?.npub) ?? null;
  const [sparkReady, setSparkReady] = useState(hasSpark());
  const [nwcReady, setNwcReady] = useState(hasNwc());
  const [weblnReady, setWeblnReady] = useState(isWeblnEnabled());
  const [balance, setBalance] = useState<number | null>(null);
  const [budget, setBudget] = useState<NwcBudget | null>(null);

  const [, setPrefTick] = useState(0);

  useEffect(() => {
    const unsubSpark = subscribeSpark(() => setSparkReady(hasSpark()));
    const unsubNwc = subscribeNwc(() => setNwcReady(hasNwc()));
    const unsubWebln = subscribeWebln(() => setWeblnReady(isWeblnEnabled()));
    // Rail-pref switches change the effective rail without any readiness
    // flag moving — bump so the chip re-resolves and refetches.
    const unsubPref = subscribeRailPref(() => setPrefTick((t) => t + 1));
    return () => { unsubSpark(); unsubNwc(); unsubWebln(); unsubPref(); };
  }, []);

  // Resolve effective rail. If the caller forced one, we still gate on it
  // being actually available; an override that points at a disconnected
  // rail collapses to null so the chip hides instead of showing a stale 0.
  let rail: Rail | null;
  if (railOverride === undefined) {
    const pref = storage.railPref.get();
    rail =
      (pref === 'nwc' && nwcReady) || (pref === 'spark' && sparkReady) || (pref === 'webln' && weblnReady)
        ? pref
        : nwcReady ? 'nwc' : sparkReady ? 'spark' : weblnReady ? 'webln' : null;
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
    setBudget(null);
    if (rail === null) return;
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    const refresh = async () => {
      if (cancelled) return;
      if (rail === 'spark') {
        const info = await sparkGetInfo();
        if (!cancelled && info) setBalance(info.balanceSats);
      } else if (rail === 'nwc') {
        const spendable = await nwcGetSpendable();
        if (!cancelled && spendable !== null) {
          setBalance(spendable.sats);
          // Only when the BUDGET is what caps the number. A connection with a
          // 100k budget over a 5k wallet is showing 5k for the ordinary
          // reason, and calling that a budget would explain it wrongly.
          setBudget(spendable.budgetLimited ? spendable.budget : null);
        }
      } else {
        const sats = await weblnGetBalance();
        if (!cancelled && sats !== null) setBalance(sats);
      }
    };

    // Event-driven refreshes are debounced; the first read of each rail stays
    // immediate so the chip paints without a delay.
    //
    // A boost pays its legs serially and the wallet pushes a `payment_sent`
    // per leg, so a ten-recipient boost used to fire ten balance reads — and
    // this hook is mounted twice while boosting (header chip + boost modal),
    // making it twenty. Each read opens a NIP-47 connection, so that burst was
    // the single largest contributor to the socket leak that took payments
    // down mid-session (see lib/v4v/nwc.ts:client). Closing the clients bounds
    // it; collapsing the burst means we don't open twenty in the first place.
    //
    // Trailing edge, and deliberately shorter than the gaps in the Spark retry
    // ladder below (2s/5s/12s) so those still land as three separate reads.
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (cancelled) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { debounce = null; void refresh(); }, BALANCE_DEBOUNCE_MS);
    };
    cleanups.push(() => { if (debounce) clearTimeout(debounce); });

    if (rail === 'spark') {
      let unsubEvents: (() => void) | null = null;
      const retryTimers: ReturnType<typeof setTimeout>[] = [];
      subscribeSparkEvents((e) => {
        if (e.type === 'paymentSucceeded'
          || e.type === 'claimedDeposits'
          || e.type === 'newDeposits'
          || e.type === 'synced') {
          scheduleRefresh();
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
          scheduleRefresh();
        }
      }).then((fn) => {
        if (cancelled) { fn(); return; }
        unsubNotifs = fn;
      });
      const onFocus = () => { if (document.visibilityState === 'visible') scheduleRefresh(); };
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
      const unsubWebln = subscribeWebln(scheduleRefresh);
      const onFocus = () => { if (document.visibilityState === 'visible') scheduleRefresh(); };
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
      storage.walletBalance.set(npub, rail, balance, budget !== null);
    }
  }, [balance, rail, npub, budget]);

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

  // A cached value paints before the first read lands, and it may be a
  // budget-capped number — so the cache records that it was, and the surface
  // keeps saying so. Dropping the caveat for the second it takes the live read
  // to arrive would flash "this is your wallet balance" over a number that
  // isn't one.
  const displayBudget =
    budget ?? (balance === null && cached?.limited && displayRail === 'nwc'
      ? PLACEHOLDER_BUDGET
      : null);

  return { balance: displayBalance, rail: displayRail, budget: displayBudget };
}


/**
 * How a budget-capped number is described, in one place, because both
 * surfaces below say it and a boost that fails for budget reasons must not be
 * explained two different ways.
 */
export function budgetTitle(budget: NwcBudget): string {
  if (budget.totalSats <= 0) return 'Limited by this connection\u2019s spending budget';
  const period = budget.renewalPeriod && budget.renewalPeriod !== 'never'
    ? `, renews ${budget.renewalPeriod}`
    : '';
  return `${budget.remainingSats.toLocaleString()} of ${budget.totalSats.toLocaleString()} sats left in this app\u2019s NWC budget${period}`;
}

/**
 * Compact balance pill for the header. Hidden when no rail is connected.
 *
 * A budget-capped number carries a `≤` prefix — "you may spend at most this",
 * which is what a budget remainder is. One character, because the header has
 * no width to spare (see the `<AppHeader>` rule in CLAUDE.md), and a marker at
 * all because the number otherwise silently means something different from the
 * balance the user reads in their own wallet app: a chip showing 2,340 beside
 * a node holding 9,017,493 reads as a bug. `~` was the first draft and says
 * the wrong thing — the figure is exact, it is the ceiling that is the news.
 */
export function WalletBalanceChip() {
  const { balance, rail, budget } = useWalletBalance();
  if (rail === null || balance === null) return null;
  const formatted = balance.toLocaleString();
  const railName = rail === 'nwc' ? 'NWC' : rail === 'webln' ? 'WebLN' : 'Spark';
  const title = budget
    ? `${formatted} sats spendable (${railName}) \u2014 ${budgetTitle(budget)}`
    : `${formatted} sats (${railName})`;
  return (
    // No ⚡ here: the only call site (<AuthControl>) already renders one in the
    // button, and it has to stay there — this component returns null whenever
    // the balance is unknown (WebLN exposes none, and every rail is null mid-
    // reconnect), and that lone bolt is what still reads as "connected".
    // Rendering one in both gave the chip two.
    <span
      className="text-bolt text-[11px] font-mono tabular-nums whitespace-nowrap"
      title={title}
    >
      {budget ? '\u2264' : ''}{formatted}
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
  const { balance, rail, budget } = useWalletBalance(railOverride);
  if (rail === null || balance === null) return null;
  // The insufficient test runs against the SPENDABLE number, so a boost the
  // connection's budget would refuse is flagged here rather than at the
  // wallet — the point of reading the budget at all.
  const insufficient = amountSats > balance;
  const railName = rail === 'nwc' ? 'NWC' : rail === 'spark' ? 'Spark' : 'WebLN';
  return (
    <span
      className={`text-[11px] font-mono tabular-nums whitespace-nowrap ${
        insufficient ? 'text-nostr' : 'text-muted'
      }`}
      title={budget
        ? `${balance.toLocaleString()} sats spendable on ${railName} \u2014 ${budgetTitle(budget)}`
        : `${balance.toLocaleString()} sats available on ${railName}`}
    >
      <span className={insufficient ? 'text-nostr' : 'text-bolt'}>⚡</span>
      {balance.toLocaleString()}
      {/* The modal has room for the word, so it says it rather than wearing
          the chip's `≤` — a symbol beside a spelt-out caveat is noise. */}
      {budget && <span className="ml-1 text-muted/70">budget</span>}
    </span>
  );
}
