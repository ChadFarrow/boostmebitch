// Tiny inline icons that inherit currentColor — used in places where the ⚡
// emoji's color glyph clashes with a yellow background (e.g., .btn-bolt).
// Keep these path-only and dependency-free; lucide etc. is overkill here.

export function BoltIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={`fill-current flex-shrink-0 ${className}`}
    >
      <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />
    </svg>
  );
}

export function SunIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`flex-shrink-0 ${className}`}
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

export function ShareIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`flex-shrink-0 ${className}`}
    >
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98" />
    </svg>
  );
}

// Coin with a "$" — the non-Lightning funding/support link (Patreon etc.),
// distinct from ShareIcon so SUPPORT and SHARE don't look alike.
export function CoinIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`flex-shrink-0 ${className}`}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M14.5 9.4c-.6-.7-1.5-1-2.5-1-1.5 0-2.6.8-2.6 1.9 0 1.2 1.1 1.6 2.6 1.9s2.6.8 2.6 2c0 1.1-1.1 1.9-2.6 1.9-1 0-1.9-.3-2.5-1M12 6.8v10.4" />
    </svg>
  );
}

export function PipIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`flex-shrink-0 ${className}`}
    >
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <rect x="12" y="11" width="8" height="6" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Corner brackets pointing outward — enter fullscreen.
export function FullscreenIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`flex-shrink-0 ${className}`}
    >
      <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
    </svg>
  );
}

// The same brackets pointing inward — exit fullscreen.
export function ExitFullscreenIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`flex-shrink-0 ${className}`}
    >
      <path d="M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5" />
    </svg>
  );
}

/**
 * Skip-back / skip-forward: a broken circular arrow with the interval written
 * inside it — the idiom every podcast app uses, and the reason these are SVG
 * rather than glyphs. There is no character for "jump back fifteen seconds":
 * ⏪/⏩ mean *scan*, which is a different transport verb, and ↺/↻ beside a
 * separate number reads as two controls rather than one.
 *
 * The number is `<text>`, so it tracks the button's color with everything else
 * (`fill-current`) and the caller states the interval once — the same constant
 * that drives the seek, so the button cannot say 15 and jump 30. Rendered at
 * `fontSize` 9 against a 24-unit box: two digits fit inside the arc's gap
 * without touching it, which is why the arc is drawn open at the top.
 */
function SkipIcon({
  seconds,
  forward,
  className,
}: {
  seconds: number;
  forward: boolean;
  className: string;
}) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={`flex-shrink-0 ${className}`}
      // Mirrored rather than drawn twice: the two icons are the same shape and
      // keeping one path means they can't drift apart by a pixel.
      //
      // The path below is drawn as the FORWARD arrow — arc sweeping clockwise
      // with the tip at the top right — so it is *back* that gets the mirror.
      // Worth stating, because the first version had this the wrong way round
      // and it is close to invisible in review: both buttons still showed a
      // circular arrow with the right number, just each wearing the other's
      // direction.
      style={forward ? undefined : { transform: 'scaleX(-1)' }}
    >
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        {/* Open at the top so the digits sit in the gap, not on the stroke. */}
        <path d="M20 12a8 8 0 1 1-3.5-6.6" />
        <path d="M16.2 2.3v3.6h-3.6" />
      </g>
      <text
        x="12"
        y="15.5"
        textAnchor="middle"
        fontSize="9"
        className="fill-current"
        // Undo the mirror on the label — a flipped "15" is unreadable. Tracks
        // whichever side actually carries the mirror above.
        style={forward ? undefined : { transform: 'scaleX(-1)', transformOrigin: 'center' }}
      >
        {seconds}
      </text>
    </svg>
  );
}

export function SkipBackIcon({ seconds, className = 'w-6 h-6' }: { seconds: number; className?: string }) {
  return <SkipIcon seconds={seconds} forward={false} className={className} />;
}

export function SkipForwardIcon({ seconds, className = 'w-6 h-6' }: { seconds: number; className?: string }) {
  return <SkipIcon seconds={seconds} forward className={className} />;
}

export function MoonIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`flex-shrink-0 ${className}`}
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
