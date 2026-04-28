'use client';
import type { ValueRecipient, BoostResult } from '@/lib/types';

export function SplitsPreview({
  recipients,
  splits,
  results,
}: {
  recipients: ValueRecipient[];
  splits: number[];
  results: BoostResult[];
}) {
  return (
    <div className="card p-3">
      <div className="text-[11px] uppercase tracking-widest text-muted mb-2">Recipients</div>
      <ul className="text-xs space-y-1 max-h-40 overflow-y-auto">
        {recipients.map((r, i) => {
          const res = results[i];
          return (
            <li key={i} className="flex justify-between gap-3 items-center">
              <span className="truncate">
                <span className="text-muted mr-1">{r.fee ? 'fee' : '·'}</span>
                {r.name || r.address.slice(0, 10) + '…'}
              </span>
              <span className="tabular-nums flex items-center gap-2">
                {res?.ok && <span className="text-bolt">✓</span>}
                {res && !res.ok && <span className="text-nostr">✗</span>}
                {splits[i]} sat
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function LightningStatus({
  results,
  totalRecipients,
}: {
  results: BoostResult[];
  totalRecipients: number;
}) {
  if (results.length === 0) return null;
  const okCount = results.filter((r) => r.ok).length;
  const errors = results.filter((r) => !r.ok);
  return (
    <div className="text-xs text-muted">
      ⚡ Lightning: {okCount}/{totalRecipients} sent
      {errors.length > 0 && (
        <details className="mt-1">
          <summary className="text-nostr cursor-pointer">errors</summary>
          <ul className="mt-1 space-y-0.5">
            {errors.map((r, i) => (
              <li key={i}>{r.recipient.name || 'recipient'}: {r.error}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
