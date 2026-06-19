'use client';
import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { nip19 } from 'nostr-tools';
import {
  fetchLiveStreamByAddr,
  resolveStreamV4V,
  streamToEpisode,
  streamToPodcast,
  fetchProfile,
} from '@/lib/nostr';
import { useApp } from '@/lib/store';
import { NostrAuth } from '@/components/nostr-auth';

// Dedicated standalone page for a single Nostr live stream. Renders ONLY a
// loading / not-found state — the app-global <Player> (mounted in the root
// layout) shows the fullscreen player on top once we set `current`. No browse
// header or feeds mount here, so nothing main-page-related loads.
export default function StreamPage() {
  const params = useParams();
  const router = useRouter();
  const naddr = Array.isArray(params.naddr) ? params.naddr[0] : (params.naddr ?? '');
  const play = useApp((s) => s.play);
  const setPlayerExpanded = useApp((s) => s.setPlayerExpanded);
  const playerExpanded = useApp((s) => s.playerExpanded);

  const [status, setStatus] = useState<'loading' | 'open' | 'notfound'>('loading');
  const wasOpen = useRef(false);

  // Decode the naddr, fetch the stream, open the player. Enrich (host name +
  // boost value) in the background — episode.id is stable so the video/hls
  // don't restart.
  useEffect(() => {
    let decoded: ReturnType<typeof nip19.decode> | null = null;
    try { decoded = nip19.decode(naddr); } catch { /* malformed */ }
    if (!decoded || decoded.type !== 'naddr' || decoded.data.kind !== 30311) {
      setStatus('notfound');
      return;
    }
    const { pubkey, identifier, relays } = decoded.data;
    let cancelled = false;
    (async () => {
      const stream = await fetchLiveStreamByAddr(pubkey, identifier, relays ?? []);
      if (cancelled) return;
      if (!stream) { setStatus('notfound'); return; }
      play(streamToEpisode(stream, null), streamToPodcast(stream, null));
      setPlayerExpanded(true);
      setStatus('open');
      const [profile, value] = await Promise.all([
        fetchProfile(stream.pubkey).catch(() => null),
        resolveStreamV4V(stream).catch(() => null),
      ]);
      if (!cancelled && useApp.getState().current?.episode.guid === stream.id) {
        play(streamToEpisode(stream, value), streamToPodcast(stream, profile));
      }
    })();
    return () => { cancelled = true; };
  }, [naddr, play, setPlayerExpanded]);

  // When the user collapses the fullscreen player (← back / ✕), leave this
  // standalone page and go home — the stream keeps playing in the mini-bar
  // (the Player lives in the layout, so it survives the navigation).
  useEffect(() => {
    if (playerExpanded) wasOpen.current = true;
    else if (wasOpen.current) router.push('/');
  }, [playerExpanded, router]);

  return (
    <>
      {/* Mounts the Nostr session logic (identity hydration from the cached
          login + the sign-in modal) on this standalone route, where the home
          page and its <NostrAuth> aren't present — otherwise you can't be
          recognized as signed in, nor sign in, without backing out to home.
          The visible button is hidden; the fullscreen player's own "Sign in"
          button opens the (portal'd) modal, and the modal renders to <body>
          regardless of this wrapper's display:none. */}
      <div className="hidden">
        <NostrAuth />
      </div>
      <div
        className="fixed inset-0 z-40 bg-ink flex flex-col items-center justify-center gap-3 text-muted"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
      {status === 'notfound' ? (
        <>
          <span className="text-sm">Stream not found or ended.</span>
          <button onClick={() => router.push('/')} className="btn-ghost">← Go home</button>
        </>
      ) : (
        <>
          <span className="text-nostr animate-bolt text-3xl">●</span>
          <span className="text-sm font-mono uppercase tracking-widest">Loading live stream…</span>
        </>
      )}
      </div>
    </>
  );
}
