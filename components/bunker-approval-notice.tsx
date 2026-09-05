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
// Renders nothing when idle, so a surface can mount it unconditionally.
export function BunkerApprovalNotice({ className = '' }: { className?: string }) {
  const [stage, setStage] = useState<BunkerApprovalStage>({ waiting: false, label: null, attempt: 0 });

  useEffect(() => subscribeBunkerApproval(setStage), []);

  if (!stage.waiting) return null;

  return (
    <div className={`border border-nostr/40 bg-nostr/10 p-2 flex flex-col gap-1 ${className}`}>
      <span className="text-[11px] text-bone">
        ◆ Waiting for you to approve in your signer
        {stage.attempt > 1 ? ` (asked ${stage.attempt}×)` : ''} — approve it and this
        finishes on its own.
      </span>
      <button
        onClick={cancelBunkerApprovalWait}
        className="btn-ghost text-[10px] py-1 px-2 self-start"
      >
        Stop waiting
      </button>
    </div>
  );
}
