'use client';
import { useEffect, useState } from 'react';
import { subscribeBunkerApproval, cancelBunkerApprovalWait, type BunkerApprovalStage } from '@/lib/nostr';

// "Your signer has the request and is waiting for you."
//
// WHY THIS IS A COMPONENT AND NOT A LINE OF COPY IN EACH PLACE. A NIP-46 signer
// that queues a request for its user — Clave on iOS is the one this was built
// for — answers `permission denied` immediately and delivers the real result
// only after the tap. lib/nostr/bunker.ts re-issues for up to 90 s, and a 90 s
// silence is exactly the "guard that withholds without saying so" CLAUDE.md
// forbids: indistinguishable from a hang, and <BunkerHealthBanner> deliberately
// does NOT fire, because the signer answered.
//
// It carries its own escape hatch, and that is the load-bearing half rather
// than the sentence. NIP-46 standardises no error strings, so a signer
// REFUSING outright may phrase it identically to one that is queueing; that
// user would otherwise watch this for the full budget. "Stop waiting" makes it
// one tap. See withApprovalWait's accepted-risk note.
//
/**
 * What the signer is being asked for, in words — from `BunkerApprovalStage.label`.
 *
 * The notice used to say only "waiting for you to approve", which is true of
 * six different requests, and on a connection set to approve everything a user
 * has no way to tell which one their signer is refusing. Clave has answered
 * `no permission` on a Full Trust connection (docs/signers.md), so "I set it to
 * approve everything" does not settle it; the request does. Unknown labels and
 * kinds fall through to the raw label rather than to a guess.
 */
const KIND_NAMES: Record<number, string> = {
  0: 'your profile',
  1: 'a note',
  3: 'your follow list',
  5: 'a deletion',
  6: 'a repost',
  7: 'a reaction',
  17: 'an episode like',
  1311: 'a live chat message',
  3369: 'a value receipt',
  9734: 'a zap request',
  10000: 'your mute list',
  10002: 'your relay list',
  10333: 'your favorites list',
  30078: 'an app settings backup',
  33369: 'a value summary',
};

export function approvalRequestText(label: string | null): string | null {
  if (!label) return null;
  const sign = /^sign_event kind:(\d+)$/.exec(label);
  if (sign) {
    const kind = Number(sign[1]);
    return `signing ${KIND_NAMES[kind] ?? 'an event'} (kind ${kind})`;
  }
  switch (label) {
    case 'connect':
    case 'reconnect':
      return 'connecting this site';
    case 'get_public_key':
      return 'reading your public key';
    case 'nip04_encrypt':
    case 'nip44_encrypt':
      return 'encrypting a private list';
    default:
      return label;
  }
}

// Renders nothing when idle, so a surface can mount it unconditionally.
export function BunkerApprovalNotice({ className = '' }: { className?: string }) {
  const [stage, setStage] = useState<BunkerApprovalStage>({ waiting: false, label: null, attempt: 0 });

  useEffect(() => subscribeBunkerApproval(setStage), []);

  if (!stage.waiting) return null;
  const what = approvalRequestText(stage.label);

  return (
    <div className={`border border-nostr/40 bg-nostr/10 p-2 flex flex-col gap-1 ${className}`}>
      <span className="text-[11px] text-bone">
        ◆ Waiting for you to approve in your signer
        {stage.attempt > 1 ? ` (asked ${stage.attempt}×)` : ''} — approve it and this
        finishes on its own.
      </span>
      {what && (
        <span className="text-[10px] text-muted">Request: {what}</span>
      )}
      <button
        onClick={cancelBunkerApprovalWait}
        className="btn-ghost text-[10px] py-1 px-2 self-start"
      >
        Stop waiting
      </button>
    </div>
  );
}
