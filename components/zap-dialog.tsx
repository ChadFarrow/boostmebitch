'use client';

// The NIP-57 zap dialog: one amount, one optional comment, one Send.
//
// Shared by two surfaces that zap a PERSON, never a value block:
//   - ⚡ zap on a Nostr note (`components/nostr-note-card.tsx`), which zaps the
//     note's author and names the note (`eventId`);
//   - ⚡ ZAP on a community playlist (`components/lists/playlist-zap.tsx`),
//     which zaps the playlist's maker and names the playlist (`refs`).
// It moved here out of the note card on 2026-11-25 so the second surface did
// not grow a second copy of the indeterminate-wallet handling below. The note
// card's behaviour is unchanged: the same field, presets, default and Send.
//
// It pays through `sendZap`, which picks the rail with `pickRail()` (the rail
// preference first, then NWC > Spark > WebLN). A zap is never a boost (boost
// invariant 12): no boostagram, no value block, no keysend. docs/money-boosts.md,
// "A playlist maker's ZAP".

import { useId, useState } from 'react';
import { ModalShell } from './modal-shell';
import { resolvePublishRelays, shortNpub } from '@/lib/nostr';
import type { Nip73Refs } from '@/lib/nostr/zap-request';
import { sendZap, NwcIndeterminateError } from '@/lib/v4v/zap';
import { DefaultAmountControl, MIN_BOOST_SATS, readAmountDefault } from './boost-modal/amount-input';
import { useApp } from '@/lib/store';
import { getErrorMessage } from '@/lib/util';

type ZapState = 'idle' | 'busy' | 'done' | 'error';

/** The person a zap pays: a pubkey and what their kind:0 says. */
export interface ZapRecipient {
  pubkey: string;
  npub: string;
  /** `display_name || name` from the kind:0, when it has one. */
  name?: string;
  lud16?: string;
  lud06?: string;
}

export function ZapDialog({
  recipient,
  identity,
  onClose,
  eventId,
  refs,
  subtitle,
  noAddressText = "This author has no Lightning address on their Nostr profile, so they can't receive zaps.",
  commentPlaceholder = 'great post',
}: {
  recipient: ZapRecipient;
  identity: NonNullable<ReturnType<typeof useApp.getState>['identity']>;
  onClose: () => void;
  /** The note being zapped. Omit for a profile zap. */
  eventId?: string;
  /** What the zap is for, as NIP-73 refs on the kind:9734. */
  refs?: Nip73Refs;
  /** One line under the title: what the zap is for and where it goes. */
  subtitle?: string;
  /** Shown instead of the form when `recipient` has no lud16/lud06. */
  noAddressText?: string;
  commentPlaceholder?: string;
}) {
  // The zap dialog's OWN saved default (SET AS DEFAULT, below the field),
  // never a boost surface's. Both zap surfaces share it: each sends ONE
  // payment of the typed amount, so nothing multiplies it (Chad, 2026-11-25).
  // docs/money-boosts.md, "Default amounts".
  const [amount, setAmount] = useState(() => readAmountDefault('zap') ?? 100);
  const [comment, setComment] = useState('');
  const [state, setState] = useState<ZapState>('idle');
  const [err, setErr] = useState<string | null>(null);
  // The wallet was asked and never answered: the zap MAY have been paid. Send
  // stays disabled, because pressing it again is how the same sats go out twice.
  const [unanswered, setUnanswered] = useState(false);
  // The note card renders inside feeds, which sit in the layout's `relative z-0`
  // content wrapper, so this dialog's z-index couldn't rise above the
  // body-level mini-player (z-30) without escaping it. <ModalShell> owns the
  // portal that does the escaping.

  const canZap = !!(recipient.lud16 || recipient.lud06);

  async function onZap() {
    if (!canZap || amount < MIN_BOOST_SATS) return;
    setState('busy');
    setErr(null);
    try {
      await sendZap({
        recipientPubkey: recipient.pubkey,
        recipientLud16: recipient.lud16,
        recipientLud06: recipient.lud06,
        amountSats: amount,
        comment: comment.trim() || undefined,
        eventId,
        refs,
        relays: resolvePublishRelays(identity),
      });
      setState('done');
      setTimeout(onClose, 800);
    } catch (e) {
      // `sendZap` keeps a reply timeout as `NwcIndeterminateError`: the request
      // was published and the wallet may have paid. A plain failure re-enables
      // Send; this one must not (boost invariant 11, docs/money-boosts.md).
      if (e instanceof NwcIndeterminateError) setUnanswered(true);
      setErr(getErrorMessage(e, 'zap failed'));
      setState('error');
    }
  }

  const zapTarget = recipient.name || shortNpub(recipient.npub, 6);
  // htmlFor/id — both fields were bare siblings, so neither had an accessible
  // name, on the dialog that sends the zap.
  const amountId = useId();
  const commentId = useId();

  return (
    // Not dismissable while paying — this is a real Lightning send.
    <ModalShell
      onClose={onClose}
      label={`Zap ${zapTarget}`}
      className="p-4 max-w-sm w-full"
      dismissable={state !== 'busy'}
      closeButton
    >
        {/* `pr-8` keeps the title clear of the shell's × in the corner. */}
        <header className="mb-3 pr-8">
          <h3 className="font-display text-lg">⚡ Zap {zapTarget}</h3>
          {subtitle && <p className="text-xs text-muted mt-1 break-words">{subtitle}</p>}
        </header>
        {!canZap && (
          <p className="text-sm text-red-400">{noAddressText}</p>
        )}
        {canZap && (
          <>
            <label htmlFor={amountId} className="block text-[11px] uppercase tracking-widest text-muted mb-1">amount (sats)</label>
            <input
              id={amountId}
              type="number"
              min={MIN_BOOST_SATS}
              step={1}
              value={amount}
              // Math.round: the field accepts decimals, and a fractional sat is
              // not a thing that can be sent. No clamp to the minimum here — that
              // would rewrite the field mid-keystroke; the send button gates it.
              onChange={(e) => setAmount(Math.max(0, Math.round(Number(e.target.value) || 0)))}
              className="input w-full mb-2"
            />
            <div className="flex justify-end mb-3">
              <DefaultAmountControl kind="zap" typed={amount} disabled={state === 'busy'} />
            </div>
            <div className="flex gap-2 mb-3">
              {[100, 500, 1000, 5000].map((n) => (
                <button
                  key={n}
                  onClick={() => setAmount(n)}
                  className="btn-ghost text-xs flex-1"
                >
                  {n}
                </button>
              ))}
            </div>
            <label htmlFor={commentId} className="block text-[11px] uppercase tracking-widest text-muted mb-1">comment (optional)</label>
            <input
              id={commentId}
              type="text"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={commentPlaceholder}
              className="input w-full mb-3"
            />
            {amount < MIN_BOOST_SATS && (
              <p className="text-[11px] text-muted mb-2">minimum {MIN_BOOST_SATS} sats</p>
            )}
            <button
              onClick={onZap}
              disabled={state === 'busy' || state === 'done' || unanswered || amount < MIN_BOOST_SATS}
              className="btn-bolt w-full"
            >
              {state === 'busy' ? 'paying…' : state === 'done' ? 'zapped ⚡' : unanswered ? 'check your wallet' : `Send ${amount} sats`}
            </button>
            {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
            {unanswered && (
              <p className="text-xs text-muted mt-2">
                Your wallet did not answer, so this zap may have been paid. Check your wallet before you zap again.
              </p>
            )}
          </>
        )}
    </ModalShell>
  );
}
