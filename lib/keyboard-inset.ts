/**
 * `--kb-inset`: how far DOWN the dock has to move to stay on the bottom of the
 * screen while iOS moves the viewport around underneath it. Published as a CSS
 * variable on `<html>`, read as a `translateY` by both halves of the dock.
 *
 * THE BUG THIS EXISTS FOR. Reported 2026-09-06 off an iPhone 16 Pro screenshot,
 * installed home-screen app: the tab bar sat 68 CSS px above the bottom of the
 * screen with the feed showing underneath it, and it stayed there. The step
 * before it was a reply — `<NostrNoteCard>`'s composer is an in-flow
 * `<textarea>` on the main feed, so tapping it raises the keyboard with no
 * overlay involved and nothing in this app aware that it happened.
 *
 * TWO VIEWPORTS, AND WHICH ONE THE DOCK IS NAILED TO. The keyboard does not
 * resize the LAYOUT viewport; what shrinks, and what iOS then scrolls, is the
 * VISUAL one. `position: fixed; bottom: 0` resolves against the LAYOUT
 * viewport, so the dock does not follow the visual viewport at all — and that
 * is the whole defect. To keep the focused field in sight iOS scrolls the
 * visual viewport DOWN, past the end of the layout viewport if it has to, and
 * on dismissal it does not always scroll back. `visualViewport.offsetTop` is
 * left holding that leftover, the layout viewport's bottom is that far above
 * the screen's, and the dock is sitting on it. A reload clears it, which is
 * why it reads as a rendering glitch rather than a state.
 *
 * SO THE CORRECTION IS A SUM OF TWO INDEPENDENT TERMS, AND THE FIRST TWO
 * ATTEMPTS AT THIS FILE COLLAPSED THEM INTO ONE SUBTRACTION.
 *
 *   lift    = visualViewport.offsetTop        — how far the visual viewport has
 *             been scrolled past the layout viewport, keyboard or leftover.
 *   covered = clientHeight - visualViewport.height — how much of the layout
 *             viewport something is sitting on top of.
 *
 * `--kb-inset` is `lift + (covered, if a keyboard explains it)`. The two answer
 * different questions and neither implies the other: a stranded viewport has a
 * lift and covers nothing, an open keyboard covers and usually also lifts. The
 * shipped formula was `clientHeight - (offsetTop + height)`, which is
 * `covered - lift` — so the 68px leftover measured as MINUS 68, failed the
 * "is this a keyboard" test, published 0px, and left the transform the
 * identity while the dock sat 68px up the page. Measured off the screenshot in
 * the report: a 874px screen, a 90px bar at full height, 68.3px of feed under
 * it. That is why the symptom survived two fixes and was scroll-shaped both
 * times — `offsetTop` IS a scroll offset.
 *
 * SEVEN THINGS THAT LOOK OPTIONAL AND ARE NOT.
 *
 * 1. **`covered` is only counted while an EDITABLE element has focus.** It is
 *    what keeps a viewport that shrinks for some other reason — a focused
 *    button, a page that is not being typed into at all — from moving the dock.
 *    It is NOT, on its own, the answer to the two cases below: iOS leaves the
 *    field focused when the keyboard is dismissed by a scroll, so the focus
 *    test still says yes for the whole time both of them are being measured.
 *
 * 2. **`lift` is counted whatever has focus, and is clamped at 0 rather than
 *    subtracted.** Clamped, because at the top of the document an overscroll
 *    bounce carries the visual viewport ABOVE the layout viewport and
 *    `offsetTop` goes negative; the dock is then already below the fold and
 *    pushing it further down is not the repair. Counted unconditionally,
 *    because the state this file exists for outlives the focus: the leftover is
 *    read on a page nobody is typing into, minutes after the reply.
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
 * 5. **The nudge is the only thing that clears a stranded viewport AT THE
 *    SOURCE, and it is armed whenever the dock has to move with no keyboard to
 *    explain it — not only on the way back from one.** The transform hides the
 *    leftover; a one-pixel scroll and back is what makes WebKit settle it, and
 *    it costs nothing when there is nothing to settle. It is scheduled after
 *    the dismissal animation rather than on the resize event, because the event
 *    that reports full height arrives while the keyboard is still sliding away
 *    and the offset is re-applied behind it. Arming it only on a CHANGE is what
 *    keeps it off the scroll path: a measurement that agrees with the last one
 *    returns before the timer.
 *
 * 6. **A pinch-zoomed page is left alone.** Above scale 1 `offsetTop` is a pan
 *    offset in layout pixels against a screen that is no longer painting them
 *    1:1, so correcting by it moves the dock somewhere nobody asked for. The
 *    dock is not usable zoomed in either way; not moving is the honest answer.
 *
 * 7. **Everything is guarded on `window.visualViewport`.** Where it is absent
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
  /** Whether the current stranded episode has already had its one nudge. */
  let nudged = false;

  // A one-pixel scroll and back. `scrollTo` with an unchanged offset is a no-op
  // in WebKit and settles nothing, which is why this moves first.
  const settleFixedLayer = () => {
    const y = window.scrollY;
    window.scrollTo(0, y + 1);
    window.scrollTo(0, y);
  };

  const measure = () => {
    frame = 0;
    // `clientHeight` of the root IS the layout viewport, and neither the
    // keyboard nor a scroll changes it — that is the whole reason it is the
    // reference here rather than `innerHeight`, which follows the visual
    // viewport under pinch-zoom.
    //
    // The two terms are independent and are ADDED, never netted off against
    // each other (see the header): `lift` is how far the visual viewport has
    // been scrolled past the layout viewport — including the leftover iOS
    // forgets to give back — and `covered` is how much of the layout viewport
    // something sits on top of. Only `covered` has to prove it is a keyboard.
    const scale = Number.isFinite(vv.scale) ? vv.scale : 1;
    const lift = Math.max(0, Math.round(vv.offsetTop));
    const covered = Math.max(0, Math.round(root.clientHeight - vv.height));
    const keyboard = covered >= MIN_KEYBOARD_PX && raisesKeyboard(document.activeElement);
    const next = scale > 1 ? 0 : lift + (keyboard ? covered : 0);
    if (next === current) return;
    current = next;
    root.style.setProperty(VAR, `${next}px`);
    // Rule 5: the transform above only HIDES a stranded viewport, so try to
    // settle it at the source whenever the dock has to move with no keyboard to
    // explain it — the keyboard closing, and the leftover arriving on its own.
    // Armed on a CHANGE only, which makes it a debounce rather than something
    // on the scroll path: a run of changing measurements re-arms one timer and
    // fires once, 300ms after the last of them.
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = undefined;
    if (keyboard) { nudged = false; return; }
    // ONE attempt per stranded episode. A nudge that moves the viewport
    // publishes a new value and would otherwise arm the next nudge, and a
    // leftover that settles to something else instead of to zero would keep
    // that going every 300ms for the life of the page. Reaching 0px is the
    // exit, and it re-arms for the next episode.
    if (next > 0 && nudged) return;
    nudged = next > 0;
    settleTimer = setTimeout(settleFixedLayer, SETTLE_MS);
  };

  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(measure);
  };

  // `focusout` is what drops the inset when the field is left, and it is the
  // reason none of these measures inline — see rule 4 in the header.
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('orientationchange', schedule);
  document.addEventListener('focusin', schedule);
  document.addEventListener('focusout', schedule);

  measure();

  return () => {
    if (frame) cancelAnimationFrame(frame);
    if (settleTimer) clearTimeout(settleTimer);
    vv.removeEventListener('resize', schedule);
    vv.removeEventListener('scroll', schedule);
    window.removeEventListener('orientationchange', schedule);
    document.removeEventListener('focusin', schedule);
    document.removeEventListener('focusout', schedule);
    root.style.removeProperty(VAR);
  };
}
