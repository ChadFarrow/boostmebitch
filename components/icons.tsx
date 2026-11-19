import { useId } from 'react';
import type { SearchType } from '@/lib/util';
import type { DemuHoliday } from '@/lib/demu-holiday';

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

// Thumbs-up for the episode LIKE tile. Not the 👍 emoji: that is a colour glyph,
// yellow in BOTH states on every platform, so it was the one coloured icon in a
// monochrome row and could not show whether you had liked anything. This one
// takes `currentColor` — bone, then `bolt` once liked — and `filled` is the
// liked state, as ♥ is to ♡.
export function ThumbsUpIcon({ filled = false, className = 'w-4 h-4' }: { filled?: boolean; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`flex-shrink-0 ${className}`}
    >
      <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
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
 *
 * ONLY THE ARROW IS MIRRORED, and it is mirrored with SVG's own `transform`
 * attribute rather than a CSS one. The first version flipped the whole `<svg>`
 * with `style={{ transform: 'scaleX(-1)' }}` and flipped the label back with a
 * second CSS transform at `transformOrigin: 'center'` — and *what centre* is a
 * question CSS answers with `transform-box`, whose used value differs between
 * engines. In Chrome the 15 sat in the middle of the arc; on iOS it sat low and
 * to the right, reported from a phone as "the 10 in the skip back button is off
 * center". `translate(24,0) scale(-1,1)` on the `<g>` is the same mirror in the
 * viewBox's own coordinates — x becomes 24 − x — and it cannot reach the label,
 * because the label is not inside it.
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
    >
      {/* Mirrored rather than drawn twice: the two icons are the same shape and
          keeping one path means they can't drift apart by a pixel.

          The path below is drawn as the FORWARD arrow — arc sweeping clockwise
          with the tip at the top right — so it is *back* that gets the mirror.
          Worth stating, because the first version had this the wrong way round
          and it is close to invisible in review: both buttons still showed a
          circular arrow with the right number, just each wearing the other's
          direction. */}
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        transform={forward ? undefined : 'translate(24,0) scale(-1,1)'}
      >
        {/* Open at the top so the digits sit in the gap, not on the stroke. */}
        <path d="M20 12a8 8 0 1 1-3.5-6.6" />
        <path d="M16.2 2.3v3.6h-3.6" />
      </g>
      {/* No transform of any kind: the mirror above is on the `<g>`, so the
          label is already upright and already centred on the 24-unit box. */}
      <text x="12" y="15.5" textAnchor="middle" fontSize="9" className="fill-current">
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

/**
 * A QR code, and the finder squares are the whole point: three corners with a
 * ring and a filled centre is what the eye reads as "scan me" at 12 pixels.
 * The scattered modules are decoration and are deliberately sparse — a denser
 * grid turns to mud at this size.
 *
 * Filled rather than stroked, unlike most of the icons above, because it sits
 * on a light tile in the sign-in list where a 2px stroke reads as grey.
 */
export function QrIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={`fill-current flex-shrink-0 ${className}`}
    >
      {/* Three finder squares: outer ring drawn as four bars, filled centre. */}
      <path d="M3 3h7v7H3V3Zm2 2v3h3V5H5Z" />
      <path d="M14 3h7v7h-7V3Zm2 2v3h3V5h-3Z" />
      <path d="M3 14h7v7H3v-7Zm2 2v3h3v-3H5Z" />
      {/* Sparse data modules in the free quadrant. */}
      <path d="M14 14h3v3h-3v-3Zm5 0h2v2h-2v-2Zm-5 5h2v2h-2v-2Zm4 1h3v1h-3v-1Zm2-3h1v2h-1v-2Z" />
    </svg>
  );
}

/**
 * A key — the bunker/`bunker://` mark. Every signer that hands out one of those
 * URIs draws itself with a key (Clave's own App Store icon included), so this
 * is the shape a user is already looking for rather than one invented here.
 */
export function KeyIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={`fill-current flex-shrink-0 ${className}`}
    >
      <path d="M15 3a6 6 0 0 0-5.66 8L3 17.34V21h3.66l1.5-1.5V18h1.5v-1.5H11l2-2A6 6 0 1 0 15 3Zm2 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z" />
    </svg>
  );
}

/**
 * A puzzle piece — the universal browser-extension mark, which is what Chrome
 * and Firefox both put in their own toolbars. Named after what it IS rather
 * than what it means, like the rest of this file.
 */
