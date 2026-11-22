'use client';
import { useEffect, useRef, useState } from 'react';
import { fmt } from '@/lib/format';
import { chapterState, type ChapterEntry } from '@/lib/chapters';
import { LinkIcon } from './icons';

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
 *
 * **Placed with the thumb inset, not as a plain percentage.** A range input
 * keeps its thumb inside the box, so a value maps to `thumb/2 + (width -
 * thumb) * fraction`; a plain `left: n%` put each tick up to half a thumb from
 * the point that seeks to it, which on a four-hour episode is minutes.
 * `--seek-thumb` (app/globals.css) is the one width the thumb, the ticks and
 * `<ChapterHoverTip>` all read.
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
            className="pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-px h-2.5 bg-bone/45"
            style={{ left: `calc(var(--seek-thumb) / 2 + (100% - var(--seek-thumb)) * ${c.startTime / duration})` }}
          />
        ) : null,
      )}
    </>
  );
}

/**
 * The chapter under the MOUSE on a seek bar: hover anywhere along it and a tip
 * above the pointer reads `12:34 · Chapter title`. Rendered inside the same
 * `relative` wrapper as `<ChapterTicks>`, and it listens on that wrapper, so a
 * player adds one element and no handlers. Shared by both players.
 *
 * **Mouse only.** A touch has no hover, and a finger dragging the thumb
 * already covers the place a tip would show. `pointerType !== 'mouse'` is
 * ignored rather than hidden with CSS, so a touch never mounts it at all.
 *
 * **The time it names is where a click seeks**, using the same thumb inset as
 * the input itself and `<ChapterTicks>` (see there). Pointing at a tick names
 * the chapter that tick starts.
 *
 * **Text only — no chapter art.** Chapter images are arbitrary third-party
 * media, often tens of megabytes on the audio's own host, and `<Player>`'s
 * `artOk` gate exists to keep them from starving playback. A tip that fetched
 * one per chapter hovered would go around that gate.
 *
 * **Kept inside the bar by its own transform.** It shifts left by the fraction
 * of the bar the pointer is at — 0% at the start, 50% in the middle, 100% at
 * the end — so it never needs measuring, and it never hangs past either end of
 * a bar wider than the tip.
 *
 * `aria-hidden`: the input's own `aria-valuetext` is what a screen reader
 * hears, and a pointer-position readout is not something to announce.
 */
export function ChapterHoverTip({
  chapters,
  duration,
}: {
  chapters: ChapterEntry[] | null;
  duration: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [hover, setHover] = useState<{ x: number; f: number } | null>(null);
  const on = Number.isFinite(duration) && duration > 0 && !!chapters?.length;

  useEffect(() => {
    const wrap = ref.current?.parentElement;
    const input = wrap?.querySelector<HTMLInputElement>('input[type="range"]');
    if (!on || !wrap || !input) return;
    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const box = input.getBoundingClientRect();
      const thumb = parseFloat(getComputedStyle(input).getPropertyValue('--seek-thumb')) || 0;
      const travel = box.width - thumb;
      if (!(travel > 0)) return;
      const f = Math.min(1, Math.max(0, (e.clientX - box.left - thumb / 2) / travel));
      setHover({ x: e.clientX - wrap.getBoundingClientRect().left, f });
    };
    const leave = () => setHover(null);
    wrap.addEventListener('pointermove', move);
    wrap.addEventListener('pointerleave', leave);
    return () => {
      wrap.removeEventListener('pointermove', move);
      wrap.removeEventListener('pointerleave', leave);
      setHover(null);
    };
  }, [on]);

  if (!on || !hover) return <span ref={ref} hidden />;
  const t = hover.f * duration;
  const { chapter } = chapterState(chapters, t, duration);
  return (
    <span
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute bottom-full z-10 mb-2 max-w-[18rem] truncate whitespace-nowrap border border-bone/30 bg-ink px-2 py-1 text-[11px] leading-tight text-bone"
      style={{ left: hover.x, transform: `translateX(${-hover.f * 100}%)` }}
    >
      <span className="tabular-nums text-muted">{fmt(t)}</span>
      {chapter?.title ? ` · ${chapter.title}` : null}
    </span>
  );
}

