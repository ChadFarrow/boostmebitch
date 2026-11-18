'use client';
import { useEffect, useRef, useState } from 'react';
import { checkLeg, resendLeg, type BoostResult, type LegVerdict } from '@/lib/v4v/boost';

/**
 * The single BOOST panel's answer to a `?` leg: ask the NWC wallet about that
 * payment by its hash, and offer RETRY only once the wallet says it FAILED —
 * then pay the SAME hash again, which a node that already took it refuses.
 * docs/money-boosts.md, "The unanswered wallet".
 *
 * A leg is asked about (`checkAll`) when the send or a retry has finished, each
 * time the app comes back to the front (`visibilitychange`, and `resume` after a
 * frozen page), and every `PENDING_RECHECK_MS` while the wallet says "pending",
 * `PENDING_RECHECKS` times at most. Asking pays nothing. A check or a resend does
 * not START while a send or a "Retry N failed" is going; one that started before
 * finishes and writes its own leg into the CURRENT array, which every writer
 * re-reads at write time, and "Retry N failed" never takes a leg with `nwcCheck`.
 *
 * `resending` is true while a RETRY payment is moving: the panel must not close
 * by accident then (Escape, a backdrop press), or the result is dropped and a
 * leg that paid stays `?` in the log. A refused RETRY keeps its reason in
 * `retryErrors` until the leg is paid, so the line says why — the wallet's
 * lookup will say "failed" again, and RETRY alone would repeat the refusal.
 */

/** `p:<index>` for the track's (or the whole boost's) block, `h:<index>` for the show's share. */
export type LegKey = `${'p' | 'h'}:${number}`;

export type LegView =
  | { state: 'checking' }
  | { state: 'resending' }
  | { state: 'pending'; tries: number }
  | { state: 'failed' }
  | { state: 'unknown'; why: Extract<LegVerdict, { state: 'unknown' }>['why'] };

export const PENDING_RECHECK_MS = 15_000;
export const PENDING_RECHECKS = 8;

/** A leg the wallet never answered, that we know how to ask about. */
export function isCheckable(r: BoostResult | undefined): r is BoostResult {
  return !!r && !r.ok && !!r.indeterminate && !!r.nwcCheck;
}

/**
 * The leg as PAID: a `paid` verdict, or a resend that was answered. No error,
 * no `nwcCheck` (it is settled, so nothing will ask about it or pay it again).
 */
function paidLeg(r: BoostResult): BoostResult {
  return { recipient: r.recipient, sats: r.sats, ok: true, boostboxUrl: r.boostboxUrl, boostboxId: r.boostboxId };
}

export function useUnconfirmedLegs(args: {
  /** Every settled leg of the boost as sent, by key — read when a check runs. */
  legs: () => { key: LegKey; result: BoostResult }[];
  /** A send or a "Retry N failed" is running. */
  busy: () => boolean;
  /** Write a leg's new result: `paid` from a check, or whatever a resend returned. */
  write: (key: LegKey, next: BoostResult, how: 'check' | 'resend') => void;
}) {
  const [views, setViews] = useState<Partial<Record<LegKey, LegView>>>({});
  const viewsRef = useRef(views);
  const [retryErrors, setRetryErrors] = useState<Partial<Record<LegKey, string>>>({});
  const retryErrorsRef = useRef(retryErrors);
  const argsRef = useRef(args);
  argsRef.current = args;
  const timers = useRef(new Map<LegKey, ReturnType<typeof setTimeout>>());
  const mounted = useRef(true);

  // The check functions live in a ref, so the event listeners below and the
  // pending timers always call the newest ones.
  const api = useRef({
    setView(key: LegKey, v: LegView | null) {
      const next = { ...viewsRef.current };
      if (v) next[key] = v;
      else delete next[key];
      viewsRef.current = next;
      if (mounted.current) setViews(next);
    },
    setRetryError(key: LegKey, error: string | null) {
      const next = { ...retryErrorsRef.current };
      if (error !== null) next[key] = error;
      else delete next[key];
      retryErrorsRef.current = next;
      if (mounted.current) setRetryErrors(next);
    },
    clearTimer(key: LegKey) {
      const t = timers.current.get(key);
      if (t !== undefined) clearTimeout(t);
      timers.current.delete(key);
    },
    find(key: LegKey): BoostResult | undefined {
      return argsRef.current.legs().find((l) => l.key === key)?.result;
    },
    async check(key: LegKey) {
      const a = api.current;
      if (argsRef.current.busy()) return;
      const leg = a.find(key);
      if (!isCheckable(leg)) {
        a.setView(key, null);
        return;
      }
      const cur = viewsRef.current[key];
      if (cur?.state === 'checking' || cur?.state === 'resending') return;
      a.clearTimer(key);
      const tries = cur?.state === 'pending' ? cur.tries : 0;
      a.setView(key, { state: 'checking' });
      const v = await checkLeg(leg);
      if (!mounted.current) return;
      if (v.state === 'paid') {
        a.setView(key, null);
        a.setRetryError(key, null);
        argsRef.current.write(key, paidLeg(leg), 'check');
      } else if (v.state === 'pending') {
        const n = tries + 1;
        a.setView(key, { state: 'pending', tries: n });
        if (n < PENDING_RECHECKS) {
          timers.current.set(key, setTimeout(() => {
            timers.current.delete(key);
            void api.current.check(key);
          }, PENDING_RECHECK_MS));
        }
      } else if (v.state === 'failed') {
        a.setView(key, { state: 'failed' });
      } else {
        a.setView(key, { state: 'unknown', why: v.why });
      }
    },
    /** Ask about every `?` leg that is not being asked about, resent, or waiting for RETRY. */
    checkAll() {
      if (argsRef.current.busy()) return;
      for (const { key, result } of argsRef.current.legs()) {
        if (!isCheckable(result)) continue;
        const cur = viewsRef.current[key];
        if (cur?.state === 'checking' || cur?.state === 'resending' || cur?.state === 'failed') continue;
        void api.current.check(key);
      }
    },
    /**
     * RETRY: only for a leg the wallet said FAILED, and only under its first
     * payment hash (`resendLeg`). A resend that is not answered either is asked
     * about again; it is never offered to "Retry N failed".
     */
    async resend(key: LegKey) {
      const a = api.current;
      if (argsRef.current.busy() || viewsRef.current[key]?.state !== 'failed') return;
      const leg = a.find(key);
      if (!isCheckable(leg)) return;
      a.setView(key, { state: 'resending' });
      const next = await resendLeg(leg);
      if (!mounted.current) return;
      a.setView(key, null);
      a.setRetryError(key, next.ok ? null : (next.error ?? ''));
      argsRef.current.write(key, next, 'resend');
      if (!next.ok) void a.check(key);
    },
  });

  useEffect(() => {
    mounted.current = true;
    const t = timers.current;
    // Back to the front: a reply that was due while the page slept is lost (a
    // kind:23195 is not stored by relays), so ask the wallet instead.
    const onVisible = () => {
      if (document.visibilityState === 'visible') api.current.checkAll();
    };
    const onResume = () => api.current.checkAll();
    document.addEventListener('visibilitychange', onVisible);
    document.addEventListener('resume', onResume);
    return () => {
      mounted.current = false;
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('resume', onResume);
      for (const id of t.values()) clearTimeout(id);
      t.clear();
    };
  }, []);

  return {
    views,
    retryErrors,
    resending: Object.values(views).some((v) => v?.state === 'resending'),
    checkAll: () => api.current.checkAll(),
    check: (key: LegKey) => void api.current.check(key),
    resend: (key: LegKey) => void api.current.resend(key),
  };
}
