'use client';

// Libre Listener Wallet rail — an embedded, in-page Lightning node
// (github.com/ChadFarrow/libre-listener-wallet-monorepo). The widget draws
// its own UI (Google sign-in, running chip, approval / spending-cap modals)
// inside a shadow root and installs a WebLN provider at window.webln
// (installWebln: true), so payments leave via standard WebLN calls. Running
// the node in the foreground page is what makes boosts settle on iOS, where
// a backgrounded PWA wallet gets frozen.
//
// Deliberately separate from lib/v4v/webln.ts: routing through weblnPayInvoice
// would flip that module's `weblnEnabled` flag and light the WebLN rail up
// across the UI, making the two rails indistinguishable. This module talks to
// window.webln directly and keeps its own observable. While the user is opted
// into Libre (`hasLibre()`), every WebLN surface is suppressed — the provider
// at window.webln *is* the Libre wallet, and offering both rails would be two
// doors to the same wallet.
//
// Lifetime rules (load-bearing):
//   - The widget is mounted ONCE per page into a module-owned container
//     (`ensureLibreWidget`) and only ever disposed by `libreDisconnect()` —
//     NEVER from a React effect cleanup. <LibreWalletHost> merely adopts /
//     detaches the container node, so StrictMode's dev double-mount can't
//     kill the node.
//   - `bmb:libre` (storage.libre) marks the opt-in; the layout host mounts
//     the widget whenever it's set, so the Google OAuth full-page redirect
//     back to `/` (and any reload) lands on a mounted widget again.

import { createObservable } from '../pubsub';
import { storage } from '../storage';

export type LibreView = 'running' | 'stopped' | 'moved-away';

type Webln = NonNullable<Window['webln']>;

// null = widget not mounted / no state reported yet.
let libreView: LibreView | null = null;

const { subscribe: subscribeLibre, notify } = createObservable();
export { subscribeLibre };

/** True when the Libre rail can be offered at all (client id configured). */
export function libreConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_LIBRE_GOOGLE_CLIENT_ID;
}

/** User opted into the Libre wallet on this device (widget mounts on load). */
export function hasLibre(): boolean {
  return storage.libre.get();
}

/** Mounted, signed in, and running in THIS page — i.e. actually payable. */
export function isLibreRunning(): boolean {
  return (
    hasLibre()
    && libreView === 'running'
    && typeof window !== 'undefined'
    && !!window.webln
  );
}

export function getLibreView(): LibreView | null {
  return libreView;
}

/** Mark the opt-in; the layout host reacts by mounting the docked widget. */
export function libreOptIn(): void {
  storage.libre.set();
  notify();
}

// --- singleton widget mount -------------------------------------------------

let container: HTMLDivElement | null = null;
let handle: import('@libre/wallet-embed').LibreWalletHandle | null = null;
let mounting: Promise<HTMLDivElement> | null = null;

/** The live widget container, if mounted — used by the host to detach. */
export function getLibreContainer(): HTMLDivElement | null {
  return container;
}

// Unknown view strings (future widget versions) coerce to 'stopped': only
// 'running' may enable payments, so unknown must never masquerade as it.
function coerceView(v: string): LibreView {
  return v === 'running' || v === 'moved-away' ? v : 'stopped';
}

/**
 * Mount the widget exactly once per page and return its container element.
 * Idempotent: concurrent/repeat callers (StrictMode double-mounts) share one
 * promise. The dynamic import keeps the LDK/WASM bundle out of the main JS
 * and off the server.
 */
export function ensureLibreWidget(): Promise<HTMLDivElement> {
  if (mounting) return mounting;
  mounting = (async () => {
    const el = document.createElement('div');
    const { mountLibreWallet } = await import('@libre/wallet-embed');
    const h = await mountLibreWallet(el, {
      googleClientId: process.env.NEXT_PUBLIC_LIBRE_GOOGLE_CLIENT_ID!,
      wasmUrl: '/liblightningjs.wasm',
      appName: 'boostmebitch',
      installWebln: true, // the boost rail reads window.webln
    });
    container = el;
    handle = h;
    h.onState?.((s) => {
      libreView = coerceView(s.view);
      notify();
    });
    // Conservative until the widget reports otherwise — a not-yet-running
    // wallet must not be offered as payable.
    libreView ??= 'stopped';
    notify();
    return el;
  })();
  // Allow a retry after a failed mount (bad WASM fetch, import error) instead
  // of caching the rejection forever.
  mounting.catch(() => { mounting = null; });
  return mounting;
}

/**
 * Full disconnect: clear the opt-in flag (UI flips immediately) and dispose
 * the widget. Dispose errors are swallowed — a wedged widget must not block
 * connecting a different wallet.
 */
export async function libreDisconnect(): Promise<void> {
  const h = handle;
  handle = null;
  container = null;
  mounting = null;
  libreView = null;
  storage.libre.clear();
  notify();
  if (h) {
    try { await h.dispose(); } catch { /* ignore */ }
  }
}

// --- payments / balance (direct window.webln, never lib/v4v/webln.ts) --------

async function libreProvider(): Promise<Webln> {
  if (!hasLibre()) throw new Error('Libre Wallet is not connected');
  if (libreView === 'moved-away') {
    throw new Error('Libre Wallet is active on another site — use "Move wallet here" in the widget first');
  }
  if (!isLibreRunning()) {
    throw new Error('Libre Wallet is not running — open the widget and sign in first');
  }
  const wl = window.webln;
  if (!wl) throw new Error('Libre WebLN provider not found');
  await wl.enable(); // WebLN handshake; expected no-op for the in-page provider
  return wl;
}

export async function librePayInvoice(invoice: string): Promise<string> {
  const wl = await libreProvider();
  const r = await wl.sendPayment(invoice);
  notify(); // balance chip refresh
  return r.preimage;
}

export async function libreKeysend(args: {
  pubkey: string;
  amount_sat: number;
  customRecords?: Record<string, string>;
}): Promise<string> {
  const wl = await libreProvider();
  if (!wl.keysend) throw new Error('Libre wallet does not support keysend');
  const r = await wl.keysend({
    destination: args.pubkey,
    amount: args.amount_sat,
    customRecords: args.customRecords,
  });
  notify();
  return r.preimage;
}

/**
 * Balance in sats, or null when not running / unsupported / on error. Same
 * defensive currency handling as weblnGetBalance — the WebLN spec leaves the
 * unit free. Reads the provider without enable() so a balance poll can never
 * surface a prompt.
 */
export async function libreGetBalance(): Promise<number | null> {
  if (!isLibreRunning()) return null;
  try {
    const wl = window.webln as Webln & {
      getBalance?: () => Promise<{ balance: number; currency?: string }>;
    };
    if (typeof wl.getBalance !== 'function') return null;
    const res = await wl.getBalance();
    if (!res || typeof res.balance !== 'number' || !Number.isFinite(res.balance)) return null;
    const cur = (res.currency ?? 'sats').toLowerCase();
    if (cur === 'msat' || cur === 'msats') return Math.floor(res.balance / 1000);
    if (cur === 'btc') return Math.floor(res.balance * 100_000_000);
    return Math.floor(res.balance);
  } catch {
    return null;
  }
}
