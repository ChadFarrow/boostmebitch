'use client';

// Where Amber lands after signing, when the request went out with a
// `callbackUrl`. See lib/nostr/amber-callback-url.ts for the wire format and
// how it was measured; this file is only the landing.
//
// The job is small and deliberately dumb: recognise the answer, park it, and
// get out of the way. It performs NO validation that matters and makes NO trust
// decision — `AmberSigner.signEvent` still runs `verifyEvent` plus the
// signed-in-key comparison on whatever comes through here, exactly as it does
// for a clipboard result. Widening this page's job is how a "convenience"
// landing page ends up being the thing that decides what gets published.
//
// THREE THINGS HERE ARE NOT COSMETIC:
//
// 1. The fragment is read once and then `history.replaceState`d away, before
//    anything else. It can hold a signed event or, for a decrypt, the user's
//    PLAINTEXT, and a session-history entry outlives the page. It never reaches
//    the server — that is the whole reason the terminator is a fragment — but
//    "not on the wire" is not the same as "not in the back button".
//
// 2. Every failure gets a SCREEN, not a console.warn. CLAUDE.md: a guard that
//    silently withholds must say so. This page's whole failure mode is doing
//    nothing, and a silent correct decision ("that callback wasn't for this
//    tab") is indistinguishable from a broken one to the person looking at it.
//    So each refusal names itself and hands back the raw value, which
//    <AmberCompletion>'s manual paste can still consume.
//
// 3. THE CALLBACK USUALLY LANDS IN A DIFFERENT TAB. Measured on a Pixel 6
//    against a real https origin: Brave opens Amber's ACTION_VIEW in a NEW TAB
//    (count went 15 to 16) rather than reusing the one that made the request.
//    That is why the pending record and the parked result are localStorage —
//    sessionStorage is per-tab and was never there. See lib/storage.ts.
//
//    THE TWA IS THE OPPOSITE CASE, and it is not a different storage
//    partition — Chrome hands a verified TWA the same profile as the site,
//    which is the whole premise of the assetlinks rule in CLAUDE.md. Measured
//    2026-09-03 on a Pixel 6 with com.boostmebitch installed and
//    www.boostmebitch.com `verified`: an https ACTION_VIEW on /amber-callback
//    resolved to CustomTabActivity, i.e. INTO the app, replacing the window
//    that asked. So there the callback reaches the same localStorage AND the
//    same tab. Point 4's parking rule must not fire there; `amberTab` is what
//    separates the two.
//
// 4. FROM A HOME-SCREEN APP THE CALLBACK LANDS IN A BROWSER TAB, ALWAYS — and
//    that tab must NOT become the app. Measured 2026-09-03 on boostmebuddy.com
//    installed from Brave: sign-in completed, and the user was left in a new
//    browser tab running a second copy of the site while the home-screen
//    window sat on "Approve in Amber…". Android hands an https ACTION_VIEW to
//    the default browser; nothing here can route it to the standalone window.
//    So when the pending record says the request left a standalone window,
//    this page parks the answer, tries to close itself, and says "switch back"
//    — the window that asked hears the `storage` event and signs in on its
//    own. Navigating this tab would be the bug the user reported, made worse:
//    two signed-in copies, and the one they installed still waiting.

import { BRAND } from '@/lib/brand';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  AMBER_CALLBACK_PATH,
  amberRecordIsFresh,
  looksLikeAmberResult,
  parseAmberCallback,
} from '@/lib/nostr/amber-callback-url';
import { storage } from '@/lib/storage';

type Outcome =
  | { kind: 'working' }
  | { kind: 'ok'; back: string }
  /** Parked for a home-screen window that is still open; this tab stays put. */
  | { kind: 'parked'; back: string }
  | { kind: 'refused'; why: string; detail: string; raw?: string };

