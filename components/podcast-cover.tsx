'use client';
import { useState } from 'react';

// Renders the podcast's `image` URL with a deterministic colored-initial
// fallback when the image is missing, blocked, or 404s. Mirrors the Avatar
// component's pattern so any podcast artwork slot in the app degrades to a
// visible placeholder instead of a phantom border.
//
// Pass the same sizing/border classes you'd put on a bare <img>; this
// component re-applies them to the fallback div so the layout stays stable
// either way.
export function PodcastCover({
  image,
  title,
  seed,
  className,
}: {
  image?: string | null;
  title?: string | null;
  /** Optional seed for the fallback hue; defaults to the title. Use a guid
   *  or feed id when you want the color to follow identity, not display
   *  string. */
  seed?: string;
  className?: string;
}) {
  const [errored, setErrored] = useState(false);
  if (image && !errored) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={image}
        alt=""
        className={`${className ?? ''} object-cover`}
        onError={() => setErrored(true)}
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