export function PuzzleIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={`fill-current flex-shrink-0 ${className}`}
    >
      <path d="M10 2a2.5 2.5 0 0 1 2.5 2.5V5H15a1 1 0 0 1 1 1v2.5h.5a2.5 2.5 0 1 1 0 5H16V16a1 1 0 0 1-1 1h-2.5v-.5a2.5 2.5 0 1 0-5 0V17H5a1 1 0 0 1-1-1v-2.5h.5a2.5 2.5 0 1 0 0-5H4V6a1 1 0 0 1 1-1h2.5v-.5A2.5 2.5 0 0 1 10 2Z" />
    </svg>
  );
}

/*
 * The search-type glyphs: one per option of the search box's type menu, and the
 * same shape wherever that type is named — the hero's BROWSE buttons, the
 * `PLAYLIST` stamp on a result row, the /demu page's "Self-hosted" badge.
 *
 * FILLED, like the `♫` they replace, because the menu's MUSIC note was the
 * reference ("an icon like music has"). Inline SVG rather than more characters
 * because there is no text glyph for a microphone, and because a character
 * falls back to whatever font the platform has: the `♫` drew at one width on
 * iOS and another on desktop, so labels after it never lined up.
 *
 * Sized in `em`, so one icon follows the text it sits in — 11px on a
 * `.btn-mini`, 12px in a menu row, 14px on a `.btn-ghost`.
 */
const TYPE_ICON = 'w-[1.15em] h-[1.15em]';

/** Two beamed eighth notes — `♫`, drawn. MUSIC. */
export function MusicNoteIcon({ className = TYPE_ICON }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={`fill-current flex-shrink-0 ${className}`}>
      <path d="M8 17.5V5.6L20 2.6v12.9h-1.6V6.5L9.6 8.7v8.8Z" />
      <ellipse cx="5.6" cy="17.6" rx="3.4" ry="2.6" transform="rotate(-20 5.6 17.6)" />
      <ellipse cx="16" cy="15.6" rx="3.4" ry="2.6" transform="rotate(-20 16 15.6)" />
    </svg>
  );
}

/**
 * An emu in headphones — DEMU. A play on the name and on the emu with
 * headphones that is the de-mu GitHub account's picture (the home of the DeMu
 * feed template); a new drawing on that idea, not that artwork (Chad,
 * 2026-11-19). Also the /demu page's "Self-hosted" badge.
 */
export function EmuIcon({ className = TYPE_ICON }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={`fill-current flex-shrink-0 ${className}`}>
      <EmuShapes />
    </svg>
  );
}

/** Head and neck, with a gap around the ear cup and the eye cut out. */
const EMU_HEAD = 'M9.7 14.22A4.4 4.4 0 0 0 8.77 7.12L9.3 5.3 10.7 5.9 10.4 3.9 12 5.1 12.3 3.1 13.6 4.7 14.6 3.4 15 5.3 16.4 5 15.9 6.6C18.4 7.4 20.8 8.8 22.7 10.4c.5.4.3 1.1-.3 1.2C20.6 12 18.2 12.4 16 12.7C14.3 13.4 13.5 14.9 13.5 17C13.5 19.6 14.4 21.8 15.4 24H9.1C9.6 21.6 9.7 19.2 9.7 16.4ZM13.1 8.9a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0Z';
/** The headphones' band, over the crown to the far ear. */
const EMU_BAND = 'M4.6 9.4C4.4 4.6 7.8 1.6 11.9 1.6c1.8 0 3.3.5 4.6 1.4';

/**
 * The emu's three shapes, in ONE place: `EmuIcon` and `HolidayEmuIcon` both draw
 * them, so a costume can never wear a different emu (`e2e:demuholiday` compares
 * the markup, and `e2e:typeicons` holds `EmuIcon` to the menu's DEMU glyph).
 */
function EmuShapes() {
  return (
    <>
      <path fillRule="evenodd" d={EMU_HEAD} />
      <circle cx="6.7" cy="11" r="3.3" />
      <path d={EMU_BAND} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </>
  );
}

