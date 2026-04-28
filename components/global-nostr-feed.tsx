'use client';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { fetchAllPodcastNotes, shortNpub, type DiscoveredNote } from '@/lib/nostr';
import type { Podcast } from '@/lib/types';

// Matches http(s) URLs and bech32 nostr: URIs (nevent/note/npub/nprofile/naddr).
// The bech32 charset is restricted to nostr-tools' alphabet so we don't grab
// trailing prose by accident.
const LINK_RE =
  /(https?:\/\/[^\s]+|nostr:n(?:event|ote|pub|profile|addr)1[023456789acdefghjklmnpqrstuvwxyz]+)/gi;

// Trailing punctuation that's almost always sentence/grammar, not part of the
// URL — peel it off and render outside the anchor.
function splitTrailingPunct(token: string): { token: string; trailing: string } {
  let trailing = '';
  while (token.length > 0 && /[.,;:!?)\]]$/.test(token)) {
    trailing = token.slice(-1) + trailing;
    token = token.slice(0, -1);
  }
  return { token, trailing };
}

function linkify(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  // Reset because we declared with /g.
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text)) !== null) {
    if (m.index > cursor) parts.push(text.slice(cursor, m.index));
    const { token, trailing } = splitTrailingPunct(m[0]);
    const href = token.startsWith('nostr:')
      ? `https://njump.me/${token.slice('nostr:'.length)}`
      : token;
    parts.push(
      <a
        key={`l-${m.index}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-nostr break-all hover:underline underline-offset-2"
      >
        {token}
      </a>,
    );
    if (trailing) parts.push(<Fragment key={`t-${m.index}`}>{trailing}</Fragment>);
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function timeAgo(unixSec: number): string {
  const diff = Date.now() / 1000 - unixSec;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixSec * 1000).toLocaleDateString();
}

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

function NoteCard({
  note,
  podcast,
}: {
  note: DiscoveredNote;
  podcast: Podcast | null;
}) {
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
          {note.client && <span className="text-muted">via {note.client}</span>}
        </div>

        {podcast && (
          <div className="flex items-center gap-2 mt-1.5 text-[11px] text-muted">
            {podcast.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={podcast.image}
                alt=""
                className="w-4 h-4 object-cover border border-bone/20 flex-shrink-0"
              />
            ) : null}
            <span className="truncate">
              <span className="text-nostr">→</span>{' '}
              <span className="text-bone">{podcast.title}</span>
              {podcast.author ? <span className="text-muted"> · {podcast.author}</span> : null}
            </span>
          </div>
        )}
        {!podcast && note.podcastGuid && (
          <div className="mt-1.5 text-[11px] text-muted truncate">
            <span className="text-nostr">→</span> {note.podcastGuid}
          </div>
        )}

        <p className="text-sm text-bone whitespace-pre-wrap break-words mt-1.5">
          {linkify(note.content)}
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
