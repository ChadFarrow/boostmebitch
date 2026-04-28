'use client';
import type { ReactNode } from 'react';
import type { DiscoveredNote } from '@/lib/nostr';

/**
 * Shared shell for the global + per-podcast Nostr feeds. Owns the
 * header / refresh-button / loading / error / empty / list state machine so
 * each surface only configures its title, description, empty message, and
 * the per-note renderer.
 */
export function FeedSection({
  heading,
  description,
  notes,
  loading,
  err,
  emptyMessage,
  onRefresh,
  renderNote,
  className = '',
}: {
  heading: ReactNode;
  description?: ReactNode;
  notes: DiscoveredNote[] | null;
  loading: boolean;
  err: string | null;
  emptyMessage: string;
  onRefresh: () => void;
  renderNote: (note: DiscoveredNote) => ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <header className="flex items-center justify-between border-b border-bone/15 pb-2 mb-3">
        {heading}
        <button
          onClick={onRefresh}
          disabled={loading}
          className="btn-ghost text-xs"
          title="Re-query relays"
        >
          {loading ? 'loading…' : 'refresh'}
        </button>
      </header>
      {description}
      {err && <p className="text-sm text-red-400">{err}</p>}
      {!err && notes === null && loading && (
        <p className="text-sm text-muted">searching nostr relays…</p>
      )}
      {!err && notes !== null && notes.length === 0 && (
        <p className="text-sm text-muted">{emptyMessage}</p>
      )}
      {!err && notes !== null && notes.length > 0 && (
        <div className="space-y-2">{notes.map(renderNote)}</div>
      )}
    </section>
  );
}
