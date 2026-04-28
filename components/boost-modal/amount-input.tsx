'use client';

const PRESETS = [100, 500, 1000, 5000];

export function AmountInput({
  sats,
  onChange,
}: {
  sats: number;
  onChange: (n: number) => void;
}) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-widest text-muted">Sats</label>
      <div className="flex gap-2 mt-1.5">
        <input
          type="number"
          min={1}
          className="input flex-1"
          value={sats}
          onChange={(e) => onChange(Math.max(1, Number(e.target.value) || 0))}
        />
        {PRESETS.map((n) => (
          <button key={n} onClick={() => onChange(n)} className="btn-ghost !px-3">{n}</button>
        ))}
      </div>
    </div>
  );
}
