'use client';
import type { ValueRecipient, BoostResult } from '@/lib/types';
import { explainPaymentError, feeNote, recipientAddress, recipientOrder, type PaymentErrorExplanation } from '@/lib/util';
import { LegStatusGlyph } from '../leg-status-glyph';

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
  listed,
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
  // Every recipient the FEED listed, when `recipients` has been trimmed to the
  // ones this leg can pay (`payableLeg`). The percentages are the feed's
  // AUTHORED shares, so their denominator is the authored weight total: a block
  // of 5/1/5/1 trimmed to its two 5s rendered 50% each where the feed said
  // 41.7%, directly above a line saying two more payees exist. The card would
  // assert that two payees are entitled to half each while naming four.
  // Defaults to `recipients`, so an untrimmed caller is unchanged.
  listed?: ValueRecipient[];
}) {
  const authored = listed ?? recipients;
  const totalWeight = authored.reduce((sum, r) => sum + (r.split ?? 0), 0);
  // Why the shares below can carry a decimal and not add to 100: a fee's weight
  // is in that total like any other. See `feeNote`. Read off the authored list
  // for the same reason the denominator is — a dropped fee recipient's weight
  // is still in the total it explains.
  const note = feeNote(authored);
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
                {/* Three states, not two — see <LegStatusGlyph>. */}
                {res && <LegStatusGlyph ok={res.ok} indeterminate={res.indeterminate} />}
                {splits[i]} sat
              </span>
            </li>
          );
        })}
      </ul>
      {/* OUTSIDE the <ul>, which is `aria-live="polite"` so legs are announced
          as they settle — static copy inside it is re-announced on every settle.
          Outside the `max-h-48` scroll box too, so it stays on screen under a
          long value block instead of scrolling away. */}
      {note && <p className="mt-2 text-[11px] text-muted leading-snug">{note}</p>}
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
      {errors.length > 0 && <FailedLegs errors={errors} />}
    </div>
  );
}

/**
 * The failed legs, grouped by what went WRONG rather than listed per payee.
 *
 * One unreachable wallet relay fails every NWC leg with the same library
 * string, so a per-leg list printed "Failed to connect to wss://…" eight times
 * and buried the one different line (a recipient's own service refusing) in
 * the middle. Grouped, it reads as two causes. Open by default: the user just
 * watched the boost fail, and "why" is the question on screen.
 *
 * "Nothing was sent" is printed only where `explainPaymentError` PROVES it —
 * see its note. The raw library text stays one tap away for a bug report.
 */
function FailedLegs({ errors }: { errors: BoostResult[] }) {
  const groups = new Map<string, { x: PaymentErrorExplanation; legs: BoostResult[] }>();
  for (const r of errors) {
    const x = explainPaymentError(r.error);
    const key = `${x.cause}|${x.action ?? ''}|${x.nothingSent}`;
    const g = groups.get(key);
    if (g) g.legs.push(r);
    else groups.set(key, { x, legs: [r] });
  }
  return (
    <details className="mt-1" open>
      <summary className="text-nostr cursor-pointer">
        {errors.length} failed — why
      </summary>
      <ul className="mt-1 space-y-2">
        {[...groups.values()].map(({ x, legs }) => (
          <li key={`${x.cause}|${x.action ?? ''}|${x.nothingSent}`} className="leading-snug">
            <span className="text-bone">{x.cause}</span>
            {x.nothingSent && (
              <span> Nothing was sent to {legs.length === 1 ? 'this recipient' : 'these recipients'}.</span>
            )}
            {x.action && <span> {x.action}</span>}
            <div className="text-[11px] text-muted/80">
              {/* ` · `, not a comma: payee names carry commas of their own
                  ("Mutton, Mead & Music"), so a comma list reads as more payees. */}
              {legs.map((r) => r.recipient.name || 'recipient').join(' · ')}
            </div>
          </li>
        ))}
      </ul>
      <details className="mt-2">
        <summary className="cursor-pointer text-[11px]">technical details</summary>
        <ul className="mt-1 space-y-0.5 text-[11px] break-words">
          {errors.map((r, i) => (
            <li key={i}>{r.recipient.name || 'recipient'}: {r.error}</li>
          ))}
        </ul>
      </details>
    </details>
  );
}
