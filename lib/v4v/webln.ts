// WebLN payments — uses window.webln from Alby/Mutiny browser extensions.

import { createObservable } from '../pubsub';

type Webln = NonNullable<Window['webln']>;

export function hasWebln(): boolean {
  return typeof window !== 'undefined' && !!window.webln;
}

// WebLN has a per-site permission gate (`wl.enable()`). Until the user grants
// it, we can't call any other method without showing a prompt — so we don't
// fetch the balance speculatively. Track the granted state in module memory
// so subsequent re-mounts (e.g. opening the wallet modal again) don't lose it
// within a session. localStorage isn't useful here: the actual permission
// lives in the extension and can be revoked there independently.
let weblnEnabled = false;
const { subscribe: subscribeWebln, notify } = createObservable();
export { subscribeWebln };

export function isWeblnEnabled(): boolean {
  return weblnEnabled;
}

// Returns the resolved provider so callers don't need to assert again. Marks
// WebLN as enabled (and notifies subscribers) on first successful enable.
async function ensureWebln(): Promise<Webln> {
  const wl = typeof window !== 'undefined' ? window.webln : undefined;
  if (!wl) throw new Error('WebLN provider not found');
  await wl.enable();
  if (!weblnEnabled) {
    weblnEnabled = true;
    notify();
  }
  return wl;
}

/**
 * Thrown when the WebLN provider refused a request INSTEAD of executing it —
 * the rail's counterpart to NIP-47's `NwcNotAttemptedError`, and load-bearing
 * for the same reason: nothing left the wallet, so `payOne` may retry the leg
 * over LNURL and must NOT record the failure against the recipient.
 *
 * WebLN has no error codes, so this is raised only from the two paths **this
 * module controls**, both of which run before any payment is attempted: the
 * provider being absent or refusing `enable()`, and a provider that exposes no
 * `keysend` method. Anything `wl.keysend()` itself rejects with stays a plain
 * Error and stays fatal to the leg — the extension may already have paid, and a
 * message heuristic is not proof that it didn't.
 *
 * `railCanKeysend('webln')` cannot answer this in advance: the Alby extension
 * defines `keysend` on the provider object whatever the connected account
 * supports, so the method's presence is not a capability. That is why that arm
 * reports `'unknown'` rather than `'yes'`, and this class is what makes
 * attempting anyway safe.
 */
export class WeblnNotAttemptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeblnNotAttemptedError';
  }
}

/** Public alias for the gated enable so the wallet sub-card can drive state. */
export async function weblnEnable(): Promise<void> {
  await ensureWebln();
}

/** Clear the per-session enabled flag and notify subscribers. Called when switching away from WebLN. */
export function weblnDisable(): void {
  if (weblnEnabled) {
    weblnEnabled = false;
    notify();
  }
}

/**
 * Fetch balance in sats. Returns null when:
 *   - the user hasn't enabled WebLN this session (so we don't prompt them
 *     just to read a balance the chip would otherwise hide anyway),
 *   - the wallet doesn't implement getBalance (Alby does; some don't),
 *   - the call throws.
 *
 * WebLN spec: `{ balance, currency? }`. Default currency is 'sats'; we also
 * handle 'msat' / 'btc' defensively because the spec leaves the unit free
 * and not every provider sets it consistently.
 */
export async function weblnGetBalance(): Promise<number | null> {
  if (!weblnEnabled) return null;
  try {
    const wl = await ensureWebln();
    const fn = (wl as { getBalance?: () => Promise<{ balance: number; currency?: string }> }).getBalance;
    if (typeof fn !== 'function') return null;
    const res = await fn.call(wl);
    if (!res || typeof res.balance !== 'number' || !Number.isFinite(res.balance)) return null;
    const cur = (res.currency ?? 'sats').toLowerCase();
    if (cur === 'msat' || cur === 'msats') return Math.floor(res.balance / 1000);
    if (cur === 'btc') return Math.floor(res.balance * 100_000_000);
    return Math.floor(res.balance);
  } catch {
    return null;
  }
}

export async function weblnPayInvoice(invoice: string): Promise<string> {
  const wl = await ensureWebln();
  const r = await wl.sendPayment(invoice);
  // Notify so the balance chip refreshes after the payment without waiting
  // for the next visibility-change.
  notify();
  return r.preimage;
}

export async function weblnKeysend(args: {
  pubkey: string;
  amount_sat: number;
  customRecords?: Record<string, string>;
}): Promise<string> {
  // Both of these are refusals, not failures: neither reaches `wl.keysend`, so
  // no payment can have been attempted. Typing them is what stops `payOne`
  // blaming the recipient's node for a locked extension or an account with no
  // keysend support — and what lets the leg fall back to LNURL, which is the
  // rail every WebLN wallet does implement.
  let wl: Webln;
  try {
    wl = await ensureWebln();
  } catch (e) {
    throw new WeblnNotAttemptedError(e instanceof Error ? e.message : String(e));
  }
  if (!wl.keysend) throw new WeblnNotAttemptedError('This WebLN wallet does not support keysend');
  const r = await wl.keysend({
    destination: args.pubkey,
    amount: args.amount_sat,
    customRecords: args.customRecords,
  });
  notify();
  return r.preimage;
}
