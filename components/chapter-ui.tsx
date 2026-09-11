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
 * The current-chapter label shown by the seek bar: `start–end · title`. When the
 * chapter published a `url` the title becomes a link and a trailing `↗` marks
 * it.
 * `className` carries the per-player size/margin. Renders null without a title.
 *
 * **The link is here because a chapter that publishes one is the only place it
 * is ever said.** `<EpisodeContents>` already hangs a `↗` off its chapter rows,
 * but that list is a tab the listener has to open, so the chapter playing right
 * now announced its title and silently dropped the URL that goes with it —
 * reported against the *Chad and Reeds* 006 chapter linking Zapstore. Both
 * players render this one component, so putting it here is what stops the two
 * seek bars drifting the way the two chapter lists did.
 *
 * **The href is already guarded and must not be re-derived here.** `useChapters`
 * (`lib/chapters.ts`) runs every chapter `url` through `httpUrl` at the parse
 * boundary, so a rejected scheme arrives as `undefined` and renders no `↗` at
 * all. A chapters document is attacker-chosen bytes at a URL the FEED names, and
 * React does not block a `javascript:` href — it only warns in dev — while this
 * origin holds the wallet credential. Guard at the parse site, not per surface.
 *
 * **The TITLE is the link and the `↗` repeats it, which is a deliberate pair of
 * affordances for one destination — so exactly one of them is a link to a screen
 * reader.** The title carries the accessible name a link should have ("Boost Me
 * Buddy launches on Zap Store"); the `↗` carries none, which is why it is
 * `aria-hidden` with `tabIndex={-1}` rather than given a second label. Two
 * adjacent anchors to one href otherwise read out twice and take two tab stops,
 * and the second announces only "link, Open chapter link" — the arrow exists for
 * sighted discovery, because an underline-on-hover alone is invisible on touch
 * and says nothing at rest about *where* the chapter points.
 *
 * **`stopPropagation` is load-bearing in the mini-bar, and on BOTH anchors.**
 * `<Player>`'s whole bar is a `role="button"` that opens the fullscreen player,
 * so without it one tap both follows the link and expands the player behind it.
 * **A linked title does change what a tap on that line does there** — it used to
 * open the player and now follows the chapter's URL. That is confined to `sm:`
 * and up, because the mini-bar folds this whole line away below it, and the rest
 * of the bar still expands the player.
 *
 * **The control takes its 24px on the axis that is free, and NOT on the one that
 * is spoken for.** Width is free — the title truncates, so the link costs it
 * nothing. Height is not: `<FullscreenPlayer>`'s cover is capped against a
 * hard-coded `30rem` reserve that is measured from this pane's rows, the
 * active-chapter label among them, and the measured clearance under the tile row
 * is **+22px at 390×844 and already −60px at 375×667** (docs/ui.md). Giving the
 * row a `min-h-6` would eat 8 of those 22 and silently falsify the constant, on
 * the surface where nobody would look for the cause. It would also make the
 * mini-bar change height on its own as playback crossed between chapters that
 * link and chapters that do not — feeds link a handful and leave the rest bare.
 *
 * So the link is `self-stretch`: 24px wide, and as tall as the line box the
 * title already sets. Measured against the built CSS: the mini-bar label stays
 * **15px** and the fullscreen label **16px**, both unchanged from before this
 * link existed, and the mini-bar label measures 15px WITH and WITHOUT the `↗`
 * — which is the no-jitter property, not just the no-growth one. The target
 * comes out 24×16, and the linked title **192×16** on the reported chapter — so
 * the real target is the title and the arrow is the marker. Both sit under
 * WCAG 2.5.8's *inline* exception, which exempts a
 * target "whose size is otherwise constrained by the line-height of non-target
 * text" — the same carve-out CLAUDE.md states as "a link inside a sentence is
 * exempt". `<EpisodeContents>`' row `↗` is NOT line-constrained (it is a flex
 * sibling of the row button), which is why that one pays for `px-2 py-1.5` and
 * this one must not copy it.
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
    // The caller's `className` keeps owning DISPLAY as well as size — the
    // mini-bar passes `hidden sm:block` to fold this line away below `sm:`. So
    // the flex row is nested INSIDE it rather than replacing it; making the root
    // a flex would have been overridden by that `sm:block` at exactly the width
    // the line is visible.
    <div className={`text-bolt/90 ${className}`}>
      <div className="flex items-center gap-1 min-w-0">
        {/* The timestamp stays OUTSIDE the anchor: the link's subject is the
            chapter, not the minute it starts at, and a screen reader reading
            "5:00–10:28 Boost Me Buddy launches on Zap Store, link" names a
            range that is not what opens. */}
        <span className="truncate" title={chapter.title}>
          <span className="text-bolt/60 tabular-nums">
            {fmt(chapter.startTime)}–{fmt(end)}
          </span>{' '}
          {chapter.url ? (
            <a
              href={chapter.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="underline decoration-bolt/30 underline-offset-2 hover:decoration-bolt/80 transition"
            >
              {chapter.title}
            </a>
          ) : (
            chapter.title
          )}
        </span>
        {chapter.url && (
          <a
            href={chapter.url}
            target="_blank"
            rel="noopener noreferrer"
            // Decorative twin of the linked title above — see the note on the
            // component. It must not become a second link in the a11y tree.
            aria-hidden
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            className="flex-shrink-0 self-stretch inline-flex items-center justify-center w-6 text-muted hover:text-bolt transition"
          >
            ↗
          </a>
        )}
      </div>
    </div>
  );
}
