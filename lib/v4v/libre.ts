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
// synchronous readers and React subscribers stay in sync. The wallet-embed package is imported
// dynamically (inside ensureLibreMounted) so its LDK/WASM bundle never lands in the main chunk or
// on the server; only `import type` runs at module load.
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
//
// THE GATE IS IN HERE, NOT AT A CALLER (`libreAvailable`). Three doors mount the widget and only one
// of them is a click: a picker row, a `bmb:libre_active` left by an earlier visit, and a Drive OAuth
// redirect landing (`#access_token=…`). `isLibreWanted` and `ensureLibreMounted` both refuse when
// the gate is shut, so a gate at the picker alone would leave the other two open — the same shape
// as Spark's `sparkAvailable()` (docs/wallets.md). See docs/wallets.md, "Libre Wallet".

import { createObservable } from '../pubsub';
import { storage } from '@/lib/storage';
import { BRAND } from '@/lib/brand';
import { isNativeIos } from '@/lib/native/platform';
import { getErrorMessage } from '@/lib/util';
import { isWeblnEnabled, weblnDisable } from './webln';
import type { MountHandle, MountOptions, RoamingViewState } from '@libre/wallet-embed';

export type LibreView = RoamingViewState['view'];

// NEXT_PUBLIC_*, so it is inlined at BUILD time: a build without it cannot turn Libre on, whatever
// the browser holds. Public by design (an OAuth client id), never a secret.
const CLIENT_ID = process.env.NEXT_PUBLIC_LIBRE_GOOGLE_CLIENT_ID;

/**
 * The build-time half of the gate: a client id was baked in AND this is the Boost Me Bitch deploy.
 * Same answer on the server and in the first client render, so a component may branch on it while
 * rendering without a hydration mismatch.
 *
 * Buddy never gets Libre: it is the family-friendly brand, and it is the Android app on Zapstore.
 * A per-brand switch would belong in `lib/brand.ts`, but every `Brand` field is a pinned non-empty
 * string (`check:brand`), so the brand is read here by id.
 */
export function libreConfigured(): boolean {
  return !!CLIENT_ID && BRAND.id === 'bmb';
}

/**
 * The whole gate, browser-only: configured, and NOT inside the iOS app. The iOS app is a Capacitor
 * shell around the live site that holds no funds (Spark is off there, #637) and has no Google
 * sign-in (#638) — and Libre's whole connect is a Google OAuth redirect. `isNativeIos()` reads
 * `window.Capacitor`, so this must not be called while rendering (the server says false).
 */
export function libreAvailable(): boolean {
  return libreConfigured() && !isNativeIos();
}

/** The one set of mount options. `appName` is display-only upstream (written into the Drive lease
 *  record, never compared — checked at the pinned commit), so it follows the brand. */
const LIBRE_MOUNT_OPTS: MountOptions = {
  googleClientId: CLIENT_ID ?? '',
  wasmUrl: '/liblightningjs.wasm',
  appName: BRAND.wireName,
  network: 'mainnet',
};

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
let freshAdoption = false;

const { subscribe: subscribeLibre, notify } = createObservable();
export { subscribeLibre };

/** Ask the host to load + mount the widget (idempotent). Set when the user picks the Libre rail. */
export function requestLibreMount(): void {
  if (!libreAvailable()) return;
  if (!wantMount) {
    wantMount = true;
    notify();
  }
}

/**
 * Whether this page load is a Google OAuth redirect coming back to us. Read as a fragment
 * PARAMETER, the way the package's own `parseDriveOAuthFragment` reads it, not as a substring:
 * since #120 was written, the Amber callback (`app/amber-callback/`) also returns in the fragment
 * (`#r=<rid>;event=<signed event>`), and a signed event's text is not ours to match against.
 */
function isOAuthReturn(): boolean {
  try {
    const h = window.location.hash;
    if (!h || h.length < 2) return false;
    return new URLSearchParams(h.slice(1)).has('access_token');
  } catch {
    return false;
  }
}

/**
 * Whether the widget should be mounted. The LDK bundle is ~5 MB JS + ~12 MB WASM, so it loads only
 * when there's a reason: an explicit pick this page-life, a user who already adopted Libre here, or
 * a Drive OAuth redirect landing that nothing else can complete. Never while the gate is shut.
 */
