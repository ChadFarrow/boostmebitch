/**
 * `--kb-inset`: how much of the layout viewport the on-screen keyboard covers,
 * published as a CSS variable on `<html>` so the dock can get out of its way.
 *
 * THE BUG THIS EXISTS FOR. Reported 2026-09-06 off an iPhone 16 Pro screenshot,
 * installed home-screen app: the tab bar sat 68 CSS px above the bottom of the
 * screen with the feed showing underneath it, and it stayed there. The step
 * before it was a reply — `<NostrNoteCard>`'s composer is an in-flow
 * `<textarea>` on the main feed, so tapping it raises the keyboard with no
 * overlay involved and nothing in this app aware that it happened.
 *
 * WHAT iOS ACTUALLY DOES. The keyboard does not resize the LAYOUT viewport, so
 * `bottom: 0` still resolves to the bottom of the screen; what shrinks is the
 * VISUAL viewport. WebKit then offsets the fixed layer to keep it on screen,
 * which is the bar travelling up. The part that is a bug rather than a policy
 * is what happens on dismissal: the offset is not always given back, so the bar
 * is left stranded over the page with no gesture that puts it back. A reload
 * clears it, which is why it reads as a rendering glitch rather than a state.
 *
 * SO THE DOCK STOPS RIDING THE KEYBOARD AND HIDES BEHIND IT INSTEAD.
 * `--kb-inset` is the covered height; `<TabBar>` and `<Player>`'s mini-bar both
 * carry `translateY(var(--kb-inset))`, which cancels WebKit's lift and parks
 * the dock at the layout bottom — under the keyboard, out of the composer's
 * way, the same thing a native app does while you type. It is derived from a
 * measurement every frame it changes rather than remembered, so "the keyboard
 * closed" is not a state this module can get wrong: the inset goes back to 0px
 * and the transform is the identity again.
 *
 * THE MEASUREMENT ANSWERS THREE QUESTIONS, NOT ONE, and the first version
 * asked only the first. A visual viewport shorter than the layout viewport is
 * not by itself a keyboard: TWO other things on iOS produce the identical
 * arithmetic, both of them while the composer is focused, and both of them
 * shipped. Reported off a phone as "keyboard is fine while typing but [the
 * dock] pops up after I'm done and returns to the bottom when I scroll down
 * but moves back up when I scroll up" — one sentence describing both.
 *
 * SIX THINGS THAT LOOK OPTIONAL AND ARE NOT.
 *
 * 1. **The inset is only counted while an EDITABLE element has focus.** It is
 *    what keeps a viewport that shrinks for some other reason — a focused
 *    button, a page that is not being typed into at all — from moving the dock.
 *    It is NOT, on its own, the answer to the two cases below: iOS leaves the
 *    field focused when the keyboard is dismissed by a scroll, so the focus
 *    test still says yes for the whole time both of them are being measured.
 *    That is what the first version got wrong, and why it read as a dock that
 *    followed the scroll rather than the keyboard.
 *
 * 2. **A negative `offsetTop` is DISPLACEMENT, and is clamped rather than
 *    subtracted.** At the top of the document an overscroll bounce carries the
 *    visual viewport ABOVE the layout viewport, so `offsetTop` goes negative
 *    and `clientHeight - (offsetTop + height)` reads "the keyboard is up, by
 *    90px" while nothing covers anything. Clamping at 0 is exact: the bounce
 *    moves the viewport, it does not cover the bottom of it.
 *
 * 3. **Coverage below `MIN_KEYBOARD_PX` is BROWSER CHROME, not a keyboard.**
 *    Safari's bottom toolbar collapses on a downward scroll and re-expands on
 *    an upward one, and it takes its ~51px out of the visual viewport while
 *    leaving the layout viewport alone — the same shape as a keyboard, an
 *    order of magnitude smaller, and tied to the scroll DIRECTION, which is
 *    what made the dock oscillate. The floor is the one judgement in this
 *    file, so it is sized from both sides: the chrome it must reject is ~51px
 *    (toolbar) and ~44px (the keyboard accessory bar left behind by a hardware
 *    keyboard), and the shortest keyboard it must still accept is an iPhone's
 *    LANDSCAPE one at ~162px. Raising it past that brings the original bug
 *    back on landscape only, which is where nobody is looking.
 *
 *    AND IT APPLIES ONLY WHERE THERE IS CHROME TO REJECT. An installed
 *    home-screen app has no toolbar and no address bar, so nothing there can
 *    shorten the visual viewport except the keyboard and WebKit's own stranded
 *    offset — both of which want cancelling at any size. `display-mode:
 *    browser` is the test, read once. Applying the browser's floor there would
 *    suppress exactly the correction the installed app needs, and the strand
 *    measured on a phone is ~88px: under the floor, over the truth.
 *
 * 4. **Every event schedules the measurement for the next frame; none of them
 *    measures inline.** `focusout` is why: during it `document.activeElement`
 *    is still the field being left, so an inline read answers "a text field has
 *    focus" and holds the inset at the keyboard's full height. Nothing else
 *    then fires — the stuck offset is exactly the case where iOS sends no
 *    closing `resize` — so the dock stays parked off the bottom of the screen
 *    for the rest of the session. Measured that way in Chromium against the
 *    shipping component before the frame was added. The deferral also collapses
 *    the burst of `resize` events the keyboard animation emits into one write.
 *
 * 5. **The transition to closed nudges the scroll position by a pixel, IN TWO
 *    DIFFERENT FRAMES.** Publishing `0px` re-lays the dock out correctly, but
 *    the stranded offset lives in WebKit's own fixed layer, not in our
 *    transform, so the bar can come back to rest one keyboard-height too high.
 *    A one-pixel scroll and back is what makes WebKit re-settle that layer —
 *    but only if a scroll actually happens, and BOTH HALVES IN ONE TASK LEAVE
 *    THE OFFSET WHERE IT STARTED. The compositor then sees nothing, the nudge
 *    settles nothing, and the bar stays stranded with a transform that is
 *    already correct: measured on a phone at ~88px, reported as "dock still
 *    moves around" against a build that had every other rule here right. The
 *    restore is relative to where the page is a frame later, so a nudge landing
 *    mid-flick does not yank the reader back. It is scheduled after the
 *    dismissal animation rather than on the resize event, because the event
 *    that reports full height arrives while the keyboard is still sliding away
 *    and the offset is re-applied behind it.
 *
 * 6. **Everything is guarded on `window.visualViewport`.** Where it is absent
 *    the inset stays 0px and every transform is the identity, so this costs
 *    nothing and changes nothing off iOS.
 */

