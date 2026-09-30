'use client';

import {
  usePlayed,
  useSavedPosition,
  type ResumeEpisode,
  type ResumePodcast,
} from '@/lib/resume-position';

/**
 * "· ✓ PLAYED" on an episode row this device played to the end. Renders
 * nothing while the episode has a saved place, so an episode started again
 * shows `<ResumeLeft>` instead of both. See lib/resume-position.ts, "PLAYED".
 *
 * Its own subscriber, like `<ResumeLeft>`, so a finish re-renders this label
 * and not the list. Takes the narrow key types so a surface holding a Podcast
 * Index record (the new-episodes rows) can pass one.
 */
export function PlayedMark({
  episode,
  podcast,
  bare = false,
}: {
  episode: ResumeEpisode;
  podcast: ResumePodcast;
  /** Drop the leading "·" where the host separates items with a gap. */
  bare?: boolean;
}) {
  const played = usePlayed(episode, podcast);
  const saved = useSavedPosition(episode, podcast);
  if (!played || saved) return null;
  return <span className="whitespace-nowrap text-bone/80">{bare ? '' : '· '}✓ PLAYED</span>;
}
