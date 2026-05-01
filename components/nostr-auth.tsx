'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { nip19 } from 'nostr-tools';
import {
  loginWithExtension,
  loginWithAmber,
  restoreAmberSigner,
  clearAmberSigner,
  shortNpub,
  fetchProfile,
  fetchRelayList,
  fetchEncryptedMnemonic,
  hydrateFavorites,
  hydrateMutes,
  unionMutedPubkeys,
  type NostrIdentity,
  type ProfileMetadata,
} from '@/lib/nostr';
import { getLatestPendingAmber, submitManualAmberResult } from '@/lib/nostr/amber';
import { hasSpark, sparkInitFromMnemonic } from '@/lib/v4v/spark';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { getErrorMessage } from '@/lib/util';
import { Avatar } from './avatar';
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
  const setMutedPubkeys = useApp((s) => s.setMutedPubkeys);
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
    // Fire all four background refreshes in parallel. Each has a 4s
    // QUERY_MAX_WAIT_MS bound, so total wall time is ~4s, not the 12-16s
    // serialized chain it used to be. Mute hydration depends on the bare
    // identity (npub + pubkey), favorites needs the resolved publish-relay
    // set ideally — but resolvePublishRelays falls back to DEFAULT_RELAYS
    // when writeRelays haven't landed yet, so the rare debounced republish
    // tolerates the race.
    const profilePromise = fetchProfile(id.pubkey).catch(() => null);
    const relayListPromise = fetchRelayList(id.pubkey).catch(() => null);
    const favoritesPromise = hydrateFavorites(id).catch(() => {});
    const mutesPromise = hydrateMutes(id).catch(() => {});
    const sparkPromise = !hasSpark()
      ? fetchEncryptedMnemonic(id)
          .then((mnemonic) => {
            if (mnemonic) return sparkInitFromMnemonic({ mnemonic, ownerPubkey: id.pubkey });
          })
          .catch(() => {})
      : Promise.resolve();

    // Apply profile + relay list as soon as both land. Both feed the
    // identity object, so we wait for them together to avoid two re-renders.
    const [profile, relayList] = await Promise.all([profilePromise, relayListPromise]);
    const enriched: NostrIdentity = { ...id };
    if (profile) enriched.profile = profile;
    if (relayList?.write?.length) enriched.writeRelays = relayList.write;
    if (profile || relayList?.write?.length) setIdentity(enriched);

    // Wait for the rest so the dedup map's resolved promise doesn't release
    // before everything settles (in_flight guards re-entrant remounts).
    await Promise.allSettled([favoritesPromise, mutesPromise, sparkPromise]);
  }

  useEffect(() => {
    // Fast-path: hydrate everything we have cached locally before any relay
    // round-trip so the page paints immediately on reload —
    //   - identity (pubkey/npub) decoded from `bmb:npub`
    //   - kind:0 profile (display name, picture) from storage.profile
    //   - favorites set from storage.favorites
    //   - mute list from storage.muted
    // The signer (window.nostr.signEvent / nip44) isn't called here; it's
    // only needed when an action requires signing and we lazy-call it then.
    // `loadProfile` then runs in the background to refresh from relays.
    if (identity || typeof window === 'undefined') return;
    const stored = storage.npub.get();
    if (!stored) return;
    let pubkey: string;
    try {
      const decoded = nip19.decode(stored);
      if (decoded.type !== 'npub') return;
      pubkey = decoded.data;
    } catch { return; }
    // If the user signed in with Amber, reinstall the AmberSigner polyfill on
    // window.nostr before any signing operation runs. Synchronous; no popup.
    if (storage.signer.get() === 'amber') {
      restoreAmberSigner(pubkey);
    }
    const bare: NostrIdentity = { pubkey, npub: stored };
    const cachedProfile = storage.profile.get(pubkey);
    if (cachedProfile) bare.profile = cachedProfile;
    setIdentity(bare);
    const cachedFavorites = storage.favorites.get(stored);
    if (Object.keys(cachedFavorites).length > 0) setFavorites(cachedFavorites);
    const cachedMutes = storage.muted.get(stored);
    if (cachedMutes.publicPubkeys.length || cachedMutes.privatePubkeys.length) {
      setMutedPubkeys(unionMutedPubkeys({
        publicPubkeys: cachedMutes.publicPubkeys,
        publicOtherTags: cachedMutes.publicOtherTags,
        privatePubkeys: cachedMutes.privatePubkeys,
        privateOtherTags: cachedMutes.privateOtherTags,
        unreadablePrivateContent: cachedMutes.unreadablePrivateContent,
        updatedAt: cachedMutes.updatedAt,
      }));
    }
    loadProfile(bare);
  }, [identity, setIdentity, setFavorites, setMutedPubkeys]);

  // Single sign-in entry point. Routing rules:
  //   - If a NIP-07 extension is installed (window.nostr present), use it.
  //   - Else, fall through to Amber via NIP-55 deep links. Works on Android
  //     where Amber is installed; on desktop / iOS without Amber the popup
  //     shows an unknown-scheme error and the user gets the manual-paste
  //     affordance below the button.
  async function signin() {
    setBusy(true); setErr(null);
    try {
      const hasExtension = typeof window !== 'undefined' && !!window.nostr;
      let id: NostrIdentity;
      if (hasExtension) {
        id = await loginWithExtension();
        storage.signer.clear();
      } else {
        id = await loginWithAmber();
        storage.signer.set('amber');
      }
      setIdentity(id);
      storage.npub.set(id.npub);
      loadProfile(id);
    } catch (e) {
      setErr(getErrorMessage(e, 'sign-in failed'));
    } finally { setBusy(false); }
  }

  /** Manual-paste recovery for the case where Amber's callback URL opens in
   *  a different browser than the app (Brave vs Chrome) — neither
   *  BroadcastChannel nor postMessage cross that boundary. The user copies
   *  the result from Amber and pastes it here. */
  function submitManualPaste(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return false;
    const pending = getLatestPendingAmber();
    if (!pending) {
      setErr('No pending Amber request to attach this to.');
      return false;
    }
    return submitManualAmberResult(pending.id, trimmed);
  }

  function signout() {
    setIdentity(null);
    setFavorites({});
    setMutedPubkeys(new Set());
    storage.npub.clear();
    storage.signer.clear();
    clearAmberSigner();
  }

  if (identity) {
    return <AccountMenu identity={identity} onSignOut={signout} />;
  }

  // The button auto-routes: NIP-07 extension if present, otherwise Amber
  // via NIP-55 deep links. The manual-paste affordance only appears once
  // we've actually fallen through to the Amber path, where the cross-browser
  // / cross-tab callback can fail silently.
  return (
    <div className="flex flex-col items-end gap-1">
      <button onClick={signin} disabled={busy} className="btn-ghost">
        <span className="text-nostr">◆</span>
        {busy ? 'Connecting…' : 'Sign in with Nostr'}
      </button>
      {err && <span className="text-[10px] text-nostr/80 max-w-[260px] text-right">{err}</span>}
      {busy && <AmberManualPaste onSubmit={submitManualPaste} />}
    </div>
  );
}

