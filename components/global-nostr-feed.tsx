'use client';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import {
  fetchAllPodcastNotes,
  resolvePublishRelays,
  shortNpub,
  type DiscoveredNote,
} from '@/lib/nostr';
import { publishQuoteRepost, publishReply, publishRepost } from '@/lib/nostr/interactions';
import { sendZap } from '@/lib/v4v/zap';
import { useApp } from '@/lib/store';
import type { Podcast } from '@/lib/types';
import { getErrorMessage } from '@/lib/util';

// http(s) URLs only — bech32 nostr: URIs are stripped from the content via
// stripNostrUris before this runs since they're noise to a non-Nostr-savvy
// reader and the "view on nostr →" footer link already exposes the source
// event.
const LINK_RE = /(https?:\/\/[^\s]+)/gi;
const NOSTR_URI_RE =
  /nostr:n(?:event|ote|pub|profile|addr)1[023456789acdefghjklmnpqrstuvwxyz]+/gi;

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

// Drop bech32 nostr: URIs from the displayed content, then collapse any blank
// lines or stranded whitespace they leave behind.
function stripNostrUris(text: string): string {
  return text
    .replace(NOSTR_URI_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function linkify(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text)) !== null) {
    if (m.index > cursor) parts.push(text.slice(cursor, m.index));
    const { token, trailing } = splitTrailingPunct(m[0]);
    parts.push(
      <a
        key={`l-${m.index}`}
        href={token}
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

type ActionState = 'idle' | 'busy' | 'done' | 'error';

function NoteCard({
  note,
  podcast,
}: {
  note: DiscoveredNote;
  podcast: Podcast | null;
}) {
  const identity = useApp((s) => s.identity);
  const name =
    note.author?.display_name?.trim() ||
    note.author?.name?.trim() ||
    shortNpub(note.npub);
  const sats =
    note.amountMsat && note.amountMsat > 0
      ? Math.round(note.amountMsat / 1000)
      : null;

  const [composerMode, setComposerMode] = useState<'reply' | 'quote' | null>(null);
  const [composerDraft, setComposerDraft] = useState('');
  const [composerState, setComposerState] = useState<ActionState>('idle');
  const [composerErr, setComposerErr] = useState<string | null>(null);

  const [repostState, setRepostState] = useState<ActionState>('idle');
  const [repostErr, setRepostErr] = useState<string | null>(null);

  const [zapOpen, setZapOpen] = useState(false);

  function openComposer(mode: 'reply' | 'quote') {
    setComposerMode((curr) => (curr === mode ? null : mode));
    setComposerErr(null);
    setComposerState('idle');
  }

  function closeComposer() {
    setComposerMode(null);
    setComposerDraft('');
    setComposerErr(null);
    setComposerState('idle');
  }

  async function onSendComposer() {
    if (!identity || !composerMode) return;
    // Quote reposts allow an empty body (the nevent reference is appended
    // automatically); replies require typed text.
    if (composerMode === 'reply' && !composerDraft.trim()) return;
    setComposerState('busy');
    setComposerErr(null);
    try {
      if (composerMode === 'reply') {
        await publishReply({
          parent: note.rawEvent,
          content: composerDraft.trim(),
          relays: resolvePublishRelays(identity),
        });
      } else {
        await publishQuoteRepost({
          parent: note.rawEvent,
          comment: composerDraft,
          relays: resolvePublishRelays(identity),
        });
      }
      setComposerState('done');
      closeComposer();
    } catch (e) {
      setComposerErr(getErrorMessage(e, `${composerMode} failed`));
      setComposerState('error');
    }
  }

  async function onRepost() {
    if (!identity || repostState === 'busy' || repostState === 'done') return;
    setRepostState('busy');
    setRepostErr(null);
    try {
      await publishRepost({
        parent: note.rawEvent,
        relays: resolvePublishRelays(identity),
      });
      setRepostState('done');
    } catch (e) {
      setRepostErr(getErrorMessage(e, 'repost failed'));
      setRepostState('error');
    }
  }

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
          {linkify(stripNostrUris(note.content))}
        </p>

        <div className="flex items-center gap-3 mt-2 text-[11px] flex-wrap">
          {identity ? (
            <>
              <button
                onClick={() => openComposer('reply')}
                className="text-muted hover:text-nostr"
                aria-label="Reply"
                title="Reply"
              >
                💬 reply
              </button>
              <button
                onClick={onRepost}
                disabled={repostState === 'busy' || repostState === 'done'}
                className="text-muted hover:text-nostr disabled:opacity-60"
                aria-label="Repost"
                title="Repost"
              >
                {repostState === 'done' ? '🔁 reposted' : repostState === 'busy' ? '🔁 …' : '🔁 repost'}
              </button>
              <button
                onClick={() => openComposer('quote')}
                className="text-muted hover:text-nostr"
                aria-label="Quote"
                title="Quote repost"
              >
                ↗ quote
              </button>
              <button
                onClick={() => setZapOpen(true)}
                className="text-muted hover:text-bolt"
                aria-label="Zap"
                title="Zap (NIP-57)"
              >
                ⚡ zap
              </button>
            </>
          ) : (
            <span className="text-muted">sign in to reply / repost / quote / zap</span>
          )}
          <span className="flex-1" />
          <a
            href={`https://njump.me/${note.nevent}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted hover:text-nostr"
          >
            view on nostr →
          </a>
        </div>

        {repostErr && <p className="text-[11px] text-red-400 mt-1">{repostErr}</p>}

        {composerMode && identity && (
          <div className="mt-2 border-t border-bone/15 pt-2">
            <div className="text-[10px] uppercase tracking-widest text-muted mb-1">
              {composerMode === 'reply' ? 'replying' : 'quoting'} ↩ {name}
            </div>
            <textarea
              value={composerDraft}
              onChange={(e) => setComposerDraft(e.target.value)}
              placeholder={
                composerMode === 'reply'
                  ? 'reply on Nostr…'
                  : 'add a comment (optional) — the original note is auto-attached'
              }
              rows={3}
              className="input w-full resize-y text-sm"
            />
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={onSendComposer}
                disabled={
                  composerState === 'busy' ||
                  (composerMode === 'reply' && !composerDraft.trim())
                }
                className="btn text-xs disabled:opacity-50"
              >
                {composerState === 'busy'
                  ? 'sending…'
                  : composerMode === 'reply'
                    ? 'send reply'
                    : 'send quote'}
              </button>
              <button onClick={closeComposer} className="btn-ghost text-xs">
                cancel
              </button>
              {composerErr && <span className="text-[11px] text-red-400">{composerErr}</span>}
            </div>
          </div>
        )}

        {zapOpen && identity && (
          <ZapDialog
            note={note}
            identity={identity}
            onClose={() => setZapOpen(false)}
          />
        )}
      </div>
    </article>
  );
}

function ZapDialog({
  note,
  identity,
  onClose,
}: {
  note: DiscoveredNote;
  identity: NonNullable<ReturnType<typeof useApp.getState>['identity']>;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(100);
  const [comment, setComment] = useState('');
  const [state, setState] = useState<ActionState>('idle');
  const [err, setErr] = useState<string | null>(null);

  const lud = note.author?.lud16 || note.author?.lud06;
  const canZap = !!lud;

  async function onZap() {
    if (!canZap) return;
    setState('busy');
    setErr(null);
    try {
      await sendZap({
        recipientPubkey: note.pubkey,
        recipientLud16: note.author?.lud16,
        recipientLud06: note.author?.lud06,
        amountSats: amount,
        comment: comment.trim() || undefined,
        eventId: note.id,
        relays: resolvePublishRelays(identity),
      });
      setState('done');
      setTimeout(onClose, 800);
    } catch (e) {
      setErr(getErrorMessage(e, 'zap failed'));
      setState('error');
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-ink/80 backdrop-blur-sm grid place-items-center px-4">
      <div className="card p-4 max-w-sm w-full">
        <header className="flex items-center justify-between mb-3">
          <h3 className="font-display text-lg">⚡ Zap {note.author?.display_name || note.author?.name || shortNpub(note.npub, 6)}</h3>
          <button onClick={onClose} className="text-muted hover:text-bone text-xl leading-none">×</button>
        </header>
        {!canZap && (
          <p className="text-sm text-red-400">
            This author has no Lightning address on their Nostr profile, so they can&apos;t receive zaps.
          </p>
        )}
        {canZap && (
          <>
            <label className="block text-[11px] uppercase tracking-widest text-muted mb-1">amount (sats)</label>
            <input
              type="number"
              min={1}
              value={amount}
              onChange={(e) => setAmount(Math.max(1, Number(e.target.value) || 0))}
              className="input w-full mb-3"
            />
            <div className="flex gap-2 mb-3">
              {[21, 100, 500, 1000].map((n) => (
                <button
                  key={n}
                  onClick={() => setAmount(n)}
                  className="btn-ghost text-xs flex-1"
                >
                  {n}
                </button>
              ))}
            </div>
            <label className="block text-[11px] uppercase tracking-widest text-muted mb-1">comment (optional)</label>
            <input
              type="text"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="great post"
              className="input w-full mb-3"
            />
            <button
              onClick={onZap}
              disabled={state === 'busy' || state === 'done'}
              className="btn-bolt w-full"
            >
              {state === 'busy' ? 'paying…' : state === 'done' ? 'zapped ⚡' : `Send ${amount} sats`}
            </button>
            {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
          </>
        )}
      </div>
    </div>
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
