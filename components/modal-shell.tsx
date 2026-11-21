'use client';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { lockScroll } from '@/lib/scroll-lock';
import { useModalHistory } from './use-modal-history';

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
 *   The `mounted` gate keeps SSR (and hydration) rendering nothing, and is
 *   true from a later mount's FIRST render — see `useIsClient`.
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
 * - **Scroll lock, refcounted — and it lives in `lib/scroll-lock.ts`, not
 *   here.** Only `<FullscreenPlayer>` locked the body, so the page scrolled
 *   behind every modal on iOS. The refcount matters because these genuinely
 *   stack (a boost modal opens over the fullscreen player): without it the
 *   first one to close restores scrolling while another is still open, and a
 *   naive save/restore of `overflow` would write back the *locked* value the
 *   outer modal had already set. That refcount was still only half the rule —
 *   `<FullscreenPlayer>` kept its OWN lock, outside this count, so the two
 *   could still release over each other. Both go through the shared module
 *   now, which is also where the reason `overflow: hidden` is not a lock on
 *   iOS is written down.
 *
 * - **A history entry while it is open** (`useModalHistory`,
 *   components/use-modal-history.ts). The browser's back button — and
 *   Android's — closes the modal through `onClose`, as Escape does, instead of
 *   stepping the page behind it; any other close steps back off the entry.
 *   With `dismissable={false}` a back press changes nothing. Every caller gets
 *   it, so a caller must not push its own entry for a modal.
 */

// One shared depth. `<Player>` is z-30 and `<FullscreenPlayer>` is z-50, and a
// modal must clear BOTH — `walletOpen` was lifted into the store specifically so
// any surface could open the wallet modal, and at its old z-40 the first
// surface to do so from the fullscreen player would have rendered it
// underneath, invisible.
const OVERLAY_Z = 'z-[60]';

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
   * backdrop-click; the × close button (below) stays in charge.
   */
  dismissable?: boolean;
  /**
   * Render the × in the card's top-right corner, calling `onClose`.
   *
   * One button, because six modals each drew their own and two of them had
   * drifted under WCAG 2.5.8's 24×24 floor (an ~11px-wide glyph with no
   * padding). The padding IS the tap target: `px-3 py-2` at `top-0 right-0`
   * is a 35×44 box (wide × tall) with the glyph 12px in and 8px down.
   *
   * **Not gated on `dismissable`.** That flag stops an ACCIDENTAL exit — a
   * stray Escape or backdrop tap mid-payment. The × is a deliberate one, and
   * every modal that had its own kept it live during a send; the running send
   * reports its own results.
   *
   * It is the card's first child, so it is where initial focus lands, as the
   * hand-drawn ones were.
   */
  closeButton?: boolean;
  /**
   * Leave room at the bottom for the fixed mini-player bar so a centred card
   * doesn't sit on top of it. Default on; `<SignInModal>` and `<WalletModal>`
   * were the two that had drifted without it.
   */
  clearsPlayer?: boolean;
}

// `false` on the server and while hydrating, `true` from the first render of a
// modal mounted after that. It replaces a `useState(false)` flipped in an
// effect, which kept SSR rendering nothing too but put the portal — and any
// `autoFocus` inside it — one render AFTER the press that opened the modal,
// outside the press's own event. iOS raises the keyboard only for a focus made
// inside that event, so the GIF picker's search box got a caret and no keyboard
// (Chad, 2026-11-21: "yes, open the keyboard on the phone too"). A caller that
// opens with `flushSync` now commits the whole card inside its click handler.
const noSubscribe = () => () => {};
function useIsClient(): boolean {
  return useSyncExternalStore(noSubscribe, () => true, () => false);
}

