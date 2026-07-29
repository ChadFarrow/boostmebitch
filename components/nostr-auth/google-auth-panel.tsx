'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { Avatar } from '@/components/avatar';
import {
  loginWithLocalKey,
  fetchProfile,
  isKeyEphemeral,
  shortNpub,
  type NostrIdentity,
  type ProfileMetadata,
} from '@/lib/nostr';
import {
  deriveBackupKey,
  decryptNsec,
  encryptNsec,
  isValidPin,
  PIN_MAX_LENGTH,
  PIN_MIN_LENGTH,
} from '@/lib/nostr/backup-crypto';
import {
  DriveAuthExpiredError,
  downloadBackup,
  listBackups,
  uploadBackup,
} from '@/lib/nostr/drive-backup';
import { refreshAccessToken, signInWithGoogle } from '@/lib/nostr/google-auth';
import { getErrorMessage } from '@/lib/util';
import { buildGeneratedProfile } from '@/lib/nostr/generated-profile';
import { provisionSparkFromKey } from './provision-spark';
import { provisionProfileFromKey } from './provision-profile';

// The Google onboarding state machine, ported from Wisp's GoogleAuthScreen.kt.
//
// Google is a blob store, not an identity provider: the key is generated
// locally at random, and only its PIN-encrypted form ever reaches Drive. The
// PIN is the only secret in the construction, which is why losing it is
// unrecoverable and the UI has to say so plainly.

type Stage =
  | { s: 'idle' }
  | { s: 'signingIn' }
  | { s: 'checkingDrive' }
  | { s: 'setupPin' }
  | { s: 'confirmPin' }
  | { s: 'choose' }
  | { s: 'enterPin' }
  | { s: 'working' }
  | { s: 'ephemeral' }
  | { s: 'error'; message: string };

interface FoundAccount {
  skHex: string;
  pubkey: string;
  npub: string;
  profile?: ProfileMetadata | null;
}

