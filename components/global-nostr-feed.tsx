'use client';
import { useEffect, useState } from 'react';
import { fetchAllPodcastNotes, type DiscoveredNote } from '@/lib/nostr';
import { storage } from '@/lib/storage';
import type { Podcast } from '@/lib/types';
import { NoteCard } from './nostr-note-card';

// In-memory mirror of storage.podcastMeta — avoids re-parsing localStorage on
// every NoteCard render within the same page session.
const podcastMem = new Map<string, Podcast | null>();

async function resolvePodcast(guid: string): Promise<Podcast | null> {
  if (podcastMem.has(guid)) return podcastMem.get(guid) ?? null;
  const cached = storage.podcastMeta.get(guid);
  if (cached) {
    podcastMem.set(guid, cached);
    return cached;
  }
  try {
    const r = await fetch(`/api/by-guid?guid=${encodeURIComponent(guid)}`);
    if (!r.ok) {
      podcastMem.set(guid, null);
      return null;
    }
    const { podcast } = (await r.json()) as { podcast: Podcast };
    if (podcast) {
      podcastMem.set(guid, podcast);
      storage.podcastMeta.set(guid, podcast);
      return podcast;
    }
    podcastMem.set(guid, null);
    return null;
  } catch {
    podcastMem.set(guid, null);
    return null;
  }
}

/**
 * Global stream of every kind:1 note tagged with NIP-73 podcast identifiers,
 * across all podcasts and clients. Stale-while-revalidate: on mount we paint
 * the last cached DiscoveredNote[] (5-min TTL in localStorage) instantly,
 * then re-query relays in the background and replace.
 */
export function GlobalNostrFeed() {
  const [notes, setNotes] = useState<DiscoveredNote[] | null>(() => storage.feedNotes.get('global'));
  const [podcasts, setPodcasts] = useState<Record<string, Podcast | null>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function resolveGuids(notes: DiscoveredNote[]) {
    const guids = Array.from(
      new Set(notes.map((n) => n.podcastGuid).filter((g): g is string => !!g)),
    );
    for (const guid of guids) {
      resolvePodcast(guid).then((p) => {
        setPodcasts((prev) => ({ ...prev, [guid]: p }));
      });
    }
  }

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const result = await fetchAllPodcastNotes();
      setNotes(result);
      storage.feedNotes.set('global', result);
      resolveGuids(result);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed to load nostr feed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Resolve cached notes' podcast metadata immediately so cards from the
    // SWR paint render with show context, not just guids.
    if (notes && notes.length > 0) resolveGuids(notes);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section>
      <header className="flex items-center justify-between border-b border-bone/15 pb-2 mb-4">
        <h2 className="font-display text-2xl">
          <span className="text-nostr">#</span> Global boost feed
        </h2>
        <button
          onClick={load}
          disabled={loading}
          className="btn-ghost text-xs"
          title="Re-query relays"
        >
          {loading ? 'loading…' : 'refresh'}
        </button>
      </header>
      <p className="text-xs text-muted mb-4">
        Every public Nostr post tagged with a Podcasting 2.0 <code>podcast:guid</code> identifier —
        boosts, comments, and chatter from any client following the convention (Fountain, Wavlake,
        BoostMeBitch, etc.).
      </p>
      {err && <p className="text-sm text-red-400">{err}</p>}
      {!err && notes === null && loading && (
        <p className="text-sm text-muted">searching nostr relays…</p>
      )}
      {!err && notes !== null && notes.length === 0 && (
        <p className="text-sm text-muted">no nostr activity surfaced from these relays yet.</p>
      )}
      {!err && notes !== null && notes.length > 0 && (
        <div className="space-y-2">
          {notes.map((n) => (
            <NoteCard
              key={n.id}
              note={n}
              podcast={n.podcastGuid ? podcasts[n.podcastGuid] ?? null : null}
            />
          ))}
        </div>
      )}
    </section>
  );
}
