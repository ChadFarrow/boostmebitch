'use client';

export function MessageInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-widest text-muted">Boostagram</label>
      <textarea
        className="input mt-1.5 resize-none"
        rows={2}
        maxLength={200}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="optional message…"
      />
    </div>
  );
}
