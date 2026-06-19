'use client';
import { RefObject, useEffect, useState } from 'react';
import { OutPortal, type HtmlPortalNode } from 'react-reverse-portal';
import { useApp } from '@/lib/store';
import { fmt, stripHtml } from '@/lib/format';
import { useChapters } from '@/lib/chapters';
import type { Podcast } from '@/lib/types';
import { streamNaddr, parseStreamId, isLiveStreamId } from '@/lib/nostr';
import { BoltIcon, ShareIcon } from './icons';
import { hasValueRecipients, isMusicMedium } from '@/lib/util';
import { EpisodeSocialThread } from './episode-social-thread';
import { PodcastCover } from './podcast-cover';
import { FavHeart } from './lists';
import { TransportControls } from './transport-controls';
import { LiveChat } from './live-chat';

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

// Copy a BMB deep link to the current item: ?stream=<naddr> for a Nostr live
// stream (liveStreamId = `<pubkey>:<dTag>`), else ?podcast=<guid>. Clipboard-only
// with a COPIED flip, mirroring the episode-list ShareButton.
function ShareButton({ liveStreamId, podcast }: { liveStreamId: string | null; podcast: Podcast }) {
  const [copied, setCopied] = useState(false);

  function buildUrl(): string | null {
    if (typeof window === 'undefined') return null;
    const origin = window.location.origin;
    if (liveStreamId) {
      const parsed = parseStreamId(liveStreamId);
      if (!parsed) return null;
      return `${origin}/stream/${streamNaddr(parsed.pubkey, parsed.dTag)}`;
    }
    if (podcast.podcastGuid) return `${origin}/?podcast=${podcast.podcastGuid}`;
    return null;
  }

  const url = buildUrl();
  if (!url) return null;

  async function onClick() {
    try {
      await navigator.clipboard.writeText(url!);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked — silent no-op */ }
  }

  return (
    <button onClick={onClick} className="btn-ghost" title="Copy link to this page" aria-label="Copy link to this page">
      <ShareIcon /> {copied ? 'COPIED' : 'SHARE'}
    </button>
  );
}

