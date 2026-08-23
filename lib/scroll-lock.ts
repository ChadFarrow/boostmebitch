/**
 * The page-behind scroll lock, shared by every overlay in the app.
 *
 * Two things this owns, and both of them shipped broken:
 *
 * 1. **`overflow: hidden` is not a scroll lock on iOS.** It is the obvious
 *    implementation and it is the one that was here — `<html>` and `<body>` in
 *    `<FullscreenPlayer>`, `<body>` alone in `<ModalShell>`. In an installed
 *    home-screen app (standalone PWA) WebKit scrolls the web view anyway, and
 *    when it does, `position: fixed` elements travel WITH the document. The
 *    symptom is not a scrollbar behind a modal — it is the overlay itself
 *    sliding off the top of the screen with the browse page showing in the
 *    strip it vacates, which reads as "the fullscreen player is too short".
 *    It is not: the whole fixed layer moved. Measured on iOS 26 standalone,
 *    where the player's own header AND the `fixed bottom-0` mini-player bar
 *    left the screen together, and the gap stayed after the finger lifted.
 *
 *    A `position: fixed` `<body>` has no scroll range for the web view to
 *    drag, which is why that is the mechanism here rather than `overflow`.
 *    The cost is that the document's scroll offset is destroyed by the lock
 *    and has to be put back by hand — see `scrollY` below. Restoring it is not
 *    optional: without it, closing the player drops the user at the top of a
 *    browse list they had scrolled a long way down.
 *
 * 2. **One refcount for the whole app, not one per surface.** Overlays
 *    genuinely stack — the BOOST modal opens from inside the fullscreen
 *    player — and `<FullscreenPlayer>` used to lock outside `<ModalShell>`'s
 *    refcount with its own effect. Two independent locks over one shared
 *    `<body>` means the first one to release writes the page back to
 *    scrollable while the other is still on screen, and a naive save/restore
 *    writes back the *locked* value the outer surface had already set. Every
 *    caller goes through this module so there is one count and one saved
 *    snapshot.
 *
 * Not a React hook on purpose: `<ModalShell>` locks from a `useEffect` keyed on
 * its portal mounting and `<FullscreenPlayer>` from one keyed on `open`, and
 * both just return this function's release as the cleanup.
 */

type Saved = {
  htmlOverflow: string;
  bodyOverflow: string;
  bodyPosition: string;
  bodyTop: string;
  bodyLeft: string;
  bodyWidth: string;
  scrollY: number;
};

let locks = 0;
let saved: Saved | null = null;

/**
 * Lock the document. Returns the release; call it exactly once (the returned
 * function guards itself, so a `finally` or a double cleanup is safe).
 */
export function lockScroll(): () => void {
  if (typeof document === 'undefined') return () => {};

  if (locks === 0) {
    const html = document.documentElement.style;
    const body = document.body.style;
    // Read BEFORE anything is written, or the offset recorded is the one the
    // lock itself produced.
    saved = {
      htmlOverflow: html.overflow,
      bodyOverflow: body.overflow,
      bodyPosition: body.position,
      bodyTop: body.top,
      bodyLeft: body.left,
      bodyWidth: body.width,
      scrollY: window.scrollY,
    };
    // `left: 0` + `width: 100%`, never `left: 0` + `right: 0` + `width: 100%`:
    // the three together are over-constrained. Tailwind's preflight zeroes the
    // body margin, so 100% of the initial containing block is the viewport.
    body.position = 'fixed';
    body.top = `-${saved.scrollY}px`;
    body.left = '0';
    body.width = '100%';
    // Redundant with a fixed body in every browser measured, and kept because
    // it costs nothing and is the half that desktop has always relied on.
    html.overflow = 'hidden';
    body.overflow = 'hidden';
  }

  locks++;
  let released = false;
  return () => {
    // React 18+ StrictMode runs effect cleanups twice in development. An
    // unbalanced decrement leaves the count negative and the page permanently
    // unlocked — which looks exactly like the bug this module exists to fix.
    if (released) return;
    released = true;
    locks--;
    if (locks > 0 || !saved) return;

    const s = saved;
    saved = null;
    const html = document.documentElement.style;
    const body = document.body.style;
    html.overflow = s.htmlOverflow;
    body.overflow = s.bodyOverflow;
    body.position = s.bodyPosition;
    body.top = s.bodyTop;
    body.left = s.bodyLeft;
    body.width = s.bodyWidth;
    // AFTER the styles go back, or there is nothing to scroll yet. No CSS
    // `scroll-behavior: smooth` anywhere in the app, so this is instant and
    // lands in the same frame as the restore — no visible jump.
    window.scrollTo(0, s.scrollY);
  };
}
