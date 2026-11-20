'use client';

import { useEffect, useRef } from 'react';

/**
 * An open modal is a browser history entry, so the browser's back button —
 * and Android's back button and back gesture, which in the TWA are the same
 * history — closes it, as Escape and the × do. Mounted by `<ModalShell>`, so
 * every modal in the app gets it.
 *
 * Measured before (2026-11-19, desktop Chrome, both brands): back with the
 * sign-in modal open left the modal up and stepped the page BEHIND it back a
 * view; back with the BOOST modal open stepped the page back too, and the
 * modal went with the view that owned it. The fullscreen player had the same
 * fault and became an entry in #556 (components/player/use-player-history.ts);
 * this is its sibling, and the rules are the same where the two overlap.
 *
 * 1. **Opening PUSHES an entry for the SAME URL**, copying the state of the
 *    entry under it whole — Next.js's `__NA` and tree, `bmbView` on `/`,
 *    `bmbPlayer` when the modal opened over the fullscreen player — and
 *    appending this modal's token to `bmbModals`. So the entry is the same
 *    page and the same view to everything else that reads it, and a step off
 *    it changes nothing but the modal. Modals STACK (a GIF picker over the
 *    boost modal, a confirm over the wallet modal), so the field is a list:
 *    the entry for the top modal names every modal open under it.
 * 2. **A `popstate` closes each open modal its entry no longer names**,
 *    through the modal's own `onClose` — the call Escape makes. One task after
 *    the event, after Next.js's listener, as the player's does.
 *    **`dismissable={false}` — a payment in flight — is not closed: its entry
 *    is pushed again**, so a back press during a send changes nothing. Left
 *    off, the NEXT back would step the page under the modal, and on `/` that
 *    can unmount the view that owns the boost modal mid-send.
 * 3. **A modal that closes any other way steps back off its entry** — the ×,
 *    Escape, a backdrop click, a Cancel, a finished flow: all of them unmount
 *    `<ModalShell>`. Left behind, the entry is a copy of the page under it and
 *    the next back "does nothing" once, the fault #556 reported. The step is
 *    decided one task after the unmount, from the top of the CURRENT entry's
 *    list, so two modals closing in one commit take one `go(-2)`, and a modal
 *    that closed because something navigated (the current entry is no longer
 *    its own) takes no step at all — stepping back would undo that
 *    navigation.
 *
 * **Tokens are per page LOAD**, like the player's: a reload keeps
 * `history.state` but not the modal, and a step back over an entry of the old
 * document would be a page load. Such an entry is left alone.
 *
 * Known gaps, accepted: a forward step onto the entry of a modal that has
 * closed shows the page under it, unchanged (the modal's state is gone; it
 * cannot reopen the way the player does); and an entry left by a modal that
 * closed under a navigation, or under a view change on `/`, is one back with
 * no change on screen.
 */
const FIELD = 'bmbModals';
const PAGE = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let seq = 0;

interface OpenModal {
  /** The modal's `onClose`, current. */
  close: () => void;
  /** Its `dismissable`, current. */
  dismissable: () => boolean;
  /** The entry it was pushed on: its URL and the modals it named. */
  baseHref: string;
  baseStack: string[];
}

/** Every modal open now, in the order they opened. */
const open = new Map<string, OpenModal>();

function tokensOf(state: unknown): string[] {
  const v = (state as Record<string, unknown> | null)?.[FIELD];
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
}

const fromThisLoad = (t: string) => t.startsWith(`${PAGE}.`);

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

/** Whether the current entry is an open modal's — the fullscreen player asks,
 *  so that an episode ending under a modal does not step off the modal's entry. */
export function modalEntryOnTop(): boolean {
  if (typeof window === 'undefined') return false;
  const top = tokensOf(window.history.state).at(-1);
  return !!top && open.has(top);
}

/** Set while a step back is on its way, so a second close does not take a second step. */
let stepping = false;
let steppingTimer: ReturnType<typeof setTimeout> | undefined;
let settleQueued = false;

/**
 * Step back over the entries of modals that have closed, from the top of the
 * current entry's list down to the first modal still open (rule 3).
 */
function settle() {
  settleQueued = false;
  if (stepping) return;
  const list = tokensOf(window.history.state);
  let n = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i]!;
    if (!fromThisLoad(t) || open.has(t)) break;
    n++;
  }
  if (n === 0) return;
  stepping = true;
  clearTimeout(steppingTimer);
  // A same-document step answers in a few milliseconds. The timer only stops a
  // lost `popstate` from leaving every later close without its step.
  steppingTimer = setTimeout(() => { stepping = false; }, 1000);
  window.history.go(-n);
}

function queueSettle() {
  if (settleQueued) return;
  settleQueued = true;
  setTimeout(settle, 0);
}

function onPopState() {
  setTimeout(() => {
    // Our own step (rule 3) landing: carry on down past any entry under it
    // whose modal is gone too — one that closed while another modal opened
    // above it in the same task. A step the visitor took is never continued.
    const ownStep = stepping;
    stepping = false;
    clearTimeout(steppingTimer);
    if (ownStep) queueSettle();
    let list = tokensOf(window.history.state);
    // Newest first: a back with a confirm over the wallet modal closes the confirm.
    for (const [token, m] of [...open.entries()].reverse()) {
      if (list.includes(token)) continue;
      if (m.dismissable()) {
        m.close();
        continue;
      }
      // In flight (rule 2). Only when this step landed on the entry the modal
      // opened over: a jump further back (the long-press history menu) goes
      // where it was sent.
      if (window.location.href === m.baseHref && sameList(list, m.baseStack)) {
        list = [...list, token];
        const cur = (window.history.state ?? {}) as Record<string, unknown>;
        window.history.pushState({ ...cur, [FIELD]: list }, '', window.location.href);
      }
    }
  }, 0);
}

let listening = false;

/**
 * `<ModalShell>`'s half. `active` is its `mounted`: the push waits until the
 * modal is on screen. `onClose` and `dismissable` are read when a `popstate`
 * arrives, so the newest ones apply.
 */
export function useModalHistory(active: boolean, onClose: () => void, dismissable: boolean) {
  const closeRef = useRef(onClose);
  const dismissableRef = useRef(dismissable);
  useEffect(() => {
    closeRef.current = onClose;
    dismissableRef.current = dismissable;
  });
  // Kept across StrictMode's effect re-run, so the second run finds its own
  // entry on top and pushes no second one.
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!active) return;
    if (!listening) {
      listening = true;
      window.addEventListener('popstate', onPopState);
    }
    if (!tokenRef.current) tokenRef.current = `${PAGE}.${++seq}`;
    const token = tokenRef.current;
    const cur = (window.history.state ?? {}) as Record<string, unknown>;
    const list = tokensOf(cur);
    const pushed = list.at(-1) === token;
    const baseStack = pushed ? list.slice(0, -1) : list;
    if (!pushed) {
      window.history.pushState({ ...cur, [FIELD]: [...list, token] }, '', window.location.href);
    }
    open.set(token, {
      close: () => closeRef.current(),
      dismissable: () => dismissableRef.current,
      baseHref: window.location.href,
      baseStack,
    });
    return () => {
      open.delete(token);
      queueSettle();
    };
  }, [active]);
}
