import { Fragment, useId, type ReactNode } from 'react';
import type { DemuHoliday } from '@/lib/demu-holiday';
import { EMU_BAND, EMU_HEAD, EmuShapes } from './icons';

/*
 * The emu in a costume — only on the /demu title, on the look that
 * `demuHolidayFor` (lib/demu-holiday.ts) picks for the day. Chad picked every
 * drawing from drafts on 2026-11-19: THANKSGIVING is tail feathers and a
 * pilgrim hat, with no wattle ("Remove the turkey beard from b and just leave
 * the feathers and hat"); CHRISTMAS is a Santa hat ("That also works for Xmas
 * for a Santa hat"); the other nine are the draft he picked on the picker page,
 * shape for shape.
 * Design: docs/superpowers/specs/2026-11-19-demu-holiday-year-design.md, and
 * the drawing rules in 2026-11-19-demu-holiday-hats-design.md.
 *
 * - The box is the emu's own 24×24, and the costume draws PAST it
 *   (`overflow-visible`): a hat into the space above the title, the feathers
 *   and the fireworks into the gutter and the gap before the word. So the
 *   costume, which arrives after hydration, moves nothing on the page.
 * - The gap that keeps the emu clear of what is behind it, and what is in
 *   front of it clear of the emu, is a MASK, never a shape painted in the page
 *   colour. The page behind the title is the hero image under `bg-ink/75`, not
 *   `--ink`: a painted outline showed as a cream sticker edge on the light
 *   theme, and filled the eye that the plain emu leaves open.
 * - The costume colours are artwork, like the `/demu-apps/*.png` badges, so
 *   they are fixed hex values and not palette tokens. A faint `stroke-bone/35`
 *   edge keeps a dark hat visible on the dark theme and white fur on the light.
 * - The small emus (the search menu, BROWSE DEMU, the cover badge) stay plain:
 *   a costume does not read at 11–14 px.
 */

type Costume = {
  /** Drawn behind the emu, and masked off the emu's silhouette. */
  back?: ReactNode;
  /** Drawn over the emu. */
  front?: ReactNode;
  /** Black shapes the emu's mask cuts out round `front`, so the two never touch. */
  gap?: ReactNode;
};

export function HolidayEmuIcon({ holiday, className }: { holiday: DemuHoliday; className: string }) {
  // Two of these on one page would share mask ids without it; the characters
  // React puts in an id are not all safe inside `url(#…)`.
  const id = `emu${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const { back, front, gap } = COSTUMES[holiday];
  return (
    <svg aria-hidden viewBox="0 0 24 24" data-holiday={holiday} className={`fill-current flex-shrink-0 overflow-visible ${className}`}>
      <defs>
        {/* What shows of the emu: all of it but a gap round what is in front. */}
        <mask id={`${id}-emu`} maskUnits="userSpaceOnUse" x="-10" y="-10" width="44" height="44">
          <rect x="-10" y="-10" width="44" height="44" fill="white" />
          {gap}
        </mask>
        {/* What shows of the back part: none of it inside or near the emu, or near the front part. */}
        {back && (
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
            {gap}
          </mask>
        )}
      </defs>
      {back && <g data-part="back" mask={`url(#${id}-behind)`}>{back}</g>}
      <g data-part="emu" mask={`url(#${id}-emu)`}>
        <EmuShapes />
      </g>
      {front && <g data-part="front">{front}</g>}
    </svg>
  );
}

// ── Drawing helpers ──────────────────────────────────────────────────────────

/** Hats sit on the crest, tilted with the head. */
const TILT = 'rotate(8 13 5)';
/** The faint edge on a dark or a white shape. */
const EDGE = { className: 'stroke-bone/35', strokeWidth: 0.35 } as const;
const r2 = (n: number) => +n.toFixed(2);

/** A mask's cut-out: the shapes inside, filled and dilated by `w`. */
function Gap({ w = 1.6, children }: { w?: number; children: ReactNode }) {
  return (
    <g fill="black" stroke="black" strokeWidth={w} strokeLinejoin="round" strokeLinecap="round">
      {children}
    </g>
  );
}

