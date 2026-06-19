'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  fetchNostrLiveStreams,
  resolveStreamV4V,
  streamToEpisode,
  streamToPodcast,
  streamNaddr,
  type NostrLiveStream,
} from '@/lib/nostr/live-streams';
import { fetchProfile } from '@/lib/nostr';
import { storage } from '@/lib/storage';
import { useApp } from '@/lib/store';
import type { Episode, Podcast, ValueBlock } from '@/lib/types';
import { BoostModal } from './boost-modal';
import { PodcastCover } from './podcast-cover';
import { fmtLiveTime } from '@/lib/format';
import type { ProfileMetadata } from '@/lib/nostr/auth';

interface ResolvedStream {
  stream: NostrLiveStream;
  profile: ProfileMetadata | null;
  value: ValueBlock | null;
}

export function NostrLiveStreams() {
  const [resolved, setResolved] = useState<ResolvedStream[]>([]);
  const [loading, setLoading] = useState(true);
  const [boostTarget, setBoostTarget] = useState<{ episode: Episode; podcast: Podcast } | null>(null);
  const play = useApp((s) => s.play);
  const router = useRouter();
  const mountedRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Translate vertical mouse-wheel into horizontal scroll over the row. React's
  // onWheel is passive (can't preventDefault), so attach natively. We only hijack
  // when there's horizontal overflow, the gesture is vertical (mouse wheel, not a
  // trackpad swipe), and the row isn't already at the edge in that direction —
  // so page scroll still takes over once you reach the end.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const atStart = el.scrollLeft <= 0;
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
      if ((e.deltaY < 0 && atStart) || (e.deltaY > 0 && atEnd)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [resolved.length]);

  useEffect(() => {
    mountedRef.current = true;
    load();
    const timer = setInterval(load, 60_000);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    try {
      const streams = await fetchNostrLiveStreams();
      if (!mountedRef.current) return;

      // Fetch host profiles (needed for name + avatar + LN address)
      const hostPubkeys = [...new Set(streams.map((s) => s.pubkey))];
      await Promise.all(
        hostPubkeys.map(async (pk) => {
          const cached = storage.profile.get(pk);
          if (cached === undefined) await fetchProfile(pk);
        }),
      );

      // Resolve V4V for each stream (profiles now cached — fast path)
      const withV4V = await Promise.all(
        streams.map(async (stream) => {
          const profile = storage.profile.get(stream.pubkey) ?? null;
          const value = await resolveStreamV4V(stream);
          return { stream, profile, value };
        }),
      );

      if (!mountedRef.current) return;
      setResolved(withV4V);
    } catch {
      // silently ignore — live streams section just stays empty / stale
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }

  if (loading && !resolved.length) {
    return (
      <section>
        <h3 className="font-display text-lg mb-3 text-bone/70">
          <span className="text-nostr animate-bolt">●</span> Live on Nostr
        </h3>
        <div className="flex gap-3 overflow-x-auto pb-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex-shrink-0 w-64 h-24 card animate-pulse opacity-40" />
          ))}
        </div>
      </section>
    );
  }

  if (!resolved.length) return null;

  return (
    <section>
      <h3 className="font-display text-lg mb-3 flex items-center gap-2">
        <span className="text-nostr animate-bolt text-sm">●</span>
        Live on Nostr
        <span className="text-[11px] font-mono text-muted uppercase tracking-widest">
          {resolved.filter((r) => r.stream.status === 'live').length} live
          {resolved.filter((r) => r.stream.status === 'planned').length > 0 &&
            ` · ${resolved.filter((r) => r.stream.status === 'planned').length} upcoming`}
        </span>
      </h3>

      <div ref={scrollRef} className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
        {resolved.map(({ stream, profile, value }) => {
          // Play instantly (the card already has the resolved data); a card
          // click (expand) also navigates to the dedicated /stream/<naddr> page
          // so the URL reflects it and a refresh restores the stream. The PLAY
          // button stays in the mini-bar (no navigation).
          const start = (expand: boolean) => {
            play(streamToEpisode(stream, value), streamToPodcast(stream, profile));
            if (expand) router.push(`/stream/${streamNaddr(stream.pubkey, stream.dTag)}`);
          };
          return (
            <StreamCard
              key={stream.id}
              stream={stream}
              profile={profile}
              value={value}
              onPlay={() => start(false)}
              onOpen={() => start(true)}
              onBoost={() => {
                const podcast = streamToPodcast(stream, profile);
                podcast.value = value;
                setBoostTarget({
                  episode: streamToEpisode(stream, value),
                  podcast,
                });
              }}
            />
          );
        })}
      </div>

      {boostTarget && (
        <BoostModal
          episode={boostTarget.episode}
          podcast={boostTarget.podcast}
          onClose={() => setBoostTarget(null)}
        />
      )}
    </section>
  );
}

