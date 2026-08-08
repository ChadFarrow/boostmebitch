'use client';

// Show the user their own nsec, once, on request.
//
// This sits deliberately close to a standing prohibition, so read the boundary
// before editing. The rule in CLAUDE.md and docs/signers.md is about AMBIENT
// exposure: never assign a signer instance to `window.nostr` (TypeScript's
// `private sk` has no runtime effect, so the key becomes `window.nostr.sk` for
// every script on the origin, Google's injected GIS script included), and never
// add a module-level accessor that hands the key to any caller. Both still
// stand and neither is weakened here.
//
// What this does instead is a single user-initiated read into component state,
// rendered once, cleared on unmount. `getKey()` is already the sanctioned
// in-app read path — provision-spark.ts uses it to derive the wallet seed. The
// difference that matters is that a person asked, and nothing is left reachable
// afterwards.
//
// Why it has to exist: a Google-onboarded user's identity is only theirs if
// they can leave with it. Without this they can post from this origin and
// nowhere else, and a sign-out — which for a local signer wipes both the
// ciphertext and the wrap key — puts their whole identity behind a PIN they may
// not remember.

import { useEffect, useState } from 'react';
import { nip19 } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';
import { getKey } from '@/lib/nostr/local-key-store';
import { storage } from '@/lib/storage';
import { getErrorMessage } from '@/lib/util';

export function ExportKeySection() {
  const [nsec, setNsec] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Don't leave the key in a component that's merely hidden — a closed menu is
  // still mounted in plenty of layouts.
  useEffect(() => () => setNsec(null), []);

  // Only the local signer holds a key here. Amber and bunker sign remotely and
  // a NIP-07 extension owns its own key, so there is nothing for us to export
  // and the affordance would be a lie.
  if (storage.signer.get() !== 'local') return null;

  async function reveal() {
    setBusy(true);
    setErr(null);
    try {
      const skHex = await getKey();
      if (!skHex) throw new Error('No key stored on this device.');
      setNsec(nip19.nsecEncode(hexToBytes(skHex)));
    } catch (e) {
      setErr(getErrorMessage(e, 'could not read your key'));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!nsec) return;
    try {
      await navigator.clipboard.writeText(nsec);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setErr(getErrorMessage(e, 'could not copy'));
    }
  }

  return (
    <div className="border-t border-bone/15 mt-4 pt-3 space-y-2">
      <div className="text-[11px] uppercase tracking-widest text-muted">Your private key</div>

      {!nsec ? (
        <>
          <p className="text-[10px] text-muted leading-relaxed">
            Your nsec is this identity. Paste it into Damus, Amethyst, Primal or any
            other Nostr app to sign in as the same person. Anyone who has it is you —
            there is no way to change it.
          </p>
          <button onClick={() => void reveal()} disabled={busy} className="btn-ghost text-[10px] py-1 px-2">
            {busy ? 'Reading…' : 'Show my private key'}
          </button>
        </>
      ) : (
        <>
          <div className="text-[10px] text-bolt/90">
            Save this somewhere only you can reach. Don&apos;t paste it into a website.
          </div>
          <code className="block card p-3 text-[11px] leading-relaxed break-all select-all">
            {nsec}
          </code>
          <div className="flex gap-2">
            <button onClick={() => void copy()} className="btn-ghost text-[10px] py-1 px-2">
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
            <button onClick={() => setNsec(null)} className="btn-ghost text-[10px] py-1 px-2">
              Hide
            </button>
          </div>
          <p className="text-[10px] text-muted leading-relaxed">
            Your Lightning balance does not travel with this key — other apps derive
            their own wallet from it. Move sats out of the wallet here before relying
            on another app.
          </p>
        </>
      )}

      {err && <div className="text-[10px] text-nostr">{err}</div>}
    </div>
  );
}