const HEART_POINTS = [[0, 0.9], [-0.9, 0.3], [-1.1, -0.2], [-1, -0.5], [-0.9, -0.95], [-0.3, -1.05], [0, -0.55], [0.3, -1.05], [0.9, -0.95], [1, -0.5], [1.1, -0.2], [0.9, 0.3], [0, 0.9]];
/** A heart of half-width `s`, centred on 0,0, point down. */
function heartD(s: number) {
  const p = HEART_POINTS.map(([x, y]) => `${r2(x * s)},${r2(y * s)}`);
  return `M${p[0]}C${p[1]} ${p[2]} ${p[3]}C${p[4]} ${p[5]} ${p[6]}C${p[7]} ${p[8]} ${p[9]}C${p[10]} ${p[11]} ${p[12]}Z`;
}
function Heart({ x, y, s, a = 0, fill }: { x: number; y: number; s: number; a?: number; fill?: string }) {
  return <path transform={`translate(${x} ${y}) rotate(${a})`} d={heartD(s)} fill={fill} />;
}

/** A firework: `n` rays from the centre, each ending in a dot. */
function Burst({ x, y, r, colour, n = 10 }: { x: number; y: number; r: number; colour: string; n?: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, k) => {
        const a = (k / n) * Math.PI * 2;
        const c = Math.cos(a);
        const s = Math.sin(a);
        return (
          <Fragment key={k}>
            <path d={`M${r2(x + c * r * 0.35)} ${r2(y + s * r * 0.35)}L${r2(x + c * r * 0.85)} ${r2(y + s * r * 0.85)}`} stroke={colour} strokeWidth="0.55" strokeLinecap="round" />
            <circle cx={r2(x + c * r)} cy={r2(y + s * r)} r="0.38" fill={colour} />
          </Fragment>
        );
      })}
    </>
  );
}

// ── The looks, in year order ─────────────────────────────────────────────────

/** New Year's: a party hat with a pompom, confetti behind. */
const PARTY_CONE = 'M9.4 5.5 13.6-5.4 17 5.3Z';
const newyear: Costume = {
  back: (
    <>
      <rect x="2.2" y="3.2" width="1.3" height="0.7" rx="0.2" fill="#00bbf9" transform="rotate(-30 2.8 3.5)" />
      <rect x="19.6" y="-1.6" width="1.3" height="0.7" rx="0.2" fill="#f15bb5" transform="rotate(25 20.2 -1.2)" />
      <circle cx="5.6" cy="-0.6" r="0.55" fill="#9b5de5" />
      <circle cx="21.4" cy="3.6" r="0.5" fill="#00f5d4" />
      <rect x="7.4" y="-3.6" width="1.2" height="0.6" rx="0.2" fill="#00f5d4" transform="rotate(40 8 -3.3)" />
    </>
  ),
  front: (
    <g transform={TILT}>
      <path d={PARTY_CONE} fill="#7b4fe0" />
      <path d="M12.34 -2.13 14.62 -2.19 15.1 -0.69 11.75 -0.6Z" fill="#f15bb5" />
      <path d="M11 1.36 15.71 1.23 16.18 2.73 10.41 2.88Z" fill="#00bbf9" />
      <circle cx="13.6" cy="-5.6" r="1.3" fill="#f15bb5" />
    </g>
  ),
  gap: (
    <Gap>
      <g transform={TILT}>
        <path d={PARTY_CONE} />
        <circle cx="13.6" cy="-5.6" r="1.3" />
      </g>
    </Gap>
  ),
};

/** Valentine's Day: a heart over the ear cup, small hearts floating behind. */
const valentines: Costume = {
  back: (
    <>
      <Heart x={13.2} y={-0.6} s={1.5} a={-10} fill="#ff6b8b" />
      <Heart x={18} y={-2.8} s={1.05} a={14} fill="#e63946" />
      <Heart x={9.4} y={-2.6} s={0.8} a={-18} fill="#ff9eb1" />
    </>
  ),
  front: <Heart x={6.7} y={11.4} s={3.6} fill="#e63946" />,
  gap: (
    <Gap w={1.4}>
      <Heart x={6.7} y={11.4} s={3.6} />
    </Gap>
  ),
};

/** St. Patrick's Day: a green hat with a black band and a gold buckle. */
const LEPRECHAUN_CROWN = 'M10.2 5 9.5-2.6h8l-.6 7.6Z';
const stpatricks: Costume = {
  front: (
    <g transform={TILT}>
      <path d={LEPRECHAUN_CROWN} fill="#1f9d55" {...EDGE} />
      <rect x="9.95" y="1.8" width="7.5" height="2" fill="#1f1d1c" />
      <rect x="12.4" y="1.4" width="2.4" height="2.8" rx="0.3" fill="none" stroke="#f0c419" strokeWidth="0.7" />
      <rect x="7.4" y="4.6" width="12.6" height="1.7" rx="0.85" fill="#157a41" {...EDGE} />
    </g>
  ),
  gap: (
    <Gap>
      <g transform={TILT}>
        <path d={LEPRECHAUN_CROWN} />
        <rect x="7.4" y="4.6" width="12.6" height="1.7" rx="0.85" />
      </g>
    </Gap>
  ),
};

