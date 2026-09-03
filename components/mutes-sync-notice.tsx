'use client';
import { useState } from 'react';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { hydrateMutes } from '@/lib/nostr';

// "We are not applying your private mutes" made visible.
//
// A kind:10000 carries two lists: public `p` tags, and an encrypted JSON tag
// array in `event.content`. When this app cannot open that second half it keeps
// the ciphertext verbatim and publishes nothing derived from it, which is the
// right behaviour — a blind republish would destroy private mutes set in Damus
// or Amethyst, on someone else's device, with no undo.
//
// It was also completely silent, and silent is expensive here for the reason
// CLAUDE.md gives: a withheld private half renders as a SHORTER LIST and
// nothing else. There is no error state to notice, no gap on screen, no console
// line the user will ever read. Someone muted twelve accounts in Damus, opens
// this app, sees four of them muted, and has no way to learn that the other
// eight exist — the accounts they muted are simply back in their feed.
// `docs/signers.md` has listed this as the missing piece for a while.
//
// THE TWO REASONS ARE DIFFERENT SENTENCES BECAUSE THE USER'S NEXT MOVE IS
// DIFFERENT, which is the same argument <FavoritesSyncNotice> makes for its own
// split:
//
//  - 'withheld' — we chose not to ask. Nothing is broken. A signer that lives
//    outside the browser (Amber, or a bunker on the user's own phone like
//    Clave) gets no unattended decrypt on a cold start, because that puts an
//    approval sheet in front of someone who has just opened an app. The control
//    spends that prompt on purpose, and it will work.
//  - 'private-unreadable' — we asked and it did not open. Worth retrying, and
//    it may mean this signer does not implement the cipher the list is written
//    in. Reading it as the first case would promise a fix that isn't coming.
//
// It renders ONLY when a private half actually exists — `reportPrivateHalf`
// gates on `unreadablePrivateContent`, so an account with no private mutes, or
// one whose private mutes opened fine, never sees this. A permanent banner for
// everyone signed in with Amber would be noise, and noise is how a notice stops
// being read.
//
// Signed out is excluded for the same reason the favorites notice excludes it:
// there is no key, nothing is in flight, and there is no relay copy to fail at.

export function MutesSyncNotice() {
  const identity = useApp((s) => s.identity);
  const degraded = useApp((s) => s.mutesSync === 'degraded');
  const reason = useApp((s) => s.mutesSyncReason);
  const [busy, setBusy] = useState(false);

  // 'idle' is the pre-hydration and signed-out state, never a failure.
  if (!identity || !degraded) return null;

  const withheld = reason === 'withheld';

  const message = withheld
    ? 'Your private mute list wasn’t opened on load — showing the mutes saved on this device.'
    : '⚠ Your signer couldn’t open your private mute list — showing the mutes saved on this device.';

  async function load() {
    setBusy(true);
    try {
      // 'user-initiated' is the whole point of the button: it is the one thing
      // that spends a signer prompt on a signer we deliberately do not ask
      // unprompted. A success flips `mutesSync` and unmounts this from under
      // us; `hydrateMutes` owns both the store and the cache, so there is
      // nothing to repaint here afterwards.
      // This button has exactly one meaning — "open my private mute list" — so
      // the consent is unconditional here, unlike the favorites notice whose
      // control doubles as a plain relay retry. Written before the await for
      // the same reason: a success unmounts this component.
      storage.listUnlock.set(identity!.npub, true);
      await hydrateMutes(identity!, 'user-initiated');
    } catch {
      // hydrateMutes already reported the state; the notice simply stays up.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="status"
      className="text-[11px] text-nostr/80 border border-nostr/30 bg-nostr/5 px-2 py-1.5 mb-2 flex items-center justify-between gap-2"
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={load}
        disabled={busy}
        className="underline underline-offset-2 hover:text-nostr disabled:opacity-40 flex-shrink-0"
      >
        {busy ? 'loading…' : withheld ? 'load' : 'retry'}
      </button>
    </div>
  );
}
