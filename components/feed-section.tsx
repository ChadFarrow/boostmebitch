'use client';
import type { ReactNode } from 'react';

/**
 * Shared shell for the global + per-podcast Nostr feeds. Owns the
 * header / refresh-button / loading / error / empty / list state machine so
 * each surface only configures its title, description, empty message, and
 * the per-item renderer. Generic in the item type so the global feed can
 * mix Nostr notes with locally-stored boosts.
 */
export function FeedSection<T>({
  heading,
  description,
  notes,
  loading,
  err,
  emptyMessage,
  onRefresh,
  renderNote,
  itemKey,
  className = '',
}: {
  heading: ReactNode;
  description?: ReactNode;
  notes: T[] | null;
  loading: boolean;
  err: string | null;
  emptyMessage: string;
  onRefresh: () => void;
  renderNote: (item: T) => ReactNode;
  /** Optional stable React key per item; defaults to array index. */
  itemKey?: (item: T) => string;
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
        <div className="space-y-2">
          {notes.map((item, i) => (
            <div key={itemKey ? itemKey(item) : i}>{renderNote(item)}</div>
          ))}
        </div>
      )}
    </section>
  );
}