/*
 * The emu in a holiday costume — only on the /demu title, and only while
 * `demuHolidayFor` (lib/demu-holiday.ts) says so. Chad picked each one on
 * 2026-11-19 from drafts: THANKSGIVING is tail feathers and a pilgrim hat, with
 * no wattle ("Remove the turkey beard from b and just leave the feathers and
 * hat"); CHRISTMAS is a Santa hat ("That also works for Xmas for a Santa hat").
 * Design: docs/superpowers/specs/2026-11-19-demu-holiday-hats-design.md.
 *
 * - The box is the emu's own 24×24, and the costume draws PAST it
 *   (`overflow-visible`): the hat into the space above the title, the feathers
 *   into the gutter and the gap before the word. So the costume, which arrives
 *   after hydration, moves nothing on the page.
 * - The gap that keeps the emu clear of the feathers, and each hat clear of the
 *   emu, is a MASK, never a shape painted in the page colour. The page behind
 *   the title is the hero image under `bg-ink/75`, not `--ink`: a painted
 *   outline showed as a cream sticker edge on the light theme, and filled the
 *   eye that the plain emu leaves open.
 * - The costume colours are artwork, like the `/demu-apps/*.png` badges, so
 *   they are fixed hex values and not palette tokens. A faint `stroke-bone/35`
 *   edge keeps the dark hat visible on the dark theme and the white fur on the
 *   light one.
 * - The small emus (the search menu, BROWSE DEMU, the cover badge) stay plain:
 *   a costume does not read at 11–14 px.
 */
export function HolidayEmuIcon({ holiday, className = TYPE_ICON }: { holiday: DemuHoliday; className?: string }) {
  // Two of these on one page would share mask ids without it; the characters
  // React puts in an id are not all safe inside `url(#…)`.
  const id = `emu${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const turkey = holiday === 'thanksgiving';
  const hatGap = turkey ? <PilgrimGap /> : <SantaGap />;
  return (
    <svg aria-hidden viewBox="0 0 24 24" data-holiday={holiday} className={`fill-current flex-shrink-0 overflow-visible ${className}`}>
      <defs>
        {/* What shows of the emu: all of it but a gap round the hat. */}
        <mask id={`${id}-emu`} maskUnits="userSpaceOnUse" x="-10" y="-10" width="44" height="44">
          <rect x="-10" y="-10" width="44" height="44" fill="white" />
          {hatGap}
        </mask>
        {/* What shows of the feathers: none of them inside or near the emu, or near the hat. */}
        {turkey && (
          <mask id={`${id}-behind`} maskUnits="userSpaceOnUse" x="-10" y="-10" width="44" height="44">
            <rect x="-10" y="-10" width="44" height="44" fill="white" />
            <g fill="black" stroke="black" strokeWidth="2.2" strokeLinejoin="round">
              <path d={EMU_HEAD} />
              <circle cx="6.7" cy="11" r="3.3" />
              <path d={EMU_BAND} fill="none" strokeWidth="4.2" strokeLinecap="round" />
              {/* The eye. The head's own eye subpath winds the other way, so the
                  nonzero fill above leaves it open, and a feather showed in it. */}
              <circle cx="14.6" cy="8.9" r="1.5" />
            </g>
            {hatGap}
          </mask>
        )}
      </defs>
      {turkey && (
        <g data-part="feathers" mask={`url(#${id}-behind)`}>
          {FEATHER_ANGLES.map((a, i) => (
            <ellipse key={a} cx="12.5" cy="10" rx="2.8" ry="8" fill={FEATHER_COLOURS[i % 3]} transform={`rotate(${a} 12.5 18)`} />
          ))}
        </g>
      )}
      <g data-part="emu" mask={`url(#${id}-emu)`}>
        <EmuShapes />
      </g>
      {turkey ? <PilgrimHat /> : <SantaHat />}
    </svg>
  );
}

/** Nine feathers fanned 170° about a point behind the neck, rust, orange and brown in turn. */
const FEATHER_COLOURS = ['#c8432b', '#ea8a2f', '#94602f'];
const FEATHER_ANGLES = [-85, -63.75, -42.5, -21.25, 0, 21.25, 42.5, 63.75, 85];

/** Both hats sit on the crest, tilted with the head. */
const HAT_TILT = 'rotate(8 13 5)';

/** A tall black hat with a brown band and a gold buckle. */
function PilgrimHat() {
  return (
    <g data-part="pilgrim" transform={HAT_TILT}>
      <path d="M9.9 5.2 10.6-2.6h6.2l.7 7.8Z" fill="#2c2724" className="stroke-bone/35" strokeWidth="0.35" />
      <rect x="10.1" y="2.4" width="7.2" height="2" fill="#6b5640" />
      <rect x="12.6" y="2" width="2.2" height="2.8" rx="0.3" fill="none" stroke="#f0c419" strokeWidth="0.7" />
      <rect x="7.6" y="4.8" width="12.2" height="1.7" rx="0.85" fill="#2c2724" className="stroke-bone/35" strokeWidth="0.35" />
    </g>
  );
}
/** The gap round the pilgrim hat's crown, in a mask. */
function PilgrimGap() {
  return <path transform={HAT_TILT} d="M9.4 5.6 10.1-3.1h7.2l.7 8.7Z" fill="black" stroke="black" strokeWidth="1.6" />;
}

