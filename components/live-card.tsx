import type { ReactNode } from 'react';
import { PodcastCover } from '@/components/podcast-cover';

/**
 * The card `/live` renders, for both of its sources.
 *
 * WHY THIS EXISTS. The page grew two card shapes: `<podcast:liveItem>` rows
 * were art-left/content-right in a grid, while Nostr streams kept the
 * fixed-width `w-64` shape they had as a horizontal rail on the home page. On
 * the home page that rail was right — it was one row competing with a search
 * box and a feed. On a page whose entire job is listing what is on, it hides
 * cards off the side of the screen and reads as a different kind of thing.
 * Reported as "one is a list and one is a row".
 *
 * So this owns the FRAME and the PROPORTIONS and nothing else: the border, the
 * art size, where the badge sits, the type scale of the three text lines, and
 * the action row's spacing. What goes IN those slots stays with each caller,
 * because the two are genuinely different objects — a live item has a feed, a
 * `podcastGuid`, a share URL and a ♡; a stream has an npub, an naddr, a viewer
 * count and hashtags. Merging the CONTENT would mean one component holding two
 * sets of affordances and a flag to pick between them.
 *
 * The split is deliberate in the other direction too: the sections stay
 * separate and keep their own headings, because which protocol a broadcast is
 * on decides where a boost goes and what a click opens.
 *
 * ART IS A CONTROL ONLY WHEN THERE IS SOMETHING TO PLAY. `onArtClick` absent
 * renders a plain `<div>` rather than a disabled button, so an upcoming card
 * does not take focus on the way to the controls that do work — the same rule
 * `<StreamCard>`'s header already followed for its own reason.
 */
export function LiveCard({
  image,
  artwork,
  title,
  seed,
  badges,
  heading,
  sub,
  meta,
  extra,
  actions,
  onArtClick,
  artLabel,
}: {
  image?: string | null;
  artwork?: string | null;
  title: string;
  /** Fallback-hue seed. A guid or feed id, so the colour follows identity
   *  rather than a display string that may change. */
  seed?: string;
  /** Status stamps — `● LIVE`, `PENDING`, and anything qualifying them. */
  badges: ReactNode;
  /** The primary line. Usually a button that opens the thing. */
  heading: ReactNode;
  /** The secondary line: the episode, or the host. */
  sub?: ReactNode;
  /** The time line. */
  meta?: ReactNode;
  /** Anything between the text and the actions — hashtags, for instance. */
  extra?: ReactNode;
  actions: ReactNode;
  /** Omit to render the art as decoration rather than a control. */
  onArtClick?: () => void;
  artLabel?: string;
}) {
  const art = (
    <PodcastCover
      image={image}
      artwork={artwork}
      title={title}
      seed={seed}
      // An allowlisted width, never a free integer — each (url, width) is a CDN
      // cache key. 160 is the smallest offered and the closest above this 64px
      // box at 2x.
      w={160}
      className="w-16 h-16 rounded object-cover"
    />
  );

  return (
    /* `min-w-0` is load-bearing and its absence is invisible until one card
       has a long title. A grid item defaults to `min-width: auto`, meaning it
       may not shrink below its own min-content — so ONE card whose title or
       action row cannot break widens the whole grid TRACK, and every card in
       that section grows with it. Measured at 390px: a 586px card in a 390px
       viewport. Nothing scrolled, because `html, body` are `overflow-x: clip`
       (see the background-art rules) — the cards were simply cut off at the
       right edge, which is how this was reported. `truncate` on the lines
       inside cannot help while the box it is inside is free to grow. */
    <article className="card p-3 flex gap-3 items-start min-w-0">
      {onArtClick ? (
        <button
          type="button"
          onClick={onArtClick}
          aria-label={artLabel}
          title={artLabel}
          className="shrink-0 hover:opacity-90 transition-opacity"
        >
          {art}
        </button>
      ) : (
        <div className="shrink-0">{art}</div>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-1 flex-wrap">{badges}</div>
        {heading}
        {sub}
        {meta}
        {extra}
        <div className="flex items-center gap-2 mt-2 flex-wrap">{actions}</div>
      </div>
    </article>
  );
}

/**
 * The container both sections put their cards in.
 *
 * One class string rather than two, because "the two sections should look the
 * same" is the whole point and a duplicated grid definition is how that stops
 * being true three months from now.
 */
export const LIVE_GRID = 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3';
