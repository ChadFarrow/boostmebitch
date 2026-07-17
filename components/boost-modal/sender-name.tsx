'use client';

export function SenderName({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-widest text-muted">From</label>
      <input
        className="input mt-1.5 w-full"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="boostmebitch.com user"
      />
    </div>
  );
}
