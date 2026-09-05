'use client';
import type { PublishedNote } from '@/lib/nostr';
import { BunkerApprovalNotice } from '../bunker-approval-notice';

export type PublishState =
  | { kind: 'idle' }
  | { kind: 'publishing' }
  | { kind: 'done'; note: PublishedNote }
  | { kind: 'error'; message: string };

export function PublishStatus({ state }: { state: PublishState }) {
  if (state.kind === 'idle') return null;

  if (state.kind === 'publishing') {
    // The notice renders nothing unless a bunker is actually waiting on the
    // user, so this costs a signed-out or extension user nothing. It is here
    // because this is where the wait bites: a signer that queues its approvals
    // can hold a boost note for up to 90 s, and "Publishing to nostr…" alone
    // would read as a hang. It matters more here than anywhere else because
    // there is no retry control below — a publish that gives up is a kind:1
    // nothing re-attempts.
    return (
      <div className="text-xs text-nostr space-y-1">
        <div>◆ Publishing to nostr…</div>
        <BunkerApprovalNotice />
      </div>
    );
  }

  if (state.kind === 'error') {
    return <div className="text-xs text-nostr">◆ Publish failed: {state.message}</div>;
  }

  // state.kind === 'done'
  const total = state.note.acceptedRelays.length + state.note.failedRelays.length;
  return (
    <div className="text-xs space-y-1">
      <div className="text-nostr">
        ◆ Published to {state.note.acceptedRelays.length}/{total} relays
      </div>
      <a
        href={`https://njump.me/${state.note.nevent}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-muted hover:text-nostr underline underline-offset-2"
      >
        view note ↗
      </a>
    </div>
  );
}
