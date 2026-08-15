'use client';
import type { ValueRecipient, BoostResult } from '@/lib/types';
import { recipientAddress, recipientOrder } from '@/lib/util';

// Format a weight as a percentage of the total weight. Integer when it rounds
// cleanly (50%, 90%, 1%), one decimal otherwise (33.3%, 16.7%) — most value
// blocks use whole-number weights so we avoid the visual noise of "33.33%"
// for clean splits.
function formatPct(weight: number, total: number): string {
  if (total <= 0) return '0%';
  const pct = (weight / total) * 100;
  const rounded = Math.round(pct);
  return Math.abs(pct - rounded) < 0.05 ? `${rounded}%` : `${pct.toFixed(1)}%`;
}

export function SplitsPreview({
  recipients,
  splits,
  results,
  title = 'Recipients',
}: {
  recipients: ValueRecipient[];
  splits: number[];
  // Sparse mid-send — a hole is a recipient whose leg hasn't settled yet.
  results: (BoostResult | undefined)[];
  // Overridden only when a boost sends TWO legs — a valueTimeSplit redirect
  // pays the track and the show separately, and two identically-headed
  // "Recipients" cards would leave the user to guess which was which while
  // deciding whether to press the button.
  title?: string;
}) {
  const totalWeight = recipients.reduce((sum, r) => sum + (r.split ?? 0), 0);
  return (
    <div className="card p-3">
      <div className="text-[11px] uppercase tracking-widest text-muted mb-2">{title}</div>
      {/* tabIndex on the scroll box: a keyboard user has no other way to reach
          the rows below the fold in a long value block, since the rows hold no
          focusable controls of their own.
          aria-live so legs settling are announced as they land, rather than
          silently changing under a reader who has already passed them. */}
      <ul
        className="text-xs space-y-1.5 max-h-48 overflow-y-auto pr-2"
        tabIndex={0}
        aria-live="polite"
      >
        {/* Biggest share first — and since sendBoost traverses this same order,
            it's also the order the sats actually go out in. `i` stays the
            ORIGINAL index throughout, so splits[i] and results[i] still belong
            to this recipient. A missing results[i] renders no glyph: that's the
            pending state, and mid-send the holes are scattered rather than
            trailing, because legs settle top-to-bottom of this list. */}
        {recipientOrder(recipients).map((i) => {
          const r = recipients[i];
          const res = results[i];
          const name = r.name?.trim();
          const addr = recipientAddress(r);
          return (
            <li key={i} className="flex justify-between gap-3 items-start">
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  <span className="text-muted mr-1">{r.fee ? 'fee' : '·'}</span>
                  {name || <span className="text-muted">(unnamed)</span>}
                  <span className="text-muted ml-1.5 tabular-nums">{formatPct(r.split ?? 0, totalWeight)}</span>
                </span>
                {/* The destination the sats actually go to — an lnaddress, or an
                    elided keysend pubkey. Skipped when the feed used the address
                    as the name, which would otherwise print it twice. */}
                {name !== r.address && (
                  <span className="block pl-3.5 text-[10px] text-muted font-mono truncate" title={r.address}>
                    {addr}
                  </span>
                )}
              </span>
              <span className="tabular-nums flex items-center gap-2 flex-shrink-0">
                {/* Three states, not two. A leg whose wallet never answered
                    must not show ✗ — the sats may have gone out, and a ✗ is
                    what talks someone into boosting again and paying twice. */}
                {/* Each glyph carries an sr-only word. The mark alone is
                    colour-and-symbol only, and the ? in particular means
                    something a reader cannot guess — its explanation used to
                    live in `title`, which is unreachable on touch and
                    unreliably announced. */}
                {res?.ok && (
                  <span className="text-bolt">✓<span className="sr-only"> sent</span></span>
                )}
                {res && !res.ok && res.indeterminate && (
                  <span className="text-muted" title="Wallet did not answer — this may still have been sent">
                    ?<span className="sr-only"> wallet did not answer — this may still have been sent</span>
                  </span>
                )}
                {res && !res.ok && !res.indeterminate && (
                  <span className="text-nostr">✗<span className="sr-only"> failed</span></span>
                )}
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
  results: (BoostResult | undefined)[];
  totalRecipients: number;
}) {
  // `results` is pre-sized the moment a send starts, so its LENGTH is the
  // recipient count, not the settled count — reading it would render
  // "0/5 sent" before a single leg had gone out. Count what's actually there.
  const settled = results.filter((r): r is BoostResult => !!r);
  if (settled.length === 0) return null;
  const okCount = settled.filter((r) => r.ok).length;
  // Split the two, and lead with the unknowns: an unanswered wallet is the one
  // state where the right next step is "look before you act", and folding it
  // in with the outright failures is what made a paid boost read as a failed
  // one. Counted, not just listed, so it's visible without opening anything.
  const unknown = settled.filter((r) => !r.ok && r.indeterminate);
  const errors = settled.filter((r) => !r.ok && !r.indeterminate);
  return (
    <div className="text-xs text-muted">
      ⚡ Lightning: {okCount}/{totalRecipients} sent
      {unknown.length > 0 && (
        <div className="mt-1">
          <span className="text-bolt">
            {unknown.length} unconfirmed — your wallet didn&rsquo;t answer in time.
          </span>{' '}
          These may already have been paid; check your wallet before boosting again.
          <ul className="mt-1 space-y-0.5">
            {unknown.map((r, i) => (
              <li key={i}>· {r.recipient.name || 'recipient'} ({r.sats} sat)</li>
            ))}
          </ul>
        </div>
      )}
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
