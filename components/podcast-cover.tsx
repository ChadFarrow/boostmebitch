'use client';
import { memo, useMemo, useState } from 'react';
import { artCandidates, DEFAULT_ART_WIDTH, type ArtWidth } from '@/lib/util';

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
// One shared empty set, so a cover with no failures allocates nothing.
// `setFailed` always replaces it with a new set, so it is never mutated.
const NO_FAILURES: ReadonlySet<string> = new Set();

function PodcastCoverImpl({
  image,
  artwork,
  title,
  seed,
  className,
  w = DEFAULT_ART_WIDTH,
  fit = 'cover',
  lowPriority,
  localSrc,
  preferOriginal,
  hold,
}: {
  image?: string | null;
  artwork?: string | null;
  /**
   * A cover already on this device — a `blob:` URL from a download.
   *
   * It is the LAST rung, not the first, and that ordering is the whole design.
   * Online, the network candidates are better: `nowPlayingArt` may be handing
   * this component the art of the chapter or the track playing THIS SECOND,
   * and a downloaded feed cover must never outrank it. Offline every network
   * rung fails and this one catches, which is the case it exists for.
   *
   * It must not be proxied — `/api/art` cannot fetch a `blob:` URL, and the
   * point of this rung is that it needs no network at all. So it is appended
   * to `artCandidates`' output rather than passed into it, which also leaves
   * that function, pinned by `check:art`, untouched.
   *
   * The CALLER owns revoking it. <Player> is the only writer; see
   * `nowPlayingCover` in lib/store.ts.
   */
  localSrc?: string | null;
  title?: string | null;
  /** Optional seed for the fallback hue; defaults to the title. Use a guid
   *  or feed id when you want the color to follow identity, not display
   *  string. */
  seed?: string;
  className?: string;
  /**
   * How wide to ask /api/art for, in CSS pixels before device pixel ratio.
   *
   * The default suits a list row or a podroll card. Only a surface that paints
   * the cover large needs to say otherwise — <FullscreenPlayer>'s hero passes
   * 640. It is an allowlisted set rather than a free number because each
   * `(url, width)` pair is a CDN cache key whose miss costs a decode and a
   * resize; `artWidth` in lib/util.ts is the guard, pinned by check:art.
   */
  w?: ArtWidth;
  /**
   * Whether the art may be CROPPED to fill its box.
   *
   * `'cover'` (the default) is right for a tile: the box is a square the
   * layout depends on, and a cover that is not square gets its edges trimmed
   * rather than the row's geometry changing.
   *
   * `'contain'` is for a surface where the picture is the content rather than
   * a thumbnail. Episode art is NOT reliably square — a show that reuses its
   * video thumbnail publishes 16:9 — and a cropped one loses whatever the
   * artist put near the edges, most visibly the episode title printed across
   * the bottom of it. It letterboxes inside the same square box instead, so
   * the surrounding layout is unchanged and the fallback tile still has a
   * definite height.
   *
   * **It is a PROP and not a class the caller passes.** `object-cover` and
   * `object-contain` are display utilities of equal specificity, so a
   * `className` that merely names the other one leaves the choice to
   * Tailwind's emit order — the same trap `sideShow` in <TransportControls>
   * documents, and it fails by silently keeping the crop.
   */
  fit?: 'cover' | 'contain';
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
  /**
   * Ask for the file the artist published, with the proxied copy behind it.
   *
   * `/api/art` takes frame one on purpose, so an animated cover is STILL under
   * the proxy. This is how the one surface that paints the picture large gets
   * the animation back — and it is narrow deliberately, because the same file
   * measured 4,472,805 bytes against 5,502 at `w=160`.
   *
   * Pass it only while that surface is on screen AND the art gate is open. It
   * is not a quality switch: every other caller wants the proxy first, and a
   * 48px tile paying 4.47 MB on the audio's own connection is the failure
   * `artOk` exists for.
   */
  preferOriginal?: boolean;
  /**
   * Keep the last picture PAINTED until the next one has loaded.
   *
   * Without it a new URL is a new `<img>` (the `key` below), empty until its
   * file arrives. On the big now-playing cover the URL changes up to three
   * times per track — the next track's published file while the art gate is
   * still open from the last one, its proxied copy once `waiting` shuts the
   * gate, the published file again when the buffer reopens it — and the mini
   * bar's tile changes once per track. Reported from the beta site as "the art
   * loads, but then it also flashes just once", and again for the tile;
   * measured as 372 ms of an empty big cover, and ~170 ms of an empty tile in
   * WebKit.
   *
   * With it the incoming `<img>` loads invisibly on top of the painted one and
   * takes its place on `load`; the box is a `<span>` carrying the caller's
   * `className`, which both pictures fill. Nothing is fetched that was not
   * fetched before, and a failure still walks the ladder while the held picture
   * stays up.
   *
   * **Not a single element with a changing `src`**, though the HTML image
   * algorithm keeps painting the current picture while a new `src` is pending.
   * Measured 2026-11-13 with screenshots of the box: WebKit held the old
   * picture, but Chrome painted the big cover's large original while it was
   * still arriving — one frame was a near-empty box (7 KB of JPEG against
   * 71 KB). Two elements hold in both engines.
   *
   * For a surface that changes its picture IN PLACE — the two now-playing
   * covers. A list tile is a new row per item and has nothing to hold.
   */
  hold?: boolean;
}) {
  // Proxied copies first, then the ORIGINAL third-party URLs behind them.
  //
  // The raw tail is what keeps this an accelerator rather than a dependency:
  // if /api/art is undeployed, rate-limited, out of memory, or handed a format
  // sharp cannot decode, the `onError` ladder below falls straight through to
  // the URL the app used before the proxy existed. Dropping it would blank
  // every cover on all twelve surfaces that render this component. Ordering it
  // the other way round would leave the feature installed and inert. Both
  // shapes are pinned by `npm run check:art`.
  //
  // `preferOriginal` swaps the two halves for the one surface that wants the
  // published file rather than a still tile of it. The other half stays behind
  // it either way, which is what makes both orders safe.
  const candidates = useMemo(() => {
    const net = artCandidates(image, artwork, w, { preferOriginal });
    return localSrc ? [...net, localSrc] : net;
  }, [image, artwork, w, localSrc, preferOriginal]);
  // The ladder records which URLs FAILED, never a position in the list.
  //
  // It was an index, reset to 0 by a passive effect on mount and whenever the
  // URLs changed. A URL that fails with no round trip — blocked, offline,
  // refused by the browser — fires `error` before that effect runs, so
  // `onError` moved the index to 1 and the effect moved it straight back to 0.
  // Same URL, so the same `key`, so React kept the <img> that had already
  // failed, and a failed <img> never fires again: a broken image for good, on
  // every surface that renders a cover. Traced on Homegrown Hits 157 with the
  // episode art blocked, and pinned by `npm run e2e:coverladder`.
  //
  // A failure is a fact about a URL, so nothing can undo it and a failed URL
  // can never be `current` again. That also covers what the reset was for: a
  // caller that swaps `image` over time (per-chapter artwork in the player)
  // hands over a URL that is not in the set, so it is tried at once, and a
  // valid image is never skipped for the artwork because an earlier one failed.
  // The cost: a URL that failed is not retried while this cover stays mounted.
  // The set grows only by URLs that failed here, so it stays a handful.
  const [failed, setFailed] = useState<ReadonlySet<string>>(NO_FAILURES);
  // `hold` only: the last URL whose picture finished loading here.
  const [shown, setShown] = useState<string | null>(null);
  const current = candidates.find((u) => !failed.has(u));
  const fail = (u: string) => setFailed((prev) => (prev.has(u) ? prev : new Set(prev).add(u)));
  if (current && hold) {
    // The painted picture stays until the incoming one has LOADED: the incoming
    // `<img>` loads invisibly on top and takes over on `load`. Both are keyed by
    // URL in one parent, so React keeps that decoded element — moving it, never
    // re-creating it — and no frame is empty. The CALLER's `className` sizes and
    // decorates the box (the 48px tile, the big cover's rounded square) and the
    // pictures fill it, so neither caller's layout changes. The attributes are
    // the plain branch's below, for its reasons.
    const held = shown && shown !== current && !failed.has(shown) ? shown : null;
    const fill = `absolute inset-0 h-full w-full ${fit === 'contain' ? 'object-contain' : 'object-cover'}`;
    const attrs = {
      loading: 'lazy' as const,
      decoding: 'async' as const,
      ...(lowPriority ? { fetchPriority: 'low' as const } : {}),
    };
    return (
      <span className={`relative block overflow-hidden ${className ?? ''}`}>
        {held && (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={held} src={held} alt="" {...attrs} className={fill} onError={() => fail(held)} />
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={current}
          src={current}
          alt=""
          {...attrs}
          className={held ? `${fill} opacity-0 pointer-events-none` : fill}
          // On `load` AND decoded. `decoding="async"` lets the browser leave an
          // invisible picture undecoded, and Chrome then decoded the big cover
          // only at the swap — one near-empty frame (measured, 7 KB of JPEG
          // against 71 KB). `decode()` resolves when it can paint at once.
          onLoad={(e) => {
            const done = () => setShown(current);
            const el = e.currentTarget;
            if (typeof el.decode === 'function') el.decode().then(done, done);
            else done();
          }}
          onError={() => fail(current)}
        />
      </span>
    );
  }
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
        className={`${className ?? ''} ${fit === 'contain' ? 'object-contain' : 'object-cover'}`}
        onError={() => setFailed((prev) => (prev.has(current) ? prev : new Set(prev).add(current)))}
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
      // The initial tile keeps its own square under `fit="contain"`: a
      // contain-fitting caller sizes the IMG from the box it is given, and a
      // <div> has no intrinsic ratio to inherit that from — without this it
      // collapses to the height of one letter.
      className={`${className ?? ''} ${fit === 'contain' ? 'aspect-square' : ''} flex items-center justify-center font-display text-bone/90 select-none`}
      style={{ background: bg }}
      aria-hidden="true"
    >
      {initial}
    </div>
  );
}

/**
 * MEMOIZED, and every prop is a primitive, which is what makes it work.
 *
 * This is mounted once per row on twelve surfaces — every episode row, every
 * favorites row, every queue row — and it carries internal state: the URLs
 * the `onError` ladder has seen fail. `<EpisodeList>` reads seven store slices
 * including `current` and `isPlaying`, and its rows are one long inline closure
 * rather than components, so every `play()` and every pause re-renders every
 * visible row. Without this, each of those re-renders reconciled a cover whose
 * inputs had not changed.
 *
 * `image`, `artwork`, `localSrc`, `title`, `seed`, `className`, `w`, `fit`,
 * `lowPriority`, `preferOriginal` and `hold` are all strings, numbers or booleans, so the default shallow
 * comparison is exactly right here — there is no object or callback prop for a
 * caller to hand over a fresh reference of by accident, which is the usual way a
 * `memo` becomes decoration. A new prop has to keep that true.
 *
 * Deliberately NOT a fix for the row itself. Extracting `<EpisodeList>`'s row
 * into a memoized component would mean stabilising about fifteen props including
 * callbacks, on a surface carrying the boost control, the hearts and the
 * download button — and a memo whose props are not all stable does nothing while
 * looking like it does. That is a change worth measuring first, not bundling into
 * an audit.
 */
export const PodcastCover = memo(PodcastCoverImpl);