export function GoogleAuthPanel({
  onSuccess,
  onCancel,
}: {
  onSuccess: (id: NostrIdentity) => void;
  onCancel: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ s: 'idle' });
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<FoundAccount[]>([]);
  const [selected, setSelected] = useState<FoundAccount | null>(null);
  // Backups Drive listed but wouldn't hand over. Load-bearing: while this is
  // non-zero we can't tell "wrong PIN" from "the matching blob is one we
  // couldn't read", so it gates both the error copy and the create path.
  const [missed, setMissed] = useState(0);

  // Google session state for the current attempt. Held in refs, never
  // persisted: the access token is short-lived and the sub is only salt.
  const subRef = useRef<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const blobsRef = useRef<string[]>([]);
  const pendingIdRef = useRef<NostrIdentity | null>(null);
  // One in-flight refresh at a time. Without this, a token that expires between
  // list and download makes every parallel downloadBackup 401 at once, and each
  // one independently asks GIS for a token — N popups, N-1 of them blocked.
  // (Only matters because the downloads are parallel.)
  const refreshingRef = useRef<Promise<string> | null>(null);

  const fail = useCallback((e: unknown, fallback: string) => {
    setStage({ s: 'error', message: getErrorMessage(e, fallback) });
  }, []);

  /** Run a Drive call with the current token, refreshing once on a 401. Every
   *  Drive call goes through this: an expired token that reads as "no backups"
   *  is what walks a returning user into creating a second identity. */
  const withDrive = useCallback(async <T,>(fn: (token: string) => Promise<T>): Promise<T> => {
    const token = tokenRef.current;
    if (!token) throw new Error('Google session expired. Try again.');
    try {
      return await fn(token);
    } catch (e) {
      if (!(e instanceof DriveAuthExpiredError)) throw e;
      if (!refreshingRef.current) {
        const p = refreshAccessToken();
        refreshingRef.current = p;
        // Clear on success only. A REJECTION stays cached for the rest of this
        // attempt: a refresh that failed (blocked popup, revoked grant) will
        // fail identically for every other caller, and clearing it lets the
        // next one start its own — which is another popup. Parallel downloads
        // don't 401 at the same instant, so a `finally` here staggers into a
        // popup per caller and Firefox reports "Opening multiple popups was
        // blocked due to lack of user activation". begin() resets it.
        //
        // The identity check matters: begin() nulls the ref, so a slow refresh
        // from an ABANDONED attempt could otherwise resolve later and clear a
        // still-pending refresh belonging to the current one — reopening the
        // multiple-popup hole this is here to close.
        p.then(
          () => { if (refreshingRef.current === p) refreshingRef.current = null; },
          () => { /* keep the rejection cached — see above */ },
        );
      }
      const fresh = await refreshingRef.current;
      tokenRef.current = fresh;
      return fn(fresh);
    }
  }, []);

  /** Step 1: Google consent, then pull down every blob this account holds.
   *  Decryption can't happen yet — we don't have the PIN. */
  const begin = useCallback(async () => {
    setPin('');
    setConfirm('');
    setPinErr(null);
    setAccounts([]);
    setSelected(null);
    blobsRef.current = [];
    refreshingRef.current = null; // a new attempt gets a fresh shot at refreshing
    setMissed(0);
    setStage({ s: 'signingIn' });
    try {
      const { sub, accessToken } = await signInWithGoogle();
      subRef.current = sub;
      tokenRef.current = accessToken;

      setStage({ s: 'checkingDrive' });
      const files = await withDrive(listBackups);
      const settled = await Promise.all(
        files.map((f) =>
          withDrive((t) => downloadBackup(t, f.id)).then<string | null, null>(
            (blob) => blob,
            () => null,
          ),
        ),
      );
      const blobs = settled.filter((b): b is string => b !== null);
      blobsRef.current = blobs;
      setMissed(files.length - blobs.length);

      // Three outcomes, and only the first may ever reach setupPin.
      if (files.length === 0) {
        setStage({ s: 'setupPin' }); // genuinely new to this Google account
      } else if (blobs.length === 0) {
        // Backups exist and not one of them came back — a token that died
        // between list and download, or Drive 5xx. Falling through to setupPin
        // here is precisely how a returning user mints a second identity and
        // orphans their real one, so this is a hard stop with no create path.
        setStage({
          s: 'error',
          message:
            "This Google account has a saved account, but Drive wouldn't hand it over. " +
            'Check your connection and try again — creating a new one now would leave the old one behind.',
        });
      } else {
        setStage({ s: 'choose' }); // may be partial; `missed` gates the create path
      }
    } catch (e) {
      fail(e, 'Google sign-in failed');
    }
  }, [fail, withDrive]);

  // Kick off on mount — the user already tapped "Continue with Google", and
  // running inside that gesture's transient activation is what keeps the
  // consent popup from being blocked. (Retry is a direct click, so a blocked
  // first attempt is always recoverable.)
  //
  // The ref guard is for StrictMode's mount → unmount → mount cycle in dev,
  // which would otherwise open two Google popups back to back.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    begin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Shared tail: install the signer, provision a wallet for brand-new keys,
   *  hand the identity back to <NostrAuth>. */
  async function finish(skHex: string, isNewAccount: boolean) {
    const id = await loginWithLocalKey(skHex);
    // The `bmb:signer` sentinel is written by <NostrAuth>'s completeSignIn,
    // which onSuccess feeds — don't duplicate it here.
    if (isNewAccount) {
      // Best-effort: a failed wallet provision must not block sign-in — but it
      // must not vanish either. Swallowing this outright makes "no wallet" look
      // identical to "still initializing", with nothing anywhere to explain it.
      // Log the message, not the error object: this rejection can come from
      // SparkWallet.initialize({ mnemonicOrSeed }), and SDKs routinely echo
      // their options back in validation errors — which would put the wallet
      // seed in the console.
      provisionSparkFromKey(skHex, id).catch((e) => {
        console.warn('[spark] wallet provisioning failed:', getErrorMessage(e, 'unknown error'));
      });
      // Attach the generated profile to the identity synchronously, before
      // onSuccess hands it to completeSignIn. provisionProfileFromKey below
      // is async (it awaits a signEvent + relay-publish round-trip) and can't
      // land before then, but <AccountMenu> renders from identity.profile —
      // never from storage.profile, which only the *next* page load's mount
      // fast-path reads. Without this the header shows the bare npub for the
      // whole signup session even though the kind:0 is on its way.
      id.profile = buildGeneratedProfile(id.pubkey);
      // Same contract as the wallet: new-account only, best-effort, and the
      // failure is logged as a message rather than an object.
      provisionProfileFromKey(id).catch((e) => {
        console.warn('[profile] generated profile publish failed:', getErrorMessage(e, 'unknown error'));
      });
    }
    // putKey fell back to memory-only (private mode, partitioned storage): this
    // session works, the next one doesn't. Say so before handing off rather
    // than letting the user discover it as a silent sign-out on reload. Not
    // fatal — the blob is in Drive, so Google + PIN gets them back.
    if (isKeyEphemeral()) {
      pendingIdRef.current = id;
      setStage({ s: 'ephemeral' });
      return;
    }
    onSuccess(id);
  }

  /** New account: mint a random key, back it up under the PIN, sign in. */
  async function createAccount() {
    const sub = subRef.current;
    const token = tokenRef.current;
    if (!sub || !token) {
      setStage({ s: 'error', message: 'Google session expired. Try again.' });
      return;
    }
    setStage({ s: 'working' });
    let uploaded = false;
    try {
      const skHex = bytesToHex(generateSecretKey());
      const key = await deriveBackupKey(sub, pin);
      const payload = encryptNsec(skHex, key);
      await withDrive((t) => uploadBackup(t, payload));
      uploaded = true;
      await finish(skHex, true);
    } catch (e) {
      // Once the upload lands the account exists, even though sign-in didn't
      // finish. Retry re-runs begin(), which will now FIND that blob — so point
      // the user at the PIN prompt instead of letting them mint a second key.
      // (Set the stage directly rather than via fail(), whose getErrorMessage
      // would let the underlying error win over this copy.)
      if (uploaded) {
        setStage({
          s: 'error',
          message:
            "Your account was saved, but signing in didn't finish. " +
            'Tap Retry and enter the PIN you just set.',
        });
      } else {
        fail(e, 'Could not create your account');
      }
    }
  }

  /** Returning user: try the PIN against every blob, dedupe by npub. */
  async function unlock() {
    const sub = subRef.current;
    if (!sub) {
      setStage({ s: 'error', message: 'Google session expired. Try again.' });
      return;
    }
    setPinErr(null);
    setStage({ s: 'working' });
    try {
      const key = await deriveBackupKey(sub, pin);
      const seen = new Set<string>();
      const found: FoundAccount[] = [];
      for (const blob of blobsRef.current) {
        let skHex: string;
        try {
          // A failure here means the blob belongs to a different PIN — not an
          // error, just someone else's account on a shared Google login.
          skHex = decryptNsec(blob, key);
        } catch {
          continue;
        }
        const pubkey = getPublicKey(hexToBytes(skHex));
        if (seen.has(pubkey)) continue;
        seen.add(pubkey);
        found.push({ skHex, pubkey, npub: nip19.npubEncode(pubkey) });
      }

      if (found.length === 0) {
        setPinErr(
          missed > 0
            // The blob that matches this PIN may be one of the ones that failed
            // to download, so "Incorrect PIN" would be a claim we can't tell
            // apart from the truth.
            ? `That PIN didn't match the ${blobsRef.current.length} backup(s) we could read, and ${missed} more couldn't be downloaded. Tap "Retry downloads", then try again.`
            : 'Incorrect PIN',
        );
        setStage({ s: 'enterPin' });
        return;
      }
      if (found.length === 1) {
        await finish(found[0].skHex, false);
        return;
      }
      setAccounts(found);
      setStage({ s: 'choose' });
      // Names make the picker usable; a failed lookup just leaves the npub.
      found.forEach((a) => {
        fetchProfile(a.pubkey)
          .then((profile) => {
            setAccounts((prev) =>
              prev.map((x) => (x.pubkey === a.pubkey ? { ...x, profile } : x)),
            );
          })
          .catch(() => { /* npub is a fine label */ });
      });
    } catch (e) {
      fail(e, 'Could not unlock your backup');
    }
  }

  function submitSetupPin() {
    if (!isValidPin(pin)) return;
    setPinErr(null);
    setStage({ s: 'confirmPin' });
  }

  function submitConfirmPin() {
    if (confirm !== pin) {
      setPinErr("PIN doesn't match");
      return;
    }
    setPinErr(null);
    createAccount();
  }

  /** Every non-destructive stage needs a way out. <SignInModal> collapses the
   *  tab strip while this panel is mounted, so without this a user who tapped
   *  "Continue with Google" by mistake can only escape by closing the whole
   *  modal. */
  function goBack() {
    if (stage.s === 'confirmPin') {
      setConfirm('');
      setPinErr(null);
      setStage({ s: 'setupPin' });
      return;
    }
    // setupPin/enterPin reached from a picker fall back to it; otherwise
    // leaving the panel is what restores the tab strip.
    if ((stage.s === 'setupPin' || stage.s === 'enterPin') && blobsRef.current.length > 0) {
      setPin('');
      setPinErr(null);
      setStage({ s: 'choose' });
      return;
    }
    onCancel();
  }

  // `working` is excluded on purpose: an upload may be in flight, and
  // abandoning it is how you get a blob in Drive with no local key.
  // signingIn/checkingDrive are safe — onCancel unmounts the panel, so a late
  // resolve is a no-op. `error` and `ephemeral` carry their own buttons.
  const canGoBack =
    stage.s !== 'working' && stage.s !== 'error' && stage.s !== 'ephemeral';
  // Mirrors goBack()'s branches exactly, so the label can't promise one
  // destination while the handler goes to another.
  const backToPicker =
    stage.s === 'confirmPin' ||
    (blobsRef.current.length > 0 && (stage.s === 'setupPin' || stage.s === 'enterPin'));

  /** Suppressed while any backup failed to download: creating an account from
   *  this state is the orphan path. Retrying the downloads is the fix. */
  function createAnotherButton() {
    if (missed > 0) {
      return (
        <>
          <button onClick={begin} className="btn-ghost w-full text-[11px]">
            Retry downloads
          </button>
          <p className="text-[11px] text-nostr/80">
            {missed} saved account(s) couldn&apos;t be downloaded. Retry before creating a
            new one — otherwise you may end up with a duplicate you can&apos;t find later.
          </p>
        </>
      );
    }
    return (
      <button
        onClick={() => {
          // Deliberately keeps `accounts`. Clearing it made goBack()'s
          // "← Back" land on the picker's empty branch ("Welcome back / Enter
          // your PIN") instead of the list the label promises — costing the
          // user another PIN entry and another Argon2id derivation to get
          // back what they already had.
          setPin('');
          setPinErr(null);
          setStage({ s: 'setupPin' });
        }}
        className="btn-ghost w-full text-[11px]"
      >
        Create another account
      </button>
    );
  }

  const busyLabel =
    stage.s === 'signingIn'
      ? 'Signing in…'
      : stage.s === 'checkingDrive'
        ? 'Checking your backups…'
        : stage.s === 'working'
          ? 'Working…'
          : null;

  return (
    <div className="flex flex-col gap-3">
      {busyLabel && (
        <div className="flex items-center gap-2 text-xs text-muted py-4">
          <span className="animate-bolt">◆</span>
          {busyLabel}
        </div>
      )}

      {stage.s === 'error' && (
        <>
          <span className="text-[11px] text-nostr/80">{stage.message}</span>
          <div className="flex gap-2">
            <button onClick={begin} className="btn-bolt text-[11px] py-1 px-3">
              Retry
            </button>
            <button onClick={onCancel} className="btn-ghost text-[11px] py-1 px-3">
              Cancel
            </button>
          </div>
        </>
      )}

      {stage.s === 'setupPin' && (
        <>
          <h4 className="font-display text-sm">Set up your PIN</h4>
          <p className="text-[11px] text-muted">
            Your account key is encrypted with this PIN before it&apos;s saved to
            your Google Drive. Google never sees the key itself.
          </p>
          <p className="text-[11px] text-nostr">
            Your PIN cannot be recovered. If you forget it, this account is gone
            for good.
          </p>
          <PinField value={pin} onChange={setPin} onSubmit={submitSetupPin} autoFocus />
          <button
            onClick={submitSetupPin}
            disabled={!isValidPin(pin)}
            className="btn-bolt w-full disabled:opacity-40"
          >
            Continue
          </button>
        </>
      )}

      {stage.s === 'confirmPin' && (
        <>
          <h4 className="font-display text-sm">Confirm your PIN</h4>
          <p className="text-[11px] text-muted">Enter it once more to be sure.</p>
          <PinField value={confirm} onChange={setConfirm} onSubmit={submitConfirmPin} autoFocus />
          {pinErr && <span className="text-[11px] text-nostr/80">{pinErr}</span>}
          <button
            onClick={submitConfirmPin}
            disabled={!isValidPin(confirm)}
            className="btn-bolt w-full disabled:opacity-40"
          >
            Create account
          </button>
        </>
      )}

      {stage.s === 'choose' && accounts.length === 0 && (
        <>
          <h4 className="font-display text-sm">Welcome back</h4>
          <p className="text-[11px] text-muted">
            Enter your PIN to unlock the account saved to this Google account.
          </p>
          <button onClick={() => setStage({ s: 'enterPin' })} className="btn-bolt w-full">
            Enter PIN
          </button>
          {createAnotherButton()}
        </>
      )}

      {stage.s === 'choose' && accounts.length > 0 && (
        <>
          <h4 className="font-display text-sm">Choose an account</h4>
          <ul className="flex flex-col gap-1 max-h-72 overflow-y-auto">
            {accounts.map((a) => (
              <li key={a.pubkey}>
                <button
                  onClick={() => {
                    setSelected(a);
                    // Move to `working` as well as disabling the siblings.
                    // Staying on `choose` left BOTH the back button and
                    // "Create another account" live while finish() ran: Back
                    // unmounted the panel while the sign-in completed anyway
                    // (signing the user in with the button they pressed to
                    // escape), and Create minted a second key mid-flight —
                    // the orphaned-identity case this whole flow guards
                    // against, reached from the picker.
                    setStage({ s: 'working' });
                    finish(a.skHex, false).catch((e) => fail(e, 'Sign-in failed'));
                  }}
                  disabled={selected !== null}
                  className="w-full flex items-center gap-2 p-2 border border-bone/15 hover:border-bone/40 transition text-left disabled:opacity-40"
                >
                  <Avatar
                    pubkey={a.pubkey}
                    picture={a.profile?.picture}
                    name={a.profile?.display_name || a.profile?.name}
                    className="w-8 h-8 rounded-full shrink-0"
                  />
                  <span className="text-xs truncate">
                    {a.profile?.display_name || a.profile?.name || shortNpub(a.npub)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {createAnotherButton()}
        </>
      )}

      {stage.s === 'enterPin' && (
        <>
          <h4 className="font-display text-sm">Enter your PIN</h4>
          <p className="text-[11px] text-muted">The PIN you set when you created this account.</p>
          <PinField value={pin} onChange={setPin} onSubmit={unlock} autoFocus />
          {pinErr && <span className="text-[11px] text-nostr/80">{pinErr}</span>}
          <button
            onClick={unlock}
            disabled={!isValidPin(pin)}
            className="btn-bolt w-full disabled:opacity-40"
          >
            Unlock
          </button>
          {createAnotherButton()}
        </>
      )}

      {stage.s === 'ephemeral' && (
        <>
          <h4 className="font-display text-sm">You&apos;re in — one thing first</h4>
          <p className="text-[11px] text-nostr">
            This browser won&apos;t let us save your key, so you&apos;ll be signed out
            when you reload.
          </p>
          <p className="text-[11px] text-muted">
            Sign in with Google and the same PIN to come back — your backup is safe
            in Drive. Leaving private browsing will make it stick.
          </p>
          <button
            onClick={() => pendingIdRef.current && onSuccess(pendingIdRef.current)}
            className="btn-bolt w-full"
          >
            Continue
          </button>
        </>
      )}

      {canGoBack && (
        <button onClick={goBack} className="btn-ghost w-full text-[11px]">
          {backToPicker ? '← Back' : '← Other sign-in options'}
        </button>
      )}
    </div>
  );
}

function PinField({
  value,
  onChange,
  onSubmit,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  autoFocus?: boolean;
}) {
  return (
    <input
      type="password"
      inputMode="numeric"
      autoComplete="one-time-code"
      autoFocus={autoFocus}
      value={value}
      maxLength={PIN_MAX_LENGTH}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSubmit();
      }}
      placeholder={`${PIN_MIN_LENGTH}–${PIN_MAX_LENGTH} digits`}
      className="input w-full tracking-[0.4em] text-center"
    />
  );
}
