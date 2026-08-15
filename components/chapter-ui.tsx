'use client';
import { fmt } from '@/lib/format';
import type { ChapterEntry } from '@/lib/chapters';

/**
 * The 36–40px thumbnail on a chapter or track row, with the two-URL-then-hide
 * fallback all three of those lists need. Extracted because it was already
 * copied twice (the fullscreen `<EpisodeInfoPanel>` and the detail view's
 * `<ChaptersList>`) and had begun to drift in its class list, and the `onError`
 * rule below is exactly the kind that survives in one copy and quietly rots in
 * the others.
 *
 * **Why a chapter with no art of its own borrows the episode's.** Feeds
 * typically illustrate a handful of chapters and leave the rest bare — 4 of 16
 * on a real episode — so rendering the thumbnail only when present gives the
 * list two different left edges and reads as broken layout rather than as "this
 * chapter has a picture".
 *
 * **`onError` must terminate on an attempt marker, not a string compare.**
 * `HTMLImageElement.src`'s *getter* returns the RESOLVED absolute URL while
 * `fallback` is a raw feed string, so an untrimmed, relative or
 * protocol-relative URL never compares equal and the handler re-assigns the
 * same failing URL **forever**. An ad-blocked host makes that a tight loop (it
 * fails with no round trip), and `<FullscreenPlayer>` is always mounted — only
 * translated off-screen — so collapsing the player does not stop it. The
 * `data-fell-back` marker plus `key={src || fallback}` (so a changed list
 * remounts rather than inheriting another episode's marker) is what terminates
 * it.
 *
 * **Hidden with `visibility`, not `display`,** so a dead image still holds its
 * box and the one-left-edge this whole thing exists for survives the failure it
 * was written for.
 *
 * `lazy`/`low`/`async` are not decoration either: chapter art is arbitrary
 * third-party media, routinely hosted on the SAME origin as the enclosure and
 * routinely enormous (33–36 MB GIFs on a real music feed), and a list of them
 * competes with the audio for one connection. They were measured to be
 * insufficient on their own for the always-visible hero — which is what
 * `<Player>`'s `artOk` gate is for — but a list is only fetched once someone
 * opens its tab and scrolls, so here they are the whole mitigation.
 */
export function RowThumb({
  src,
  fallback,
  className,
}: {
  src?: string;
  fallback?: string;
  className: string;
}) {
  const initial = src || fallback;
  if (!initial) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={initial}
      src={initial}
      alt=""
      loading="lazy"
      fetchPriority="low"
      decoding="async"
      onError={(e) => {
        const el = e.currentTarget;
        if (!el.dataset.fellBack && fallback) {
          el.dataset.fellBack = '1';
          el.src = fallback;
          return;
        }
        el.style.visibility = 'hidden';
      }}
      className={className}
    />
  );
}

/**
 * Chapter tick marks for a seek bar, rendered as a fragment of absolutely-
 * positioned spans (no wrapper) so each player keeps its own
 * `relative flex items-center` wrapper around the <input>. Skips the 0s start so
 * a tick doesn't sit under the thumb at rest. Shared by both players.
 */
export function ChapterTicks({
  chapters,
  duration,
}: {
  chapters: ChapterEntry[] | null;
  duration: number;
}) {
  if (!(duration > 0) || !chapters?.length) return null;
  return (
    <>
      {chapters.map((c, i) =>
        c.startTime > 0 && c.startTime < duration ? (
          <span
            key={`${c.startTime}-${i}`}
            aria-hidden
            title={c.title}
            className="pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-px h-2.5 bg-bone/45"
            style={{ left: `${(c.startTime / duration) * 100}%` }}
          />
        ) : null,
      )}
    </>
  );
}

/**
 * The current-chapter label shown by the seek bar: `start–end · title`.
 * `className` carries the per-player size/margin. Renders null without a title.
 */
export function ChapterLabel({
  chapter,
  end,
  className = '',
}: {
  chapter: ChapterEntry | null;
  end: number;
  className?: string;
}) {
  if (!chapter?.title) return null;
  return (
    <div className={`truncate text-bolt/90 ${className}`} title={chapter.title}>
      <span className="text-bolt/60 tabular-nums">
        {fmt(chapter.startTime)}–{fmt(end)}
      </span>{' '}
      {chapter.title}
    </div>
  );
}
