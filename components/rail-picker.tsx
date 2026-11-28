'use client';
import { useSyncExternalStore } from 'react';
import { hasNwc } from '@/lib/v4v/nwc-state';
import { libreHoldsWebln, subscribeLibre } from '@/lib/v4v/libre';
import { hasSpark } from '@/lib/v4v/spark';
import { hasWebln } from '@/lib/v4v/webln';
import { railDescription, railLabel } from '@/lib/v4v/wallets';
import type { Rail } from '@/lib/v4v/boost';

// Shared by BoostModal and BoostAllModal. It lived only in BoostAllModal, and
// that asymmetry was a real bug rather than a cosmetic gap: pickRail() honors
// storage.railPref (the last rail that successfully paid), so a user who once
// boosted with a WebLN extension kept paying from it even after connecting and
// funding Spark — and on a single boost there was nothing on screen naming the
// rail, let alone changing it. The money moved from a wallet the user wasn't
// looking at. Same component in both places now, so they can't drift again.
// (Since 2026-11-27 a `webln` pref counts only while the extension is enabled
// in this page load: docs/wallets.md.)
//
// The labels and tooltips are `railLabel` / `railDescription` (lib/v4v/wallets.ts),
// read during render, not module constants: while the Libre wallet holds
// window.webln the WebLN button IS Libre, and naming it after the extension
// would hide which wallet pays.

/** Rails with a usable wallet right now, in pickRail()'s own priority order.
 *
 *  Call it during render — both modals re-render via `useWalletChange`, which
 *  subscribes to all THREE rails, so a wallet connected mid-modal shows up
 *  without a remount.
 *
 *  That used to say "subscribeNwc/subscribeSpark", and it was wrong in a way
 *  that mattered: this function reads `hasWebln()` as well, but neither modal
 *  subscribed to `subscribeWebln`. Enabling an Alby extension while the boost
 *  modal was open therefore produced no re-render at all — the WebLN button
 *  never appeared, `pickRail()` never re-ran, and the user could not pay from
 *  the wallet they had just turned on. Any new rail added here needs a matching
 *  subscription in `lib/use-wallet-change.ts`, or it will be invisible in
 *  exactly the same way. */
export function availableRails(): Rail[] {
  const rails: Rail[] = [];
  if (hasNwc()) rails.push('nwc');
  if (hasSpark()) rails.push('spark');
  if (hasWebln()) rails.push('webln');
  return rails;
}

/**
 * "Pay via [NWC] [Spark] [WebLN]" — renders nothing when there's only one rail
 * (or none), since there's no choice to make and the boost modal is already
 * dense. With 2+, the selected rail is always visibly named.
 */
export function RailPicker({
  rail,
  onChange,
}: {
  rail: Rail | null;
  onChange: (r: Rail) => void;
}) {
  // Libre taking window.webln renames the WebLN button without moving `rail`,
  // and a parent whose `setRail` returns the same rail renders nothing — so the
  // picker subscribes for its own labels.
  useSyncExternalStore(subscribeLibre, libreHoldsWebln, () => false);
  const rails = availableRails();
  if (rails.length < 2) return null;
  return (
    <div>
      <p className="text-[11px] uppercase tracking-widest text-muted mb-1.5">Pay via</p>
      <div className="flex gap-2">
        {rails.map((r) => (
          <button
            key={r}
            onClick={() => onChange(r)}
            aria-pressed={rail === r}
            title={railDescription(r)}
            className={`btn-ghost !px-3 text-xs ${rail === r ? '!border-bolt text-bolt' : ''}`}
          >
            {railLabel(r)}
          </button>
        ))}
      </div>
    </div>
  );
}
