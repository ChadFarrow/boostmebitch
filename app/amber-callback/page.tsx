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
// 3. There is a real case where the honest answer is "not for this tab", and it
//    is not rare. With the Android app installed and verified, Amber's
//    ACTION_VIEW on this origin can resolve to the TWA rather than to the
//    browser tab the request came from. Different sessionStorage, no pending
//    record, nothing to match — and the right thing to do is say so and let the
//    user paste, not to guess.

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
  | { kind: 'ok' }
  | { kind: 'refused'; why: string; detail: string; raw?: string };

export default function AmberCallbackPage() {
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'working' });

  useEffect(() => {
    // Read BEFORE the rewrite. Order is the point.
    const hash = window.location.hash;
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

    storage.amberResult.set({
      rid: parsed.rid,
      type: pending.type,
      value: parsed.raw,
      ts: Date.now(),
    });
    storage.amberPending.clear();
    setOutcome({ kind: 'ok' });

    // Back where the user was, not to `/`. `replace`, so this page does not sit
    // in history between them and the back button.
    const back = pending.origin && pending.origin.startsWith('/') ? pending.origin : '/';
    window.location.replace(back);
  }, []);

  return (
    <main className="min-h-screen px-4 pt-[env(safe-area-inset-top)]">
      <div className="max-w-xl mx-auto pt-24">
        <div className="card p-5">
          <div className="stamp text-muted border-muted/40 mb-2">AMBER</div>

          {outcome.kind !== 'refused' ? (
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
