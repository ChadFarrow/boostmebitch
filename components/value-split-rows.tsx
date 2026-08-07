'use client';
import type { ValueBlock } from '@/lib/types';
import { recipientAddress, recipientOrder } from '@/lib/util';

/**
 * The read-only "who gets paid" list, shared by every surface that shows one.
 *
 * Three surfaces rendered this independently — the show header's value-block
 * panel, the episode detail page and the fullscreen player's Value split
 * disclosure — and they had already drifted: `lists.tsx` carried its own inlined
 * copy of the address elision rather than calling `recipientAddress`, whose own
 * comment says the elision has to stay identical everywhere precisely so a
 * pubkey looks the same wherever you compare it.
 *
 * `<SplitsPreview>` in the boost modal is deliberately NOT folded in. It carries
 * per-leg sat amounts and ✓/✗ delivery status against a live payment, so sharing
 * would mean a component branching on a flag — worse than two components that
 * each read straight through.
 *
 * Order is `recipientOrder`: biggest share first, because feed order is
 * authoring order and buries the recipient the listener actually cares about.
 */
export function ValueSplitRows({
  value,
  className = 'space-y-2',
}: {
  value: ValueBlock;
  className?: string;
}) {
  return (
    <ul className={className}>
      {recipientOrder(value.recipients).map((i) => {
        const r = value.recipients[i];
        return (
          <li key={i} className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap text-sm">
                <span className="font-display">
                  {r.name?.trim() || <span className="text-muted">(unnamed)</span>}
                </span>
                {r.fee && <span className="stamp text-muted border-bone/30">fee</span>}
              </div>
              <div className="text-[11px] text-muted font-mono break-all">
                {recipientAddress(r)}
              </div>
            </div>
            <div className="text-right flex-shrink-0">
              <div className="font-display text-sm text-bolt">{r.split}</div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
