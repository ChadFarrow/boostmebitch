'use client';

import { fmt, fmtTimeLeft } from '@/lib/format';
import { useSavedPosition } from '@/lib/resume-position';
import type { Episode, Podcast } from '@/lib/types';

/**
 * "· 23 min left" on an episode row the listener started and did not finish.
 * Renders nothing for an episode with no saved place, and for anything that
 * never resumes (music, live) — see lib/resume-position.ts.
 *
 * A component rather than a hook call in the row, because the rows are
 * rendered from a `.map()`. It is its own subscriber, so a position write
 * re-renders this label and not the list.
 */
export function ResumeLeft({ episode, podcast }: { episode: Episode; podcast: Podcast }) {
  const saved = useSavedPosition(episode, podcast);
  if (!saved) return null;
  const left = fmtTimeLeft((saved.d || episode.duration || 0) - saved.t);
  return (
    <span className="whitespace-nowrap text-bone/80">
      · {left || `stopped at ${fmt(saved.t)}`}
    </span>
  );
}
