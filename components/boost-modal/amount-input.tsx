'use client';
import { useEffect, useState } from 'react';

export const MIN_BOOST_SATS = 100;

export function AmountInput({
  sats,
  onChange,
}: {
  sats: number;
  onChange: (n: number) => void;
}) {
  const [raw, setRaw] = useState(sats > 0 ? String(sats) : '');

  useEffect(() => {
    setRaw(sats > 0 ? String(sats) : '');
  }, [sats]);

  return (
    <div>
      <label className="text-[11px] uppercase tracking-widest text-muted">Amount to send (sats)</label>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        className="input w-full mt-1.5 text-2xl text-center font-display tracking-wide"
        value={raw}
        placeholder="enter amount"
        onFocus={(e) => e.target.select()}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, '');
          setRaw(digits);
          if (digits) onChange(Number(digits));
        }}
      />
      <p className="text-[11px] text-muted mt-1.5">minimum {MIN_BOOST_SATS} sats</p>
    </div>
  );
}
