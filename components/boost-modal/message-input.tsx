'use client';
import { useId } from 'react';

export function MessageInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  // htmlFor/id: the label was a bare sibling, so this field had no accessible
  // name at all.
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-[11px] uppercase tracking-widest text-muted">
        Boostagram
      </label>
      <textarea
        id={id}
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