/** Easter: two bunny ears, white with pink insides. Both in front, or the mask hid the far one. */
const easter: Costume = {
  front: (
    <>
      <g transform="rotate(16 16.2 -.6)">
        <ellipse cx="16.2" cy="-1.4" rx="1.55" ry="4.3" fill="#ece6dc" {...EDGE} />
        <ellipse cx="16.2" cy="-1.1" rx="0.75" ry="3.1" fill="#f28ab5" />
      </g>
      <g transform="rotate(-14 11.6 -.6)">
        <ellipse cx="11.6" cy="-1.6" rx="1.6" ry="4.5" fill="#f4f1ec" {...EDGE} />
        <ellipse cx="11.6" cy="-1.3" rx="0.78" ry="3.3" fill="#ff9ec4" />
      </g>
    </>
  ),
  gap: (
    <Gap w={1.4}>
      <g transform="rotate(-14 11.6 -.6)">
        <ellipse cx="11.6" cy="-1.6" rx="1.6" ry="4.5" />
      </g>
      <g transform="rotate(16 16.2 -.6)">
        <ellipse cx="16.2" cy="-1.4" rx="1.55" ry="4.3" />
      </g>
    </Gap>
  ),
};

/** Bitcoin Pizza Day: a pizza slice worn point up, crust as the brim. */
const SLICE = 'M9.6 5 13.5-5.6 17.6 5Z';
const pizzaday: Costume = {
  front: (
    <g transform={TILT}>
      <path d={SLICE} fill="#f4b942" />
      <rect x="9" y="3.9" width="9.2" height="2.2" rx="1.1" fill="#c7863f" {...EDGE} />
      <circle cx="13.3" cy="-1.2" r="1" fill="#c0392b" />
      <circle cx="14.6" cy="1.8" r="1.05" fill="#c0392b" />
      <circle cx="12" cy="2.2" r="0.85" fill="#c0392b" />
    </g>
  ),
  gap: (
    <Gap>
      <g transform={TILT}>
        <path d={SLICE} />
        <rect x="9" y="3.9" width="9.2" height="2.2" rx="1.1" />
      </g>
    </Gap>
  ),
};

/** The Fourth of July: three fireworks behind the emu. Nothing in front. */
const july4: Costume = {
  back: (
    <>
      <Burst x={4} y={0.6} r={3} colour="#e63946" />
      <Burst x={19.6} y={-1.2} r={3.2} colour="#4d8dff" />
      <Burst x={12.4} y={-4.4} r={2.4} colour="#ff9f1c" n={8} />
    </>
  ),
};

/** Summer: dark sunglasses. The lens covers the eye on purpose. */
const LENS = 'M12.5 7.5h5c.45 0 .75.35.65.8l-.45 2.2c-.2.9-1 1.5-1.9 1.5h-1.6c-.9 0-1.7-.6-1.9-1.5l-.45-2.2c-.1-.45.2-.8.65-.8Z';
const summer: Costume = {
  front: (
    <>
      <path d="M12.9 8.6 9.6 9.6" stroke="#1f1d1c" strokeWidth="0.8" strokeLinecap="round" />
      <path d={LENS} fill="#1f1d1c" />
      <path d="M13.6 8.4l1.2 1.6" stroke="#ffffff" strokeOpacity="0.55" strokeWidth="0.45" strokeLinecap="round" />
      <path d="M18.1 8.3l2 .3" stroke="#1f1d1c" strokeWidth="0.7" strokeLinecap="round" />
    </>
  ),
  gap: (
    <Gap w={0.7}>
      <path d={LENS} />
    </Gap>
  ),
};

/** International Podcast Day: a studio microphone on a stand, under the beak. */
const podcastday: Costume = {
  front: (
    <>
      <rect x="17.3" y="12.6" width="3.6" height="5.6" rx="1.8" fill="#a3a8b4" {...EDGE} />
      <path d="M17.5 14.3h3.2M17.4 15.6h3.4M17.5 16.9h3.2" stroke="#4a4f59" strokeWidth="0.4" />
      <path d="M19.1 18.2v4" stroke="#6d727d" strokeWidth="0.8" />
      <rect x="16.9" y="22" width="4.4" height="1.1" rx="0.5" fill="#6d727d" />
    </>
  ),
  gap: (
    <Gap w={1.2}>
      <rect x="17.3" y="12.6" width="3.6" height="5.6" rx="1.8" />
    </Gap>
  ),
};