export function isLibreWanted(): boolean {
  if (typeof window === 'undefined') return false;
  if (!libreAvailable()) return false;
  if (wantMount) return true;
  try {
    // The installed-PWA Drive login is a full-page redirect back to '/' with the token in the
    // fragment, which kills `wantMount` and lands before the user has ever reached 'running' (so
    // libreActive isn't set yet either). This check is therefore the ONLY thing that mounts the
    // widget to complete a first-ever connect there — load-bearing, not opportunistic.
    if (isOAuthReturn()) return true;
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

/**
 * True while Libre's provider is the object at `window.webln` — so a WebLN leg paid NOW would be
 * paid by Libre, and could stop on its approval sheet (first use, or past the daily limit) until
 * somebody clicks. Streaming asks this before every unattended settle (`unattendedRailRefusal`).
 *
 * Identity, not `isLibreRunning()` or `bmb:libre_active`: while Libre runs, NWC or Spark may be the
 * rail that pays, and while Libre is mounted but not running an extension may hold `window.webln`.
 * Both of those must still stream.
 */
export function libreHoldsWebln(): boolean {
  if (typeof window === 'undefined' || !handle) return false;
  return (window as { webln?: unknown }).webln === handle.webln;
}

/**
 * Is the WebLN slot live? Enabled in this page load, OR held by Libre. The ONE answer the payer
 * (`pickRail`), the header chip and the wallet modal read, so they name the same wallet.
 *
 * `isWeblnEnabled()` alone is per page load and turns true only on the first payment, so after a
 * reload a running Libre read "not ready": a `webln` preference (what picking Libre records) lost
 * to any other connected rail in the payer and the chip, while the modal named Libre (#120,
 * 98786072). Libre's own approval sheet is its permission gate; the app's flag is for extensions.
 */
export function weblnLive(): boolean {
  return isWeblnEnabled() || libreHoldsWebln();
}

/** True while Libre holds `window.webln` over a provider it displaced (an extension, usually),
 *  which `libreDisconnect` would hand back. The wallet modal offers that extension by name. */
export function libreDisplacedWebln(): boolean {
  return claimed && priorWebln !== undefined && libreHoldsWebln();
}

/**
 * True exactly once per adoption: Libre just reached 'running' on a browser that hadn't adopted it
 * yet. The host uses it to disconnect the other rails — and ONLY then.
 *
 * This has to be captured inside the state transition rather than sampled by the caller. `view` is
 * module state that resets to 'stopped' on every page load, so a returning user's auto-mount
 * reaching 'running' looks exactly like a fresh connect from outside; clearing on that edge
 * unconditionally deleted the user's NWC URI on every reload. Sampling `libreActive` once at effect
 * setup fixes the reload but goes stale within a page life (disconnect Libre → connect NWC →
 * reconnect Libre would then leave both wired up, with pickRail quietly preferring NWC).
 */
export function consumeFreshAdoption(): boolean {
  const v = freshAdoption;
  freshAdoption = false;
  return v;
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
    // The WebLN rail's `enabled` flag is a grant to the PROVIDER that held window.webln when the
    // user enabled it — an extension, not Libre. Left set, the header chip's balance read passes
    // its gate and calls `enable()` on Libre's provider, which opens Libre's approval sheet on
    // first use with nobody having pressed anything. Libre's first payment sets it again.
    weblnDisable();
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
    // Whether THIS transition is the moment Libre became this browser's wallet, captured before
    // the flag is written — it's the only instant the answer is knowable. The host consumes it to
    // decide whether to disconnect the other rails. See consumeFreshAdoption.
    freshAdoption = !storage.libreActive.get();
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
 * mount; if the element already exists it is simply re-parked into `home`. Does nothing at all
 * while the gate is shut (`libreAvailable`) — the import is never even started.
 *
 * Never rejects: the callers are effects that can only `void` this, and the widget's own card is
 * the surface where a failure has to be reported anyway (see getLibreMountError).
 */
export async function ensureLibreMounted(home: HTMLElement): Promise<void> {
  if (!libreAvailable()) return;
  homeSlot = home;
  if (handle) {
    if (!borrowed && handle.element.parentElement !== home) moveElement(handle.element, home);
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
      handle = mountLibreWallet(homeSlot ?? home, { ...LIBRE_MOUNT_OPTS, installWebln: false });
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
export async function retryLibreMount(home: HTMLElement): Promise<void> {
  mountError = null;
  notify();
  await ensureLibreMounted(home);
}

/**
 * Stop using Libre on this browser: hand window.webln back, tear the LDK node down, and forget the
 * adoption so later visits don't re-download 17 MB. Idempotent. Leaves the wallet's own seed and
 * channel state in the package's IndexedDB — removing those is a separate, confirmed action.
 */
export async function libreDisconnect(): Promise<void> {
  storage.libreActive.clear();
  wantMount = false;
  // Never let an unconsumed adoption survive a disconnect and fire against a later, unrelated
  // connect — that would tear down whatever wallet the user moved to in the meantime.
  freshAdoption = false;
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

// ---- "Sign out & remove from this device" -------------------------------------------------------
//
// The package's OWN storage at the pin (468ac13b), read from the shipped bundle (`dist/index.mjs`)
// and its sources. None of it is a bmb:* key, so none of it is in lib/storage.ts. COUPLED TO THE PIN:
// after a bump, read the bundle's `libre-wallet…` / `libre_…` literals again, and run
// `npm run e2e:libreremove`, whose last section lists what the real package writes on mount.
//
// IndexedDB — the SEED and channel state, per network and per origin (not per Google account), store
// `settings` (`IndexedDBStorageProvider`): `libre-wallet-<network>` for the four networks the package
// supports, `libre-wallet-meta` (the active-network pointer) and the legacy `libre-wallet`. The same
// list as the package's own `resetWallet()`, which clears rather than deletes, because
// `deleteDatabase` blocks on an open connection.
const LIBRE_DB_NAMES = [
  'libre-wallet-mainnet',
  'libre-wallet-testnet',
  'libre-wallet-signet',
  'libre-wallet-regtest',
  'libre-wallet-meta',
  'libre-wallet',
];
const LIBRE_DB_STORE = 'settings';

// localStorage:
// - `libre_drive_hint` / `libre_drive_configured`: the Drive login. The hint goes back to Google as
//   `login_hint`, so the next connect silently reuses this account; `configured` drives the
//   auto-reconnect on load. Gone, the next connect asks for an account.
// - `libre_state_version_hwm:<network>`: the rolled-back-storage witness, kept OUTSIDE IndexedDB on
//   purpose. `resetWallet()` clears it with the DBs: left behind, it outlives the seed it describes,
//   and the next wallet on this origin starts below its mark. #120's wipe missed it.
// - `libre_embed:` prefix: the widget's permission store, today `libre_embed:libre_webln_grants` —
//   each origin's WebLN grant and daily limit. Left behind, the next wallet on this device pays this
//   site under the old grant without asking. #120's wipe missed it too.
const LIBRE_LOCAL_KEYS = ['libre_drive_hint', 'libre_drive_configured'];
const LIBRE_LOCAL_PREFIXES = ['libre_state_version_hwm:', 'libre_embed:'];
// sessionStorage: an OAuth `state` in flight (`libre_drive_oauth_state`).
const LIBRE_SESSION_KEYS = ['libre_drive_oauth_state'];

/**
 * Empty one of the package's IndexedDB stores. Opens WITHOUT a version, so an existing database
 * never upgrades. Always resolves: a failed wipe must not strand the reload. (#120.)
 *
 * A database that does NOT exist must stay absent. `open(name)` with no version CREATES it, empty, at
 * version 1 — and the package opens at version 1 and makes its `settings` store only in an upgrade,
 * which then never fires: a shell left here is a database the package can never use again. #120's
 * copy made one for every network the wallet never ran on. So the upgrade a missing database
 * triggers is aborted, which makes the open fail and creates nothing.
 */
function clearLibreDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(name);
    } catch {
      resolve();
      return;
    }
    req.onupgradeneeded = (e) => {
      if (e.oldVersion === 0) req.transaction?.abort();
    };
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
    req.onsuccess = () => {
      const db = req.result;
      const done = () => {
        db.close();
        resolve();
      };
      try {
        if (!db.objectStoreNames.contains(LIBRE_DB_STORE)) {
          done();
          return;
        }
        const tx = db.transaction(LIBRE_DB_STORE, 'readwrite');
        tx.objectStore(LIBRE_DB_STORE).clear();
        tx.oncomplete = done;
        tx.onerror = done;
        tx.onabort = done;
      } catch {
        done();
      }
    };
  });
}

/** Forget the package's own keys (above). Only those: every bmb:* key and every other key stays. */
function forgetLibreKeys(): void {
  try {
    for (const k of Object.keys(localStorage)) {
      if (LIBRE_LOCAL_KEYS.includes(k) || LIBRE_LOCAL_PREFIXES.some((p) => k.startsWith(p))) {
        localStorage.removeItem(k);
      }
    }
  } catch {
    // Storage unavailable: nothing was written there either.
  }
  try {
    for (const k of LIBRE_SESSION_KEYS) sessionStorage.removeItem(k);
  } catch {
    // As above.
  }
}

/**
 * Sign out AND delete the wallet from this browser: the seed, the channel state, the Drive login and
 * this origin's WebLN grant. For a shared computer, or to connect a different Google account or
 * wallet — without the seed wipe the package finds a local seed and runs the OLD wallet against the
 * NEW account, never asking for a recovery phrase. DESTRUCTIVE: the seed comes back only from the
 * user's saved recovery phrase (and that wallet's Drive backup), so the caller confirms first.
 *
 * ONLY WHILE RUNNING (#120): `dispose()` stops the node, flushes the last backup and releases the
 * Drive lease with its proof only when the session is `running` (`roaming-session.ts`, `wasRunning`).
 * It does NOT report the result: at the pin one `catch` swallows a failed flush (offline, an expired
 * token) and skips the release with it, and `libreDisconnect` swallows again. So the wipe still runs
 * after a failed save, and the confirm must not promise one; the fix is an upstream `dispose` that
 * says whether the flush and the release worked.
 * Wiped from any other state, the lease stays `live` at this origin and the local state that would
 * prove the hand-off is gone, so the next visit to that account halts on a hand-off it cannot
 * prove. So it refuses — returns false, touches nothing — unless running; the button is disabled
 * too. It disposes BEFORE the wipe, which also closes the node's IndexedDB handles.
 *
 * Then it reloads: the package keeps the OAuth access token in module scope for the page's life, and
 * has no API to reset it.
 */
export async function removeLibreFromDevice(): Promise<boolean> {
  if (typeof window === 'undefined' || !isLibreRunning()) return false;
  await libreDisconnect();
  await Promise.all(LIBRE_DB_NAMES.map(clearLibreDb));
  forgetLibreKeys();
  window.location.reload();
  return true;
}

// Move the element into `target` (the wallet modal). The node keeps its session — no remount.
// notify() only fires on the borrowed:false→true transition, so a caller that re-borrows from a
// subscribeLibre handler (to catch the element mounting after the modal opened) can't loop.
/**
 * The package's approval sheet while one is open. It is the `<dialog>` in the element's OPEN shadow
 * root (`element.ts` at the pin: `requestApproval` → `showModal()`) — an internal of the package,
 * pinned by `npm run e2e:librewallet` against the real chunk.
 */
function openSheet(): HTMLDialogElement | null {
  const d = handle?.element.shadowRoot?.querySelector('dialog');
  return typeof HTMLDialogElement !== 'undefined' && d instanceof HTMLDialogElement && d.open ? d : null;
}

/** True while Libre's approval sheet is open — a surface holding the element must not act on a key
 *  the sheet answers (Escape), or it closes itself, moves the element, and strands the sheet. */
export function libreSheetOpen(): boolean {
  return openSheet() !== null;
}

/**
 * Every move of the element goes through here. Moving a `<dialog>` takes it out of the top layer
 * and leaves it OPEN and non-modal, inside a host that may be the collapsed 0×0 box: invisible, and
 * its promise settles only on a click — the payment waiting on it hangs — while the next
 * `showModal()` throws ("already open as a non-modal dialog"), so every later payment fails too.
 * Measured on the real package (e2e:librewallet). So a move under an open sheet DENIES it: the
 * sheet's own denial path (`close`), the payment fails as refused with nothing paid, and the next
 * request opens a fresh sheet. Re-showing it in place would lean on how a browser treats a removed
 * `open` attribute.
 */
function moveElement(el: HTMLElement, target: HTMLElement): void {
  const sheet = openSheet();
  target.appendChild(el);
  sheet?.close();
}

export function borrowLibreElement(target: HTMLElement): void {
  if (!handle) return;
  if (handle.element.parentElement !== target) moveElement(handle.element, target);
  if (!borrowed) {
    borrowed = true;
    notify();
  }
}

/** Return the element to its persistent home slot (called when the modal closes / rail switches). */
export function parkLibreElement(): void {
  if (!handle || !homeSlot) return;
  if (handle.element.parentElement !== homeSlot) moveElement(handle.element, homeSlot);
  if (borrowed) {
    borrowed = false;
    notify();
  }
}
