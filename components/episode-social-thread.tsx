'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchSocialInteractThread,
  noteFromEvent,
  resolvePublishRelays,
  type DiscoveredNote,
} from '@/lib/nostr';
import { publishReply } from '@/lib/nostr/interactions';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import type { SocialInteract } from '@/lib/types';
import { getErrorMessage } from '@/lib/util';
import { NoteCard } from './nostr-note-card';

function countNotes(notes: DiscoveredNote[]): number {
  return notes.reduce((sum, n) => sum + 1 + countNotes(n.replies), 0);
}

type ThreadStatus = 'loading' | 'ready' | 'error';
type ActionState = 'idle' | 'busy' | 'done' | 'error';

export function EpisodeSocialThread({
  entries,
  label = 'Nostr comments',
}: {
  entries: SocialInteract[];
  label?: string;
}) {
  const [status, setStatus] = useState<ThreadStatus>('loading');
  const [notes, setNotes] = useState<DiscoveredNote[] | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false); // fetch failed AFTER something was already painted
  const [loadingReplies, setLoadingReplies] = useState(false); // root painted, reply tree still streaming
  const [reloadTick, setReloadTick] = useState(0);

  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [sendState, setSendState] = useState<ActionState>('idle');
  const [sendErr, setSendErr] = useState<string | null>(null);

  // Optimistic comments survive a wholesale setNotes (the reply-tree replace or
  // a later revalidation) until a fetch genuinely carries them back.
  const pendingOptimistic = useRef<DiscoveredNote[]>([]);

  const identity = useApp((s) => s.identity);
  const mutedPubkeys = useApp((s) => s.mutedPubkeys);

  const primary = entries[0];
  const njumpUrl = primary.uri.startsWith('nostr:')
    ? `https://njump.me/${primary.uri.slice(6)}`
    : null;

  // Re-attach any optimistic note the incoming array doesn't already contain
  // (matched by id, anywhere in the tree) so a fresh fetch can't drop a comment
  // the user just posted to relays we don't query.
  const applyPending = useCallback((arr: DiscoveredNote[]): DiscoveredNote[] => {
    const pend = pendingOptimistic.current;
    if (!pend.length || !arr.length) return arr;
    const have = new Set<string>();
    const collect = (ns: DiscoveredNote[]) => {
      for (const x of ns) {
        have.add(x.id);
        collect(x.replies);
      }
    };
    collect(arr);
    const missing = pend.filter((p) => !have.has(p.id));
    if (!missing.length) return arr;
    return arr.map((n, i) =>
      i === 0 ? { ...n, replies: [...n.replies, ...missing] } : n,
    );
  }, []);

  // Reset the composer whenever the episode (URI) changes — not on a manual
  // reload, so a retry doesn't wipe an in-progress draft.
  useEffect(() => {
    setComposerOpen(false);
    setDraft('');
    setSendState('idle');
    setSendErr(null);
    pendingOptimistic.current = [];
  }, [primary.uri]);

  // Stale-while-revalidate: paint cache (or the root-only progressive paint)
  // immediately, then replace with the full thread. reloadTick bumps drive the
  // retry button through the same path so cancellation stays correct.
  useEffect(() => {
    let cancelled = false;
    const cached = storage.socialThread.get(primary.uri);
    let painted = false;
    if (cached && cached.length) {
      setNotes(applyPending(cached));
      setStatus('ready');
      painted = true;
    } else {
      setNotes(null);
      setStatus('loading');
    }
    setRefreshFailed(false);
    setLoadingReplies(false);

    fetchSocialInteractThread(primary.uri, {
      onRoot: (root) => {
        if (cancelled || painted) return;
        painted = true;
        setNotes(applyPending([root]));
        setStatus('ready');
        setLoadingReplies(true);
      },
    })
      .then((fresh) => {
        if (cancelled) return;
        setNotes(applyPending(fresh));
        setStatus('ready');
        setLoadingReplies(false);
        storage.socialThread.set(primary.uri, fresh);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadingReplies(false);
        if (painted) setRefreshFailed(true);
        else setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [primary.uri, reloadTick, applyPending]);

  const visibleNotes = useMemo(
    () => (notes ? notes.filter((n) => !mutedPubkeys.has(n.pubkey)) : notes),
    [notes, mutedPubkeys],
  );

  // The root anchor always renders, so "comments" = total minus the top-level
  // note(s), not total minus 1.
  const total = visibleNotes ? countNotes(visibleNotes) : 0;
  const replyCount =
    visibleNotes && visibleNotes.length ? Math.max(0, total - visibleNotes.length) : 0;

  // Reply target is the publisher-designated thread root (notes[0], unfiltered
  // so a muted-root edge case doesn't break replying).
  const rootNote = notes && notes.length ? notes[0] : null;

  async function onSend() {
    if (!identity || !rootNote || !draft.trim()) return;
    setSendState('busy');
    setSendErr(null);
    try {
      const relays = resolvePublishRelays(identity);
      const { event } = await publishReply({
        parent: rootNote.rawEvent,
        content: draft.trim(),
        relays,
      });
      const optimistic = noteFromEvent(event, relays, identity.profile ?? null);
      pendingOptimistic.current = [...pendingOptimistic.current, optimistic];
      const next = (notes ?? []).map((n, i) =>
        i === 0 ? { ...n, replies: [...n.replies, optimistic] } : n,
      );
      setNotes(next);
      storage.socialThread.set(primary.uri, next);
      setDraft('');
      setComposerOpen(false);
      setSendState('done');
    } catch (e) {
      setSendErr(getErrorMessage(e, 'comment failed'));
      setSendState('error');
    }
  }

  const showComposerArea = status === 'ready' && (rootNote ? true : !!identity);

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <p className="text-[11px] uppercase tracking-widest text-muted flex-1">
          {label}
          {status === 'ready' && replyCount > 0 && (
            <span className="ml-1 text-nostr">({replyCount})</span>
          )}
        </p>
        {refreshFailed && (
          <span className="text-[11px] text-muted">couldn&apos;t refresh</span>
        )}
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

      {status === 'loading' && (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="card p-3 animate-pulse">
              <div className="h-3 w-24 bg-bone/10 rounded mb-2" />
              <div className="h-3 w-full bg-bone/10 rounded mb-1.5" />
              <div className="h-3 w-2/3 bg-bone/10 rounded" />
            </div>
          ))}
        </div>
      )}

      {status === 'error' && (
        <div>
          <p className="text-xs text-red-400">couldn&apos;t load this thread</p>
          <button
            onClick={() => setReloadTick((t) => t + 1)}
            className="btn-ghost text-xs mt-1"
          >
            retry
          </button>
        </div>
      )}

      {status === 'ready' && (
        <>
          {visibleNotes && visibleNotes.length > 0 && (
            <div className="space-y-3">
              {visibleNotes.map((n) => (
                <NoteCard key={n.id} note={n} />
              ))}
            </div>
          )}
          {loadingReplies && (
            <p className="text-xs text-muted mt-2">loading replies…</p>
          )}
          {(!visibleNotes || visibleNotes.length === 0) && !loadingReplies && (
            <p className="text-xs text-muted">no comments yet</p>
          )}

          {showComposerArea && (
            <div className="mt-3 border-t border-bone/10 pt-2">
              {!rootNote ? (
                <span className="text-muted text-xs">
                  this episode&apos;s thread root isn&apos;t on relays yet — nothing to comment on
                </span>
              ) : !identity ? (
                <span className="text-muted text-xs">sign in to comment</span>
              ) : !composerOpen ? (
                <button
                  onClick={() => {
                    setComposerOpen(true);
                    setSendState('idle');
                    setSendErr(null);
                  }}
                  className="text-muted hover:text-nostr text-xs"
                  aria-label="Comment"
                  title="Comment on this episode"
                >
                  💬 comment
                </button>
              ) : (
                <div>
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="comment on this episode…"
                    rows={3}
                    className="input w-full resize-y text-sm"
                  />
                  <div className="flex items-center gap-2 mt-2">
                    <button
                      onClick={onSend}
                      disabled={sendState === 'busy' || !draft.trim()}
                      className="btn text-xs disabled:opacity-50"
                    >
                      {sendState === 'busy' ? 'sending…' : 'post comment'}
                    </button>
                    <button
                      onClick={() => {
                        setComposerOpen(false);
                        setDraft('');
                        setSendErr(null);
                        setSendState('idle');
                      }}
                      className="btn-ghost text-xs"
                    >
                      cancel
                    </button>
                    {sendErr && (
                      <span className="text-[11px] text-red-400">{sendErr}</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
