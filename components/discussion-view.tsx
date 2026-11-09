'use client';
import { useApp } from '@/lib/store';
import { backOr } from '@/lib/view-history';
import { EpisodeSocialThread } from './episode-social-thread';

/**
 * Full-page discussion screen for an episode's podcast:socialInteract thread.
 * Selected by `discussionEpisode` in the store (opened from the "💬 discussion"
 * button in the episode list); rendered by `app/page.tsx` ahead of the
 * browse/detail views. `← back to episodes` clears it, returning to the same
 * episode list (the podcast stays selected underneath).
 */
export function DiscussionView() {
  const episode = useApp((s) => s.discussionEpisode);
  const closeDiscussion = useApp((s) => s.closeDiscussion);
  const hasEpisodeDetail = useApp((s) => !!s.selectedEpisode);
  if (!episode?.socialInteract?.length) return null;
  return (
    <div>
      {/* `backOr`: a step back through the browser history when the entry
          behind is the view this returns to — see lib/view-history.ts. */}
      <button onClick={() => backOr({ discussionEpisode: null }, closeDiscussion)} className="btn-ghost text-xs mb-3">
        {hasEpisodeDetail ? '← back to episode' : '← back to episodes'}
      </button>
      <section className="card p-4">
        <h2 className="font-display text-lg mb-3 truncate">
          <span className="text-nostr">💬</span> Discussion
          {episode.title ? (
            <span className="text-muted text-sm"> · {episode.title}</span>
          ) : null}
        </h2>
        <EpisodeSocialThread entries={episode.socialInteract} label="Episode thread" />
      </section>
    </div>
  );
}
