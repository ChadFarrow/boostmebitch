// Libre Wallet rail — a roaming, in-page LDK Lightning wallet embedded via @libre/wallet-embed.
//
// Unlike the other rails, the whole wallet UI (connect, roaming states, the spend-approval modal,
// the running balance chip) is drawn by the <libre-wallet> custom element inside its own shadow
// root. We mount ONE instance for the app's lifetime (see components/libre/libre-wallet-host.tsx)
// so the LDK node, the window.webln provider, and the Google-Drive OAuth redirect landing all
// survive the wallet modal opening and closing. The element is a stable DOM node with no
// teardown-on-detach, so it can be moved between the persistent host slot and the modal body
// (borrow/park below) without losing the session.
//
// This module mirrors the nwc / spark / webln rails: module-level state + a createObservable so
// synchronous readers (wallet-modal's getActiveRail) and React subscribers stay in sync. The
// wallet-embed package is imported dynamically (inside ensureLibreMounted) so its LDK/WASM bundle
// never lands in the main chunk or on the server; only `import type` runs at module load.
//
// Libre is NOT a fourth Rail. It becomes window.webln while it runs, so boosts go down the
// existing WebLN path with no changes to boost.ts / zap.ts / RailPref. Two consequences worth
// keeping in mind here:
//   - Everything below distinguishes "running" from "adopted". `view` is module state and resets to
//     'stopped' on every page load, so it can never answer "is Libre this browser's wallet?" —
//     that's storage.libreActive, and conflating the two silently wiped users' NWC URIs on reload.
//   - We own window.webln, so we must hand it back: releaseWebln restores the provider we displaced
//     and turns the WebLN rail's session flag off. Leaving either behind strands the user with a UI
//     that says "connected" and a boost path that throws.

import { createObservable } from '../pubsub';
import { storage } from '@/lib/storage';
import { getErrorMessage } from '@/lib/util';
import { weblnDisable } from './webln';
import type { MountHandle, MountOptions, RoamingViewState } from '@libre/wallet-embed';

export type LibreView = RoamingViewState['view'];

let handle: MountHandle | null = null;
let mounting: Promise<void> | null = null;
let mountError: string | null = null;
let unsubState: (() => void) | null = null;
let homeSlot: HTMLElement | null = null;
let borrowed = false;
let wantMount = false;
let view: LibreView = 'stopped';
// The provider window.webln held before we claimed it (an extension like Alby, usually). Restored
// on release — see claimWebln.
let priorWebln: unknown;
let claimed = false;

const { subscribe: subscribeLibre, notify } = createObservable();
export { subscribeLibre };

/** Ask the host to load + mount the widget (idempotent). Set when the user picks the Libre rail. */
export function requestLibreMount(): void {
  if (!wantMount) {
    wantMount = true;
    notify();
  }
}

/**
 * Whether the widget should be mounted. The LDK bundle is ~5 MB JS + ~12 MB WASM, so it loads only
 * when there's a reason: an explicit pick this page-life, a user who already adopted Libre here, or
 * a Drive OAuth redirect landing that nothing else can complete.
 */
export function isLibreWanted(): boolean {
  if (wantMount) return true;
  if (typeof window === 'undefined') return false;
  try {
    // The installed-PWA Drive login is a full-page redirect back to '/' with the token in the
    // fragment, which kills `wantMount` and lands before the user has ever reached 'running' (so
    // libreActive isn't set yet either). This check is therefore the ONLY thing that mounts the
    // widget to complete a first-ever connect on iOS — load-bearing, not opportunistic. Nothing
    // else in this app puts a token in the fragment (grep: this is the sole `location.hash` use).
    if (window.location.hash.includes('access_token')) return true;
    return storage.libreActive.get();
  } catch {
    return false;
  }
}

/** Why the widget failed to load, if it did. Cleared on a retry. */
export function getLibreMountError(): string | null {
  return mountError;
}

/** True while the LDK bundle is downloading — the widget draws nothing until it lands. */
export function isLibreLoading(): boolean {
  return mounting !== null;
}

/** True once the roaming session is live here (the node is running). */
export function isLibreRunning(): boolean {
  return view === 'running';
}

/** The current roaming view — the host reflects in-progress/blocked/halted states from it. */
export function getLibreView(): LibreView {
  return view;
}

/** True while the element has been reparented out of its home slot (into the wallet modal). */
export function isLibreBorrowed(): boolean {
  return borrowed;
}

/** True once the single instance has been mounted (the widget exists in the DOM). */
export function isLibreMounted(): boolean {
  return handle !== null;
}

export function getLibreElement(): HTMLElement | null {
  return handle?.element ?? null;
}

// Make Libre the page's WebLN provider. The widget's own installWebln is deliberately POLITE (it
// won't replace an existing window.webln — see MountHandle.installedWebln), but picking Libre in
// the wallet modal is an explicit choice to pay through it here, so we override even an extension.
//
// We snapshot whoever held window.webln first and put them back on release. Same shape as
// lib/nostr/signer.ts captureOriginal() does for window.nostr, and for the same reason: an
// extension injects once at page load, so a provider we delete instead of restoring is gone until
// a reload — a user who stops Libre would silently lose Alby with no way to get it back.
function claimWebln(): void {
  if (!handle || typeof window === 'undefined') return;
  try {
    const w = window as { webln?: unknown };
    if (!claimed) priorWebln = w.webln;
    Object.defineProperty(window, 'webln', {
      value: handle.webln,
      writable: false,
      configurable: true,
    });
    claimed = true;
    window.dispatchEvent(new Event('webln:ready'));
  } catch {
    // A non-configurable existing provider — leave it; nothing else we can safely do.
  }
}

