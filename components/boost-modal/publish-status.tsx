'use client';
import type { PublishedNote, SignerCheck } from '@/lib/nostr';
import { BunkerApprovalNotice } from '../bunker-approval-notice';
import { BunkerRestoreNotice } from '../bunker-restore-notice';

export type PublishState =
  | { kind: 'idle' }
  /** `step: 'stamp'` while a site-signed note's 1-sat stamp is being paid. */
  | { kind: 'publishing'; step?: 'stamp' }
  /**
   * `notice`: why the note went out from a one-time key instead of the site's
   * (lib/site-stamp.ts). The note IS posted; this says by whom.
   */
  | { kind: 'done'; note: PublishedNote; notice?: string }
  /**
   * `retry` posts the SAME note again — same boost, same receipt if one was
   * already published. Absent where there is nothing to retry with.
   */
  | { kind: 'error'; message: string; retry?: () => void };

/**
 * Why a boost note was not signed, when the signer check said so BEFORE the
 * signature was asked for. A refusal is quoted, never paraphrased — the same
 * rule <BunkerHealthBanner> follows: "Pairing limit reached" and "Client not
 * paired" want different next moves, and only the reader can pick.
 */
export function signerCheckMessage(check: Exclude<SignerCheck, { kind: 'ok' }>): string {
  return check.kind === 'refused'
    ? `your signer refused: “${check.message}”`
    : 'your signer did not answer, so nothing was signed';
}

export function PublishStatus({ state }: { state: PublishState }) {
  if (state.kind === 'idle') return null;

  if (state.kind === 'publishing') {
    // The notice renders nothing unless a bunker is actually waiting on the
    // user, so this costs a signed-out or extension user nothing. It is here
    // because this is where the wait bites: a signer that queues its approvals
    // can hold a boost note for up to 90 s, and "Publishing to nostr…" alone
    // would read as a hang.
    //
    // The restore notice is the other wait: `checkSignerLink` runs before the
    // note signs, and on a dead link it probes for 10 s and then reconnects.
    // It renders nothing for the first five seconds, so a healthy check — one
    // ping — never shows it.
    return (
      <div role="status" className="text-xs text-nostr space-y-1">
        <div>{state.step === 'stamp' ? '◆ Paying the 1-sat stamp…' : '◆ Publishing to nostr…'}</div>
        <BunkerApprovalNotice />
        <BunkerRestoreNotice />
      </div>
    );
  }

  if (state.kind === 'error') {
    // The note is the one part of a boost that nothing else re-attempts: the
    // sats have moved, the modal's payment Retry covers legs, and a kind:1
    // that was never signed is gone unless this button posts it. A retry is
    // safe against a duplicate — nothing published the first attempt, since
    // the event is published only after the signer's answer arrives.
    return (
      <div role="status" className="text-xs text-nostr space-y-1">
        <div>◆ Note not posted: {state.message}</div>
        {state.retry && (
          <button onClick={state.retry} className="btn-ghost text-nostr">
            Retry note
          </button>
        )}
      </div>
    );
  }

  // state.kind === 'done'
  const total = state.note.acceptedRelays.length + state.note.failedRelays.length;
  // `role="status"` on every branch: the payment rows beside this announce
  // each leg (splits-preview.tsx), and the note's publishing → done/failed
  // sequence changed silently in the same modal.
  return (
    <div role="status" className="text-xs space-y-1">
      <div className="text-nostr">
        ◆ Published to {state.note.acceptedRelays.length}/{total} relays
      </div>
      {state.notice && <div className="text-muted leading-relaxed">{state.notice}</div>}
      <a
        href={`https://njump.me/${encodeURIComponent(state.note.nevent)}`}
        target="_blank"
        rel="noopener noreferrer"
        className="btn-inline text-muted hover:text-nostr"
      >
        view note ↗
      </a>
    </div>
  );
}