export function ModalShell({
  onClose,
  label,
  children,
  className = '',
  dismissable = true,
  clearsPlayer = true,
  closeButton = false,
}: ModalShellProps) {
  const mounted = useIsClient();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const labelId = useId();
  // Where focus goes back to on close. Read in the FIRST render, before the
  // card commits: an `autoFocus` inside it takes focus during that commit, so
  // an effect would read the card's own control.
  const [returnFocus] = useState<HTMLElement | null>(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null));

  useEffect(() => {
    if (!mounted) return;
    return lockScroll();
  }, [mounted]);

  useModalHistory(mounted, onClose, dismissable);

  // Move focus into the dialog once it exists. Prefer the first focusable
  // control; fall back to the card itself (which carries tabIndex={-1}) so
  // focus is at least inside the trap rather than left on the trigger behind it.
  //
  // UNLESS a control inside already holds it. React's `autoFocus` focuses its
  // element while the card commits, BEFORE this effect runs, so moving focus
  // here silently overrode every `autoFocus` in a modal: the GIF picker's
  // search box carried one from the start and the cursor still landed on the
  // picker's own Close button (Chad, 2026-11-21: "so I can start typing in the
  // search right away"). A caller that wants the cursor somewhere says so with
  // `autoFocus`; the first-focusable rule is only the default.
  useEffect(() => {
    if (!mounted) return;
    const card = cardRef.current;
    if (!card) return;
    const held = document.activeElement;
    if (!(held && held !== card && card.contains(held))) {
      const first = card.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? card).focus({ preventScroll: true });
    }
  }, [mounted]);

  // Hand focus back when the dialog closes. The "was focus inside us" test is
  // made in a LAYOUT cleanup: React runs it BEFORE it takes the card out, and a
  // passive cleanup AFTER, when the focused control is gone and
  // `document.activeElement` is <body>. The restore sat in a passive cleanup,
  // so the test always failed and nothing was ever restored: after the GIF
  // picker closed, focus sat on <body>, outside the boost modal's key handler,
  // so Escape no longer closed it and Tab walked the page behind
  // (`e2e:gifgrid` 2f, 2026-11-21).
  //
  // The restore itself waits for a microtask, after the whole commit:
  // - StrictMode (dev) runs a mount's effects twice, with a simulated unmount
  //   between, and the card is still there afterwards. Restoring then moved
  //   focus out of a modal that stays open, and the re-run initial-focus
  //   effect put it on the first control, not the `autoFocus` one.
  // - The same commit can still remove `back` after this cleanup runs (a GIF
  //   pick turns the picker's button into its preview).
  useLayoutEffect(() => {
    if (!mounted) return;
    const card = cardRef.current;
    if (!card) return;
    return () => {
      // Restore focus only if it was inside us — if something else had taken
      // it, yanking it back is the more surprising move.
      const active = document.activeElement;
      if (!active || !card.contains(active)) return;
      queueMicrotask(() => {
        if (card.isConnected) return; // not closed: StrictMode's re-run
        // Something focused since (a modal opened in the same press) wins.
        const now = document.activeElement;
        if (now && now !== document.body) return;
        const back = returnFocus;
        if (back && back.isConnected) {
          back.focus({ preventScroll: true });
          if (document.activeElement === back) return;
        }
        // `back` is gone, disabled, or never had focus (Safari does not focus
        // a clicked button): land on the modal under us, if there is one, so
        // its Escape and its Tab trap still have focus to work with.
        const under = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')).at(-1);
        under?.focus({ preventScroll: true });
      });
    };
  }, [mounted, returnFocus]);

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
    //
    // The BLOCK-axis padding is `max(1rem, env(safe-area-inset-*))`, not the
    // plain `p-4` the inline axis keeps, and that is the same class of bug one
    // step further on. `viewportFit: 'cover'` (app/layout.tsx) means this box
    // starts at the PHYSICAL top of the screen, so 16px of padding put a card
    // that reaches `max-h-full` under the notch / Dynamic Island — its header,
    // which is the part naming what the modal is about. The boost modal is the
    // money surface here, so "which show am I paying" going under the island is
    // not cosmetic.
    //
    // `max()` rather than adding the inset: 1rem is already enough on every
    // device with no inset, and summing would push the card down a further
    // notch's worth on the phones that do have one, for nothing.
    //
    // The bottom follows the same rule only when the mini-player is NOT being
    // cleared — `pb-28` is 112px and already covers the home indicator, so that
    // branch is unchanged.
    <div
      className={`fixed inset-x-0 top-0 h-[100dvh] ${OVERLAY_Z} bg-ink/85 backdrop-blur-sm flex items-center justify-center p-4 pt-[max(1rem,env(safe-area-inset-top))] ${clearsPlayer ? 'pb-28' : 'pb-[max(1rem,env(safe-area-inset-bottom))]'}`}
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
        // `overscroll-contain`: a swipe that runs past the end of this card
        // otherwise chains outward to the document, and on iOS that drags the
        // whole fixed layer — this overlay included — off the screen. The lock
        // in lib/scroll-lock.ts is what makes that impossible; this stops the
        // gesture from ever reaching the document. Containing at the overlay
        // boundary covers every nested list inside it, because chaining walks
        // outward to the nearest scrollable ancestor and stops here.
        className={`card bg-ink relative max-h-full overflow-y-auto overscroll-contain outline-none ${className}`}
      >
        {closeButton && (
          <button
            type="button"
            onClick={onClose}
            className="absolute top-0 right-0 px-3 py-2 text-muted hover:text-bone text-lg z-10"
            aria-label="Close"
          >
            ×
          </button>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
