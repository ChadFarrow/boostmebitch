'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  fetchEpisodeNotes,
  useVisibleNotes,
  useNostrFeed,
  indexedEpisodeNotes,
  useViewerReposts,
  noteFromEvent,
  noteNpubs,
  resolvePublishRelays,
  type DiscoveredNote,
} from '@/lib/nostr';
import { publishEpisodeComment } from '@/lib/nostr/interactions';
import type { MentionNpub } from '@/lib/nostr/mention-tags';
import { useApp } from '@/lib/store';
import type { Episode, Podcast } from '@/lib/types';
import { getErrorMessage } from '@/lib/util';
import { FeedSection } from './feed-section';
import { MessageInput } from './message-input';
import { NoteCard } from './nostr-note-card';

/** A kind:1 has no Lightning budget; the reply composer's cap. */
const COMMENT_MAX = 2000;

/**
 * Per-episode Nostr stream — relay query scoped to a single episode via
 * NIP-73 `#i: podcast:item:guid:<guid>`. Mounted inside <EpisodeDetailView>.
 *
 * It carries the episode's COMMENT box too. Without it the only way onto this
 * list was a boost, and a show with no value block has no BOOST button — so its
 * Comments tab was a list nobody here could add to.
 */
export function EpisodeNostrFeed({
  episode,
  episodeGuid,
  podcast,
}: {
  episode: Episode;
  /** `episode.guid`, checked present by the caller. */
  episodeGuid: string;
  podcast: Podcast;
}) {
  const { notes, loading, err, refresh, addLocal } = useNostrFeed({
    cacheKey: `episode:${episodeGuid}`,
    fetcher: (opts) => fetchEpisodeNotes(episodeGuid, opts),
    indexFetcher: () => indexedEpisodeNotes(episodeGuid),
    deps: [episodeGuid],
  });
  const identity = useApp((s) => s.identity);
  const mutedPubkeys = useApp((s) => s.mutedPubkeys);
  const repostedIds = useViewerReposts(notes, identity);
  const visibleNotes = useVisibleNotes(notes, mutedPubkeys);

  return (
    <FeedSection
      heading={
        <h3 className="font-display text-lg">
          <span className="text-nostr">#</span> Boosts &amp; comments on Nostr
          {episode.title ? <span className="text-muted text-sm"> · {episode.title}</span> : null}
        </h3>
      }
      description={
        <EpisodeCommentBox
          episode={episode}
          episodeGuid={episodeGuid}
          podcast={podcast}
          onPublished={addLocal}
        />
      }
      notes={visibleNotes}
      loading={loading}
      err={err}
      emptyMessage="no boosts or comments for this episode on nostr yet — be the first."
      onRefresh={refresh}
      renderNote={(n: DiscoveredNote) => (
        <NoteCard key={n.id} note={n} repostedIds={repostedIds} />
      )}
    />
  );
}

type SendState = 'idle' | 'busy' | 'error';

function EpisodeCommentBox({
  episode,
  episodeGuid,
  podcast,
  onPublished,
}: {
  episode: Episode;
  episodeGuid: string;
  podcast: Podcast;
  onPublished: (note: DiscoveredNote) => void;
}) {
  const identity = useApp((s) => s.identity);
  const setSignInOpen = useApp((s) => s.setSignInOpen);
  const [draft, setDraft] = useState('');
  const [mentions, setMentions] = useState<MentionNpub[]>([]);
  const [state, setState] = useState<SendState>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  // Memoised: <MessageInput>'s local-tier effect keys on this list, and a new
  // array per render is the loop docs/nostr.md records for `feedNpubs`.
  const feedNpubs = useMemo(() => noteNpubs(podcast, episode), [podcast, episode]);

  // A draft belongs to one episode.
  useEffect(() => {
    setDraft('');
    setMentions([]);
    setState('idle');
    setErr(null);
    setSentAt(null);
  }, [episodeGuid]);

  if (!identity) {
    return (
      <p className="text-sm text-muted mb-3">
        <button type="button" className="btn-inline" onClick={() => setSignInOpen(true)}>
          Sign in with Nostr
        </button>{' '}
        to comment on this episode.
      </p>
    );
  }

  async function onSend() {
    if (!identity || state === 'busy' || !draft.trim()) return;
    setState('busy');
    setErr(null);
    try {
      const relays = resolvePublishRelays(identity);
      const { event } = await publishEpisodeComment({
        feedGuid: podcast.podcastGuid,
        itemGuid: episodeGuid,
        content: draft,
        relays,
        mentions,
      });
      onPublished(noteFromEvent(event, relays, identity.profile ?? null));
      setDraft('');
      setMentions([]);
      setState('idle');
      setSentAt(Date.now());
    } catch (e) {
      setErr(getErrorMessage(e, 'comment failed'));
      setState('error');
    }
  }

  return (
    <div className="mb-4">
      <MessageInput
        value={draft}
        onChange={(v) => {
          setDraft(v);
          if (sentAt) setSentAt(null);
        }}
        mentions={mentions}
        onMentionsChange={setMentions}
        feedNpubs={feedNpubs}
        label="Comment"
        placeholder="comment on this episode…"
        maxLength={COMMENT_MAX}
        textareaRows={3}
      />
      <div className="flex flex-wrap items-center gap-2 mt-2">
        <button
          type="button"
          onClick={onSend}
          disabled={state === 'busy' || !draft.trim()}
          className="btn text-xs disabled:opacity-50"
        >
          {state === 'busy' ? 'posting…' : '💬 post comment'}
        </button>
        {sentAt && state === 'idle' && (
          <span className="text-[11px] text-muted">posted to Nostr</span>
        )}
        {err && <span className="text-[11px] text-red-400">{err}</span>}
      </div>
    </div>
  );
}
