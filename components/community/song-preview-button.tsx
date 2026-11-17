'use client';

import { useEffect, useRef, useState } from 'react';
import { RowThumb } from '@/components/chapter-ui';
import { resolveEpisodeByGuid, resolvePodcastByGuid } from '@/lib/podcast-meta';
import { useApp } from '@/lib/store';
import type { Episode, Podcast } from '@/lib/types';
import { artCandidates, epKey } from '@/lib/util';

/**
 * The 40x40 cover of a song row, as a button that previews ONLY that song: it
 * plays from 0 and stops at the end (`playPreview`; `<Player>` stops on
 * `previewKey` instead of advancing). Docs: docs/ui.md "Song preview button".
 *
 * The podcast handed to the player is the SONG'S OWN feed. A playlist or the
 * draft is a container, never the parent (CLAUDE.md), and no value block is
 * copied on: the player asks /api/item-value for a row with no `value` key,
 * so BOOST pays that song's artist.
 */
export function SongPreviewButton({ feedGuid, itemGuid, title, image, episode, podcast }: {
  feedGuid: string;
  itemGuid: string;
  title: string;
  image?: string;
  episode?: Episode;
  podcast?: Podcast;
}) {
  const isCurrent = useApp((s) => {
    const c = s.current;
    return !!c && c.episode.guid === itemGuid && (c.episode.podcastGuid ?? c.podcast.podcastGuid) === feedGuid;
  });
  const isPlaying = useApp((s) => s.isPlaying);
  const playing = isCurrent && isPlaying;
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  async function onClick() {
    setFailed(false);
    if (isCurrent) {
      // Already loaded (also when the listen queue cued it): keep the place, but make this a
      // preview, so it stops at its end.
      const st = useApp.getState();
      if (!st.isPlaying && st.current) useApp.setState({ previewKey: epKey(st.current.episode) });
      st.togglePlay();
      return;
    }
    setLoading(true);
    try {
      const ep = episode ?? await resolveEpisodeByGuid(feedGuid, itemGuid);
      if (!ep || !ep.enclosureUrl) throw new Error('no audio');
      const pod: Podcast =
        (podcast && podcast.podcastGuid === feedGuid ? podcast : null)
        ?? await resolvePodcastByGuid(feedGuid)
        ?? {
          id: ep.feedId ?? 0,
          podcastGuid: feedGuid,
          title: ep.feedTitle ?? title,
          image: ep.feedImage ?? image,
          artwork: ep.feedImage ?? image,
          medium: 'music',
        };
      useApp.getState().playPreview(ep, pod);
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      if (alive.current) setLoading(false);
    }
  }

  const glyph = loading ? '…' : playing ? '❚❚' : '▶';
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        aria-label={`${playing ? 'Pause' : 'Play'} ${title}`}
        className="relative h-10 w-10 shrink-0 overflow-hidden bg-bone/10 border border-bone/30"
        data-song-art
        data-song-preview
      >
        {image && <RowThumb src={artCandidates(image, null, 160)[0]} fallback={image} className="h-full w-full object-cover" />}
        <span aria-hidden className="absolute inset-0 flex items-center justify-center bg-ink/55 text-sm text-bone">{glyph}</span>
      </button>
      <p aria-live="polite" className={failed ? 'basis-full pl-8 text-xs text-bone/70' : 'sr-only'} data-preview-error={failed ? '' : undefined}>
        {failed ? 'Could not load this song.' : ''}
      </p>
    </>
  );
}
