'use client';
import type { PayableLeg } from '@/lib/util';

/**
 * Who the feed lists that this leg does not pay, and why.
 *
 * ONE sentence per reason, in one place. Three hand-written copies of this had
 * drifted into three wordings for the same fact — two in <BoostModal> and a
 * third in <BoostAllModal> — which is the "one place per thing" case in
 * CLAUDE.md: the drift shows up on the screen you were not looking at.
 *
 * WHY IT EXISTS AT ALL. A payee `payableSplit` drops is simply absent from a
 * list the user is reading to check where their money went, and a silent
 * omission on a payment screen is indistinguishable from a bug.
 *
 * WHY TWO REASONS AND NOT A COUNT. Only one of them is the user's to fix.
 * "Boost more to include everyone" is true of a payee this leg is too small to
 * reach, and is advice nobody can act on for a payee the feed lists at
 * `split="0"` — no amount ever reaches them. The modal told a user to boost
 * more at a `split="0"` recipient, which is a sentence that cannot come true.
 */
export function DroppedPayees({
  leg,
  label,
  className = 'text-[11px] text-muted -mt-2',
}: {
  leg: PayableLeg;
  /** Whose split this is, in the user's words — a show title or a track label. */
  label: string;
  className?: string;
}) {
  if (leg.listed === 0) return null;

  const lines: string[] = [];
  if (!leg.payable) {
    // The leg is not sent at all. Say so: the card above it may be empty, and
    // an empty card reads as a load that never finished.
    lines.push(
      leg.sats <= 0
        ? `Nothing goes to ${label}’s split — this boost leaves it 0 sat.`
        : `Nothing goes to ${label}’s split — the feed lists every payee at 0%.`,
    );
  } else {
    if (leg.droppedTooSmall > 0) {
      lines.push(
        `${leg.sats} sat ${leg.sats === 1 ? 'reaches' : 'reach'} ${leg.recipients.length}`
        + ` of ${leg.listed} in ${label}’s split — boost more to include everyone.`,
      );
    }
    if (leg.droppedZeroWeight > 0) {
      const one = leg.droppedZeroWeight === 1;
      lines.push(
        `${leg.droppedZeroWeight} of ${leg.listed} in ${label}’s split`
        + ` ${one ? 'is' : 'are'} listed at 0% and ${one ? 'receives' : 'receive'} nothing.`,
      );
    }
  }
  if (lines.length === 0) return null;

  return (
    <div className={className}>
      {lines.map((line) => <p key={line}>{line}</p>)}
    </div>
  );
}
