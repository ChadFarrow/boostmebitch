'use client';
import { useMemo } from 'react';
import {
  fetchEpisodeNotes,
  useNostrFeed,
  useViewerReposts,
  type DiscoveredNote,
} from '@/lib/nostr';
import { useApp } from '@/lib/store';
import { FeedSection } from './feed-section';
import { NoteCard } from './nostr-note-card';

/**
 * Per-episode Nostr stream — relay query scoped to a single episode via
 * NIP-73 `#i: podcast:item:guid:<guid>`. Mounted inside <EpisodeDetailView>.
 */
export function EpisodeNostrFeed({
  episodeGuid,
  episodeTitle,
}: {
  episodeGuid: string;
  episodeTitle?: string;
}) {
  const { notes, loading, err, refresh } = useNostrFeed({
    cacheKey: `episode:${episodeGuid}`,
    fetcher: (opts) => fetchEpisodeNotes(episodeGuid, opts),
    deps: [episodeGuid],
  });
  const identity = useApp((s) => s.identity);
  const mutedPubkeys = useApp((s) => s.mutedPubkeys);
  const repostedIds = useViewerReposts(notes, identity);
  const visibleNotes = useMemo(
    () => (notes ? notes.filter((n) => !mutedPubkeys.has(n.pubkey)) : notes),
    [notes, mutedPubkeys],
  );

  return (
    <FeedSection
      className="mt-8"
      heading={
        <h3 className="font-display text-lg">
          <span className="text-nostr">#</span> Boosts &amp; chatter on Nostr
          {episodeTitle ? <span className="text-muted text-sm"> · {episodeTitle}</span> : null}
        </h3>
      }
      notes={visibleNotes}
      loading={loading}
      err={err}
      emptyMessage="no nostr boosts for this episode yet — be the first."
      onRefresh={refresh}
      renderNote={(n: DiscoveredNote) => (
        <NoteCard key={n.id} note={n} repostedIds={repostedIds} />
      )}
    />
  );
}
