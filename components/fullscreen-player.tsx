'use client';
import { RefObject, useState } from 'react';
import { useApp } from '@/lib/store';
import { fmt, stripHtml } from '@/lib/format';
import { useChapters } from '@/lib/chapters';
import { BoltIcon } from './icons';
import { EpisodeSocialThread } from './episode-social-thread';
import { PodcastCover } from './podcast-cover';

function ChaptersList({
  url,
  onSeek,
  currentSec,
}: {
  url: string;
  onSeek: (s: number) => void;
  currentSec: number;
}) {
  const { chapters, loading } = useChapters(url);

  if (loading && !chapters) {
    return <p className="text-xs text-muted">Loading chapters…</p>;
  }
  if (!chapters?.length) return null;

  return (
    <div>
      <p className="text-[11px] uppercase tracking-widest text-muted mb-2">
        Chapters ({chapters.length})
      </p>
      <ul className="space-y-1 text-xs max-h-72 overflow-y-auto pr-2">
        {chapters.map((c, i) => {
          const next = chapters[i + 1];
          const active = currentSec >= c.startTime && (!next || currentSec < next.startTime);
          return (
            <li key={`${c.startTime}-${c.title ?? ''}`}>
              <button
                type="button"
                onClick={() => onSeek(c.startTime)}
                className={`w-full flex gap-3 text-left transition py-1 px-2 -mx-2 ${
                  active ? 'bg-bolt/10 text-bolt' : 'text-bone/80 hover:bg-bone/5'
                }`}
              >
                <span className="text-muted tabular-nums w-12 flex-shrink-0">
                  {fmt(c.startTime)}
                </span>
                <span className="truncate">{c.title ?? `Chapter ${i + 1}`}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function FullscreenPlayer({
  open,
  duration,
  audioRef,
  onClose,
  onBoost,
}: {
  open: boolean;
  duration: number;
  audioRef: RefObject<HTMLAudioElement | null>;
  onClose: () => void;
  onBoost: () => void;
}) {
  const { current, isPlaying, setPlaying, positionSec, setPosition } = useApp();
  const [valueOpen, setValueOpen] = useState(false);

  if (!current) return null;

  const { episode, podcast } = current;
  const isLive = episode.liveStatus === 'live';
  const value = episode.value ?? podcast.value;
  const hasValue = !!value?.recipients?.length;
  const description = episode.description ? stripHtml(episode.description) : '';

  function seekTo(s: number) {
    if (audioRef.current) audioRef.current.currentTime = s;
    setPosition(s);
  }

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col bg-ink transition-transform duration-300 ease-in-out ${open ? 'translate-y-0' : 'translate-y-full pointer-events-none'}`}
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex items-center justify-between px-5 pt-4 pb-2 flex-shrink-0 border-b border-bone/10">
        <span className="text-[11px] text-muted uppercase tracking-widest">Now Playing</span>
        <button onClick={onClose} className="btn-ghost px-2 py-1 text-base leading-none" aria-label="Close fullscreen player">
          ✕
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-5 py-6 lg:py-10 grid lg:grid-cols-2 gap-8 lg:gap-12 items-start">
          {/* Artwork — first on mobile, sticky on desktop so it stays visible while right pane scrolls */}
          <div className="lg:sticky lg:top-6">
            <div className="w-full max-w-md mx-auto aspect-square">
              <PodcastCover
                image={episode.image ?? podcast.image}
                artwork={podcast.artwork}
                title={podcast.title}
                seed={podcast.id?.toString()}
                className="w-full h-full rounded-xl border border-bone/10 shadow-2xl text-5xl"
              />
            </div>
          </div>

          {/* Info + controls */}
          <div className="flex flex-col gap-5 min-w-0">
            <div>
              <h1 className="font-display text-2xl lg:text-3xl leading-tight">{episode.title}</h1>
              <p className="text-sm text-muted mt-1.5">{podcast.title}</p>
              {podcast.author && (
                <p className="text-xs text-muted/70 mt-0.5">{podcast.author}</p>
              )}
            </div>

            {isLive ? (
              <div className="flex items-center gap-2">
                <span className="stamp text-nostr border-nostr/60 bg-nostr/10 animate-bolt">● LIVE</span>
                <span className="text-xs text-muted">streaming now</span>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <input
                  type="range"
                  className="seek w-full"
                  min={0}
                  max={duration || 0}
                  value={positionSec}
                  onChange={(e) => seekTo(Number(e.target.value))}
                />
                <div className="flex justify-between text-[11px] text-muted tabular-nums">
                  <span>{fmt(positionSec)}</span>
                  <span>{fmt(duration)}</span>
                </div>
              </div>
            )}

            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={() => setPlaying(!isPlaying)}
                className="btn text-2xl w-14 h-14 flex items-center justify-center flex-shrink-0"
                aria-label={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? '❚❚' : '▶'}
              </button>
              <button
                onClick={onBoost}
                disabled={!hasValue}
                className="btn-bolt disabled:opacity-40 disabled:cursor-not-allowed"
                title={hasValue ? 'Send a boost' : 'Episode has no value block'}
              >
                <BoltIcon /> BOOST
              </button>
            </div>

            {description && (
              <div className="border-t border-bone/10 pt-5">
                <p className="text-[11px] uppercase tracking-widest text-muted mb-2">About this episode</p>
                <div className="text-sm text-bone/80 leading-relaxed whitespace-pre-wrap max-h-72 overflow-y-auto pr-2">
                  {description}
                </div>
              </div>
            )}

            {hasValue && value && (
              <div className="border-t border-bone/10 pt-5">
                <button
                  type="button"
                  onClick={() => setValueOpen((v) => !v)}
                  className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-bolt hover:text-bolt/80"
                  aria-expanded={valueOpen}
                >
                  <span>⚡ Value split · {value.recipients.length} recipients</span>
                  <span aria-hidden>{valueOpen ? '▾' : '▸'}</span>
                </button>
                {valueOpen && (
                  <ul className="space-y-2 mt-3">
                    {value.recipients.map((r, i) => {
                      const isLnAddr = r.type === 'lnaddress';
                      const addr =
                        isLnAddr || r.address.length <= 20
                          ? r.address
                          : `${r.address.slice(0, 8)}…${r.address.slice(-8)}`;
                      return (
                        <li key={i} className="flex items-start gap-3 text-sm">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-display">
                                {r.name?.trim() || <span className="text-muted">(unnamed)</span>}
                              </span>
                              {r.fee && <span className="stamp text-muted border-bone/30">fee</span>}
                            </div>
                            <div className="text-[11px] text-muted font-mono break-all">{addr}</div>
                          </div>
                          <div className="font-display text-sm text-bolt flex-shrink-0">{r.split}</div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}

            {!isLive && episode.chaptersUrl && (
              <div className="border-t border-bone/10 pt-5">
                <ChaptersList
                  url={episode.chaptersUrl}
                  onSeek={seekTo}
                  currentSec={positionSec}
                />
              </div>
            )}

            {episode.socialInteract?.length ? (
              <div className="border-t border-bone/10 pt-5">
                <EpisodeSocialThread entries={episode.socialInteract} />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
