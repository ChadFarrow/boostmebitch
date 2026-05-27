'use client';
import { useMemo } from 'react';
import {
  fetchPodcastNotes,
  useNostrFeed,
  useViewerReposts,
  type DiscoveredNote,
} from '@/lib/nostr';
import { useApp } from '@/lib/store';
import type { SocialInteract } from '@/lib/types';
import { FeedSection } from './feed-section';
import { NoteCard } from './nostr-note-card';
import { EpisodeSocialThread } from './episode-social-thread';

/**
 * Per-podcast Nostr stream — same card UI as <GlobalNostrFeed>, but the relay
 * query is scoped to a single show via NIP-73 `#i: podcast:guid:<guid>`. Used
 * inside <EpisodeList> so selecting a podcast surfaces just that show's
 * boosts and chatter.
 */
export function PodcastNostrFeed({
  podcastGuid,
  podcastTitle,
  pinnedSocialInteract,
}: {
  podcastGuid: string;
  podcastTitle?: string;
  pinnedSocialInteract?: SocialInteract[];
}) {
  const { notes, loading, err, refresh } = useNostrFeed({
    cacheKey: `podcast:${podcastGuid}`,
    fetcher: (opts) => fetchPodcastNotes(podcastGuid, opts),
    deps: [podcastGuid],
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
          {podcastTitle ? <span className="text-muted text-sm"> · {podcastTitle}</span> : null}
        </h3>
      }
      description={
        pinnedSocialInteract?.length ? (
          <div className="mb-4 pb-4 border-b border-bone/10">
            <EpisodeSocialThread entries={pinnedSocialInteract} label="📌 Episode thread" />
          </div>
        ) : undefined
      }
      notes={visibleNotes}
      loading={loading}
      err={err}
      emptyMessage="no nostr notes tagged this podcast yet — be the first to boost."
      onRefresh={refresh}
      renderNote={(n: DiscoveredNote) => (
        <NoteCard key={n.id} note={n} repostedIds={repostedIds} />
      )}
    />
  );
}
