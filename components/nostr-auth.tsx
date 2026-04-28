'use client';
import { useEffect, useState } from 'react';
import {
  loginWithExtension,
  shortNpub,
  fetchProfile,
  fetchRelayList,
  fetchFavoriteGuids,
  resolvePublishRelays,
  schedulePublishFavorites,
  type NostrIdentity,
} from '@/lib/nostr';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { getErrorMessage } from '@/lib/util';
import type { FavoritePodcast, Podcast } from '@/lib/types';

async function resolveGuidToFavorite(guid: string): Promise<FavoritePodcast | null> {
  try {
    const r = await fetch(`/api/by-guid?guid=${encodeURIComponent(guid)}`);
    if (!r.ok) return null;
    const { podcast } = (await r.json()) as { podcast: Podcast };
    if (!podcast?.podcastGuid) return null;
    return {
      id: podcast.id,
      podcastGuid: podcast.podcastGuid,
      title: podcast.title,
      author: podcast.author,
      image: podcast.image,
      url: podcast.url,
      addedAt: Date.now(),
    };
  } catch {
    return null;
  }
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
    const resolved = await Promise.all(unresolved.map(resolveGuidToFavorite));
    const merged = { ...useApp.getState().favorites };
    for (const fav of resolved) {
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
    } catch { /* ignore — keep bare identity */ }
  }

  useEffect(() => {
    // Auto-sign-in if extension is already present and previously approved
    const stored = storage.npub.get();
    if (stored && !identity && typeof window !== 'undefined' && window.nostr) {
      loginWithExtension()
        .then((id) => { setIdentity(id); loadProfile(id); })
        .catch(() => {});
    }
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
    const name = identity.profile?.display_name || identity.profile?.name;
    const pic = identity.profile?.picture;
    return (
      <button onClick={signout} className="btn-ghost group flex items-center gap-2" title="Sign out">
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
        <span className="opacity-40 group-hover:opacity-100 transition">↗</span>
      </button>
    );
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
