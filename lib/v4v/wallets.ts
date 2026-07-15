// Cross-wallet cleanup — enforces one-active-wallet-at-a-time.
// Call clearOtherWallets(keep, npub) after a new wallet successfully connects.

import { clearNwcUri, hasNwc } from './nwc';
import { hasSpark, sparkDisconnect } from './spark';
import { weblnDisable } from './webln';
import { hasLibre, libreDisconnect } from './libre';
import { storage } from '@/lib/storage';

/**
 * Disconnect every rail except `keep`.
 * - Sets sparkOptOut when moving away from Spark (so auto-restore is suppressed on reload).
 * - Does NOT touch sparkOptOut when moving TO Spark — SparkWallet clears it before init.
 * - Clears the cached wallet balance so the header chip resets immediately.
 */
export async function clearOtherWallets(
  keep: 'nwc' | 'spark' | 'webln' | 'libre',
  npub?: string,
): Promise<void> {
  if (keep !== 'nwc' && hasNwc()) clearNwcUri();
  if (keep !== 'spark' && hasSpark()) await sparkDisconnect();
  if (keep !== 'webln') weblnDisable();
  if (keep !== 'libre' && hasLibre()) await libreDisconnect();
  if (keep !== 'spark') storage.sparkOptOut.set();
  storage.walletBalance.clear(npub);
}
