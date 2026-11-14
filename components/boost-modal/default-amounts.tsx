'use client';
import { useEffect, useId, useState } from 'react';
import { storage, subscribeAmountDefaults, type AmountDefaultKind } from '@/lib/storage';
import { MIN_BOOST_SATS, readAmountDefault } from './amount-input';

/**
 * The wallet modal's "Default amounts" section: the amount each boost surface
 * OPENS with, all three in one place. The surfaces set the same keys from their
 * own SET AS DEFAULT control (`<DefaultAmountControl>`); both read and write
 * through `storage.amountDefault` and re-read on `subscribeAmountDefaults`,
 * because this section opens on top of an open boost modal.
 *
 * One field per surface, never a shared one: boost-all's number is PER TRACK
 * and is multiplied by the track count. docs/money-boosts.md, "Default amounts".
 *
 * A field commits on blur or Enter, like the streaming rate beside it. Blank
 * clears the default; a number under the minimum is refused and the field goes
 * back to the saved value. Nothing here sends anything.
 */
const ROWS: { kind: AmountDefaultKind; label: string }[] = [
  { kind: 'boost', label: 'Boost' },
  { kind: 'boostAll', label: 'Boost all, per track' },
  { kind: 'zap', label: 'Zap' },
];

export function DefaultAmounts() {
  const hintId = useId();
  return (
    <div>
      <p className="text-[11px] uppercase tracking-widest text-muted mb-2">Default amounts</p>
      <div className="space-y-2">
        {ROWS.map((row) => (
          <DefaultAmountRow key={row.kind} kind={row.kind} label={row.label} hintId={hintId} />
        ))}
      </div>
      <p id={hintId} className="text-[11px] text-muted mt-2">
        The amount each one opens with. Blank means none: a boost opens blank, boost all and
        zap open at 100. Minimum {MIN_BOOST_SATS} sats. Nothing is sent until you press Send.
      </p>
    </div>
  );
}

function DefaultAmountRow({
  kind,
  label,
  hintId,
}: {
  kind: AmountDefaultKind;
  label: string;
  hintId: string;
}) {
  const id = useId();
  const [saved, setSaved] = useState<number | null>(() => readAmountDefault(kind));
  const [draft, setDraft] = useState(() => (saved === null ? '' : String(saved)));
  const [visitOnly, setVisitOnly] = useState(() => storage.amountDefault.isEphemeral(kind));

  useEffect(() => subscribeAmountDefaults(() => {
    const n = readAmountDefault(kind);
    setSaved(n);
    setDraft(n === null ? '' : String(n));
    setVisitOnly(storage.amountDefault.isEphemeral(kind));
  }), [kind]);

  function commit() {
    if (!draft) {
      if (saved !== null) storage.amountDefault.clear(kind);
      return;
    }
    const n = Number(draft);
    if (!Number.isSafeInteger(n) || n < MIN_BOOST_SATS) {
      setDraft(saved === null ? '' : String(saved));
      return;
    }
    if (n !== saved) storage.amountDefault.set(kind, n);
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="text-xs text-bone">{label}</label>
      <span className="inline-flex items-center gap-1.5">
        {visitOnly && saved !== null && (
          <span className="text-[11px] text-bolt/80">this visit only</span>
        )}
        <input
          id={id}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          aria-describedby={hintId}
          placeholder="none"
          className="input !py-1 !px-2 !w-24 sm:!w-20 min-h-[44px] sm:min-h-0 text-[16px] sm:text-xs text-right tabular-nums"
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
        <span className="text-[11px] text-muted">sats</span>
      </span>
    </div>
  );
}
