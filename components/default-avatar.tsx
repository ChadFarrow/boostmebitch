'use client';

// Deterministic placeholder for authors whose kind:0 has no `picture` field
// (or whose kind:0 we couldn't find on any relay). Hue is derived from the
// first 6 hex chars of the pubkey so the same author renders the same color
// every refresh and across every feed surface.
//
// Pass the same wrapper classes you'd give the `<img>` (size, border,
// rounded, flex-shrink); this component only sets background + flex-center
// for the initial.
export function DefaultAvatar({
  pubkey,
  name,
  className,
}: {
  pubkey: string;
  name?: string | null;
  className?: string;
}) {
  const hue = parseInt(pubkey.slice(0, 6) || '0', 16) % 360;
  const bg = `hsl(${hue}, 45%, 28%)`;
  const initial = name?.trim()?.[0]?.toUpperCase() || '◆';
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
