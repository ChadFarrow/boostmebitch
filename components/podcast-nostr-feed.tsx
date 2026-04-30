'use client';
import {
  fetchPodcastNotes,
  useNostrFeed,
  useViewerReposts,
  type DiscoveredNote,
} from '@/lib/nostr';
import { useApp } from '@/lib/store';
import { FeedSection } from './feed-section';
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
  const { notes, loading, err, refresh } = useNostrFeed({
    cacheKey: `podcast:${podcastGuid}`,
    fetcher: () => fetchPodcastNotes(podcastGuid),
    deps: [podcastGuid],
  });
  const identity = useApp((s) => s.identity);
  const repostedIds = useViewerReposts(notes, identity);

  return (
    <FeedSection
      className="mt-8"
      heading={
        <h3 className="font-display text-lg">
          <span className="text-nostr">#</span> Boosts &amp; chatter on Nostr
          {podcastTitle ? <span className="text-muted text-sm"> · {podcastTitle}</span> : null}
        </h3>
      }
      notes={notes}
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
