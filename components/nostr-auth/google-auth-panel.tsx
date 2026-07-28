'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { Avatar } from '@/components/avatar';
import {
  loginWithLocalKey,
  fetchProfile,
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
import { provisionSparkFromKey } from './provision-spark';

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

  // Google session state for the current attempt. Held in refs, never
  // persisted: the access token is short-lived and the sub is only salt.
  const subRef = useRef<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const blobsRef = useRef<string[]>([]);

  const fail = useCallback((e: unknown, fallback: string) => {
    setStage({ s: 'error', message: getErrorMessage(e, fallback) });
  }, []);

  /** Step 1: Google consent, then pull down every blob this account holds.
   *  Decryption can't happen yet — we don't have the PIN. */
  const begin = useCallback(async () => {
    setPin('');
    setConfirm('');
    setPinErr(null);
    setAccounts([]);
    setSelected(null);
    setStage({ s: 'signingIn' });
    try {
      const { sub, accessToken } = await signInWithGoogle();
      subRef.current = sub;
      tokenRef.current = accessToken;

      setStage({ s: 'checkingDrive' });
      let files;
      try {
        files = await listBackups(accessToken);
      } catch (e) {
        if (!(e instanceof DriveAuthExpiredError)) throw e;
        // Never let an expired token read as "no backups" — that would walk a
        // returning user into creating a second identity and orphan their real
        // one.
        const fresh = await refreshAccessToken();
        tokenRef.current = fresh;
        files = await listBackups(fresh);
      }

      const token = tokenRef.current;
      blobsRef.current = (
        await Promise.all(
          files.map((f) => downloadBackup(token, f.id).catch(() => null)),
        )
      ).filter((b): b is string => b !== null);

      setStage({ s: blobsRef.current.length > 0 ? 'choose' : 'setupPin' });
    } catch (e) {
      fail(e, 'Google sign-in failed');
    }
  }, [fail]);

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
      // Best-effort: a failed wallet provision must not block sign-in.
      provisionSparkFromKey(skHex, id).catch(() => { /* wallet stays unconfigured */ });
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
    try {
      const skHex = bytesToHex(generateSecretKey());
      const key = await deriveBackupKey(sub, pin);
      const payload = encryptNsec(skHex, key);
      try {
        await uploadBackup(token, payload);
      } catch (e) {
        if (!(e instanceof DriveAuthExpiredError)) throw e;
        const fresh = await refreshAccessToken();
        tokenRef.current = fresh;
        await uploadBackup(fresh, payload);
      }
      await finish(skHex, true);
    } catch (e) {
      fail(e, 'Could not create your account');
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
        setPinErr('Incorrect PIN');
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
          <button
            onClick={() => setStage({ s: 'setupPin' })}
            className="btn-ghost w-full text-[11px]"
          >
            Create another account
          </button>
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
          <button
            onClick={() => {
              setAccounts([]);
              setPin('');
              setStage({ s: 'setupPin' });
            }}
            className="btn-ghost w-full text-[11px]"
          >
            Create another account
          </button>
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
          <button
            onClick={() => {
              setPin('');
              setPinErr(null);
              setStage({ s: 'setupPin' });
            }}
            className="btn-ghost w-full text-[11px]"
          >
            Create another account
          </button>
        </>
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
