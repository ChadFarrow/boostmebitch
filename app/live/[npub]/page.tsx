'use client';
import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { nip19 } from 'nostr-tools';
import {
  fetchLatestStreamByPubkey,
  resolveStreamV4V,
  streamToEpisode,
  streamToPodcast,
  fetchProfile,
  type NostrLiveStream,
} from '@/lib/nostr';
import type { ProfileMetadata } from '@/lib/nostr/auth';
import { useApp } from '@/lib/store';
import { NostrAuth } from '@/components/nostr-auth';
import { Avatar } from '@/components/avatar';
import { fmtLiveTime } from '@/lib/format';

// Permanent per-host live link: `/live/<npub>`. Unlike `/stream/<naddr>` (which
// pins one broadcast by its dTag), this resolves the host's *current* stream at
// click time, so the URL a show puts in its bio stays valid across broadcasts —
// each new stream gets a fresh dTag, but the host's npub never changes.
//
// When the host is live we open the app-global <Player> (mounted in the root
// layout) on top, same as the /stream route. When they aren't, we render a
// clean "not live" placeholder with their name/avatar (and a "next up" time if
// a stream is scheduled) instead of opening anything.
export default function LivePage() {
  const params = useParams();
  const router = useRouter();
  const npub = Array.isArray(params.npub) ? params.npub[0] : (params.npub ?? '');
  const play = useApp((s) => s.play);
  const setPlayerExpanded = useApp((s) => s.setPlayerExpanded);
  const playerExpanded = useApp((s) => s.playerExpanded);

  const [status, setStatus] = useState<'loading' | 'open' | 'offline' | 'notfound'>('loading');
  // The host's stream (when planned, drives the "next up" hint) + profile for
  // the offline placeholder.
  const [host, setHost] = useState<{ profile: ProfileMetadata | null; stream: NostrLiveStream | null }>({
    profile: null,
    stream: null,
  });
  const wasOpen = useRef(false);

  useEffect(() => {
    let pubkey = '';
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') pubkey = decoded.data;
    } catch { /* malformed */ }
    if (!pubkey) { setStatus('notfound'); return; }

    let cancelled = false;
    (async () => {
      // Host profile and stream in parallel; the profile is needed whether or
      // not they're live (placeholder + player podcast stub).
      const profilePromise = fetchProfile(pubkey).catch(() => null);

      // Retry before giving up: a cold load (no warm WS to the host relay like
      // fountain.fm) can time out on the first query — a second/third attempt
      // reuses the now-warm connection. Same pattern as the /stream route.
      let stream: NostrLiveStream | null = null;
      for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 800));
        stream = await fetchLatestStreamByPubkey(pubkey);
        if (stream?.status === 'live') break; // live now — stop early
      }
      if (cancelled) return;

      const profile = await profilePromise;
      if (cancelled) return;
      setHost({ profile, stream });

      if (stream?.status === 'live' && stream.streamUrl) {
        play(streamToEpisode(stream, null), streamToPodcast(stream, profile));
        setPlayerExpanded(true);
        setStatus('open');
        // Enrich boost value in the background — episode.id is stable so the
        // video/hls don't restart.
        const value = await resolveStreamV4V(stream).catch(() => null);
        if (!cancelled && value && useApp.getState().current?.episode.guid === stream.id) {
          play(streamToEpisode(stream, value), streamToPodcast(stream, profile));
        }
      } else {
        setStatus('offline');
      }
    })();
    return () => { cancelled = true; };
  }, [npub, play, setPlayerExpanded]);

  // When the user collapses the fullscreen player, leave this page and go home —
  // the stream keeps playing in the mini-bar (the Player lives in the layout).
  useEffect(() => {
    if (playerExpanded) wasOpen.current = true;
    else if (wasOpen.current) router.push('/');
  }, [playerExpanded, router]);

  const displayName =
    host.profile?.display_name ?? host.profile?.name ?? (npub ? npub.slice(0, 12) + '…' : 'this host');

  return (
    <>
      {/* Mounts the Nostr session logic (identity hydration + sign-in modal) on
          this standalone route where the home page's <NostrAuth> isn't present.
          Hidden; the player's own "Sign in" button opens the portal'd modal. */}
      <div className="hidden">
        <NostrAuth />
      </div>
      <div
        className="fixed inset-0 z-40 bg-ink flex flex-col items-center justify-center gap-4 text-muted px-6 text-center"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        {status === 'notfound' ? (
          <>
            <span className="text-sm">That host link isn&apos;t valid.</span>
            <button onClick={() => router.push('/')} className="btn-ghost">← Go home</button>
          </>
        ) : status === 'offline' ? (
          <>
            <Avatar
              pubkey={host.stream?.pubkey ?? ''}
              picture={host.profile?.picture}
              name={displayName}
              className="w-16 h-16 rounded-full"
            />
            <div className="flex flex-col gap-1">
              <span className="font-display text-lg text-bone">{displayName}</span>
              <span className="text-sm">isn&apos;t live right now.</span>
            </div>
            {host.stream?.status === 'planned' && host.stream.startsAt != null && (
              <span className="text-xs text-bolt font-mono">
                Next: {host.stream.title} — starts {fmtLiveTime(host.stream.startsAt)}
              </span>
            )}
            <button onClick={() => router.push('/')} className="btn-ghost mt-1">← Browse shows</button>
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
