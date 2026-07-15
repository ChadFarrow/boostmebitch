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

import { createObservable } from '../pubsub';
import type { MountHandle, MountOptions, RoamingViewState } from '@libre/wallet-embed';

type LibreView = RoamingViewState['view'];

// The LDK widget bundle is ~5 MB JS + ~12 MB WASM, so we do NOT load it for every visitor. It is
// mounted only when there's a reason to: the user picks Libre (requestLibreMount), a returning
// Libre user (the 'libre:used' marker), or a Google-Drive OAuth redirect landing on the page.
const USED_MARKER = 'libre:used';

let handle: MountHandle | null = null;
let mounting: Promise<void> | null = null;
let homeSlot: HTMLElement | null = null;
let borrowed = false;
let wantMount = false;
let view: LibreView = 'stopped';

const { subscribe: subscribeLibre, notify } = createObservable();
export { subscribeLibre };

/** Ask the host to load + mount the widget (idempotent). Set when the user picks the Libre rail. */
export function requestLibreMount(): void {
  if (!wantMount) {
    wantMount = true;
    notify();
  }
}

/** Whether the widget should be mounted (an explicit pick, a returning user, or an OAuth return). */
export function isLibreWanted(): boolean {
  if (wantMount) return true;
  if (typeof window === 'undefined') return false;
  try {
    // A Drive OAuth redirect returns the token in the URL fragment — mount to complete it.
    if (window.location.hash.includes('access_token')) return true;
    return window.localStorage.getItem(USED_MARKER) === '1';
  } catch {
    return false;
  }
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

// Make Libre the page's WebLN provider. The widget's own installWebln is deliberately POLITE
// (it won't replace an existing window.webln — see the MountHandle.installedWebln note), but
// connecting Libre in-app is an explicit choice to pay through it here, so we override even a
// browser extension. A configurable property lets us cleanly remove it again on disconnect.
function claimWebln(): void {
  if (!handle || typeof window === 'undefined') return;
  try {
    Object.defineProperty(window, 'webln', {
      value: handle.webln,
      writable: false,
      configurable: true,
    });
    window.dispatchEvent(new Event('webln:ready'));
  } catch {
    // A non-configurable existing provider — leave it; nothing else we can safely do.
  }
}

function releaseWebln(): void {
  if (!handle || typeof window === 'undefined') return;
  try {
    const w = window as { webln?: unknown };
    if (w.webln === handle.webln) delete w.webln;
  } catch {
    // ignore
  }
}

function applyState(next: LibreView): void {
  const was = view;
  view = next;
  if (view === 'running' && was !== 'running') {
    claimWebln();
    // Remember that this browser uses Libre here, so future visits auto-mount the widget (and can
    // catch the OAuth redirect) without the user re-picking it from the wallet modal.
    try {
      window.localStorage.setItem(USED_MARKER, '1');
    } catch {
      /* ignore */
    }
  }
  if (view !== 'running' && was === 'running') releaseWebln();
  notify();
}

/**
 * Mount the single wallet-embed instance into `home` (idempotent). Dynamically imports the
 * package so the LDK/WASM bundle stays out of the main chunk and off the server. Safe to call on
 * every host mount; if the element already exists it is simply re-parked into `home`.
 */
export async function ensureLibreMounted(home: HTMLElement, opts: MountOptions): Promise<void> {
  homeSlot = home;
  if (handle) {
    if (!borrowed && handle.element.parentElement !== home) home.appendChild(handle.element);
    return;
  }
  if (mounting) return mounting;
  mounting = (async () => {
    const { mountLibreWallet } = await import('@libre/wallet-embed');
    // installWebln:false — we own window.webln ourselves (claimWebln, on the running transition).
    handle = mountLibreWallet(home, { ...opts, installWebln: false });
    applyState(handle.state().view);
    handle.onState((s) => applyState(s.view));
  })();
  try {
    await mounting;
  } finally {
    mounting = null;
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
