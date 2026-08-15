'use client';
import { useEffect, useMemo, useState } from 'react';

// Renders the podcast's artwork with a deterministic colored-initial
// fallback when every candidate URL is missing, blocked, or 404s. Mirrors
// the Avatar component's pattern so any podcast artwork slot in the app
// degrades to a visible placeholder instead of a phantom border.
//
// `image` is tried first; if it errors, `artwork` is tried; finally the
// initial-tile renders. This handles podcasts (e.g. Homegrown Hits) whose
// RSS channel <image> is dead but whose <itunes:image> still resolves.
//
// Pass the same sizing/border classes you'd put on a bare <img>; this
// component re-applies them to the fallback div so the layout stays stable
// either way.
export function PodcastCover({
  image,
  artwork,
  title,
  seed,
  className,
  lowPriority,
}: {
  image?: string | null;
  artwork?: string | null;
  title?: string | null;
  /** Optional seed for the fallback hue; defaults to the title. Use a guid
   *  or feed id when you want the color to follow identity, not display
   *  string. */
  seed?: string;
  className?: string;
  /**
   * "This image must never compete with audio playback."
   *
   * Sets lazy loading, a low fetch priority and async decode together, because
   * they are only useful together and the reason for all three is the same one:
   * podcast and chapter artwork is arbitrary third-party media, it is routinely
   * hosted on the SAME ORIGIN as the enclosure, and it is routinely enormous —
   * 20–36 MB animated GIFs per chapter on a real music feed, against a 175 MB
   * mp3 on one shared HTTP/2 connection. Whoever wins that connection decides
   * whether the show keeps playing.
   *
   * `loading="lazy"` is the load-bearing half for a surface that is mounted but
   * off-screen: <FullscreenPlayer> is always in the DOM and merely translated
   * out of view, so without it the collapsed player downloads every chapter's
   * art that nobody is looking at.
   */
  lowPriority?: boolean;
}) {
  const candidates = useMemo(() => {
    const out: string[] = [];
    if (image) out.push(image);
    if (artwork && artwork !== image) out.push(artwork);
    return out;
  }, [image, artwork]);
  const [idx, setIdx] = useState(0);
  // Re-attempt from the first candidate whenever the source URLs change. Without
  // this, a caller that swaps `image` over time (e.g. per-chapter artwork in the
  // player) would keep a stale failing-index: once a bad img advanced idx to the
  // artwork fallback, the next (valid) image would be skipped for artwork.
  useEffect(() => { setIdx(0); }, [image, artwork]);
  const current = candidates[idx];
  if (current) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        key={current}
        src={current}
        alt=""
        // `loading="lazy"` is the DEFAULT, not an opt-in. It used to ride on
        // `lowPriority`, which only <FullscreenPlayer> passes — so every other
        // surface downloaded every cover eagerly. On a favorites list of ~100
        // that is ~100 image requests for the ~8 tiles actually on screen,
        // issued while the page is still fetching metadata for the same rows.
        // Observed on 3G as a fully-populated list (titles and authors resolved)
        // with every cover still blank.
        //
        // Safe as a default: these are fixed-size tiles whose box comes from
        // `className`, so lazy loading them shifts no layout, and the browser
        // still fetches anything near the viewport immediately.
        loading="lazy"
        decoding="async"
        // `lowPriority` now means only what its name says — deprioritise
        // against other in-flight requests. That is the half <Player> needs,
        // where chapter art competes with the audio enclosure on one connection.
        {...(lowPriority ? { fetchPriority: 'low' as const } : {})}
        className={`${className ?? ''} object-cover`}
        onError={() => setIdx((i) => i + 1)}
      />
    );
  }
  const seedStr = seed ?? title ?? '?';
  let hash = 0;
  for (let i = 0; i < seedStr.length; i++) hash = (hash * 31 + seedStr.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  const bg = `hsl(${hue}, 40%, 22%)`;
  const initial = title?.trim()?.[0]?.toUpperCase() || '♪';
  return (
    <div
      className={`${className ?? ''} flex items-center justify-center font-display text-bone/90 select-none`}
      style={{ background: bg }}
      aria-hidden="true"
    >
      {initial}
    </div>
  );
}
