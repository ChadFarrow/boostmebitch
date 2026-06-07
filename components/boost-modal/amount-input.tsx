'use client';
import { useEffect, useState } from 'react';

const PRESETS = [100, 500, 1000, 5000];
export const MIN_BOOST_SATS = 100;

export function AmountInput({
  sats,
  onChange,
}: {
  sats: number;
  onChange: (n: number) => void;
}) {
  // Local raw string lets the field be empty while the user is typing a new
  // value, instead of snapping to 0 the moment they clear the existing number.
  const [raw, setRaw] = useState(sats > 0 ? String(sats) : '');

  // Keep display in sync when parent changes sats (e.g. preset button click).
  useEffect(() => {
    setRaw(sats > 0 ? String(sats) : '');
  }, [sats]);

  return (
    <div>
      <label className="text-[11px] uppercase tracking-widest text-muted">Sats</label>
      <div className="flex gap-2 mt-1.5">
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          className="input flex-1"
          value={raw}
          placeholder="500"
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, '');
            setRaw(digits);
            if (digits) onChange(Number(digits));
          }}
        />
        {PRESETS.map((n) => (
          <button key={n} onClick={() => onChange(n)} className="btn-ghost !px-3">{n}</button>
        ))}
      </div>
      <p className="text-[11px] text-muted mt-1.5">minimum {MIN_BOOST_SATS} sats</p>
    </div>
  );
}
