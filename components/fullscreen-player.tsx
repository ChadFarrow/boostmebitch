'use client';
import { RefObject, useEffect, useState } from 'react';
import { OutPortal, type HtmlPortalNode } from 'react-reverse-portal';
import { useApp } from '@/lib/store';
import { fmt } from '@/lib/format';
import { chapterState, buildChapterNav, type ChapterEntry } from '@/lib/chapters';
import { ChapterTicks, ChapterLabel } from './chapter-ui';
import type { Podcast } from '@/lib/types';
import { streamNaddr, parseStreamId, isLiveStreamId } from '@/lib/nostr';
import { BoltIcon, ShareIcon } from './icons';
import { hasValueRecipients, isMusicMedium, stripHtml } from '@/lib/util';
import { EpisodeSocialThread } from './episode-social-thread';
import { PodcastCover } from './podcast-cover';
import { FavHeart } from './lists';
import { TransportControls } from './transport-controls';
import { LiveChat } from './live-chat';

// About-this-episode text + Podcasting 2.0 chapters, toggled by a tab strip.
// Tabs only show when BOTH exist; with one, it renders that section under a
// plain label. Returns null when there's neither (and nothing still loading).
function EpisodeInfoPanel({
  description,
  chapters,
  chaptersLoading,
  hasChaptersUrl,
  onSeek,
  currentSec,
}: {
  description: string;
  chapters: ChapterEntry[] | null;
  chaptersLoading: boolean;
  hasChaptersUrl: boolean;
  onSeek: (s: number) => void;
  currentSec: number;
}) {
  const [tab, setTab] = useState<'about' | 'chapters'>('about');

  const hasDescription = !!description;
  const hasChapters = !!chapters?.length;
  const chaptersPending = hasChaptersUrl && chaptersLoading;
  if (!hasDescription && !hasChapters && !chaptersPending) return null;

  const showTabs = hasDescription && hasChapters;
  // When only one section is available, force it regardless of the tab state.
  const active: 'about' | 'chapters' = showTabs ? tab : hasDescription ? 'about' : 'chapters';

  const tabCls = (on: boolean) =>
    `text-xs font-semibold uppercase tracking-widest px-4 py-2 rounded-full transition ${
      on
        ? 'bg-bolt text-ink shadow-sm'
        : 'text-muted hover:text-bone hover:bg-bone/5'
    }`;

  return (
    <div className="border-t border-bone/10 pt-5">
      {showTabs ? (
        <div className="inline-flex gap-1 mb-4 p-1 rounded-full border border-bone/15 bg-bone/5">
          <button type="button" onClick={() => setTab('about')} className={tabCls(active === 'about')}>
            About
          </button>
          <button type="button" onClick={() => setTab('chapters')} className={tabCls(active === 'chapters')}>
            Chapters ({chapters!.length})
          </button>
        </div>
      ) : (
        <p className="text-[11px] uppercase tracking-widest text-muted mb-2">
          {active === 'chapters' ? `Chapters (${chapters?.length ?? 0})` : 'About this episode'}
        </p>
      )}

      {active === 'about' && hasDescription && (
        <div className="text-sm text-bone/80 leading-relaxed whitespace-pre-wrap break-words">
          {description}
        </div>
      )}

      {active === 'chapters' &&
        (hasChapters ? (
          <ul className="text-xs">
            {chapters!.map((c, i) => {
              const next = chapters![i + 1];
              const on = currentSec >= c.startTime && (!next || currentSec < next.startTime);
              return (
                <li key={`${c.startTime}-${c.title ?? ''}`}>
                  <button
                    type="button"
                    onClick={() => onSeek(c.startTime)}
                    className={`w-full flex gap-3 items-baseline text-left rounded transition py-1.5 px-2 -mx-2 ${
                      on ? 'bg-bolt/10 text-bolt' : 'text-bone/80 hover:bg-bone/5'
                    }`}
                  >
                    <span className={`tabular-nums w-12 flex-shrink-0 ${on ? 'text-bolt' : 'text-muted'}`}>
                      {fmt(c.startTime)}
                    </span>
                    <span className="break-words">{c.title ?? `Chapter ${i + 1}`}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-muted">Loading chapters…</p>
        ))}
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
  chapters,
  chaptersLoading,
  onClose,
  onBoost,
}: {
  open: boolean;
  duration: number;
  audioRef: RefObject<HTMLAudioElement | null>;
  videoNode: HtmlPortalNode | null;
  isVideo: boolean;
  // Fetched once by <Player> and passed down (so it isn't fetched twice).
  chapters: ChapterEntry[] | null;
  chaptersLoading: boolean;
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
  const { index: activeIdx, chapter: activeChapter, end: activeChapterEnd } = chapterState(
    chapters,
    positionSec,
    duration,
  );

  function seekTo(s: number) {
    if (audioRef.current) audioRef.current.currentTime = s;
    setPosition(s);
  }

  // When the episode has chapters, the prev/next transport buttons step between
  // chapters instead of episodes (chapters are already gated off for music/live
  // upstream in <Player>). Prev restarts the current chapter if >3s in, else
  // jumps to the previous one.
  const chapterNav = buildChapterNav(chapters, activeIdx, positionSec, seekTo);

  return (
    <div
      // Height is the *dynamic* viewport (100dvh), not inset-0 / 100vh: on iOS
      // Safari a fixed inset-0 element sizes to the large (toolbar-hidden)
      // viewport, so its bottom — the live-chat composer — hides behind Safari's
      // bottom address bar. 100dvh tracks the visible area as the bar shows/hides.
      className={`fixed inset-x-0 top-0 h-[100dvh] z-50 flex flex-col bg-ink transition-transform duration-300 ease-in-out ${open ? 'translate-y-0' : 'translate-y-full pointer-events-none'}`}
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

      {/* Live streams lock to the viewport on mobile (overflow-hidden) so the
          chat — not the page behind — fills the space below the video; the page
          used to scroll past the overlay and reveal the browse view. Non-live
          (podcast/music) keeps the normal single-scroll-container behavior. */}
      <div className={`flex-1 min-h-0 flex flex-col sm:flex-row ${liveStreamId ? 'overflow-hidden sm:overflow-y-auto' : 'overflow-y-auto'}`}>
        {/* Artwork (or live video) — centered in the left half; sticky so it
            stays put as the page scrolls. For HLS streams the shared <video>
            is displayed here via its OutPortal while the player is open; when
            closed it moves back to the mini-bar so audio keeps playing. */}
        <div className="flex items-center justify-center p-4 sm:p-6 lg:p-10 flex-shrink-0 sm:w-1/2 sm:sticky sm:top-0 sm:self-start sm:h-[calc(100vh-3.5rem)]">
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
          <div className="flex-1 min-h-0 sm:flex-none sm:w-1/2 p-4 sm:p-6 lg:p-10 flex flex-col gap-3 sm:gap-4 sm:h-[calc(100vh-3.5rem)]">
            <div className="flex-shrink-0 flex flex-col gap-3 min-w-0">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="stamp text-nostr border-nostr/60 bg-nostr/10 animate-bolt">● LIVE</span>
                  <span className="text-xs text-muted">streaming now</span>
                </div>
                <h1 className="font-display text-xl sm:text-2xl lg:text-3xl leading-tight mt-2">{episode.title}</h1>
                {podcast.title && podcast.title !== episode.title && (
                  <p className="text-sm text-muted mt-1">{podcast.title}</p>
                )}
                {podcast.author && (
                  <p className="text-xs text-muted/70 mt-0.5">{podcast.author}</p>
                )}
              </div>
              {/* Compact controls for live: small transport buttons (you can't
                  seek a live stream, so they need little prominence) keep this
                  row short and hand the freed vertical space to the chat. BOOST
                  stretches as the primary action; FAV / SHARE share its row. */}
              <div className="flex items-center gap-2 flex-wrap">
                <TransportControls size="sm" />
                <button
                  onClick={onBoost}
                  disabled={!hasValue}
                  className="btn-bolt flex-1 min-w-[7rem] disabled:opacity-40 disabled:cursor-not-allowed"
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
        <div className="sm:w-1/2 p-4 sm:p-6 lg:p-10 flex flex-col gap-5 min-w-0 sm:h-[calc(100vh-3.5rem)]">
          {/* Fixed header: title, seek + transport controls stay put; only the
              About/Chapters body below scrolls (on desktop). */}
          <div className="flex-shrink-0 flex flex-col gap-5">
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
                <div className="relative flex items-center">
                  <ChapterTicks chapters={chapters} duration={duration} />
                  <input
                    type="range"
                    className="seek block w-full relative"
                    min={0}
                    max={duration || 0}
                    value={positionSec}
                    onChange={(e) => seekTo(Number(e.target.value))}
                  />
                </div>
                <div className="flex justify-between text-[11px] text-muted tabular-nums">
                  <span>{fmt(positionSec)}</span>
                  <span>{fmt(duration)}</span>
                </div>
                <ChapterLabel chapter={activeChapter} end={activeChapterEnd} className="text-xs" />
              </div>
            )}

            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <TransportControls size="lg" prev={chapterNav?.prev} next={chapterNav?.next} />
                <button
                  onClick={onBoost}
                  disabled={!hasValue}
                  className="btn-bolt flex-1 disabled:opacity-40 disabled:cursor-not-allowed"
                  title={hasValue ? 'Send a boost' : 'Episode has no value block'}
                >
                  <BoltIcon /> BOOST
                </button>
              </div>
              <div className="flex items-center gap-2">
                <FavHeart podcast={podcast} size="md" />
                <ShareButton liveStreamId={null} podcast={podcast} />
              </div>
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
          </div>

          {/* Scrollable body — About / Chapters (+ discussion). */}
          <div className="flex-1 sm:min-h-0 sm:overflow-y-auto">
            <EpisodeInfoPanel
              description={description}
              chapters={chapters}
              chaptersLoading={chaptersLoading}
              hasChaptersUrl={!isLive && !!episode.chaptersUrl}
              onSeek={seekTo}
              currentSec={positionSec}
            />

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
