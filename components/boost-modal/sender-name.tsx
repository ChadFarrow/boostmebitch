'use client';
import type { NostrIdentity } from '@/lib/nostr';

export function SenderName({
  value,
  onChange,
  identity,
}: {
  value: string;
  onChange: (v: string) => void;
  identity: NostrIdentity | null;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label className="text-[11px] uppercase tracking-widest text-muted">From</label>
        <input
          className="input mt-1.5"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="anon"
        />
      </div>
      <div>
        <label className="text-[11px] uppercase tracking-widest text-muted">Signed as</label>
        <div className="input mt-1.5 truncate text-muted">
          {identity ? <span className="text-nostr">◆ nostr</span> : 'not signed in'}
        </div>
      </div>
    </div>
  );
}
