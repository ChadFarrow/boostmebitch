'use client';
import { useEffect, useState } from 'react';
import { fetchPodcastNotes, type DiscoveredNote } from '@/lib/nostr';
import { NoteCard } from './nostr-note-card';

/**
 * Per-podcast Nostr stream — same card UI as <GlobalNostrFeed>, but the relay
 * query is scoped to a single show via NIP-73 `#i: podcast:guid:<guid>`. Used
 * inside <EpisodeList> so selecting a podcast surfaces just that show's
 * boosts and chatter.
 */
export function PodcastNostrFeed({
  podcastGuid,
  podcastTitle,
}: {
  podcastGuid: string;
  podcastTitle?: string;
}) {
  const [notes, setNotes] = useState<DiscoveredNote[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const result = await fetchPodcastNotes(podcastGuid);
      setNotes(result);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed to load nostr feed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setNotes(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [podcastGuid]);

  return (
    <section className="mt-8">
      <header className="flex items-center justify-between border-b border-bone/15 pb-2 mb-3">
        <h3 className="font-display text-lg">
          <span className="text-nostr">#</span> Boosts &amp; chatter on Nostr
          {podcastTitle ? <span className="text-muted text-sm"> · {podcastTitle}</span> : null}
        </h3>
        <button
          onClick={load}
          disabled={loading}
          className="btn-ghost text-xs"
          title="Re-query relays"
        >
          {loading ? 'loading…' : 'refresh'}
        </button>
      </header>
      {err && <p className="text-sm text-red-400">{err}</p>}
      {!err && notes === null && loading && (
        <p className="text-sm text-muted">searching nostr relays…</p>
      )}
      {!err && notes !== null && notes.length === 0 && (
        <p className="text-sm text-muted">
          no nostr notes tagged this podcast yet — be the first to boost.
        </p>
      )}
      {!err && notes !== null && notes.length > 0 && (
        <div className="space-y-2">
          {notes.map((n) => (
            <NoteCard key={n.id} note={n} />
          ))}
        </div>
      )}
    </section>
  );
}
