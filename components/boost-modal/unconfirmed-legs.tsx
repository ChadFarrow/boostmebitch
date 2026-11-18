'use client';
import type { BoostResult } from '@/lib/v4v/boost';
import { explainPaymentError } from '@/lib/util';
import { PENDING_RECHECK_MS, PENDING_RECHECKS, type LegKey, type LegView } from './use-unconfirmed-legs';

/**
 * One line per `?` leg, under <LightningStatus>'s "unconfirmed" line: what the
 * wallet said about that payment, and the one control that answer allows.
 *
 * Out of the RECIPIENTS box on purpose: that list scrolls (a button in it can
 * sit out of sight) and is `aria-live`, so every status change there is read out.
 *
 * RETRY appears ONLY for `failed`. Every other answer pays nothing and says so;
 * CHECK AGAIN only asks. A leg with no `nwcCheck` (WebLN, Spark, or an invoice
 * we could not read) cannot be asked about, so it keeps the plain line.
 *
 * A refused RETRY's reason (`retryErrors`) stays on the line until the leg is
 * paid: the next lookup says "failed" again, and without the reason RETRY would
 * repeat the same refusal with nothing on screen to say why.
 */
export function UnconfirmedLegs({
  legs,
  views,
  retryErrors,
  busy,
  onCheck,
  onRetry,
}: {
  legs: { key: LegKey; result: BoostResult }[];
  views: Partial<Record<LegKey, LegView>>;
  retryErrors: Partial<Record<LegKey, string>>;
  busy: boolean;
  onCheck: (key: LegKey) => void;
  onRetry: (key: LegKey) => void;
}) {
  return (
    <ul className="mt-1 space-y-1.5" data-unconfirmed-legs>
      {legs.map(({ key, result: r }) => {
        const name = r.recipient.name || 'recipient';
        const view = r.nwcCheck ? views[key] : undefined;
        const retryError = retryErrors[key];
        return (
          <li key={key} data-leg={key} data-leg-state={view?.state ?? (r.nwcCheck ? 'waiting' : 'plain')} className="leading-snug">
            · {name} ({r.sats} sat)
            {view && (
              <div className="pl-3 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>
                  {viewText(view)}
                  {retryError !== undefined && view.state !== 'resending' && (
                    <span data-leg-retry-error> {retryErrorText(retryError)}</span>
                  )}
                </span>
                {view.state === 'failed' && (
                  <button
                    type="button"
                    onClick={() => onRetry(key)}
                    disabled={busy}
                    aria-label={`Retry the payment to ${name}`}
                    className="btn-mini min-h-6 min-w-6 text-bolt border-bolt/50 disabled:opacity-40"
                    data-leg-retry
                  >
                    Retry
                  </button>
                )}
                {(view.state === 'unknown' || (view.state === 'pending' && view.tries >= PENDING_RECHECKS)) && (
                  <button
                    type="button"
                    onClick={() => onCheck(key)}
                    disabled={busy}
                    aria-label={`Ask your wallet again about the payment to ${name}`}
                    className="btn-mini min-h-6 min-w-6 disabled:opacity-40"
                    data-leg-check
                  >
                    Check again
                  </button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function viewText(v: LegView): string {
  switch (v.state) {
    case 'checking':
      return 'Asking your wallet…';
    case 'resending':
      return 'Sending again…';
    case 'pending':
      return v.tries < PENDING_RECHECKS
        ? `Your wallet says this payment is still on its way. The app asks again in ${PENDING_RECHECK_MS / 1000} s.`
        : 'Your wallet says this payment is still on its way.';
    case 'failed':
      // Only what the wallet said. RETRY pays the same hash, so a wrong "failed"
      // still cannot pay this recipient twice.
      return 'Your wallet says this payment failed.';
    case 'unknown': {
      const why = {
        'cannot-ask': 'Your wallet does not let the app look up payments.',
        // NOT_FOUND is also what a wallet that ignored our preimage says about a
        // payment that WENT OUT — so never words that read as "not paid".
        'not-found': 'Your wallet found no payment under the ID the app gave it. It may have paid under its own ID.',
        'no-answer': 'Your wallet did not answer.',
        unclear: 'Your wallet cannot tell if this payment went through.',
        'no-wallet': 'No NWC wallet is connected, so the app cannot ask.',
      }[v.why];
      return `${why} Look in your wallet's history before you boost again.`;
    }
  }
}

/** Why the last RETRY did not go through, in the words `explainPaymentError` uses everywhere. */
function retryErrorText(raw: string): string {
  const { cause, action } = explainPaymentError(raw);
  return `Last retry: ${cause}${action ? ` ${action}` : ''}`;
}
