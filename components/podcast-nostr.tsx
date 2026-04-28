'use client';
import { useEffect, useState } from 'react';
import { fetchPodcastNotes, shortNpub, type DiscoveredNote } from '@/lib/nostr';

function timeAgo(unixSec: number): string {
  const diff = Date.now() / 1000 - unixSec;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixSec * 1000).toLocaleDateString();
}

function NoteCard({ note }: { note: DiscoveredNote }) {
  const name =
    note.author?.display_name?.trim() ||
    note.author?.name?.trim() ||
    shortNpub(note.npub);
  const sats =
    note.amountMsat && note.amountMsat > 0
      ? Math.round(note.amountMsat / 1000)
      : null;

  return (
    <article className="card p-3 flex gap-3">
      {note.author?.picture ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={note.author.picture}
          alt=""
          className="w-9 h-9 rounded-full object-cover border border-bone/20 flex-shrink-0"
        />
      ) : (
        <div className="w-9 h-9 rounded-full border border-bone/20 bg-line flex-shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <a
            href={`https://njump.me/${note.npub}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-display text-sm text-bone hover:text-bolt truncate"
            title={note.npub}
          >
            {name}
          </a>
          <span className="text-muted">· {timeAgo(note.createdAt)}</span>
          {note.isBoost && sats !== null && (
            <span className="stamp text-bolt border-bolt/60">⚡ {sats} sats</span>
          )}
          {note.isBoost && sats === null && (
            <span className="stamp text-bolt border-bolt/60">⚡ boost</span>
          )}
          {note.client && (
            <span className="text-muted">via {note.client}</span>
          )}
        </div>
        <p className="text-sm text-bone whitespace-pre-wrap break-words mt-1">
          {note.content}
        </p>
        <a
          href={`https://njump.me/${note.nevent}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-[11px] text-muted hover:text-nostr mt-2"
        >
          view on nostr →
        </a>
      </div>
    </article>
  );
}

/**
 * Renders every public kind:1 note from any author tagged with this podcast's
 * NIP-73 `podcast:guid:` identifier. Loads on first mount; user can press
 * Refresh to re-query.
 */
export function PodcastNostrFeed({ podcastGuid }: { podcastGuid: string }) {
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
