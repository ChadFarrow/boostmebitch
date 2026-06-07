'use client';
import { useEffect, useState } from 'react';
import { useApp } from '@/lib/store';
import { fmtDuration, stripHtml } from '@/lib/format';
import { useChapters } from '@/lib/chapters';
import type { ChapterEntry } from '@/lib/chapters';
import { BoltIcon, ShareIcon } from './icons';
import { PodcastCover } from './podcast-cover';
import { BoostModal } from './boost-modal';
import { BoostAllModal } from './boost-all-modal';
import { EpisodeNostrFeed } from './episode-nostr-feed';
import type { Episode, ValueBlock } from '@/lib/types';

function ChaptersList({ url }: { url: string }) {
  const { chapters, loading } = useChapters(url);

  if (loading && chapters === null) {
    return <p className="text-xs text-muted">Loading chapters…</p>;
  }
  if (!chapters?.length) return null;

  return (
    <div>
      <p className="text-[11px] uppercase tracking-widest text-muted mb-1.5">
        Chapters ({chapters.length})
      </p>
      <ul className="space-y-1 text-xs">
        {chapters.map((c, i) => (
          <li key={i} className="flex gap-3 text-bone/80">
            <span className="text-muted tabular-nums w-12 flex-shrink-0">
              {fmtDuration(c.startTime)}
            </span>
            <span>{c.title ?? `Chapter ${i + 1}`}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ValueSplitSection({ value }: { value: ValueBlock }) {
  const suggestedSats =
    value.suggested && Number.isFinite(parseFloat(value.suggested))
      ? Math.round(parseFloat(value.suggested) * 100_000_000)
      : null;

  return (
    <div>
      <p className="text-[11px] uppercase tracking-widest text-muted mb-1.5">Value split</p>
      <div className="text-[11px] text-muted mb-2">
        {value.type} · {value.method}
        {suggestedSats !== null && (
          <span className="text-bolt ml-3">suggested: {suggestedSats} sats/min</span>
        )}
      </div>
      <ul className="space-y-2">
        {value.recipients.map((r, i) => {
          const isLnAddr = r.type === 'lnaddress';
          const addr =
            isLnAddr || r.address.length <= 20
              ? r.address
              : `${r.address.slice(0, 8)}…${r.address.slice(-8)}`;
          return (
            <li key={i} className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap text-sm">
                  <span className="font-display">
                    {r.name?.trim() || <span className="text-muted">(unnamed)</span>}
                  </span>
                  {r.fee && <span className="stamp text-muted border-bone/30">fee</span>}
                </div>
                <div className="text-[11px] text-muted font-mono break-all">{addr}</div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="font-display text-sm text-bolt">{r.split}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function EpisodeShareButton({ episode, podcast }: { episode: Episode; podcast: NonNullable<ReturnType<typeof useApp.getState>['selectedPodcast']> }) {
  const [copied, setCopied] = useState(false);
  if (!episode.guid || !podcast.podcastGuid) return null;

  async function onShare() {
    const url = new URL(window.location.origin + window.location.pathname);
    url.searchParams.set('podcast', podcast.podcastGuid!);
    url.searchParams.set('episode', episode.guid!);
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked — silent */ }
  }

  return (
    <button
      type="button"
      onClick={onShare}
      className="btn-ghost text-xs"
      title="Copy link to this episode"
      aria-label="Copy link to this episode"
    >
      <ShareIcon /> {copied ? 'COPIED' : 'SHARE'}
    </button>
  );
}

export function EpisodeDetailView() {
  const episode = useApp((s) => s.selectedEpisode);
  const podcast = useApp((s) => s.selectedPodcast);
  const closeEpisode = useApp((s) => s.closeEpisode);
  const play = useApp((s) => s.play);
  const togglePlay = useApp((s) => s.togglePlay);
  const current = useApp((s) => s.current);
  const isPlaying = useApp((s) => s.isPlaying);
  const positionSec = useApp((s) => s.positionSec);
  const openDiscussion = useApp((s) => s.openDiscussion);

  const [boostFor, setBoostFor] = useState<Episode | null>(null);
  const [boostAllFor, setBoostAllFor] = useState<Episode | null>(null);
  const [valueOpen, setValueOpen] = useState(false);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [episode?.id]);

  if (!episode || !podcast) return null;

  const value = episode.value ?? podcast.value;
  const hasValue = !!value?.recipients?.length;
  const isThisPlaying = current?.episode.id === episode.id;
  const playerVisible = !!current;
  const description = !episode.contentEncoded && episode.description
    ? stripHtml(episode.description)
    : '';

  function handlePlay() {
    if (isThisPlaying) {
      togglePlay();
    } else {
      play(episode!, podcast!);
    }
  }

  return (
    <div>
      <button onClick={closeEpisode} className="btn-ghost text-xs mb-3">
        ← back to episodes
      </button>

      <section className="card p-4 space-y-5">
        {/* Artwork */}
        <div className="flex justify-center pt-2">
          <PodcastCover
            image={episode.image ?? podcast.image}
            artwork={podcast.artwork}
            title={episode.title}
            seed={episode.guid ?? String(episode.id)}
            className="w-48 h-48 sm:w-64 sm:h-64 border border-bone/20 text-5xl"
          />
        </div>

        {/* Title & metadata */}
        <div>
          <h2 className="font-display text-2xl sm:text-3xl font-semibold leading-tight">
            {episode.title}
          </h2>
          <p className="text-sm text-muted mt-1">{podcast.title}</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted mt-2">
            {episode.datePublished && (
              <span>{new Date(episode.datePublished * 1000).toLocaleDateString()}</span>
            )}
            {episode.duration ? <span>· {fmtDuration(episode.duration)}</span> : null}
            {episode.episode ? <span>· Episode {episode.episode}</span> : null}
            {episode.season ? <span>· Season {episode.season}</span> : null}
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handlePlay}
            className={`btn ${isThisPlaying ? 'border-bolt text-bolt' : ''}`}
            aria-label={isThisPlaying && isPlaying ? 'Pause' : isThisPlaying ? 'Resume' : 'Play'}
          >
            {isThisPlaying && isPlaying ? '❚❚ PAUSE' : isThisPlaying ? '▶ RESUME' : '▶ PLAY'}
          </button>
          <EpisodeShareButton episode={episode} podcast={podcast} />
          {hasValue && (
            <button
              type="button"
              onClick={() => setBoostFor(episode)}
              className="btn-bolt"
              aria-label="Boost this episode"
            >
              <BoltIcon /> BOOST
            </button>
          )}
          {episode.socialInteract?.length ? (
            <button
              type="button"
              onClick={() => openDiscussion(episode)}
              className="btn-ghost text-nostr"
              aria-label="Open episode discussion"
            >
              💬 DISCUSSION
            </button>
          ) : null}
          {episode.valueTimeSplits?.length ? (
            <button
              type="button"
              onClick={() => setBoostAllFor(episode)}
              className="btn-ghost text-bolt text-[11px] uppercase tracking-wider"
              aria-label={`Boost all ${episode.valueTimeSplits.length} tracks`}
            >
              ⚡ Boost {episode.valueTimeSplits.length} tracks
            </button>
          ) : null}
        </div>

        {/* Value split */}
        {value && (
          <div>
            <button
              type="button"
              onClick={() => setValueOpen((v) => !v)}
              className="stamp text-bolt border-bolt/60 hover:bg-bolt/10 transition cursor-pointer"
              aria-expanded={valueOpen}
            >
              ⚡ {value.recipients?.length ?? 0} recipients
              <span className="ml-1">{valueOpen ? '▾' : '▸'}</span>
            </button>
            {valueOpen && <div className="mt-3"><ValueSplitSection value={value} /></div>}
          </div>
        )}

        {/* Chapters */}
        {episode.chaptersUrl && (
          <ChaptersList url={episode.chaptersUrl} />
        )}

        {/* Show notes */}
        {episode.contentEncoded ? (
          <div>
            <p className="text-[11px] uppercase tracking-widest text-muted mb-2">Show notes</p>
            <div
              className="show-notes text-sm text-bone/80 leading-relaxed overflow-x-hidden"
              dangerouslySetInnerHTML={{ __html: episode.contentEncoded }}
            />
          </div>
        ) : description ? (
          <div>
            <p className="text-[11px] uppercase tracking-widest text-muted mb-2">Show notes</p>
            <div className="text-sm text-bone/80 leading-relaxed whitespace-pre-wrap overflow-x-hidden">
              {description}
            </div>
          </div>
        ) : null}
      </section>

      {episode.guid && (
        <EpisodeNostrFeed episodeGuid={episode.guid} episodeTitle={episode.title} />
      )}

      {hasValue && (
        <button
          type="button"
          onClick={() => setBoostFor(episode)}
          className="btn-bolt fixed right-4 z-40 shadow-xl rounded-full"
          style={{ bottom: `calc(${playerVisible ? '5rem' : '1.5rem'} + env(safe-area-inset-bottom))` }}
          aria-label="Boost this episode"
        >
          <BoltIcon /> BOOST
        </button>
      )}

      {boostFor && (
        <BoostModal
          episode={boostFor}
          podcast={podcast}
          positionSec={isThisPlaying ? positionSec : 0}
          onClose={() => setBoostFor(null)}
        />
      )}
      {boostAllFor && (
        <BoostAllModal
          episode={boostAllFor}
          podcast={podcast}
          onClose={() => setBoostAllFor(null)}
        />
      )}
    </div>
  );
}
