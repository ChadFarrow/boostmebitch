'use client';
import { useEffect, useRef, useState } from 'react';
import { nip19 } from 'nostr-tools';
import {
  loginWithExtension,
  shortNpub,
  fetchProfile,
  fetchRelayList,
  fetchFavoriteGuids,
  fetchEncryptedMnemonic,
  resolvePublishRelays,
  schedulePublishFavorites,
  type NostrIdentity,
} from '@/lib/nostr';
import { hasSpark, sparkInitFromMnemonic } from '@/lib/v4v/spark';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { getErrorMessage } from '@/lib/util';
import { piMaybeUp, resolvePodcastByGuid } from '@/lib/podcast-meta';
import type { FavoritePodcast, Podcast } from '@/lib/types';
import { SparkWallet } from './spark-wallet';
import { NwcWallet } from './nwc-wallet';
import { WeblnWallet } from './webln-wallet';

// Module-level promise cache keyed by pubkey, so the same loadProfile call
// isn't fired twice when React remounts the component (StrictMode in dev,
// Fast Refresh on every save).
const pendingProfileLoad = new Map<string, Promise<void>>();

function favoriteFromPodcast(p: Podcast): FavoritePodcast | null {
  if (!p?.podcastGuid) return null;
  return {
    id: p.id,
    podcastGuid: p.podcastGuid,
    title: p.title,
    author: p.author,
    image: p.image,
    url: p.url,
    addedAt: Date.now(),
  };
}

async function resolveGuidToFavorite(guid: string): Promise<FavoritePodcast | null> {
  const podcast = await resolvePodcastByGuid(guid);
  return podcast ? favoriteFromPodcast(podcast) : null;
}

/**
 * Reconcile the user's local favorites cache with their NIP-51 kind:30003
 * event. Last-write-wins on event.created_at vs the newest cache.addedAt.
 * Resolves unknown guids via /api/by-guid in the background.
 */
async function hydrateFavorites(identity: NostrIdentity): Promise<void> {
  const setFavorites = useApp.getState().setFavorites;
  const cached = storage.favorites.get(identity.npub);
  const cachedGuids = Object.keys(cached);
  const favEvent = await fetchFavoriteGuids(identity.pubkey);

  if (!favEvent) {
    // No Nostr event yet; if we have local favorites, push them up.
    const local = useApp.getState().favorites;
    if (Object.keys(local).length > 0) {
      setFavorites(local);
      schedulePublishFavorites(
        () => Object.keys(useApp.getState().favorites),
        resolvePublishRelays(identity),
      );
    }
    return;
  }

  if (favEvent.droppedGuids.length > 0) {
    // Old buggy versions of this app (or another client reusing the d-tag)
    // wrote non-UUID values into the favorites event. They'd 404 against
    // PI, so we silently filter them. Log once so the user knows, and
    // expose a one-shot cleanup hook for permanent removal.
    if (typeof window !== 'undefined') {
      (window as any).bmbCleanFavorites = () => {
        const valid = Object.keys(useApp.getState().favorites);
        schedulePublishFavorites(() => valid, resolvePublishRelays(identity));
        return `republishing kind:30003 with ${valid.length} valid guids (debounced ~1.5s)`;
      };
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[favorites] dropped ${favEvent.droppedGuids.length} non-UUID entries from your kind:30003 event:`,
      favEvent.droppedGuids,
      '\nTo permanently remove them from relays, run:',
      '  bmbCleanFavorites()',
    );
  }

  // localStorage doesn't carry an event timestamp; the most recent `addedAt`
  // in the cache is a reasonable proxy.
  const localNewest = cachedGuids.reduce(
    (max, g) => Math.max(max, cached[g].addedAt ?? 0),
    0,
  );
  const nostrNewer = favEvent.updatedAt * 1000 >= localNewest;
  const targetGuids = nostrNewer ? favEvent.guids : cachedGuids;

  // Fill from cache first (cheap), then resolve unknown guids via PI.
  const next: Record<string, FavoritePodcast> = {};
  const unresolved: string[] = [];
  for (const guid of targetGuids) {
    if (cached[guid]) next[guid] = cached[guid];
    else unresolved.push(guid);
  }
  setFavorites(next);

  if (unresolved.length > 0) {
    // Probe sequentially with the first guid. If PI is dead (or already
    // tripped earlier this session), the breaker fires and we skip the
    // rest of the batch instead of opening 99 sockets in parallel that
    // are all going to 500.
    const firstFav = await resolveGuidToFavorite(unresolved[0]);
    const remaining = piMaybeUp() ? unresolved.slice(1) : [];
    const restFavs = await Promise.all(remaining.map(resolveGuidToFavorite));
    const merged = { ...useApp.getState().favorites };
    for (const fav of [firstFav, ...restFavs]) {
      if (fav) merged[fav.podcastGuid] = fav;
    }
    setFavorites(merged);
  }

  if (!nostrNewer && cachedGuids.length > 0) {
    schedulePublishFavorites(
      () => Object.keys(useApp.getState().favorites),
      resolvePublishRelays(identity),
    );
  }
}

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
