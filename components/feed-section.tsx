'use client';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { storage } from '@/lib/storage';

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
  collapsibleKey,
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
  /**
   * Opt into a fold-away heading, remembered under this key in
   * `storage.sectionCollapsed`. Omit and the section behaves exactly as before
   * — no toggle, no storage read — so the four existing feeds are untouched.
   *
   * Namespace it by surface ('npub:sent'), never by a value the user or a feed
   * controls: it is a storage key and an `aria-controls` IDREF stem.
   */
  collapsibleKey?: string;
}) {
  const bodyId = useId();
  // Starts EXPANDED and adopts the stored value in an effect, rather than
  // lazily initializing from localStorage the way <FavoritesList> does. That
  // one can read storage during render because it never server-renders; this
  // shell does (the /npub page is SSR'd), so a first client render that
  // disagreed with the server HTML would make React 19 throw the subtree away
  // and rebuild it. The cost is one frame — and it lands while the list still
  // says "searching nostr relays…", so there is no content to flash.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (collapsibleKey) setCollapsed(storage.sectionCollapsed.get().includes(collapsibleKey));
  }, [collapsibleKey]);

  function toggle() {
    if (!collapsibleKey) return;
    // Read-modify-write against STORAGE, not local state: one flat array covers
    // every section on the page, and each <FeedSection> holds its own copy of
    // the flag. Writing from local state would erase the other section's key.
    const next = new Set(storage.sectionCollapsed.get());
    if (!next.delete(collapsibleKey)) next.add(collapsibleKey);
    storage.sectionCollapsed.set([...next]);
    setCollapsed(next.has(collapsibleKey));
  }

  const count = notes?.length ?? null;

  return (
    <section className={className}>
      <header className="flex items-center justify-between border-b border-bone/15 pb-2 mb-3 gap-2">
        {collapsibleKey ? (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            className="flex items-center gap-2 min-w-0 text-left hover:opacity-80"
          >
            <span aria-hidden className="text-bone/60 text-sm">{collapsed ? '▸' : '▾'}</span>
            <span className="min-w-0">{heading}</span>
            {/* The count rides in the HEADER, not only in the description,
                because a collapsed section hides its description — and a fold
                that leaves nothing behind but a title tells the reader less
                than the closed drawer it replaced. */}
            {count !== null && (
              <span className="text-xs text-muted shrink-0">({count})</span>
            )}
          </button>
        ) : (
          heading
        )}
        <button
          onClick={onRefresh}
          disabled={loading}
          className="btn-ghost text-xs shrink-0"
          title="Re-query relays"
        >
          {loading ? 'loading…' : 'refresh'}
        </button>
      </header>
      {/* The wrapper always renders so `aria-controls` resolves; only its
          contents are dropped, which is what keeps a collapsed 100-card list
          from being built at all. */}
      <div id={bodyId}>
        {!collapsed && (
          <>
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
          </>
        )}
      </div>
    </section>
  );
}
