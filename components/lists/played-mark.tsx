'use client';

import {
  canResume,
  setPlayed,
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

/**
 * The PLAYED tile, for the row's `⋯` menu and the episode page's action row:
 * marks an episode played by hand (heard elsewhere, or before this device kept
 * a record), and unmarks it. Lit while played, like the heart. Nothing for an
 * item that never saves a place — a music track, a live item — because
 * `wasPlayed` would never read what it wrote.
 */
export function PlayedButton({
  episode,
  podcast,
}: {
  episode: ResumeEpisode;
  podcast: ResumePodcast | null | undefined;
}) {
  const played = usePlayed(episode, podcast);
  if (!podcast || !canResume(episode, podcast)) return null;
  return (
    <button
      type="button"
      onClick={(ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        setPlayed(episode, podcast, !played);
      }}
      className={`tile ${played ? 'border-bone bg-bone/5' : ''}`}
      aria-pressed={played}
      title={played ? 'Mark as not played' : 'Mark as played'}
      aria-label={played ? 'Mark as not played' : 'Mark as played'}
    >
      <span aria-hidden className="text-base leading-none">✓</span>
      PLAYED
    </button>
  );
}
