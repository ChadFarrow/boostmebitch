'use client';

import { useState } from 'react';
import { ModalShell } from '@/components/modal-shell';

/**
 * The first thing the maker shows a visitor who is NOT signed in and whose
 * browser holds no guest key (Chad, 2026-11-19: "we should have a pop-up that
 * people log in with Nostr, or they just say I don't have Nostr, and then we
 * make them keys and save them"). docs/feeds.md, "Making a playlist without a
 * Nostr account", says when it shows.
 *
 * - SIGN IN WITH NOSTR opens the site's sign-in. The playlist goes out under the account.
 * - I DON'T HAVE NOSTR makes the browser key now (`ensureGuestKey`) and keeps it.
 *   The person then builds with the key already in place.
 * - Closing it (×, Escape, the backdrop) chooses nothing and blocks nothing: the
 *   form is there, and PUBLISH makes the browser key then, unless the person signed
 *   in first. The dialog says so before it is closed, because a guard that
 *   withholds must say why, and a person must never be stuck behind it.
 */
export function StartChoice({
  onSignIn,
  onNoNostr,
  onClose,
}: {
  onSignIn: () => void;
  /** Makes the browser key. Resolves false when the browser could not make one. */
  onNoNostr: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [making, setMaking] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <ModalShell onClose={onClose} label="Make a playlist" className="w-full max-w-md" closeButton>
      <div className="p-5" data-start-choice>
        <h2 className="pr-8 font-display text-xl">Make a playlist</h2>
        <p className="mt-1 text-sm text-bone/80">
          A playlist goes out under a Nostr key. Sign in with your Nostr account, or let this browser make a key for you.
        </p>
        <div className="mt-4 space-y-4">
          <div>
            <button type="button" className="btn-bolt btn-compact" disabled={making} onClick={onSignIn} data-start-signin>
              SIGN IN WITH NOSTR
            </button>
            <p className="mt-1 text-xs text-bone/70">
              The playlist goes out under your account. You can change it wherever you sign in.
            </p>
          </div>
          <div>
            <button type="button" className="btn-ghost btn-compact" disabled={making} data-start-guest
              onClick={async () => {
                setMaking(true); setFailed(false);
                const ok = await onNoNostr().catch(() => false);
                // On success the parent closes the dialog; this stays mounted only on a failure.
                setMaking(false); setFailed(!ok);
              }}>
              {making ? 'MAKING A KEY…' : 'I DON’T HAVE NOSTR'}
            </button>
            <p className="mt-1 text-xs text-bone/70">
              This browser makes a key for your playlists and keeps it. You save nothing. You can change the playlist
              later in this browser only. If you clear this browser&apos;s site data, you cannot change it, and you can make it again.
            </p>
            {failed && (
              <p role="alert" className="mt-1 text-xs text-bone" data-start-failed>
                This browser could not make a key. Sign in with Nostr, or try again.
              </p>
            )}
          </div>
        </div>
        <p className="mt-4 border-t border-bone/15 pt-3 text-xs text-muted">
          Close this to decide later. You can still build the playlist. If you are not signed in when you press PUBLISH, this browser makes the key then.
        </p>
      </div>
    </ModalShell>
  );
}