// Manual-paste recovery for when Amber's callback URL doesn't reach back to
// the original tab — most commonly when Amber opens the callback in a
// different browser than the one running boostmebitch (e.g. Amber defaults
// to Brave but the app is in Chrome). Renders only while a sign-in is in
// flight; user pastes the pubkey/npub from the Amber-callback tab here.
function AmberManualPaste({ onSubmit }: { onSubmit: (value: string) => boolean }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-[10px] text-muted hover:text-nostr underline mt-1"
      >
        Amber didn&apos;t come back? Paste manually
      </button>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1 mt-1 max-w-[280px]">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Paste pubkey / npub from Amber"
        className="input text-[11px] w-full"
        rows={2}
      />
      <div className="flex items-center gap-2">
        <button
          onClick={() => setOpen(false)}
          className="text-[10px] text-muted hover:text-bone"
        >
          cancel
        </button>
        <button
          onClick={() => {
            const ok = onSubmit(value);
            if (!ok) setHint('Could not match a pending request.');
            else { setValue(''); setHint(null); }
          }}
          className="btn-ghost text-[10px] py-1 px-2"
        >
          submit
        </button>
      </div>
      {hint && <span className="text-[10px] text-nostr/80">{hint}</span>}
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

          <MutedAccountsSection />

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

// Muted accounts (NIP-51 kind:10000). Only renders when there's at least one
// muted pubkey so the menu stays compact for users who haven't used the
// feature. Profile names are best-effort from the kind:0 cache; an unresolved
// pubkey falls back to its short-npub.
function MutedAccountsSection() {
  const mutedPubkeys = useApp((s) => s.mutedPubkeys);
  const unmutePubkey = useApp((s) => s.unmutePubkey);
  const pubkeys = useMemo(() => Array.from(mutedPubkeys), [mutedPubkeys]);
  const [profiles, setProfiles] = useState<Record<string, ProfileMetadata | null>>({});

  // Fill from cache synchronously, then resolve any uncached pubkeys in the
  // background. Keeps the menu instant on open and lazy-fills missing names.
  useEffect(() => {
    if (pubkeys.length === 0) return;
    const next: Record<string, ProfileMetadata | null> = {};
    const unresolved: string[] = [];
    for (const pk of pubkeys) {
      const cached = storage.profile.get(pk);
      if (cached !== undefined) next[pk] = cached;
      else unresolved.push(pk);
    }
    setProfiles((prev) => ({ ...prev, ...next }));
    if (unresolved.length === 0) return;
    let cancelled = false;
    (async () => {
      const fetched = await Promise.all(
        unresolved.map((pk) =>
          fetchProfile(pk).then((p) => {
            if (p) storage.profile.set(pk, p);
            else storage.profile.setMiss(pk);
            return [pk, p] as const;
          }).catch(() => [pk, null] as const),
        ),
      );
      if (cancelled) return;
      setProfiles((prev) => {
        const merged = { ...prev };
        for (const [pk, p] of fetched) merged[pk] = p;
        return merged;
      });
    })();
    return () => { cancelled = true; };
  }, [pubkeys]);

  if (pubkeys.length === 0) return null;

  return (
    <div className="mt-4">
      <div className="text-[11px] uppercase tracking-widest text-bone/60 mb-2">
        Muted accounts ({pubkeys.length})
      </div>
      <ul className="space-y-1.5 max-h-48 overflow-y-auto">
        {pubkeys.map((pk) => {
          const profile = profiles[pk];
          const npub = (() => {
            try { return nip19.npubEncode(pk); } catch { return pk.slice(0, 12); }
          })();
          const name =
            profile?.display_name?.trim() ||
            profile?.name?.trim() ||
            shortNpub(npub, 6);
          return (
            <li key={pk} className="flex items-center gap-2 text-xs">
              <Avatar
                pubkey={pk}
                picture={profile?.picture}
                name={profile?.display_name || profile?.name}
                className="w-6 h-6 rounded-full border border-bone/20 flex-shrink-0 text-[10px]"
              />
              <span className="truncate flex-1" title={npub}>{name}</span>
              <button
                onClick={() => unmutePubkey(pk)}
                className="text-[10px] text-muted hover:text-nostr"
                title="Unmute this account"
              >
                unmute
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
