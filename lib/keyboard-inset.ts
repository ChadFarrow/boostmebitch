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
 * FOUR THINGS THAT LOOK OPTIONAL AND ARE NOT.
 *
 * 1. **The inset is only counted while an EDITABLE element has focus.** The
 *    same arithmetic answers a rubber-band bounce — `visualViewport.offsetTop`
 *    goes negative at the top of the document, so the visual bottom sits above
 *    the layout bottom and the naive reading is "the keyboard is up, by 90px".
 *    Without the focus test the dock would jump down and back on every
 *    overscroll bounce, on every platform, which is a worse bug than the one
 *    being fixed and would be blamed on the transform rather than on this.
 *
 * 2. **Every event schedules the measurement for the next frame; none of them
 *    measures inline.** `focusout` is why: during it `document.activeElement`
 *    is still the field being left, so an inline read answers "a text field has
 *    focus" and holds the inset at the keyboard's full height. Nothing else
 *    then fires — the stuck offset is exactly the case where iOS sends no
 *    closing `resize` — so the dock stays parked off the bottom of the screen
 *    for the rest of the session. Measured that way in Chromium against the
 *    shipping component before the frame was added. The deferral also collapses
 *    the burst of `resize` events the keyboard animation emits into one write.
 *
 * 3. **The transition to closed nudges the scroll position by a pixel.**
 *    Publishing `0px` re-lays the dock out correctly, but the stranded offset
 *    lives in WebKit's own fixed layer, not in our transform, so the bar can
 *    come back to rest one keyboard-height too high. A one-pixel scroll and
 *    back is what makes WebKit re-settle that layer, and it is scheduled after
 *    the dismissal animation rather than on the resize event, because the event
 *    that reports full height arrives while the keyboard is still sliding away
 *    and the offset is re-applied behind it.
 *
 * 4. **Everything is guarded on `window.visualViewport`.** Where it is absent
 *    the inset stays 0px and every transform is the identity, so this costs
 *    nothing and changes nothing off iOS.
 */

/** The dismissal animation is ~250ms on iOS; settle after it, not during. */
const SETTLE_MS = 300;

const VAR = '--kb-inset';

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

  // A one-pixel scroll and back. `scrollTo` with an unchanged offset is a no-op
  // in WebKit and settles nothing, which is why this moves first.
  const settleFixedLayer = () => {
    const y = window.scrollY;
    window.scrollTo(0, y + 1);
    window.scrollTo(0, y);
  };

  const measure = () => {
    frame = 0;
    // `clientHeight` of the root IS the layout viewport, and the keyboard does
    // not change it — that is the whole reason it is the reference here rather
    // than `innerHeight`, which follows the visual viewport under pinch-zoom.
    const covered = root.clientHeight - (vv.offsetTop + vv.height);
    const next = raisesKeyboard(document.activeElement) ? Math.max(0, Math.round(covered)) : 0;
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
    if (settleTimer) clearTimeout(settleTimer);
    vv.removeEventListener('resize', schedule);
    vv.removeEventListener('scroll', schedule);
    window.removeEventListener('orientationchange', schedule);
    document.removeEventListener('focusin', schedule);
    document.removeEventListener('focusout', schedule);
    root.style.removeProperty(VAR);
  };
}
