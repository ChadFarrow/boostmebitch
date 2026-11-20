'use client';

import { useState } from 'react';
import { ModalShell } from '@/components/modal-shell';

/** Why <StartChoice> is open: the maker opened, or PUBLISH or UPLOAD was pressed before a choice. */
export type StartChoiceFor = 'start' | 'publish' | 'upload';

/**
 * Asks a visitor who is NOT signed in whether they have Nostr, before the
 * playlist goes out under anything. docs/feeds.md, "Making a playlist without a
 * Nostr account", says when it opens.
 *
 * ITS MAIN JOB IS THE SIGN-IN. Chad, 2026-11-19, after he made a playlist on
 * beta under a browser key: "I went there and just made that playlist without
 * even knowing that I could tie it to my Nostr. So we definitely need the pop-up
 * if we're going to allow non-Nostr users to make playlists." So a person who
 * HAS Nostr must read, first, that signing in ties the playlist to their account
 * and lets them edit it from any device; I DON'T HAVE NOSTR sits under its own
 * "No Nostr account?" heading, as the choice for people without one, and says
 * what that playlist cannot do: be edited outside this browser.
 *
 * KEEP THE WORDS FEW, AND NAME "the playlist" — never "it". Chad, 2026-11-19, on
 * the first version: "The non Nostr one is too wordy. The Nostr one also doesn't
 * sound like you can edit the playlist from anywhere. It sounds more like it's
 * the Nostr account" ("you can change it from any device" read as the account).
 *
 * - SIGN IN WITH NOSTR opens the site's sign-in OVER this dialog, which stays
 *   until the account lands: closing the sign-in shows the choice again. The
 *   caller must not close this in the same press (see `onSignIn` in the maker).
 * - I DON'T HAVE NOSTR makes the browser key (`ensureGuestKey`). It is the ONLY
 *   thing that makes one for a new playlist: PUBLISH and UPLOAD open this dialog
 *   instead while no choice is made, so a closed dialog never turns into a
 *   browser key without a word.
 * - Closing it (×, Escape, the backdrop) blocks nothing: the form stays, and the
 *   next PUBLISH or UPLOAD asks again. The dialog says so before it is closed.
 */
export function StartChoice({
  when,
  onSignIn,
  onNoNostr,
  onClose,
}: {
  when: StartChoiceFor;
  onSignIn: () => void;
  /**
   * Makes the browser key. Resolves false when the browser could not make one.
   * Called inside the press itself, so the caller may open a file picker first.
   */
  onNoNostr: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [making, setMaking] = useState(false);
  const [failed, setFailed] = useState(false);
  const later = when === 'publish'
    ? 'Close this to keep building. Nothing is published until you choose.'
    : when === 'upload'
      ? 'Close this to keep building. The picture is uploaded after you choose.'
      : 'Close this to decide later. You choose before anything is published.';
  return (
    <ModalShell onClose={onClose} label="Do you have Nostr?" className="w-full max-w-md" closeButton>
      <div className="p-5" data-start-choice={when}>
        <h2 className="pr-8 font-display text-xl">Do you have Nostr?</h2>
        <p className="mt-2 text-sm text-bone">
          Sign in to tie this playlist to your Nostr account. Then you can edit the playlist from any device.
        </p>
        <button type="button" className="btn-bolt btn-compact mt-3" disabled={making} onClick={onSignIn} data-start-signin>
          SIGN IN WITH NOSTR
        </button>

        <div className="mt-5 border-t border-bone/15 pt-4" data-start-no-nostr>
          <p className="font-mono text-xs uppercase tracking-wider text-muted">No Nostr account?</p>
          <p className="mt-1 text-xs text-bone/70">
            This browser keeps a key for you. You can edit the playlist only in this browser.
          </p>
          <button type="button" className="btn-ghost btn-compact mt-2" disabled={making} data-start-guest
            onClick={async () => {
              setMaking(true); setFailed(false);
              const ok = await onNoNostr().catch(() => false);
              // On success the parent closes the dialog; this stays mounted only on a failure.
              setMaking(false); setFailed(!ok);
            }}>
            {making ? 'MAKING A KEY…' : 'I DON’T HAVE NOSTR'}
          </button>
          {failed && (
            <p role="alert" className="mt-1 text-xs text-bone" data-start-failed>
              This browser could not make a key. Sign in with Nostr, or try again.
            </p>
          )}
        </div>

        <p className="mt-4 border-t border-bone/15 pt-3 text-xs text-muted" data-start-later>{later}</p>
      </div>
    </ModalShell>
  );
}