const SANTA_CAP = 'M9.3 5.6C9.6 1.6 11.6-1.6 14.6-1.9 16.4-2.1 17.4-.9 17.4.6 17.6 2.4 18.2 4 19 5.6Z';
const SANTA_TIP = 'M14.6-1.9C12.6-2.6 9.6-2.2 7.6-.2 6.7.7 6.3 1.6 6.4 2.4 7.4 1.6 8.6 1.2 10.2 1.4Z';

/** A red cap leaning back over the headphones, its tip hanging behind, a white brim and pompom. */
function SantaHat() {
  return (
    <g data-part="santa" transform={HAT_TILT}>
      <path d={SANTA_CAP} fill="#d62828" />
      <path d={SANTA_TIP} fill="#b51f1f" />
      <rect x="7.8" y="4.5" width="12.4" height="2.4" rx="1.2" fill="#fbf8f1" className="stroke-bone/35" strokeWidth="0.35" />
      <circle cx="6.3" cy="2.6" r="1.6" fill="#fbf8f1" className="stroke-bone/35" strokeWidth="0.35" />
    </g>
  );
}
/** The gap round the Santa hat, in a mask. Its last shape hides the band where it would show between the pompom and the brim. */
function SantaGap() {
  return (
    <g transform={HAT_TILT} fill="black" stroke="black" strokeWidth="1.6" strokeLinejoin="round">
      <path d={SANTA_CAP} />
      <path d={SANTA_TIP} />
      <circle cx="6.3" cy="2.6" r="1.7" />
      <rect x="7.8" y="4.5" width="12.4" height="2.4" rx="1.2" />
      <path d="M6.4 2.4 10.2 1.4 9.3 5.6 7.8 5Z" />
    </g>
  );
}

/** The RSS mark — a podcast is a feed. PODCASTS. */
export function RssIcon({ className = TYPE_ICON }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={`fill-current flex-shrink-0 ${className}`}>
      <circle cx="5.5" cy="18.5" r="2.3" />
      <path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

/** A list with a play triangle. PLAYLISTS — not `♫`, which is MUSIC's. */
export function PlaylistIcon({ className = TYPE_ICON }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={`fill-current flex-shrink-0 ${className}`}>
      <rect x="2" y="4.5" width="13" height="2.2" rx="1.1" />
      <rect x="2" y="10" width="13" height="2.2" rx="1.1" />
      <rect x="2" y="15.5" width="8" height="2.2" rx="1.1" />
      <path d="M14 13.2v8.6l7-4.3Z" />
    </svg>
  );
}

/**
 * A key — an npub is a public key. NPUB, in the menu, in the search box's
 * left slot and on the "look it up" chip (Chad, 2026-11-19: the ⚡ read as
 * Lightning, not as a person's key). Stroked: the bow is a ring. Not
 * `KeyIcon`, the filled bunker mark the sign-in modal draws.
 */
export function NpubKeyIcon({ className = TYPE_ICON }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={`fill-current flex-shrink-0 ${className}`}>
      <circle cx="7.5" cy="12" r="3.6" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <path d="M11.1 12H21.5M18.5 12v3.6M15.5 12v2.6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Three stacked layers — every kind at once. ALL. */
export function LayersIcon({ className = TYPE_ICON }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={`fill-current flex-shrink-0 ${className}`}>
      <path d="M12 2 21.5 7 12 12 2.5 7Z" />
      <path d="M2.5 11.5 12 16.5l9.5-5M2.5 16 12 21l9.5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The glyph for one search type — six SVGs, one per type. */
export function SearchTypeIcon({ type }: { type: SearchType }) {
  switch (type) {
    case 'all': return <LayersIcon />;
    case 'music': return <MusicNoteIcon />;
    case 'demu': return <EmuIcon />;
    case 'podcast': return <RssIcon />;
    case 'playlist': return <PlaylistIcon />;
    case 'npub': return <NpubKeyIcon />;
  }
}