function StreamCard({
  stream,
  profile,
  value,
  onPlay,
  onOpen,
  onBoost,
}: {
  stream: NostrLiveStream;
  profile: ProfileMetadata | null;
  value: ValueBlock | null;
  onPlay: () => void;
  onOpen: () => void;
  onBoost: () => void;
}) {
  const current = useApp((s) => s.current);
  const isPlaying = useApp((s) => s.isPlaying);
  const isCurrentStream =
    current?.episode.guid === stream.id;
  // Only playable streams (live, with a URL) open the fullscreen player on a
  // card click; an upcoming/URL-less card click does nothing.
  const playable = stream.status !== 'planned' && !!stream.streamUrl;

  const displayName =
    profile?.display_name ?? profile?.name ?? stream.npub.slice(0, 12) + '…';
  const image = stream.image ?? profile?.picture;

  return (
    <article
      className={`flex-shrink-0 w-64 card p-3 flex flex-col gap-2 ${
        playable ? 'cursor-pointer hover:border-bone/30 transition-colors' : ''
      }`}
      onClick={playable ? onOpen : undefined}
    >
      {/* Header row: artwork + status badge */}
      <div className="flex items-start gap-2">
        <PodcastCover
          image={image}
          title={stream.title}
          seed={stream.id}
          className="w-10 h-10 rounded object-cover flex-shrink-0"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1 mb-0.5 flex-wrap">
            {stream.status === 'live' ? (
              <span className="stamp text-nostr border-nostr/60 bg-nostr/10 animate-bolt text-[10px] px-1 py-0">
                ● LIVE
              </span>
            ) : (
              <span className="stamp text-bolt border-bolt/60 text-[10px] px-1 py-0">
                UPCOMING
              </span>
            )}
            {stream.currentViewers != null && stream.currentViewers > 0 && (
              <span className="text-[10px] text-muted font-mono">
                {stream.currentViewers} 👁
              </span>
            )}
          </div>
          <p className="text-sm font-display leading-tight line-clamp-2" title={stream.title}>
            {stream.title}
          </p>
        </div>
      </div>

      {/* Host name */}
      <p className="text-xs text-muted truncate">by {displayName}</p>

      {/* Start time for upcoming streams */}
      {stream.status === 'planned' && stream.startsAt != null && (
        <p className="text-xs text-bolt font-mono">
          starts {fmtLiveTime(stream.startsAt)}
        </p>
      )}
      {stream.status === 'live' && stream.startsAt != null && (
        <p className="text-xs text-nostr font-mono">
          started {fmtLiveTime(stream.startsAt)}
        </p>
      )}

      {/* Hashtags */}
      {stream.hashtags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {stream.hashtags.slice(0, 3).map((tag) => (
            <span key={tag} className="text-[10px] text-muted font-mono bg-bone/5 px-1 rounded">
              #{tag}
            </span>
          ))}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-1.5 mt-auto pt-1">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onPlay(); }}
          disabled={stream.status === 'planned' || !stream.streamUrl}
          className="btn text-xs py-1 flex-1 disabled:opacity-40 disabled:cursor-not-allowed"
          title={
            stream.status === 'planned'
              ? "Stream hasn't started yet"
              : !stream.streamUrl
              ? 'No stream URL'
              : isCurrentStream && isPlaying
              ? 'Playing'
              : 'Play stream'
          }
        >
          {isCurrentStream && isPlaying ? '❚❚' : '▶'} PLAY
        </button>
        {value && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onBoost(); }}
            className="btn-bolt text-xs py-1 px-2 flex-shrink-0 flex items-center gap-1"
            title="Boost this stream"
          >
            ⚡
          </button>
        )}
      </div>
    </article>
  );
}
