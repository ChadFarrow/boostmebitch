'use client';

import { useEffect } from 'react';
import { useApp } from '@/lib/store';
import { modalEntryOnTop } from '@/components/use-modal-history';

/**
 * The open fullscreen player is a browser history entry, so the browser's back
 * button — and Android's back button and back gesture, which in the TWA are the
 * same history — closes it, as its own ← back does.
 *
 * Reported 2026-11-15 (#556, the Boost Me Buddy Android app, playing, on
 * `/favorites`): "Nothing happens the first two or three 'back' actions but
 * then another back action will close the app." The player is an overlay in
 * the root layout, not a route, so opening it added no entry. A back stepped
 * through the entries UNDER it — `/favorites`, then the episode and the show on
 * `/` it was opened from — while the opaque `z-50` player hid every one of
 * them, and the next back left the site, which closes the TWA. Measured on
 * main with `Page.navigateToHistoryEntry`: three backs changed the URL behind
 * the open player, the fourth reached `about:blank`.
 *
 * Three rules hold it together:
 *
 * 1. **Opening PUSHES an entry for the same URL that carries this page load's
 *    token** (`bmbPlayer`), on top of the entry it opened over. It copies that
 *    entry's state whole: Next.js's `__NA` and tree, so the patched
 *    `pushState` passes it straight through, and `bmbView`, so on `/` it is
 *    the same view as the entry under it (lib/view-history.ts).
 * 2. **The entry says whether the player is open, and a `popstate` follows
 *    it.** A step off the entry closes the player; a step back ONTO one — from
 *    a page the player was left for, or forward — opens it again if something
 *    is loaded, because that is the screen that entry was.
 * 3. **Closing in the app steps BACK off the entry rather than leaving it
 *    behind** — the rule `backOr` follows on `/`. Left behind, the entry is a
 *    copy of the page under it, and the next back "does nothing" once. The
 *    in-app controls call `closePlayer`, which only steps back and lets the
 *    `popstate` close the player, so a page that navigates when the player
 *    closes (`/live/<npub>`, `/stream/<naddr>`, through `leavePlayerPage`)
 *    does so after the step, never racing it.
 *
 * The token is per page LOAD. A reload keeps `history.state` but not the
 * player, so an entry from before it is just a page entry: answering it with
 * `history.back()` would land on an entry of the old document.
 */
const FIELD = 'bmbPlayer';
const TOKEN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Whether the current history entry is the one this page pushed for the open player. */
function onPlayerEntry(): boolean {
  if (typeof window === 'undefined') return false;
  return (window.history.state as Record<string, unknown> | null)?.[FIELD] === TOKEN;
}

/** Set while a step back is on its way, so a second tap does not take a second step. */
let stepping = false;
/**
 * The player closed by itself while a MODAL's entry was on top of its own — a
 * BOOST modal opened from the player, and the episode ended with nothing next.
 * A step back then would take the modal's entry, and the modal with it
 * (components/use-modal-history.ts). So the step waits: the modal's own close
 * steps off its entry onto this one, and the `popstate` below takes this one.
 */
let stepOffAfterModal = false;
let steppingTimer: ReturnType<typeof setTimeout> | undefined;

function stepOff() {
  if (stepping) return;
  stepping = true;
  // A same-document step answers in a few milliseconds. The timer only stops
  // a lost `popstate` from leaving the controls dead.
  clearTimeout(steppingTimer);
  steppingTimer = setTimeout(() => { stepping = false; }, 1000);
  window.history.back();
}

/**
 * The fullscreen player's ← back and ✕. On the player's own entry it steps
 * back, and the `popstate` closes the player (rule 3); anywhere else it closes
 * it in place.
 */
export function closePlayer() {
  if (onPlayerEntry()) { stepOff(); return; }
  useApp.getState().setPlayerExpanded(false);
}

/**
 * Where `/live/<npub>` and `/stream/<naddr>` go once their player has closed.
 * Those pages exist only to open the player, so closing it leaves the page too.
 *
 * - **Only while the page is still the address.** A back that closes the
 *   player on its way to ANOTHER route still finds the page mounted while that
 *   route renders, and a navigation from here would undo the step.
 * - **Reached inside the app: one more step BACK**, to the page that opened it
 *   (the Live tab's list). A push to `/` — what this was — leaves the page
 *   behind home now that the player is an entry above it: a back from home
 *   lands on the page, the page opens the player again, and the next back
 *   sends home again, a loop with no way off the site. A replace would leave
 *   two home entries in a row, and the back between them would change nothing
 *   on screen — the fault #556 reports.
 * - **The page the visitor LANDED on (a shared link): replace it with home**,
 *   so the app is still open after it, and a back from home leaves the site.
 */
export function leavePlayerPage(router: { back(): void; replace(href: string): void }, ownPath: string | null) {
  if (typeof window === 'undefined' || window.location.pathname !== ownPath) return;
  const landing = performance.getEntriesByType('navigation')[0]?.name;
  const landedHere = !landing || new URL(landing).pathname === ownPath;
  if (landedHere) router.replace('/');
  else router.back();
}

/** Mounted once, in `<Player>`. */
export function usePlayerHistory() {
  useEffect(() => {
    // A raw subscription, not an effect on `playerExpanded`: the push happens
    // in the same call that opened the player — the mini-bar, a HISTORY row,
    // a live page's mount — inside its click where there was one, and before
    // any render can draw an open player over an entry that does not say so.
    const unsubscribe = useApp.subscribe((s, prev) => {
      if (s.playerExpanded === prev.playerExpanded) return;
      if (s.playerExpanded) {
        stepOffAfterModal = false;
        if (onPlayerEntry()) return; // opened BY a step onto its entry
        const cur = (window.history.state ?? {}) as Record<string, unknown>;
        window.history.pushState({ ...cur, [FIELD]: TOKEN }, '', window.location.href);
      } else if (onPlayerEntry()) {
        // Closed by something other than a step: the episode ended with
        // nothing next, or a menu item collapsed it. Leave the entry too —
        // after the modal over it, when there is one.
        if (modalEntryOnTop()) stepOffAfterModal = true;
        else stepOff();
      }
    });
    // In a TASK after the event, not in the listener. Next.js's own `popstate`
    // listener is added after this one (the App Router is a parent, and React
    // runs a child's effects first) and dispatches the traverse that restores
    // the route. A close made in here renders and runs its effects between the
    // two listeners, so `leavePlayerPage`'s navigation was queued BEFORE that
    // traverse, and the traverse then put the page's URL back — measured on
    // `/stream/<naddr>`: a back closed the player and the page stayed.
    const onPopState = () => {
      setTimeout(() => {
        stepping = false;
        clearTimeout(steppingTimer);
        const s = useApp.getState();
        const marked = onPlayerEntry();
        if (marked && !s.playerExpanded && stepOffAfterModal) {
          if (modalEntryOnTop()) return; // still under a modal's entry
          stepOffAfterModal = false;
          stepOff();
          return;
        }
        if (marked && !s.playerExpanded && s.current) s.setPlayerExpanded(true);
        else if (!marked && s.playerExpanded) s.setPlayerExpanded(false);
      }, 0);
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      unsubscribe();
      window.removeEventListener('popstate', onPopState);
    };
  }, []);
}