export function FullscreenPlayer({
  open,
  duration,
  audioRef,
  videoNode,
  isVideo,
  onClose,
  onBoost,
}: {
  open: boolean;
  duration: number;
  audioRef: RefObject<HTMLAudioElement | null>;
  videoNode: HtmlPortalNode | null;
  isVideo: boolean;
  onClose: () => void;
  onBoost: () => void;
}) {
  const { current, isPlaying, positionSec, setPosition, episodeQueue, play } = useApp();
  const identity = useApp((s) => s.identity);
  const setSignInOpen = useApp((s) => s.setSignInOpen);
  const [valueOpen, setValueOpen] = useState(false);

  // Lock the page behind the overlay so its scrollbar doesn't show through.
  // The document scrolls at the <html> element (background lives there), so
  // lock both html and body to be safe.
  useEffect(() => {
    if (!open) return;
    const html = document.documentElement;
    const prevHtml = html.style.overflow;
    const prevBody = document.body.style.overflow;
    html.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return () => {
      html.style.overflow = prevHtml;
      document.body.style.overflow = prevBody;
    };
  }, [open]);

  if (!current) return null;

  const { episode, podcast } = current;
  const isMusic = isMusicMedium(podcast);
  const isLive = episode.liveStatus === 'live';
  // A Nostr live stream's NIP-33 id is `<64-hex pubkey>:<dTag>`, carried as the
  // episode guid. When present (and it's an HLS video stream) the right pane
  // becomes the kind:1311 live chat instead of the usual episode info.
  const liveStreamId =
    isVideo && isLiveStreamId(episode.guid) ? episode.guid! : null;
  const value = episode.value ?? podcast.value;
  const hasValue = hasValueRecipients(value);
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
        <div className="flex items-center gap-3">
          <button onClick={onClose} className="btn-ghost px-2 py-1 text-xs" aria-label="Back">
            ← back
          </button>
          <span className="text-[11px] text-muted uppercase tracking-widest">Now Playing</span>
        </div>
        <div className="flex items-center gap-2">
          {!identity && (
            <button
              onClick={() => setSignInOpen(true)}
              className="btn-ghost text-xs"
              aria-label="Sign in with Nostr"
            >
              <span className="text-nostr">◆</span> Sign in
            </button>
          )}
          <button onClick={onClose} className="btn-ghost px-2 py-1 text-base leading-none" aria-label="Close fullscreen player">
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col sm:flex-row">
        {/* Artwork (or live video) — centered in the left half; sticky so it
            stays put as the page scrolls. For HLS streams the shared <video>
            is displayed here via its OutPortal while the player is open; when
            closed it moves back to the mini-bar so audio keeps playing. */}
        <div className="flex items-center justify-center p-6 lg:p-10 sm:w-1/2 sm:flex-shrink-0 sm:sticky sm:top-0 sm:self-start sm:h-[calc(100vh-3.5rem)]">
          {isVideo ? (
            <div className="w-full max-w-md sm:max-w-lg lg:max-w-2xl aspect-video rounded-xl border border-bone/10 shadow-2xl overflow-hidden bg-black">
              {open && videoNode && <OutPortal node={videoNode} />}
            </div>
          ) : (
            <div className="w-full max-w-md sm:max-w-lg lg:max-w-xl aspect-square">
              <PodcastCover
                image={episode.image ?? podcast.image}
                artwork={podcast.artwork}
                title={podcast.title}
                seed={podcast.id?.toString()}
                className="w-full h-full rounded-xl border border-bone/10 shadow-2xl text-5xl"
              />
            </div>
          )}
        </div>

        {/* Right pane: kind:1311 live chat for Nostr streams, else episode info */}
        {liveStreamId ? (
          <div className="sm:w-1/2 p-6 lg:p-10 flex flex-col gap-4 h-[70vh] sm:h-[calc(100vh-3.5rem)]">
            <div className="flex-shrink-0 flex flex-col gap-3 min-w-0">
              <div>
                <h1 className="font-display text-2xl lg:text-3xl leading-tight">{episode.title}</h1>
                <p className="text-sm text-muted mt-1.5">{podcast.title}</p>
                {podcast.author && (
                  <p className="text-xs text-muted/70 mt-0.5">{podcast.author}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="stamp text-nostr border-nostr/60 bg-nostr/10 animate-bolt">● LIVE</span>
                <span className="text-xs text-muted">streaming now</span>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <TransportControls size="lg" />
                <button
                  onClick={onBoost}
                  disabled={!hasValue}
                  className="btn-bolt disabled:opacity-40 disabled:cursor-not-allowed"
                  title={hasValue ? 'Send a boost' : 'Stream has no value block'}
                >
                  <BoltIcon /> BOOST
                </button>
                <FavHeart podcast={podcast} size="md" />
                <ShareButton liveStreamId={liveStreamId} podcast={podcast} />
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <LiveChat streamId={liveStreamId} />
            </div>
          </div>
        ) : (
        <div className="sm:w-1/2 p-6 lg:p-10">
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

            <div className="flex items-center justify-center gap-3 flex-wrap">
              <TransportControls size="lg" />
              <button
                onClick={onBoost}
                disabled={!hasValue}
                className="btn-bolt disabled:opacity-40 disabled:cursor-not-allowed ml-28"
                title={hasValue ? 'Send a boost' : 'Episode has no value block'}
              >
                <BoltIcon /> BOOST
              </button>
              <FavHeart podcast={podcast} size="md" />
              <ShareButton liveStreamId={null} podcast={podcast} />
            </div>

            {hasValue && value && (
              <div className="-mt-1">
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

            {isMusic && episodeQueue.length > 1 && (
              <div className="border-t border-bone/10 pt-5">
                <p className="text-[11px] uppercase tracking-widest text-muted mb-2">
                  Album · {episodeQueue.length} tracks
                </p>
                <ul className="space-y-1 text-sm max-h-80 overflow-y-auto pr-2">
                  {episodeQueue.map((t, i) => {
                    const active = t.id === episode.id;
                    return (
                      <li key={t.id}>
                        <button
                          type="button"
                          onClick={() => play(t, podcast)}
                          className={`w-full flex items-center gap-3 text-left transition py-1.5 px-2 -mx-2 ${
                            active ? 'bg-bolt/10 text-bolt' : 'text-bone/80 hover:bg-bone/5'
                          }`}
                        >
                          <span className="text-muted tabular-nums w-5 flex-shrink-0 text-right">
                            {active && isPlaying ? '❚❚' : i + 1}
                          </span>
                          <span className="truncate flex-1">{t.title}</span>
                          {t.duration ? (
                            <span className="text-muted tabular-nums text-xs flex-shrink-0">{fmt(t.duration)}</span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {description && (
              <div className="border-t border-bone/10 pt-5">
                <p className="text-[11px] uppercase tracking-widest text-muted mb-2">About this episode</p>
                <div className="text-sm text-bone/80 leading-relaxed whitespace-pre-wrap max-h-72 overflow-y-auto pr-2">
                  {description}
                </div>
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
        )}
      </div>
    </div>
  );
}
