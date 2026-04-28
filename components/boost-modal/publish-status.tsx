'use client';
import type { PublishedNote } from '@/lib/nostr';

export type PublishState =
  | { kind: 'idle' }
  | { kind: 'publishing' }
  | { kind: 'done'; note: PublishedNote }
  | { kind: 'error'; message: string };

export function PublishStatus({ state }: { state: PublishState }) {
  if (state.kind === 'idle') return null;

  if (state.kind === 'publishing') {
    return <div className="text-xs text-nostr">◆ Publishing to nostr…</div>;
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
