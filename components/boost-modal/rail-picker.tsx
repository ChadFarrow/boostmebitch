'use client';
import { useState } from 'react';
import { hasNwc, saveNwcUri, clearNwcUri } from '@/lib/v4v/nwc';
import { hasWebln } from '@/lib/v4v/webln';
import { pickRail, type Rail } from '@/lib/v4v/boost';

interface Props {
  rail: Rail | null;
  onRailChange: (rail: Rail | null) => void;
}

export function RailPicker({ rail, onRailChange }: Props) {
  const [nwcUri, setNwcUri] = useState('');

  function connectNwc() {
    const uri = nwcUri.trim();
    if (!uri.startsWith('nostr+walletconnect://')) {
      alert('Paste a nostr+walletconnect:// URI');
      return;
    }
    saveNwcUri(uri);
    onRailChange('nwc');
    setNwcUri('');
  }

  return (
    <div>
      <label className="text-[11px] uppercase tracking-widest text-muted">Pay with</label>
      <div className="flex gap-2 mt-1.5 flex-wrap">
        <button
          onClick={() => hasNwc() && onRailChange('nwc')}
          disabled={!hasNwc()}
          className={`btn-ghost ${rail === 'nwc' ? '!border-bolt !text-bolt' : ''} disabled:opacity-30`}
        >NWC {hasNwc() ? '✓' : ''}</button>
        <button
          onClick={() => hasWebln() && onRailChange('webln')}
          disabled={!hasWebln()}
          className={`btn-ghost ${rail === 'webln' ? '!border-bolt !text-bolt' : ''} disabled:opacity-30`}
        >WebLN {hasWebln() ? '✓' : ''}</button>
      </div>

      {!hasNwc() && (
        <div className="mt-3 flex gap-2">
          <input
            className="input"
            placeholder="nostr+walletconnect://… (paste from Alby Hub)"
            value={nwcUri}
            onChange={(e) => setNwcUri(e.target.value)}
          />
          <button onClick={connectNwc} className="btn-ghost">Save</button>
        </div>
      )}
      {hasNwc() && rail === 'nwc' && (
        <button
          onClick={() => { clearNwcUri(); onRailChange(pickRail()); }}
          className="text-[11px] text-muted hover:text-nostr mt-2"
        >
          disconnect NWC
        </button>
      )}
    </div>
  );
}