/**
 * The chain-link mark after a chapter title that published a `url` — ONE
 * component for every surface that names such a chapter, so the list row and
 * the now-playing line cannot drift into two different marks again.
 *
 * **It replaced a `↗` that nobody found.** The row's `↗` sat at the far right
 * of the row, in `text-muted`, beside the share icon, and the player line's was
 * the same small grey arrow: reported by Chad (2026-11-22) as "hard to see, and
 * I didn't even know that it had it". So the mark is a chain link — the glyph
 * most sites use for "this goes somewhere else" — in `text-bolt`, and it sits
 * right after the title it belongs to rather than at the edge of the row.
 *
 * **24×24 for the pointer, and only 14px of the line.** The box is `w-6 h-6` —
 * a real WCAG 2.5.8 target on its own, not one that leans on the inline
 * exception — and `-my-[5px]` takes 10px back off its MARGIN box. A flex line
 * and an inline line box both size from the margin box, so the mark adds
 * nothing to the 15/16px line it sits in, while hit-testing uses the 24px
 * border box. That matters twice: `<FullscreenPlayer>`'s cover is capped
 * against a hard-coded `30rem` reserve measured from these rows (see
 * `<ChapterLabel>`), and a line that grew only on a chapter that links would
 * move the mini-bar whenever playback crossed into or out of one.
 *
 * **`label` decides whether it is a link to a screen reader at all.** Pass the
 * accessible name where the mark is the ONLY link to the url (a list row, whose
 * title seeks). Omit it where the title beside it already links to the same
 * href (`<ChapterLabel>`): the mark is then a decorative twin — `aria-hidden`,
 * `tabIndex={-1}` — because two adjacent anchors to one href read out twice and
 * take two tab stops.
 *
 * **`stopPropagation` is load-bearing.** `<Player>`'s mini-bar is a click
 * target that opens the fullscreen player, so without it one tap both follows
 * the link and expands the player behind it.
 *
 * **The href is not re-checked here and must not need to be.** `useChapters`
 * (`lib/chapters.ts`) runs every chapter `url` through `httpUrl` at the parse
 * boundary, so a rejected scheme arrives as `undefined` and no caller renders
 * this at all.
 *
 * **Square, never `rounded`.** Hit-testing follows `border-radius`, so a
 * rounded 24px box answers to less than 24×24 — its corners fall through to
 * whatever is underneath (in a list row, the row's seek overlay).
 */
export function ChapterUrlLink({
  href,
  label,
  className = '',
}: {
  href: string;
  /** The accessible name. Omit it ONLY when the title beside the mark is
   *  already a link to this same `href`. */
  label?: string;
  className?: string;
}) {
  const a11y = label
    ? { 'aria-label': label }
    : ({ 'aria-hidden': true, tabIndex: -1 } as const);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={label ?? 'Open chapter link'}
      onClick={(e) => e.stopPropagation()}
      {...a11y}
      className={`inline-flex flex-shrink-0 items-center justify-center align-middle w-6 h-6 -my-[5px] text-bolt hover:bg-bolt/15 transition ${className}`}
    >
      <LinkIcon className="w-4 h-4" />
    </a>
  );
}

/**
 * The current-chapter label shown by the seek bar: `start–end · title`. When the
 * chapter published a `url` the title becomes a link and `<ChapterUrlLink>`'s
 * chain mark follows it.
 * `className` carries the per-player size/margin. Renders null without a title.
 *
 * **The link is here because a chapter that publishes one is the only place it
 * is ever said.** `<EpisodeContents>` marks the link on its chapter rows too,
 * but that list is a tab the listener has to open, so the chapter playing right
 * now announced its title and silently dropped the URL that goes with it —
 * reported against the *Chad and Reeds* 006 chapter linking Zapstore. Both
 * players render this one component, so putting it here is what stops the two
 * seek bars drifting the way the two chapter lists did.
 *
 * **The TITLE is the link and the mark repeats it, which is a deliberate pair of
 * affordances for one destination — so exactly one of them is a link to a screen
 * reader.** The title carries the accessible name a link should have ("Boost Me
 * Buddy launches on Zap Store"); the mark is rendered without a `label`, which
 * makes it the `aria-hidden` twin. The mark exists for sighted discovery,
 * because an underline alone says little at rest about the chapter pointing
 * anywhere, and nothing at all on touch.
 *
 * **A linked title does change what a tap on that line does in the mini-bar** —
 * it used to open the player and now follows the chapter's URL. That is
 * confined to `sm:` and up, because the mini-bar folds this whole line away
 * below it, and the rest of the bar still expands the player. Both anchors stop
 * propagation for the reason given on `<ChapterUrlLink>`.
 *
 * **Height is spoken for on this line, and the mark must not take any.**
 * `<FullscreenPlayer>`'s cover is capped against a hard-coded `30rem` reserve
 * that is measured from this pane's rows, the active-chapter label among them,
 * and the measured clearance under the tile row is **+22px at 390×844 and
 * already −60px at 375×667** (docs/ui.md). A taller line would eat that and
 * silently falsify the constant, on the surface where nobody would look for the
 * cause; it would also make the mini-bar change height on its own as playback
 * crossed between chapters that link and chapters that do not. So the mark's
 * 24px box rides on negative margins (see `<ChapterUrlLink>`) and the line keeps
 * the height its text sets — the mini-bar label **15px** and the fullscreen
 * label **16px**, with the mark and without it.
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
        {/* No `label`: the linked title above is the one link a screen reader
            hears, and this is its twin.
            `translate-y-[3px] pb-1.5` moves the 24px BOX 3px down and keeps the
            ICON where it was (centred on the text). In the mini-bar the line
            sits 2px under the seek row, and a centred box reached 2px up into
            the seek input's 14px mouse box (measured: box top 812.5, input
            bottom 814.5 at 1280px), so one of the two targets lost a strip to
            the other. Below the line there is room: 7.5px to the bar's edge in
            the mini-bar, a 14–20px gap in the fullscreen pane. */}
        {chapter.url && <ChapterUrlLink href={chapter.url} className="translate-y-[3px] pb-1.5" />}
      </div>
    </div>
  );
}