function releaseWebln(): void {
  if (typeof window === 'undefined' || !claimed) return;
  try {
    const w = window as { webln?: unknown };
    // Only stand down if we're still the one installed.
    if (handle && w.webln !== handle.webln) return;
    if (priorWebln === undefined) {
      delete w.webln;
    } else {
      Object.defineProperty(window, 'webln', {
        value: priorWebln,
        writable: false,
        configurable: true,
      });
    }
  } catch {
    // ignore
  }
  claimed = false;
  priorWebln = undefined;
  // The WebLN rail's `enabled` flag is per-session module state that a Libre payment turns on (any
  // boost goes through ensureWebln). Leaving it set after Libre stops makes the account menu and
  // the wallet modal claim "WebLN — connected" while pickRail throws "no payment provider" — three
  // surfaces disagreeing. Whoever we handed back to must be re-enabled explicitly, as ever.
  weblnDisable();
}

function applyState(next: LibreView): void {
  const was = view;
  view = next;
  if (view === 'running' && was !== 'running') {
    claimWebln();
    // This browser has adopted Libre: auto-mount on later visits, and don't re-tear-down the other
    // rails on a reload (see storage.libreActive).
    storage.libreActive.set();
  }
  // Every exit from 'running' — the user disconnected, or the wallet roamed to another device, or
  // Drive went unreachable mid-session — hands window.webln back. Only 'running' can pay.
  if (view !== 'running' && was === 'running') releaseWebln();
  notify();
}

/**
 * Mount the single wallet-embed instance into `home` (idempotent). Dynamically imports the package
 * so the LDK/WASM bundle stays out of the main chunk and off the server. Safe to call on every host
 * mount; if the element already exists it is simply re-parked into `home`.
 *
 * Never rejects: the callers are effects that can only `void` this, and the widget's own card is
 * the surface where a failure has to be reported anyway (see getLibreMountError).
 */
export async function ensureLibreMounted(home: HTMLElement, opts: MountOptions): Promise<void> {
  homeSlot = home;
  if (handle) {
    if (!borrowed && handle.element.parentElement !== home) home.appendChild(handle.element);
    return;
  }
  if (mounting) return mounting;
  mountError = null;
  mounting = (async () => {
    try {
      const { mountLibreWallet } = await import('@libre/wallet-embed');
      // The home slot can be replaced while the ~17 MB bundle is in flight (a remount of the
      // layout subtree). Mount into whatever the CURRENT home is, not the one captured at call
      // time, or the element lands in a detached div and the widget is simply invisible.
      handle = mountLibreWallet(homeSlot ?? home, { ...opts, installWebln: false });
      // installWebln:false — we own window.webln ourselves (claimWebln, on the running transition).
      applyState(handle.state().view);
      unsubState = handle.onState((s) => applyState(s.view));
    } catch (e) {
      // A chunk 404 (a redeploy under an open PWA tab), offline, or a missing /liblightningjs.wasm.
      // Without this the rejection is unhandled AND the widget is a dead end: `handle` stays null
      // and nothing ever retries, so the user watches an empty card forever.
      mountError = getErrorMessage(e, 'Could not load the Libre wallet.');
    }
  })();
  try {
    await mounting;
  } finally {
    mounting = null;
    notify();
  }
}

/** Retry a failed mount (the widget card's "Try again"). */
export async function retryLibreMount(home: HTMLElement, opts: MountOptions): Promise<void> {
  mountError = null;
  notify();
  await ensureLibreMounted(home, opts);
}

/**
 * Stop using Libre on this browser: hand window.webln back, tear the LDK node down, and forget the
 * adoption so later visits don't re-download 17 MB. Idempotent.
 */
export async function libreDisconnect(): Promise<void> {
  storage.libreActive.clear();
  wantMount = false;
  releaseWebln();
  unsubState?.();
  unsubState = null;
  const h = handle;
  handle = null;
  view = 'stopped';
  notify();
  // Last — it's async (final Drive flush + lease release) and must not strand the state above.
  try {
    await h?.dispose();
  } catch {
    // Best-effort: the node is going away regardless.
  }
}

// Move the element into `target` (the wallet modal). The node keeps its session — no remount.
// notify() only fires on the borrowed:false→true transition, so a caller that re-borrows from a
// subscribeLibre handler (to catch the element mounting after the modal opened) can't loop.
export function borrowLibreElement(target: HTMLElement): void {
  if (!handle) return;
  if (handle.element.parentElement !== target) target.appendChild(handle.element);
  if (!borrowed) {
    borrowed = true;
    notify();
  }
}

/** Return the element to its persistent home slot (called when the modal closes / rail switches). */
export function parkLibreElement(): void {
  if (!handle || !homeSlot) return;
  if (handle.element.parentElement !== homeSlot) homeSlot.appendChild(handle.element);
  if (borrowed) {
    borrowed = false;
    notify();
  }
}
