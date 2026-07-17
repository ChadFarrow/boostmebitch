// Cross-wallet cleanup — enforces one-active-wallet-at-a-time.
// Call clearOtherWallets(keep, npub) after a new wallet successfully connects.

import { clearNwcUri, hasNwc } from './nwc';
import { hasSpark, sparkDisconnect } from './spark';
import { isWeblnEnabled, weblnDisable } from './webln';
import { storage } from '@/lib/storage';

/**
 * True when any rail is connected/enabled. WebLN is gated on isWeblnEnabled()
 * (explicit user enable), not mere detection — mirrors getActiveRail() in
 * wallet-modal.tsx. Drives the header wallet control's connected/not state.
 */
export function hasAnyWallet(): boolean {
  return hasNwc() || hasSpark() || isWeblnEnabled();
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
 */
export async function clearOtherWallets(
  keep: 'nwc' | 'spark' | 'webln',
  npub?: string,
): Promise<void> {
  if (keep !== 'nwc' && hasNwc()) clearNwcUri();
  if (keep !== 'spark' && hasSpark()) {
    await sparkDisconnect();
    storage.sparkOptOut.set();
  }
  if (keep !== 'webln') weblnDisable();
  storage.walletBalance.clear(npub);
}
