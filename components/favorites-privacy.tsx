'use client';

// WHERE this account's favorites go: public tags on the shared kind:10333
// event, an encrypted half inside it, or nowhere at all.
//
// Two surfaces, one vocabulary, one file:
//
//   <FavoritesPrivacyControl>  the segmented control on /favorites
//   <FavoritesPrivacyModal>    the first-favorite question, and every
//                              confirmation for a switch
//
// They share `MODES` and `describe()` deliberately. The consequence sentence is
// the whole point of the feature — "private" and "not on Nostr" are both
// invisible from the outside, and a user who cannot tell which one they are in
// has no way to find out — so two surfaces disagreeing about what a mode means
// would be worse than either wording alone.

import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/lib/store';
import { storage, subscribeFavPrivacy } from '@/lib/storage';
import { ModalShell } from './modal-shell';
import { SelectMenu } from './select-menu';
import {
  favoritesMode,
  hydrateFavorites,
  onFavoritesModeNeeded,
  privateFavoritesEnabled,
  recordFavoritesPrivacy,
  syncFavoritesNow,
  withdrawThisDevice,
  type FavoritesPrivacy,
} from '@/lib/nostr';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const MODES: FavoritesPrivacy[] = ['public', 'private', 'off'];

const LABEL: Record<FavoritesPrivacy, string> = {
  public: 'Public',
  private: 'Private',
  off: 'Not on Nostr',
};

/**
 * The confirmation's headline.
 *
 * NOT `Switch to ${LABEL[choice]}?` — that reads "Switch to Not on Nostr?",
 * which is a sentence nobody writes. The segment label has to be a short noun
 * for the control; the question has to be a question.
 */
function switchHeading(choice: FavoritesPrivacy): string {
  return choice === 'off' ? 'Stop syncing to Nostr?' : `Switch to ${LABEL[choice]}?`;
}

/**
 * What this mode actually means for the user, in one sentence naming the
 * consequence rather than the mechanism.
 *
 * 'public' says "anyone" rather than "readable" on purpose: `i` is a
 * single-letter tag, so relays index it and a `#i` filter answers *which
 * pubkeys favorited this feed*. The list is searchable in reverse, not merely
 * readable by someone who already has the pubkey, and "public" alone does not
 * convey that.
 */
function describe(mode: FavoritesPrivacy): string {
  if (mode === 'public') {
    return 'Synced across your apps. Anyone can look up who favorited a show.';
  }
  if (mode === 'private') {
    return 'Synced across your apps, encrypted so only you can read them.';
  }
  return 'Kept on this device only. Nothing is sent to Nostr.';
}

/** The one thing privacy does NOT hide, said out loud. */
const PRIVATE_CAVEAT =
  'Your pubkey, and roughly how many favorites you keep, stay visible either way.';

const GATE_REASON =
  'Waiting on the other apps that share this list. Turning it on before they update '
  + 'would let one of them erase your private favorites, with no undo.';

// ---------------------------------------------------------------------------
// Reading the current mode
// ---------------------------------------------------------------------------

/**
 * This account's mode, or null when it has never chosen.
 *
 * Null is a real third state — it is what makes the first-favorite prompt fire
 * — so it is never flattened to 'public' here. `mounted` gates the first render
 * because the value lives in localStorage and the server has no idea what it
 * is.
 */
export function useFavoritesMode(): { mode: FavoritesPrivacy | null; mounted: boolean } {
  const identity = useApp((s) => s.identity);
  const [mode, setMode] = useState<FavoritesPrivacy | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const read = () => setMode(identity ? favoritesMode(identity.npub) : null);
    read();
    setMounted(true);
    // Subscribed rather than read once: the modal and the control are separate
    // trees, and a write from either has to move the other.
    return subscribeFavPrivacy(read);
  }, [identity]);

  return { mode, mounted };
}

/**
 * The control on /favorites.
 *
 * Renders nothing signed out: favorites are already local-only then, so all
 * three options describe the same behaviour and offering a choice between them
 * would be a lie.
 */
