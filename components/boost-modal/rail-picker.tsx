'use client';
import { hasNwc } from '@/lib/v4v/nwc';
import { hasWebln } from '@/lib/v4v/webln';
import { hasSpark } from '@/lib/v4v/spark';
import { type Rail } from '@/lib/v4v/boost';

interface Props {
  rail: Rail | null;
  onRailChange: (rail: Rail | null) => void;
}

export function RailPicker({ rail, onRailChange }: Props) {
  const nwcReady = hasNwc();
  const sparkReady = hasSpark();
  const weblnReady = hasWebln();
  const noneReady = !nwcReady && !sparkReady && !weblnReady;

  return (
    <div>
      <label className="text-[11px] uppercase tracking-widest text-muted">Pay with</label>
      <div className="flex gap-2 mt-1.5 flex-wrap">
        <button
          onClick={() => nwcReady && onRailChange('nwc')}
          disabled={!nwcReady}
          className={`btn-ghost ${rail === 'nwc' ? '!border-bolt !text-bolt' : ''} disabled:opacity-30`}
        >NWC {nwcReady ? '✓' : ''}</button>
        <button
          onClick={() => sparkReady && onRailChange('spark')}
          disabled={!sparkReady}
          className={`btn-ghost ${rail === 'spark' ? '!border-bolt !text-bolt' : ''} disabled:opacity-30`}
        >Spark {sparkReady ? '✓' : ''}</button>
        <button
          onClick={() => weblnReady && onRailChange('webln')}
          disabled={!weblnReady}
          className={`btn-ghost ${rail === 'webln' ? '!border-bolt !text-bolt' : ''} disabled:opacity-30`}
        >WebLN {weblnReady ? '✓' : ''}</button>
      </div>

      <div className="text-[10px] text-muted mt-1.5">
        {noneReady
          ? 'No wallet connected — set one up in the account menu (top right).'
          : 'Manage wallets in the account menu (top right).'}
      </div>
    </div>
  );
}
