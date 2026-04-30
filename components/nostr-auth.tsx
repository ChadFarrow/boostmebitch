'use client';
import { useEffect, useRef, useState } from 'react';
import { nip19 } from 'nostr-tools';
import {
  loginWithExtension,
  shortNpub,
  fetchProfile,
  fetchRelayList,
  fetchEncryptedMnemonic,
  hydrateFavorites,
  type NostrIdentity,
} from '@/lib/nostr';
import { hasSpark, sparkInitFromMnemonic } from '@/lib/v4v/spark';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { getErrorMessage } from '@/lib/util';
import { SparkWallet } from './spark-wallet';
import { NwcWallet } from './nwc-wallet';
import { WeblnWallet } from './webln-wallet';

// Module-level promise cache keyed by pubkey, so the same loadProfile call
// isn't fired twice when React remounts the component (StrictMode in dev,
// Fast Refresh on every save).
const pendingProfileLoad = new Map<string, Promise<void>>();

export function NostrAuth() {
  const identity = useApp((s) => s.identity);
  const setIdentity = useApp((s) => s.setIdentity);
  const setFavorites = useApp((s) => s.setFavorites);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function loadProfile(id: NostrIdentity) {
    // Dedupe across remounts (StrictMode runs effects twice in dev; Fast
    // Refresh re-runs them on every save). Without this, a returning user
    // re-fetches profile/relay-list/favorites/wallet every keystroke.
    const existing = pendingProfileLoad.get(id.pubkey);
    if (existing) return existing;
    const p = doLoadProfile(id);
    pendingProfileLoad.set(id.pubkey, p);
    return p;
  }

  async function doLoadProfile(id: NostrIdentity) {
    try {
      const [profile, relayList] = await Promise.all([
        fetchProfile(id.pubkey),
        fetchRelayList(id.pubkey),
      ]);
      const enriched: NostrIdentity = { ...id };
      if (profile) enriched.profile = profile;
      if (relayList?.write?.length) enriched.writeRelays = relayList.write;
      setIdentity(enriched);
      await hydrateFavorites(enriched);
      // Best-effort Spark wallet restore. Silent on missing NIP-44 / no
      // backup yet — user can hit "Create wallet" manually in the account
      // menu (top-right).
      if (!hasSpark()) {
        fetchEncryptedMnemonic(enriched)
          .then((mnemonic) => {
            if (mnemonic) return sparkInitFromMnemonic({ mnemonic, ownerPubkey: enriched.pubkey });
          })
          .catch(() => {});
      }
    } catch { /* ignore — keep bare identity */ }
  }

  useEffect(() => {
    // Fast-path: hydrate the header from localStorage so the avatar slot
    // doesn't read "Sign in with Nostr" while we wait on the signer +
    // profile/relay-list relays. Decoding npub → hex pubkey is sync and
    // sufficient for display + read-only relay queries; the actual signer
    // (window.nostr.signEvent / nip44) is only needed when an action
    // requires signing, and we lazy-call it then.
    if (identity || typeof window === 'undefined') return;
    const stored = storage.npub.get();
    if (!stored) return;
    let pubkey: string;
    try {
      const decoded = nip19.decode(stored);
      if (decoded.type !== 'npub') return;
      pubkey = decoded.data;
    } catch { return; }
    const bare: NostrIdentity = { pubkey, npub: stored };
    setIdentity(bare);
    loadProfile(bare);
  }, [identity, setIdentity]);

  async function signin() {
    setBusy(true); setErr(null);
    try {
      const id = await loginWithExtension();
      setIdentity(id);
      storage.npub.set(id.npub);
      loadProfile(id);
    } catch (e) {
      setErr(getErrorMessage(e, 'sign-in failed'));
    } finally { setBusy(false); }
  }

  function signout() {
    setIdentity(null);
    setFavorites({});
    storage.npub.clear();
  }

  if (identity) {
    return <AccountMenu identity={identity} onSignOut={signout} />;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button onClick={signin} disabled={busy} className="btn-ghost">
        <span className="text-nostr">◆</span>
        {busy ? 'Connecting…' : 'Sign in with Nostr'}
      </button>
      {err && <span className="text-[10px] text-nostr/80 max-w-[260px] text-right">{err}</span>}
    </div>
  );
}

function AccountMenu({
  identity,
  onSignOut,
}: {
  identity: NostrIdentity;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Dismiss on click-outside / Escape so the menu doesn't trap focus.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const name = identity.profile?.display_name || identity.profile?.name;
  const pic = identity.profile?.picture;

  return (
    <div ref={wrapperRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="btn-ghost group flex items-center gap-2"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {pic ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={pic}
            alt=""
            className="w-5 h-5 rounded-full object-cover border border-nostr/40 flex-shrink-0"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
        ) : (
          <span className="text-nostr">◆</span>
        )}
        <span className="hidden sm:inline truncate max-w-[160px]">
          {name || shortNpub(identity.npub, 6)}
        </span>
        <span className="opacity-40 group-hover:opacity-100 transition text-[10px]">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-2 w-[min(360px,calc(100vw-2rem))] card bg-ink p-4 z-30 shadow-xl"
        >
          <div className="border-b border-bone/15 pb-3 mb-3">
            <div className="text-sm">{name || 'Anon'}</div>
            <div className="text-[10px] text-muted truncate">{shortNpub(identity.npub, 8)}</div>
          </div>

          <div className="text-[11px] uppercase tracking-widest text-muted">
            Connect wallet
          </div>

          <div className="mt-2 text-[11px] uppercase tracking-widest text-bone/60">NWC</div>
          <NwcWallet />

          <div className="mt-4 text-[11px] uppercase tracking-widest text-bone/60">Spark</div>
          <SparkWallet />

          <div className="mt-4 text-[11px] uppercase tracking-widest text-bone/60">WebLN</div>
          <WeblnWallet />

          <div className="border-t border-bone/15 mt-4 pt-3">
            <button
              onClick={() => { onSignOut(); setOpen(false); }}
              className="text-[11px] text-muted hover:text-nostr"
            >
              sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