export function FavoritesPrivacyControl() {
  const identity = useApp((s) => s.identity);
  const { mode, mounted } = useFavoritesMode();
  const [pending, setPending] = useState<FavoritesPrivacy | null>(null);
  const gated = mounted && !privateFavoritesEnabled();

  if (!identity || !mounted) return null;

  // Null is rendered as "nothing pressed", never as Public. Public is a real
  // claim — it means a relay can be asked who favorited a show — and showing it
  // selected for an account that has not chosen tells the user something about
  // their data that is not true yet.
  const current = mode;

  return (
    <>
      {/* ONE ROW: the menu names the mode, the sentence names what it costs.
          This was three segments spanning the page, and at 390px "Not on
          Nostr" wrapped inside its own segment — so the tallest thing above a
          287-entry library was the control saying where the library is stored.
          A menu is one line at every width and it still states the current
          mode without being opened, which is the property that matters here:
          "private" and "not on Nostr" are both invisible from the outside.

          THE CONSEQUENCE SENTENCE STAYS ON SCREEN. It is not a tooltip and not
          a menu subtitle — it is the whole point of the feature, since a user
          who cannot tell which of the two silent modes they are in has no way
          to find out. It shares the row and wraps beneath on a narrow screen. */}
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <SelectMenu
          options={MODES.map((m) => ({
            id: m,
            label: LABEL[m],
            // Never disable the mode the account is ALREADY in. The gate stops
            // you choosing private; it does not retire a private list that
            // exists, and a control showing the current state as unavailable
            // reads as a broken app rather than a withheld feature.
            disabled: m === 'private' && gated && current !== 'private',
            title: m === 'private' && gated && current !== 'private' ? GATE_REASON : describe(m),
          }))}
          active={current}
          // Null is rendered as "not set", never as Public. Public is a real
          // claim — it means a relay can be asked who favorited a show — and
          // showing it selected for an account that has not chosen tells the
          // user something about their data that is not true yet.
          placeholder="Not set"
          // A switch is never applied straight from the control. Each one moves
          // entries on a shared event — into the encrypted half, into
          // plaintext, or off the relays entirely — and two of the three are
          // not undoable by picking the old one again.
          onChange={(m) => { if (m !== current) setPending(m); }}
          label="Favorites are"
          className="shrink-0"
        />
        <p className="text-[11px] text-muted">
          {current
            ? describe(current)
            : 'Not set yet — you will be asked when you save your first favorite.'}
        </p>
        {gated && (
          <p className="w-full text-[11px] text-muted/70">Private: {GATE_REASON}</p>
        )}
      </div>

      {pending && (
        // Keyed by the target, so changing it REMOUNTS. `choice` is seeded from
        // `to` with useState, which ignores every later value — so without the
        // key a second target arriving while the dialog is open leaves the
        // heading, the copy and the action all describing the first one. The
        // backdrop makes that hard to reach by hand and trivial to reach from a
        // script, which is how it turned up.
        <FavoritesPrivacyModal key={pending} to={pending} onClose={() => setPending(null)} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

/**
 * Asks the question, then does the work.
 *
 * Two entry modes, one component. `to` unset is the FIRST-FAVORITE prompt —
 * the user has just favorited something, it is already in the store, and the
 * question is where it should live. `to` set is a switch confirmation from the
 * control above.
 *
 * The favorite is applied before this opens, deliberately: the heart fills on
 * the tap and the question comes after. Publishing publicly and THEN asking
 * "public or private?" is backwards, and a relay that has the bytes cannot be
 * asked to forget them.
 */
export function FavoritesPrivacyModal({
  to,
  onClose,
  onBusyChange,
}: {
  /** Unset = the first-favorite question. Set = confirming a switch to it. */
  to?: FavoritesPrivacy;
  onClose: () => void;
  /**
   * Reported up so the PARENT does not unmount this mid-publish.
   * `dismissable={!busy}` only stops Escape and a backdrop click; it cannot stop
   * the owner from removing the element, which is what
   * <FavoritesPrivacyPrompt>'s close-on-mode effect did the instant
   * `recordFavoritesPrivacy` wrote — while `apply` was still awaiting. Any error
   * from that publish then landed on an unmounted component and the user saw the
   * dialog simply vanish, having been told nothing.
   */
  onBusyChange?: (busy: boolean) => void;
}) {
  const identity = useApp((s) => s.identity);
  const [choice, setChoice] = useState<FavoritesPrivacy>(to ?? 'public');
  const [withdraw, setWithdraw] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  const [error, setError] = useState<string | null>(null);
  const asking = !to;
  const gated = !privateFavoritesEnabled();

  // "Is there anything of ours up there to take down?" is a question about this
  // device's BASELINE, not about the mode it is in. The mode can be unset on a
  // device that has published plenty — seeding only runs off a trustworthy
  // read, so a spell of bad relays leaves it null with a full baseline — and
  // gating the offer on `from` meant the one control that removes your entries
  // was hidden from exactly the person whose entries were out there.
  const baseline = identity ? storage.favBaseline.get(identity.npub) : null;
  const published = baseline
    ? baseline.feeds.length + baseline.items.length
      + (baseline.privateFeeds?.length ?? 0) + (baseline.privateItems?.length ?? 0)
    : 0;

  const apply = useCallback(async () => {
    if (!identity) return;
    // The gate, enforced where a HUMAN chooses — not in `favoritesMode`, which
    // must report an existing private list honestly or it gets republished in
    // plaintext (see that function). The disabled radio and the disabled
    // segment are the visible half; this is the one that matters, because the
    // property being protected is "no NEW private half until every writer
    // carries `content`", and only this path creates one.
    //
    // `current !== 'private'` mirrors the control: an account already private
    // may re-confirm it, since the harm was done before the gate could help.
    if (choice === 'private' && gated && favoritesMode(identity.npub) !== 'private') {
      setError(GATE_REASON);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Withdrawing runs BEFORE the mode is recorded. `withdrawThisDevice`
      // still reads the list first and still refuses on an untrustworthy read,
      // so it can decline — and recording 'off' first would leave a device that
      // has stopped syncing with entries it promised to remove and now never
      // will.
      if (choice === 'off' && withdraw && published > 0) {
        // **A REFUSAL IS A `null`, NOT A THROW — test the answer.**
        // `withdrawFavorites` → `syncFavorites` returns null without recording
        // anything on a degraded read, on 'wholesale-delete', on
        // 'private-unreadable', on 'private-too-large', and when the publish
        // reached no relay (`NoRelayAcceptedError` is swallowed into
        // `onDegraded`). A single relay wobble is enough. Ignoring it and
        // recording 'off' tells the user their entries were taken down while
        // they are still on the relays — and 'off' then stops both `runHydrate`
        // and `requestFavoritesSync`, so NOTHING EVER RETRIES. Stopping here
        // leaves the mode unrecorded, which is what keeps the retry real.
        const note = await withdrawThisDevice(identity);
        if (!note) {
          setError(
            'Could not remove your entries from Nostr just now — your relays did not '
            + 'confirm the change, so nothing was altered and your setting is unchanged. '
            + 'Try again in a moment.',
          );
          return;
        }
      }
      // A choice that did not reach DISK must not be reported as saved.
      // `safeSet` falls back to an in-memory mirror when localStorage is full
      // or blocked — both documented as real on iOS Safari — and that mirror
      // does not survive a reload. The setting would work for the rest of the
      // session and then be gone, dropping the account back into the
      // never-chosen path where the mode is inferred from a shared event that
      // may not be able to say. Closing the dialog on that is the app telling
      // the user their privacy choice is recorded when it is not.
      if (!recordFavoritesPrivacy(identity.npub, choice, identity)) {
        setError(
          'Could not save that choice on this device — storage is full or blocked. '
          + 'Nothing was changed. Free up space, or allow site data, and try again.',
        );
        return;
      }
      if (choice === 'off') {
        // The status is normally set by `runHydrate`, and turning sync off is
        // the one transition that stops it running — so nothing else would move
        // it off 'ok' until a reload, and <FavoritesPage>'s empty state would
        // keep telling a signed-in user to sign in. See `favoritesSync` in
        // lib/store.ts for why 'off' is not 'idle'.
        useApp.getState().setFavoritesSync('off');
      } else {
        // Re-read and republish under the new mode. This is the move: the half
        // being left drops what this device's baseline claims, and the half
        // being joined gains it, in one publish.
        //
        // `userChose` — this press IS the answer, and it is the ONLY thing that
        // may write the list's `visibility` tag or change one already there. A
        // heart toggle and a page load both leave it false. See
        // `effectiveListMode`.
        await syncFavoritesNow(identity, 'user-initiated', true);
        await hydrateFavorites(identity);
      }
      onClose();
    } catch (e) {
      setError((e as Error)?.message ?? 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }, [identity, choice, withdraw, published, gated, onClose]);

  const leaving = choice === 'off' && published > 0;

  return (
    <ModalShell
      onClose={onClose}
      label={asking ? 'Where should your favorites be stored?' : switchHeading(choice)}
      className="w-full max-w-md"
      dismissable={!busy}
    >
      <div className="p-5 border-b border-bone/15">
        <div className="stamp text-nostr border-nostr/60 mb-2">◆ FAVORITES</div>
        <h3 className="font-display text-2xl leading-tight">
          {/* "Where should THIS live?" read as a question about the one favorite
              just made. The choice governs the whole list, and a user who takes
              it as per-item will expect a control that does not exist. */}
          {asking ? 'Where should your favorites live?' : switchHeading(choice)}
        </h3>
        <p className="text-xs text-muted mt-1">
          {asking
            ? 'Your favorites sync between apps over Nostr. You choose how.'
            : describe(choice)}
        </p>
      </div>

      <div className="p-5 space-y-3">
        {asking && MODES.map((m) => {
          const disabled = m === 'private' && gated;
          return (
            <label
              key={m}
              className={`flex items-start gap-2 text-sm ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
            >
              <input
                type="radio"
                name="fav-privacy"
                className="mt-1"
                checked={choice === m}
                disabled={disabled || busy}
                onChange={() => setChoice(m)}
              />
              <span>
                <span className="font-semibold">{LABEL[m]}</span>
                <span className="block text-[11px] text-muted">
                  {disabled ? GATE_REASON : describe(m)}
                </span>
              </span>
            </label>
          );
        })}

        {!asking && choice === 'private' && (
          <p className="text-xs text-muted">
            Everything you have already favorited moves into the encrypted half,
            in one update. {PRIVATE_CAVEAT}
          </p>
        )}

        {!asking && choice === 'public' && (
          <p className="text-xs text-muted">
            Everything you have already favorited moves into the public half, in
            one update. Anyone can then look up who favorited a show.
          </p>
        )}

        {/* Nothing of ours is up there, so there is nothing to offer — but the
            silence still has to be broken. "Not on Nostr" reads as a promise
            about the past as much as the future, and letting someone infer that
            when it is not what happened is the same silent-guard failure the
            sync notice exists for, pointed the other way. */}
        {choice === 'off' && !leaving && (
          <p className="text-xs text-muted">
            Favorites stay on this device from now on. This device has not put
            anything on Nostr, so there is nothing to take down.
          </p>
        )}

        {leaving && (
          <div className="space-y-2 text-sm">
            <p className="text-xs text-muted">
              {published} {published === 1 ? 'entry' : 'entries'} from this
              device {published === 1 ? 'is' : 'are'} on Nostr right now.
            </p>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="fav-withdraw"
                className="mt-1"
                checked={withdraw}
                disabled={busy}
                onChange={() => setWithdraw(true)}
              />
              <span>
                Also remove my entries from Nostr
                <span className="block text-[11px] text-muted">
                  Takes down only what this device put there. Favorites another
                  app added are left alone.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="fav-withdraw"
                className="mt-1"
                checked={!withdraw}
                disabled={busy}
                onChange={() => setWithdraw(false)}
              />
              <span>
                Just stop syncing from now on
                <span className="block text-[11px] text-muted">
                  What you have already synced stays on Nostr, and stays public.
                </span>
              </span>
            </label>
          </div>
        )}

        {asking && choice === 'private' && !gated && (
          <p className="text-[11px] text-muted">{PRIVATE_CAVEAT}</p>
        )}

        {error && (
          <p className="text-xs text-nostr" role="alert">{error}</p>
        )}
      </div>

      <div className="p-5 pt-0 flex items-center gap-2">
        <button type="button" className="btn-bolt" onClick={apply} disabled={busy}>
          {busy ? 'working…' : asking ? 'Save' : 'Switch'}
        </button>
        <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </ModalShell>
  );
}

/**
 * Mounted once, in <AppHeader>, so `/` and /favorites both have it.
 *
 * Opened by `requestFavoritesSync` through `onFavoritesModeNeeded` — the one
 * funnel every heart passes through. Closes itself if a mode arrives from
 * somewhere else while it is open (the synced settings event landing, or
 * another tab), because the question is then already answered.
 */
export function FavoritesPrivacyPrompt() {
  const open = useApp((s) => s.favPrivacyPrompt);
  const setOpen = useApp((s) => s.setFavPrivacyPrompt);
  const identity = useApp((s) => s.identity);
  const { mode } = useFavoritesMode();

  // Registered once, from the component that draws the dialog, so the engine
  // never has to know a React tree exists. `useApp.getState()` rather than the
  // bound `setOpen` because this callback outlives any one render.
  useEffect(() => {
    onFavoritesModeNeeded(() => useApp.getState().setFavPrivacyPrompt(true));
    installPrivateFavoritesHook();
    return () => onFavoritesModeNeeded(null);
  }, []);

  // Never while the dialog is mid-publish. `apply` writes the mode BEFORE it
  // awaits `syncFavoritesNow`, so without this guard the mode landing is itself
  // what unmounts the dialog that is still working — and the error it would have
  // shown goes nowhere. `apply` closes itself on success; this effect exists for
  // the other case, a mode arriving from somewhere else (another device through
  // `applySyncedSettings`, or a second surface).
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (busy) return;
    if (open && (mode || !identity)) setOpen(false);
  }, [open, mode, identity, setOpen, busy]);

  if (!open || !identity) return null;
  return <FavoritesPrivacyModal onClose={() => setOpen(false)} onBusyChange={setBusy} />;
}

/**
 * The device escape hatch for the private half, ahead of
 * `PRIVATE_FAVORITES_ENABLED`. Deliberately a console call and not a control:
 * turning it on before the other apps carry `content` is a data-loss decision,
 * not a preference.
 */
export function installPrivateFavoritesHook() {
  if (typeof window === 'undefined') return;
  (window as unknown as Record<string, unknown>).bmbEnablePrivateFavorites = (on = true) => {
    storage.favPrivateOptIn.set(on);
    return on
      ? 'private favorites enabled on this device — other apps may still erase them'
      : 'private favorites disabled on this device';
  };
}
