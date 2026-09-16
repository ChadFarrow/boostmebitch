'use client';
import { useEffect, useId, useState } from 'react';

export const MIN_BOOST_SATS = 100;

export function AmountInput({
  sats,
  onChange,
  // Overridden only by <BoostAllModal>, where this number is PER TRACK and the
  // send multiplies it by the track count. The default is the single modal's
  // wording, where the number typed is the whole spend. It is a prop rather
  // than a second component so the htmlFor/id association below — the reason
  // this field has an accessible name at all — cannot be lost in a copy.
  label = 'Amount to send (sats)',
  // Set while a send is in flight. The amount is not just an input here: both
  // modals derive the per-leg allocation from it at RENDER time, while `go()`
  // pays from the closure it captured at the tap. Editing it mid-send repainted
  // every row with figures that differ from the sats actually going out — and
  // ✓ glyphs land beside those rows as the legs settle. <ModalShell> already
  // takes `dismissable={!running}` for the same reason.
  disabled = false,
}: {
  sats: number;
  onChange: (n: number) => void;
  label?: string;
  disabled?: boolean;
}) {
  const [raw, setRaw] = useState(sats > 0 ? String(sats) : '');
  // htmlFor/id, not a bare sibling <label>. The label was unassociated, so the
  // accessible name of the field where a user types HOW MANY SATS TO SEND was
  // empty — a screen reader announced an unlabelled text box on a payment form.
  const id = useId();
  const hintId = `${id}-hint`;

  useEffect(() => {
    setRaw(sats > 0 ? String(sats) : '');
  }, [sats]);

  return (
    <div>
      <label htmlFor={id} className="text-[11px] uppercase tracking-widest text-muted">
        {label}
      </label>
      <input
        id={id}
        // aria-describedby so the minimum is announced with the field. It's the
        // reason the send button disables, and without the association that
        // reason was on screen but not in the accessibility tree.
        aria-describedby={hintId}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        className="input w-full mt-1.5 text-2xl text-center font-display tracking-wide disabled:opacity-50"
        disabled={disabled}
        value={raw}
        placeholder="enter amount"
        onFocus={(e) => e.target.select()}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, '');
          setRaw(digits);
          if (digits) onChange(Number(digits));
        }}
      />
      <p id={hintId} className="text-[11px] text-muted mt-1.5">minimum {MIN_BOOST_SATS} sats</p>
    </div>
  );
}
