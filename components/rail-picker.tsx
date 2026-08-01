'use client';
import { hasNwc } from '@/lib/v4v/nwc';
import { hasSpark } from '@/lib/v4v/spark';
import { hasWebln } from '@/lib/v4v/webln';
import type { Rail } from '@/lib/v4v/boost';

// Shared by BoostModal and BoostAllModal. It lived only in BoostAllModal, and
// that asymmetry was a real bug rather than a cosmetic gap: pickRail() honors
// storage.railPref (the last rail that successfully paid), so a user who once
// boosted with a WebLN extension keeps paying from it even after connecting and
// funding Spark — and on a single boost there was nothing on screen naming the
// rail, let alone changing it. The money moved from a wallet the user wasn't
// looking at. Same component in both places now, so they can't drift again.
const RAIL_LABELS: Record<Rail, string> = { nwc: 'NWC', spark: 'Spark', webln: 'WebLN' };

/** Rails with a usable wallet right now, in pickRail()'s own priority order.
 *  Call it during render — both modals re-render on subscribeNwc/subscribeSpark,
 *  so a wallet connected mid-modal shows up without a remount. */
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
            className={`btn-ghost !px-3 text-xs ${rail === r ? '!border-bolt text-bolt' : ''}`}
          >
            {RAIL_LABELS[r]}
          </button>
        ))}
      </div>
    </div>
  );
}
