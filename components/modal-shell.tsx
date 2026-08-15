'use client';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * The one overlay every modal in this app renders through.
 *
 * WHY THIS EXISTS AS A COMPONENT. Six modals each hand-rolled the same
 * `portalTarget` state and the same overlay class string, and CLAUDE.md has to
 * spell out the geometry rule (`fixed inset-x-0 top-0 h-[100dvh]` + a card at
 * `max-h-full`) precisely because getting it wrong is easy and the symptom —
 * "the modal is cut off" — doesn't look like a CSS bug. Six copies had already
 * drifted: two z-indexes, two backdrop opacities, two centring idioms, and
 * `pb-28` on four of six. A rule the docs must repeat is a rule that gets
 * broken; a rule with one implementation can't be.
 *
 * WHAT IT OWNS, and why each piece is here rather than in each caller:
 *
 * - **Portal to `document.body`.** `app/layout.tsx` wraps page content in
 *   `relative z-0`, which creates a stacking context — a `fixed` overlay inside
 *   it can never rise above the body-level `<Player>`, whatever its z-index.
 *   The `mounted` gate keeps SSR rendering nothing.
 *
 * - **Dialog semantics.** `role="dialog"`, `aria-modal`, and a generated id
 *   wired to the title via `aria-labelledby`. The app had **zero** of these:
 *   a screen-reader user was never told a dialog had opened, on any surface,
 *   including the one that sends money.
 *
 * - **Escape.** Three of the six had it; the three that didn't were the boost
 *   modal, boost-all, and the zap dialog — i.e. exactly the payment surfaces.
 *
 * - **Focus trap, initial focus, and restore.** Tab used to walk straight out
 *   of an open modal into the page behind it, and closing left focus on
 *   `<body>` so the next Tab started from the top of the document.
 *
 * - **Scroll lock, refcounted.** Only `<FullscreenPlayer>` locked the body, so
 *   the page scrolled behind every modal on iOS. The refcount matters because
 *   these genuinely stack (a boost modal opens over the fullscreen player):
 *   without it the first one to close restores scrolling while another is still
 *   open, and a naive save/restore of `overflow` would write back the *locked*
 *   value the outer modal had already set.
 */

// One shared depth. `<Player>` is z-30 and `<FullscreenPlayer>` is z-50, and a
// modal must clear BOTH — `walletOpen` was lifted into the store specifically so
// any surface could open the wallet modal, and at its old z-40 the first
// surface to do so from the fullscreen player would have rendered it
// underneath, invisible.
const OVERLAY_Z = 'z-[60]';

// Refcount, not a boolean: modals stack, and the inner one closing must not
// unlock scrolling while the outer one is still open.
let scrollLocks = 0;
let savedOverflow = '';

function lockScroll(): () => void {
  if (scrollLocks === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  scrollLocks++;
  let released = false;
  return () => {
    // Guard against a double release — React 18+ StrictMode runs effect
    // cleanups twice in development, and an unbalanced decrement would leave
    // the count negative and the page permanently unlocked.
    if (released) return;
    released = true;
    scrollLocks--;
    if (scrollLocks === 0) document.body.style.overflow = savedOverflow;
  };
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface ModalShellProps {
  /** Invoked by Escape and by a backdrop click. */
  onClose: () => void;
  /**
   * Accessible name for the dialog. Rendered nowhere — callers keep their own
   * visible heading — but wired through `aria-labelledby` so assistive tech
   * announces what opened rather than just "dialog".
   */
  label: string;
  /** The card. Sized by the caller; this component owns only the box round it. */
  children: ReactNode;
  /** Extra classes for the card wrapper (width, etc.). */
  className?: string;
  /**
   * Set while a modal is mid-flight on something the user shouldn't be able to
   * walk away from by accident — an in-progress payment. Suppresses Escape and
   * backdrop-click; the caller's own close button stays in charge.
   */
  dismissable?: boolean;
  /**
   * Leave room at the bottom for the fixed mini-player bar so a centred card
   * doesn't sit on top of it. Default on; `<SignInModal>` and `<WalletModal>`
   * were the two that had drifted without it.
   */
  clearsPlayer?: boolean;
}

export function ModalShell({
  onClose,
  label,
  children,
  className = '',
  dismissable = true,
  clearsPlayer = true,
}: ModalShellProps) {
  const [mounted, setMounted] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const labelId = useId();
  // Captured before the portal mounts, so focus can go back where it came from.
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    return lockScroll();
  }, [mounted]);

  // Move focus into the dialog once it exists. Prefer the first focusable
  // control; fall back to the card itself (which carries tabIndex={-1}) so
  // focus is at least inside the trap rather than left on the trigger behind it.
  useEffect(() => {
    if (!mounted) return;
    const card = cardRef.current;
    if (!card) return;
    const first = card.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? card).focus({ preventScroll: true });
    return () => {
      // Restore focus only if it's still inside us — if something else has
      // taken it in the meantime, yanking it back is the more surprising move.
      const active = document.activeElement;
      if (active && card.contains(active)) {
        returnFocusRef.current?.focus?.({ preventScroll: true });
      }
    };
  }, [mounted]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const card = cardRef.current;
      if (!card) return;
      const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) {
        // Nothing focusable inside — keep Tab from escaping to the page behind.
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose, dismissable],
  );

  if (!mounted) return null;

  return createPortal(
    // Height is the *dynamic* viewport, never `inset-0`. A fixed inset-0
    // element sizes to iOS Safari's LARGE (toolbar-hidden) viewport, so the box
    // ends up taller than what you can actually see; centring a tall card in it
    // then pushes the card's header off the top of the screen, which reads as
    // "the modal is cut off" with the body visible and the title gone.
    <div
      className={`fixed inset-x-0 top-0 h-[100dvh] ${OVERLAY_Z} bg-ink/85 backdrop-blur-sm flex items-center justify-center p-4 ${clearsPlayer ? 'pb-28' : ''}`}
      // A backdrop click closes, but only when the press STARTED on the
      // backdrop. Without the target check, dragging to select text inside the
      // card and releasing outside it would close the modal mid-sentence.
      onMouseDown={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
    >
      {/* Visually hidden but NOT aria-hidden — this is the string
          `aria-labelledby` resolves to, so it has to stay in the accessibility
          tree. The caller renders its own visible heading. */}
      <span id={labelId} className="sr-only">{label}</span>
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        tabIndex={-1}
        // max-h-full, never a vh value: this resolves against the overlay's
        // content box, so it spends exactly what the padding above leaves. A
        // `max-h-[92vh]` is measured against the viewport instead and overflows
        // the box meant to hold it — measured at 390x844, the card ran
        // -14 -> 762 inside a 16 -> 732 padding box.
        className={`card bg-ink relative max-h-full overflow-y-auto outline-none ${className}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