/** The dismissal animation is ~250ms on iOS; settle after it, not during. */
const SETTLE_MS = 300;

const VAR = '--kb-inset';

/**
 * The floor between browser chrome and a keyboard — see rule 3. A number here
 * is only ever wrong in one of two directions, and they are not symmetric:
 * too low and the dock rides the toolbar, too high and it rides the landscape
 * keyboard. `scripts/e2e-keyboard.mjs` pins both edges.
 */
const MIN_KEYBOARD_PX = 120;

/**
 * The same floor where there is no browser chrome to reject — an installed
 * home-screen app has no toolbar and no address bar, so a short visual viewport
 * there is the keyboard or WebKit's own stranded offset, and both of those want
 * cancelling however small they are. This is only big enough to reject the
 * pixel of rounding a correction could not show anyway.
 */
const MIN_STRANDED_PX = 24;

/** Input types that raise no keyboard — a tap on one must not move the dock. */
const NON_TEXT_INPUT = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

function raisesKeyboard(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUT.has(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * Start publishing `--kb-inset`. Returns the release; call it from the same
 * effect's cleanup. Mounted once, by `<TabBar>` — it is the one component that
 * renders on every route and it owns the geometry this describes.
 */
export function startKeyboardInsetSync(): () => void {
  if (typeof window === 'undefined') return () => {};
  const vv = window.visualViewport;
  if (!vv) return () => {};

  const root = document.documentElement;
  let current = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  let settleFrame = 0;

  // Whether this document has browser chrome at the bottom that can take its
  // own height out of the visual viewport — read once, because installing an
  // app is not something that happens mid-session. See rule 3.
  const browserChrome = typeof window.matchMedia === 'function'
    ? window.matchMedia('(display-mode: browser)').matches
    : true;
  const floor = browserChrome ? MIN_KEYBOARD_PX : MIN_STRANDED_PX;

  // A one-pixel scroll and back — and THE TWO HALVES MUST BE IN DIFFERENT
  // FRAMES. Both in one task leaves the scroll offset exactly where it started,
  // so the compositor never sees a scroll at all: the nudge runs, costs a
  // function call, and settles nothing. That is how it shipped, and it is why
  // the bar was still stranded after the transform was already correct.
  //
  // The restore is relative to wherever the page is a frame later, not to the
  // captured offset, so a nudge that lands mid-flick does not yank the reader
  // back. A page too short to scroll cannot be nudged at all — nothing here can
  // fix that case, and pretending otherwise would hide it.
  const settleFixedLayer = () => {
    const before = window.scrollY;
    window.scrollTo(0, before + 1);
    let moved = window.scrollY - before;
    if (moved === 0) {
      // Already at the bottom, where a downward nudge is clamped away.
      window.scrollTo(0, before - 1);
      moved = window.scrollY - before;
    }
    if (moved === 0) return;
    settleFrame = requestAnimationFrame(() => {
      settleFrame = 0;
      window.scrollTo(0, window.scrollY - moved);
    });
  };

  const measure = () => {
    frame = 0;
    // `clientHeight` of the root IS the layout viewport, and the keyboard does
    // not change it — that is the whole reason it is the reference here rather
    // than `innerHeight`, which follows the visual viewport under pinch-zoom.
    //
    // `offsetTop` is clamped, not subtracted: negative means the viewport has
    // bounced above the layout viewport, which is displacement (rule 2). What
    // survives that is real coverage, and it still has to be big enough to be
    // a keyboard rather than the browser's own bottom chrome (rule 3).
    const covered = Math.round(root.clientHeight - (Math.max(0, vv.offsetTop) + vv.height));
    const isKeyboard = covered >= floor && raisesKeyboard(document.activeElement);
    const next = isKeyboard ? covered : 0;
    if (next === current) return;
    const closing = next === 0;
    current = next;
    root.style.setProperty(VAR, `${next}px`);
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = closing ? setTimeout(settleFixedLayer, SETTLE_MS) : undefined;
  };

  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(measure);
  };

  // `focusout` is what drops the inset when the field is left, and it is the
  // reason none of these measures inline — see rule 2 in the header.
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('orientationchange', schedule);
  document.addEventListener('focusin', schedule);
  document.addEventListener('focusout', schedule);

  measure();

  return () => {
    if (frame) cancelAnimationFrame(frame);
    if (settleFrame) cancelAnimationFrame(settleFrame);
    if (settleTimer) clearTimeout(settleTimer);
    vv.removeEventListener('resize', schedule);
    vv.removeEventListener('scroll', schedule);
    window.removeEventListener('orientationchange', schedule);
    document.removeEventListener('focusin', schedule);
    document.removeEventListener('focusout', schedule);
    root.style.removeProperty(VAR);
  };
}