/** Halloween: a purple witch hat with a bent tip and an orange band. */
const WITCH_CROWN = 'M10.2 5C11 2.4 12-.6 12.9-3.4c.5-1.5 1.8-2.6 3.3-2.2-1.1.6-1.7 1.6-1.8 2.8L17.4 5Z';
const halloween: Costume = {
  front: (
    <g transform={TILT}>
      <path d={WITCH_CROWN} fill="#4a2f73" {...EDGE} />
      <path d="M10.95 2.6h6.1l.2 1.9h-6.9Z" fill="#f77f00" />
      <ellipse cx="13.8" cy="5.1" rx="6.8" ry="1.15" fill="#3c255e" {...EDGE} />
    </g>
  ),
  gap: (
    <Gap>
      <g transform={TILT}>
        <path d={WITCH_CROWN} />
        <ellipse cx="13.8" cy="5.1" rx="6.8" ry="1.15" />
      </g>
    </Gap>
  ),
};

/** Thanksgiving: nine feathers fanned 170° behind the neck, rust, orange and brown in turn, and a pilgrim hat. */
const FEATHER_COLOURS = ['#c8432b', '#ea8a2f', '#94602f'];
const FEATHER_ANGLES = [-85, -63.75, -42.5, -21.25, 0, 21.25, 42.5, 63.75, 85];
const thanksgiving: Costume = {
  back: FEATHER_ANGLES.map((a, i) => (
    <ellipse key={a} cx="12.5" cy="10" rx="2.8" ry="8" fill={FEATHER_COLOURS[i % 3]} transform={`rotate(${a} 12.5 18)`} />
  )),
  // A tall black hat with a brown band and a gold buckle.
  front: (
    <g transform={TILT}>
      <path d="M9.9 5.2 10.6-2.6h6.2l.7 7.8Z" fill="#2c2724" {...EDGE} />
      <rect x="10.1" y="2.4" width="7.2" height="2" fill="#6b5640" />
      <rect x="12.6" y="2" width="2.2" height="2.8" rx="0.3" fill="none" stroke="#f0c419" strokeWidth="0.7" />
      <rect x="7.6" y="4.8" width="12.2" height="1.7" rx="0.85" fill="#2c2724" {...EDGE} />
    </g>
  ),
  gap: <path transform={TILT} d="M9.4 5.6 10.1-3.1h7.2l.7 8.7Z" fill="black" stroke="black" strokeWidth="1.6" />,
};

/** Christmas: a red cap leaning back over the headphones, its tip hanging behind, a white brim and pompom. */
const SANTA_CAP = 'M9.3 5.6C9.6 1.6 11.6-1.6 14.6-1.9 16.4-2.1 17.4-.9 17.4.6 17.6 2.4 18.2 4 19 5.6Z';
const SANTA_TIP = 'M14.6-1.9C12.6-2.6 9.6-2.2 7.6-.2 6.7.7 6.3 1.6 6.4 2.4 7.4 1.6 8.6 1.2 10.2 1.4Z';
const christmas: Costume = {
  front: (
    <g transform={TILT}>
      <path d={SANTA_CAP} fill="#d62828" />
      <path d={SANTA_TIP} fill="#b51f1f" />
      <rect x="7.8" y="4.5" width="12.4" height="2.4" rx="1.2" fill="#fbf8f1" {...EDGE} />
      <circle cx="6.3" cy="2.6" r="1.6" fill="#fbf8f1" {...EDGE} />
    </g>
  ),
  // Its last shape hides the band where it would show between the pompom and the brim.
  gap: (
    <g transform={TILT} fill="black" stroke="black" strokeWidth="1.6" strokeLinejoin="round">
      <path d={SANTA_CAP} />
      <path d={SANTA_TIP} />
      <circle cx="6.3" cy="2.6" r="1.7" />
      <rect x="7.8" y="4.5" width="12.4" height="2.4" rx="1.2" />
      <path d="M6.4 2.4 10.2 1.4 9.3 5.6 7.8 5Z" />
    </g>
  ),
};

const COSTUMES: Record<DemuHoliday, Costume> = {
  newyear, valentines, stpatricks, easter, pizzaday, july4, summer, podcastday, halloween, thanksgiving, christmas,
};
