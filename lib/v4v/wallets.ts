// Cross-wallet cleanup — enforces one-active-wallet-at-a-time.
// Call clearOtherWallets(keep, npub) after a new wallet successfully connects.

import { clearNwcUri, hasNwc } from './nwc';
import { hasSpark, sparkDisconnect } from './spark';
import { isWeblnEnabled, weblnDisable } from './webln';
import { isLibreRunning, libreDisconnect } from './libre';
import { storage } from '@/lib/storage';
import type { Rail } from './boost';

/**
 * A wallet the user can pick — which is NOT the same set as `Rail`, the protocol that moves the
 * money. Libre pays over the WebLN rail (it installs itself as window.webln), so it's a choice
 * without being a rail. Everything that asks "which wallet did the user choose?" — the modal's
 * picker, clearOtherWallets — is keyed on this; everything that asks "how do I pay?" stays on
 * `Rail`. Keeping them apart is what lets boost.ts / zap.ts / RailPref stay untouched by Libre.
 */
export type WalletChoice = Rail | 'libre';

/**
 * What to call a rail in the UI. 'webln' is the interesting one: while Libre runs it *is*
 * window.webln, so every WebLN surface — the balance chip, the account-menu summary, the boost-all
 * picker — would otherwise label a wallet the user connected as "Libre Wallet" as "WebLN".
 */
export function railLabel(rail: Rail): string {
  if (rail === 'nwc') return 'NWC';
  if (rail === 'spark') return 'Spark';
  return isLibreRunning() ? 'Libre' : 'WebLN';
}

/**
 * True when any rail is connected/enabled. WebLN is gated on isWeblnEnabled()
 * (explicit user enable), not mere detection — mirrors getActiveRail() in
 * wallet-modal.tsx. A running Libre counts too: it fronts window.webln but
 * isWeblnEnabled() only flips on the first payment, so a freshly connected
 * Libre would otherwise read "not connected" here. Drives the header wallet
 * control's connected/not state.
 */
export function hasAnyWallet(): boolean {
  return hasNwc() || hasSpark() || isWeblnEnabled() || isLibreRunning();
}

/**
 * Disconnect every rail except `keep`.
 * - Sets sparkOptOut only when a connected Spark wallet is being disconnected
 *   (the user genuinely moved away from Spark), so auto-restore is suppressed
 *   on reload. A device that never had Spark this session must NOT be opted
 *   out: with the two-login split, connecting NWC/WebLN while signed OUT is a
 *   normal first step, and an unconditional set here poisoned the flag before
 *   the user ever signed in — silently blocking the Spark restore at login.
 * - Does NOT touch sparkOptOut when moving TO Spark — SparkWallet clears it before init.
 * - Clears the cached wallet balance so the header chip resets immediately.
 *
 * 'libre' is a `keep` value of its own even though Libre pays over the WebLN rail (it installs
 * itself as window.webln). Two reasons it can't just be 'webln': keeping Libre must not disable
 * the WebLN session flag it pays through, and — the important one — every OTHER rail winning must
 * actually stop Libre. Libre left running while NWC is "connected" keeps window.webln, keeps its
 * LDK node alive, and keeps `libreActive` set, so the next reload re-adopts Libre and wipes the
 * NWC URI the user just pasted.
 */
export async function clearOtherWallets(keep: WalletChoice, npub?: string): Promise<void> {
  if (keep !== 'nwc' && hasNwc()) clearNwcUri();
  if (keep !== 'spark' && hasSpark()) {
    await sparkDisconnect();
    storage.sparkOptOut.set();
  }
  if (keep !== 'libre' && storage.libreActive.get()) await libreDisconnect();
  // Libre IS the WebLN provider while it runs, so keeping it keeps the rail it pays over.
  if (keep !== 'webln' && keep !== 'libre') weblnDisable();
  storage.walletBalance.clear(npub);
}
