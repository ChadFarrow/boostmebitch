'use client';
import { useEffect, useId, useState } from 'react';
import { storage, type AmountDefaultKind } from '@/lib/storage';

export const MIN_BOOST_SATS = 100;

/**
 * The amount a surface opens with, or null for "no default". A stored number
 * under the minimum reads as none: the surface would open on an amount its own
 * Send button refuses, which looks like the control did not work.
 */
export function readAmountDefault(kind: AmountDefaultKind): number | null {
  const n = storage.amountDefault.get(kind);
  return n !== null && n >= MIN_BOOST_SATS ? n : null;
}

/**
 * SET AS DEFAULT, under an amount field. Each surface keeps its OWN default
 * (`kind`) — boost-all's number is per track and is multiplied by the track
 * count, so it may never read the single boost's.
 *
 * `typed` is the number the field SHOWS. `<AmountInput>` passes its own text
 * rather than the parent's amount, because the two have disagreed before (an
 * emptied field left the old amount on Send); the zap dialog's field is
 * controlled by its amount, so there the two are the same thing. Either way
 * this control must not mark a blank field ✓ default.
 *
 * ONE <button>, at a fixed position, whose label and handler change with the
 * state. Swapping it for a different element unmounted the button that had
 * focus: focus fell to <body>, so Escape stopped closing the modal (the shell
 * listens on its overlay) and the Tab trap stopped wrapping. A click in
 * Chrome focuses a button too, so this was not only a keyboard problem.
 *
 * It writes one localStorage key and nothing else: no relay, no wallet.
 */
export function DefaultAmountControl({
  kind,
  typed,
  disabled = false,
}: {
  kind: AmountDefaultKind;
  typed: number;
  disabled?: boolean;
}) {
  const [saved, setSaved] = useState<number | null>(() => readAmountDefault(kind));
  // The write reached memory only (full or blocked storage): it works for this
  // visit, and the next one opens without it. docs/storage.md, `safeSet`.
  const [visitOnly, setVisitOnly] = useState(() => storage.amountDefault.isEphemeral(kind));

  const isDefault = saved !== null && typed === saved;
  const canSave = Number.isSafeInteger(typed) && typed >= MIN_BOOST_SATS;

  return (
    <span className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider">
      {/* Always in the tree, so a screen reader announces the change; `sr-only`
          (absolutely positioned) when empty, so it takes no gap in the row. */}
      <span role="status" className={isDefault ? 'text-bolt' : 'sr-only'}>
        {isDefault ? '✓ default' : ''}
      </span>
      {isDefault && visitOnly && (
        <span className="text-muted normal-case tracking-normal">this visit only</span>
      )}
      <button
        type="button"
        className="btn-mini disabled:opacity-40"
        disabled={disabled || (!isDefault && !canSave)}
        aria-label={isDefault ? `Clear the default amount of ${saved} sats` : undefined}
        onClick={() => {
          if (isDefault) {
            storage.amountDefault.clear(kind);
            setSaved(null);
            setVisitOnly(false);
            return;
          }
          const onDisk = storage.amountDefault.set(kind, typed);
          setSaved(typed);
          setVisitOnly(!onDisk);
        }}
      >
        {isDefault ? 'clear' : 'set as default'}
      </button>
    </span>
  );
}

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
  // Which surface's default this field saves and opens with. Absent = no
  // SET AS DEFAULT control. See <DefaultAmountControl>.
  defaultKind,
}: {
  sats: number;
  onChange: (n: number) => void;
  label?: string;
  disabled?: boolean;
  defaultKind?: AmountDefaultKind;
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
          // An emptied field is 0, not "no change". Reporting only non-empty
          // values left the parent on its LAST number, so a blank field sat
          // beside "Send 1000 sat" — and a saved default makes emptying the
          // field the ordinary way to type a different amount.
          onChange(digits ? Number(digits) : 0);
        }}
      />
      <div className="flex items-center justify-between gap-3 mt-1.5">
        <p id={hintId} className="text-[11px] text-muted">minimum {MIN_BOOST_SATS} sats</p>
        {defaultKind && (
          <DefaultAmountControl kind={defaultKind} typed={raw ? Number(raw) : 0} disabled={disabled} />
        )}
      </div>
    </div>
  );
}
