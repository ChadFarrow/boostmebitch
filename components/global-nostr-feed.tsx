'use client';
import { useEffect, useState } from 'react';
import { fetchAllPodcastNotes, type DiscoveredNote } from '@/lib/nostr';
import type { Podcast } from '@/lib/types';
import { NoteCard } from './nostr-note-card';

// Module-level cache so repeat references to the same podcast don't fan out
// into duplicate /api/by-guid round-trips while the user is on the page.
const podcastCache = new Map<string, Podcast | null>();

async function resolvePodcast(guid: string): Promise<Podcast | null> {
  if (podcastCache.has(guid)) return podcastCache.get(guid) ?? null;
  try {
    const r = await fetch(`/api/by-guid?guid=${encodeURIComponent(guid)}`);
    if (!r.ok) {
      podcastCache.set(guid, null);
      return null;
    }
    const { podcast } = (await r.json()) as { podcast: Podcast };
    podcastCache.set(guid, podcast ?? null);
    return podcast ?? null;
  } catch {
    podcastCache.set(guid, null);
    return null;
  }
}

/**
 * Global stream of every kind:1 note tagged with NIP-73 podcast identifiers,
 * across all podcasts and clients. Each note's `podcast:guid:` reference is
 * resolved against `/api/by-guid` so the show title + artwork render as
 * context.
 */
export function GlobalNostrFeed() {
  const [notes, setNotes] = useState<DiscoveredNote[] | null>(null);
  const [podcasts, setPodcasts] = useState<Record<string, Podcast | null>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const result = await fetchAllPodcastNotes();
      setNotes(result);
      // Resolve unique podcast guids in the background; UI fills in as each
      // resolution lands.
      const guids = Array.from(
        new Set(result.map((n) => n.podcastGuid).filter((g): g is string => !!g)),
      );
      for (const guid of guids) {
        resolvePodcast(guid).then((p) => {
          setPodcasts((prev) => ({ ...prev, [guid]: p }));
        });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed to load nostr feed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
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