// THE FRAGMENT IS A ONE-SHOT INPUT AND THIS EFFECT DESTROYS IT. So it is read
// once per page load and the work happens once, and both are held at module
// scope rather than in component state or a ref, neither of which survives a
// remount.
//
// This is defensive, and the honest version of why: MEASURED on this app's dev
// server (Next 15.5, no `reactStrictMode` set), the effect runs exactly ONCE, so
// there is no bug here today. But an effect that reads `window.location.hash`
// and calls `history.replaceState` two lines later is one config flag from
// breaking — React StrictMode double-invokes effects on mount (run, clean up,
// run again), and the second pass would see an empty hash, take the "there is no
// Amber result in this address" branch, and overwrite a sign-in that had already
// succeeded. The page would report failure for a round trip that worked.
//
// That failure mode is why the shape is worth fixing before it is reachable
// rather than after: it is silent, it inverts the truth, and it would surface on
// someone's phone rather than here. `handled` and `captureHash` cost two lines
// and make the effect idempotent regardless.
let capturedHash: string | null = null;
let handled = false;

function captureHash(): string {
  if (capturedHash === null) capturedHash = window.location.hash;
  return capturedHash;
}

export default function AmberCallbackPage() {
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'working' });

  useEffect(() => {
    // A second invocation must not redo the work: by then the pending record is
    // consumed, and re-running would report "this tab was not waiting for
    // anything" over a result it just parked successfully.
    if (handled) return;
    handled = true;

    // Read BEFORE the rewrite. Order is the point, and `captureHash` is what
    // makes the order survive being run twice.
    const hash = captureHash();
    try {
      window.history.replaceState(null, '', AMBER_CALLBACK_PATH);
    } catch {
      /* a blocked history API must not stop the round trip completing */
    }

    const parsed = parseAmberCallback(hash);
    if (!parsed) {
      setOutcome({
        kind: 'refused',
        why: 'There is no Amber result in this address.',
        detail:
          hash.length > 1
            ? 'Something is after the # but it is not the shape Amber sends. If you opened this page from a bookmark or a link, that is expected.'
            : 'This page only does something when Amber sends you here. Nothing to do.',
      });
      return;
    }

    const pending = storage.amberPending.get();
    if (!pending) {
      setOutcome({
        kind: 'refused',
        why: 'This browser tab was not waiting for anything.',
        detail:
          'The request was started somewhere else — another tab, or the installed app rather than the browser. Copy the value below and paste it where you started signing in.',
        raw: parsed.raw,
      });
      return;
    }
    if (pending.rid !== parsed.rid) {
      // Not an error worth alarming anyone about: it is what a second request,
      // or a stale one, looks like. It is also what a forged navigation looks
      // like, which is why the id has to match rather than merely be present.
      setOutcome({
        kind: 'refused',
        why: 'This answer belongs to a different request.',
        detail:
          'This tab is waiting on a newer Amber request than the one that just came back. Start it again, or paste the value below where you began.',
        raw: parsed.raw,
      });
      return;
    }
    if (!amberRecordIsFresh(pending.ts, Date.now())) {
      storage.amberPending.clear();
      setOutcome({
        kind: 'refused',
        why: 'That request is too old to finish automatically.',
        detail: 'Start it again, or paste the value below where you began.',
        raw: parsed.raw,
      });
      return;
    }
    if (!looksLikeAmberResult(parsed.raw, pending.type)) {
      setOutcome({
        kind: 'refused',
        why: `That does not look like a ${pending.type} result.`,
        detail:
          'Amber returned something, but not the shape this request asked for. Nothing has been used. Paste it by hand if you think it is right.',
        raw: parsed.raw,
      });
      return;
    }

    // `set` refuses a type whose result is not safe to put on disk — the guard
    // lives in lib/storage.ts, not here, so a future type added to
    // RESUMABLE_TYPES cannot start writing plaintext by accident. If it says no,
    // the round trip stops and the user is told, rather than being left on a
    // page that quietly did nothing.
    const parked = storage.amberResult.set({
      rid: parsed.rid,
      type: pending.type,
      value: parsed.raw,
      ts: Date.now(),
    });
    if (!parked) {
      storage.amberPending.clear();
      setOutcome({
        kind: 'refused',
        why: `A ${pending.type} result cannot be handed over this way.`,
        detail:
          'This kind of result is not safe to store, so it was not kept. Paste it by hand where you started, or try again.',
        raw: parsed.raw,
      });
      return;
    }
    storage.amberPending.clear();

    // Back where the user was, not to `/`. `replace`, so this page does not sit
    // in history between them and the back button.
    // `startsWith('/')` is not "same origin": `//evil.com` and `/\evil.com` are
    // both protocol-relative, and `location.pathname` really is `//evil.com`
    // for a visit to `https://<us>//evil.com`, so a sign-in begun from such a
    // URL would send the user off-site. A second leading slash or backslash is
    // the whole test, and it runs before the value is navigated to OR offered
    // as a button.
    const origin = pending.origin ?? '';
    const sameSite =
      origin.startsWith('/') && origin[1] !== '/' && origin[1] !== '\\';
    const back = sameSite ? origin : '/';

    // `standalone` says the window that asked was an installed app. It does NOT
    // say this page landed somewhere else, and a Trusted Web Activity is the
    // case where both are true at once: it matches `(display-mode: standalone)`
    // and Android hands it the https callback, which REPLACES the very window
    // that asked. Parking there leaves nobody to consume the answer, and tells
    // a user already inside the app to switch to it. `amberTab` is the missing
    // half — sessionStorage, so it is here only if this document is the one
    // that dispatched the request.
    const replacedTheAsker = storage.amberTab.get() === pending.rid;
    if (replacedTheAsker) storage.amberTab.clear();
    if (pending.standalone && !replacedTheAsker) {
      // The window that asked is a home-screen app and is still open; it has
      // just been told by the `storage` event. This tab's only job was the
      // write above. Closing is best-effort — a browser may refuse to close a
      // tab a script did not open — so the screen below says what to do
      // either way, and offers this tab as a fallback rather than assuming it.
      setOutcome({ kind: 'parked', back });
      try { window.close(); } catch { /* refused: the message covers it */ }
      return;
    }

    setOutcome({ kind: 'ok', back });
    window.location.replace(back);
  }, []);

  return (
    <main className="min-h-screen px-4 pt-[env(safe-area-inset-top)]">
      <div className="max-w-xl mx-auto pt-24">
        <div className="card p-5">
          <div className="stamp text-muted border-muted/40 mb-2">AMBER</div>

          {outcome.kind === 'parked' ? (
            <>
              <h1 className="font-display text-2xl">Signed in</h1>
              <p className="text-sm text-muted mt-2">
                Switch back to the {BRAND.displayName} app — it already has your
                sign-in. You can close this tab.
              </p>
              <div className="mt-4">
                {/* A full load on purpose, same as the non-standalone path:
                    <NostrAuth>'s mount effect is what picks a parked result up.
                    If the app window took it first, this tab simply starts
                    signed out, which is the honest state. */}
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => window.location.replace(outcome.back)}
                >
                  continue in this tab instead
                </button>
              </div>
            </>
          ) : outcome.kind !== 'refused' ? (
            <>
              <h1 className="font-display text-2xl">
                {outcome.kind === 'ok' ? 'Signed in' : 'Finishing…'}
              </h1>
              <p className="text-sm text-muted mt-2">
                {outcome.kind === 'ok'
                  ? 'Taking you back.'
                  : 'Reading what Amber sent back.'}
              </p>
            </>
          ) : (
            <>
              <h1 className="font-display text-2xl">{outcome.why}</h1>
              <p className="text-sm text-muted mt-2">{outcome.detail}</p>
              {outcome.raw && (
                <div className="mt-4">
                  <div className="stamp text-muted border-muted/40 mb-2">
                    WHAT AMBER SENT
                  </div>
                  {/* select-all so a phone can copy it without a clipboard
                      permission prompt — this page exists precisely for the
                      cases where the automatic path did not work. */}
                  <pre className="text-[11px] font-mono break-all whitespace-pre-wrap select-all border border-line rounded p-2 max-h-48 overflow-y-auto">
                    {outcome.raw}
                  </pre>
                </div>
              )}
              <div className="mt-4">
                {/* Safe as a client transition: Amber reaches this page by a
                    full page load, so the Zustand store is fresh and there is no
                    `selectedPodcast` for a <Link href="/"> to re-open — the trap
                    CLAUDE.md's handoff rule describes. The SUCCESS path is the
                    one that must not be a client transition, and it isn't: it
                    uses location.replace so <NostrAuth>'s mount effect runs and
                    picks the parked result up. */}
                <Link href="/" className="btn">← back to home</Link>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
