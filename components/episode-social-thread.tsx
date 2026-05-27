'use client';
import { useEffect, useMemo, useState } from 'react';
import { fetchSocialInteractThread, type DiscoveredNote } from '@/lib/nostr';
import { useApp } from '@/lib/store';
import type { SocialInteract } from '@/lib/types';
import { NoteCard } from './nostr-note-card';

function countNotes(notes: DiscoveredNote[]): number {
  return notes.reduce((sum, n) => sum + 1 + countNotes(n.replies), 0);
}

export function EpisodeSocialThread({ entries }: { entries: SocialInteract[] }) {
  const [notes, setNotes] = useState<DiscoveredNote[] | null>(null);
  const [loading, setLoading] = useState(false);
  const mutedPubkeys = useApp((s) => s.mutedPubkeys);

  const primary = entries[0];
  const njumpUrl = primary.uri.startsWith('nostr:')
    ? `https://njump.me/${primary.uri.slice(6)}`
    : null;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSocialInteractThread(primary.uri)
      .then((n) => { if (!cancelled) setNotes(n); })
      .catch(() => { if (!cancelled) setNotes([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [primary.uri]);

  const visibleNotes = useMemo(
    () => (notes ? notes.filter((n) => !mutedPubkeys.has(n.pubkey)) : notes),
    [notes, mutedPubkeys],
  );

  const total = visibleNotes ? countNotes(visibleNotes) : 0;

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <p className="text-[11px] uppercase tracking-widest text-muted flex-1">
          Nostr comments
          {!loading && total > 0 && (
            <span className="ml-1 text-nostr">({total})</span>
          )}
        </p>
        {njumpUrl && (
          <a
            href={njumpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-muted hover:text-nostr"
          >
            view on nostr →
          </a>
        )}
      </div>
      {loading && <p className="text-xs text-muted">loading thread…</p>}
      {!loading && visibleNotes !== null && total === 0 && (
        <p className="text-xs text-muted">no replies yet</p>
      )}
      {visibleNotes && visibleNotes.length > 0 && (
        <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
          {visibleNotes.map((n) => (
            <NoteCard key={n.id} note={n} />
          ))}
        </div>
      )}
    </div>
  );
}
