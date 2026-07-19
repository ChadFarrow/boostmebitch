'use client';
import { useEffect, useState } from 'react';
import { useApp } from '@/lib/store';
import { fmtDuration } from '@/lib/format';
import { hasValueRecipients, stripHtml } from '@/lib/util';
import { useChapters, type ChapterEntry } from '@/lib/chapters';
import { useTranscript, transcriptIndexAt } from '@/lib/transcript';
import { TranscriptPanel } from './transcript-ui';
import { useNotesFollows } from './notes-follows';
import { BoltIcon, ShareIcon, CoinIcon } from './icons';
import { PodcastCover } from './podcast-cover';
import { BoostModal } from './boost-modal';
import { BoostAllModal } from './boost-all-modal';
import { EpisodeNostrFeed } from './episode-nostr-feed';
import type { Episode, ValueBlock } from '@/lib/types';

// Chapter list. The fetch is lifted to EpisodeDetailView so the tab strip knows
// whether chapters exist. `activeIdx` (>= 0 only while this episode is playing)
// highlights the current chapter so the list tracks playback. Tapping a row
// seeks playback there via `onSeek`. No auto-scroll — the list flows in the
// page, and scrolling it would yank the whole page every chapter change (the
// fullscreen player's chapters highlight without scrolling too).
function ChaptersList({
  chapters,
  activeIdx,
  onSeek,
}: {
  chapters: ChapterEntry[];
  activeIdx: number;
  onSeek: (t: number) => void;
}) {
  return (
    <ul className="-mx-1 text-sm">
      {chapters.map((c, i) => {
        const on = i === activeIdx;
        return (
          <li
            key={i}
            className={`flex items-center gap-1 rounded-md transition ${
              on ? 'bg-bolt/10 ring-1 ring-inset ring-bolt/30' : ''
            }`}
          >
            <button
              type="button"
              onClick={() => onSeek(c.startTime)}
              title={`Jump to ${fmtDuration(c.startTime)}`}
              className={`flex-1 min-w-0 flex gap-3 items-center text-left px-3 py-1.5 rounded-md transition ${
                on ? '' : 'hover:bg-bone/5'
              }`}
            >
              {c.img && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={c.img}
                  alt=""
                  loading="lazy"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  className="w-10 h-10 rounded object-cover flex-shrink-0 border border-bone/15"
                />
              )}
              <span
                className={`tabular-nums text-xs w-12 flex-shrink-0 text-right ${
                  on ? 'text-bolt' : 'text-muted'
                }`}
              >
                {fmtDuration(c.startTime)}
              </span>
              <span className={`leading-snug break-words min-w-0 ${on ? 'text-bolt' : 'text-bone/85'}`}>
                {c.title ?? `Chapter ${i + 1}`}
              </span>
            </button>
            {c.url && (
              <a
                href={c.url}
                target="_blank"
                rel="noopener noreferrer"
                title="Open chapter link"
                aria-label="Open chapter link"
                className="flex-shrink-0 px-3 py-1.5 text-muted hover:text-bolt transition"
              >
                ↗
              </a>
            )}
          </li>
        );
      })}
    </ul>
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

// Tabs over the long content sections so the page doesn't stack them all.
// Mirrors the fullscreen player's EpisodeInfoPanel (About/Chapters/Transcript),
// plus a Boosts tab for the episode's Nostr feed.
type InfoTab = 'notes' | 'chapters' | 'transcript' | 'boosts';

export function EpisodeDetailView() {
  const episode = useApp((s) => s.selectedEpisode);
  const podcast = useApp((s) => s.selectedPodcast);
  const closeEpisode = useApp((s) => s.closeEpisode);
  const play = useApp((s) => s.play);
  const enqueueEpisode = useApp((s) => s.enqueueEpisode);
  const requestSeek = useApp((s) => s.requestSeek);
  const togglePlay = useApp((s) => s.togglePlay);
  const current = useApp((s) => s.current);
  const isPlaying = useApp((s) => s.isPlaying);
  const positionSec = useApp((s) => s.positionSec);
  const openDiscussion = useApp((s) => s.openDiscussion);

  const [boostFor, setBoostFor] = useState<Episode | null>(null);
  const [boostAllFor, setBoostAllFor] = useState<Episode | null>(null);
  const [valueOpen, setValueOpen] = useState(false);
  const [infoTab, setInfoTab] = useState<InfoTab>('notes');

  // Lifted here (not in child components) so the tab strip below knows which
  // sections have content. Both hooks no-op on an empty url. Above the early
  // return for stable hook order.
  const { chapters, loading: chaptersLoading } = useChapters(episode?.chaptersUrl ?? '');
  const { cues: transcriptCues, loading: transcriptLoading } = useTranscript(
    episode?.transcriptUrl ?? '',
    episode?.transcriptType,
  );
  // Callback ref for the show-notes container: injects Follow buttons after each
  // npub when signed in. No-op signed out.
  const notesFollowRef = useNotesFollows(episode?.id);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [episode?.id]);

  if (!episode || !podcast) return null;

  const value = episode.value ?? podcast.value;
  const hasValue = hasValueRecipients(value);
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

  // Which content sections exist, and which tab is active. A section gets a tab
  // only once it has content; a still-loading chapters/transcript renders its
  // own loading state under the active tab. Mirrors EpisodeInfoPanel.
  const hasShowNotes = !!episode.contentEncoded || !!description;
  const hasChapters = !!chapters?.length;
  const hasTranscript = !!transcriptCues?.length;
  const hasBoosts = !!episode.guid; // the feed owns its own loading/empty state
  const chaptersPending = !!episode.chaptersUrl && chaptersLoading;
  const transcriptPending = !!episode.transcriptUrl && transcriptLoading;
  const anyInfo = hasShowNotes || hasChapters || hasTranscript || hasBoosts || chaptersPending || transcriptPending;

  const infoTabs: InfoTab[] = [];
  if (hasShowNotes) infoTabs.push('notes');
  if (hasChapters) infoTabs.push('chapters');
  if (hasTranscript) infoTabs.push('transcript');
  if (hasBoosts) infoTabs.push('boosts');
  const showInfoTabs = infoTabs.length >= 2;
  const activeInfo: InfoTab =
    showInfoTabs && infoTabs.includes(infoTab) ? infoTab
    : infoTabs.length ? infoTabs[0]
    : chaptersPending ? 'chapters'
    : transcriptPending ? 'transcript'
    : 'notes';
  const infoTabCls = (on: boolean) =>
    `shrink-0 whitespace-nowrap text-xs font-semibold uppercase tracking-widest px-4 py-2 rounded-full transition ${
      on ? 'bg-bolt text-ink shadow-sm' : 'text-muted hover:text-bone hover:bg-bone/5'
    }`;
  const infoLabel = (t: InfoTab) =>
    t === 'chapters' ? `Chapters (${chapters?.length ?? 0})`
    : t === 'transcript' ? 'Transcript'
    : t === 'boosts' ? 'Boosts'
    : 'Show notes';

  // Highlight the current chapter/line only while THIS episode is the one
  // playing — otherwise the list is a static reference (-1 = nothing active).
  const chaptersActiveIdx =
    isThisPlaying && chapters
      ? chapters.reduce((acc, c, i) => (positionSec >= c.startTime ? i : acc), -1)
      : -1;
  const transcriptActiveIdx = isThisPlaying ? transcriptIndexAt(transcriptCues, positionSec) : -1;

  // Jump playback to a timestamp from a chapter/transcript tap. If this episode
  // is already current, seek in place; otherwise start it at that point.
  const seekEpisodeTo = (t: number) => {
    if (isThisPlaying) requestSeek(t);
    else play(episode!, podcast!, t);
  };

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
            className={isThisPlaying ? 'btn-bolt-soft' : 'btn'}
            aria-label={isThisPlaying && isPlaying ? 'Pause' : isThisPlaying ? 'Resume' : 'Play'}
          >
            {isThisPlaying && isPlaying ? '❚❚ PAUSE' : isThisPlaying ? '▶ RESUME' : '▶ PLAY'}
          </button>
          <button
            type="button"
            onClick={() => enqueueEpisode(episode, podcast)}
            className="btn-ghost"
            aria-label="Add to queue"
            title="Add to queue"
          >
            + queue
          </button>
          <EpisodeShareButton episode={episode} podcast={podcast} />
          {/* SUPPORT before BOOST to match the show page's cluster order
              (FAVORITE · SHARE · SUPPORT · BOOST). */}
          {podcast.funding?.[0]?.url ? (
            <a
              href={podcast.funding[0].url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost"
              title={podcast.funding[0].message || 'Support this show'}
            >
              <CoinIcon /> SUPPORT
            </a>
          ) : null}
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

        {/* Show notes / Chapters / Transcript — tabbed so they don't all stack. */}
        {anyInfo && (
          <div className="border-t border-bone/10 pt-4">
            {showInfoTabs ? (
              <div className="inline-flex max-w-full overflow-x-auto gap-1 mb-4 p-1 rounded-full border border-bone/15 bg-bone/5">
                {infoTabs.map((t) => (
                  <button key={t} type="button" onClick={() => setInfoTab(t)} className={infoTabCls(activeInfo === t)}>
                    {t === 'chapters' ? `Chapters (${chapters!.length})` : t === 'transcript' ? 'Transcript' : t === 'boosts' ? 'Boosts' : 'Show notes'}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-[11px] uppercase tracking-widest text-muted mb-2">{infoLabel(activeInfo)}</p>
            )}

            {activeInfo === 'notes' && (
              <>
                {episode.contentEncoded ? (
                  <div
                    ref={notesFollowRef}
                    className="show-notes text-sm text-bone/80 leading-relaxed overflow-x-hidden"
                    dangerouslySetInnerHTML={{ __html: episode.contentEncoded }}
                  />
                ) : description ? (
                  <div className="text-sm text-bone/80 leading-relaxed whitespace-pre-wrap overflow-x-hidden">
                    {description}
                  </div>
                ) : null}
                {/* Link out to the episode's own web page (some feeds' pages
                    carry richer content than the feed; PC20's mirrors the feed). */}
                {episode.link && (
                  <a
                    href={episode.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 mt-4 text-xs font-semibold uppercase tracking-widest text-muted hover:text-bolt transition"
                  >
                    Episode page ↗
                  </a>
                )}
              </>
            )}

            {activeInfo === 'chapters' &&
              (hasChapters
                ? <ChaptersList chapters={chapters!} activeIdx={chaptersActiveIdx} onSeek={seekEpisodeTo} />
                : <p className="text-xs text-muted">Loading chapters…</p>)}

            {activeInfo === 'transcript' && (
              <TranscriptPanel
                cues={transcriptCues}
                activeIdx={transcriptActiveIdx}
                onSeek={seekEpisodeTo}
                loading={transcriptLoading}
              />
            )}

            {/* Mounted only when active — lazy-loads the relay query (the feed
                paints its cache instantly on remount) and keeps its own
                loading/empty state. min-height reserves the feed's area so its
                short "searching relays…" first frame can't collapse the page
                height and yank the scroll position up when you open this tab. */}
            {activeInfo === 'boosts' && episode.guid && (
              <div className="min-h-[70vh]">
                <EpisodeNostrFeed episodeGuid={episode.guid} episodeTitle={episode.title} />
              </div>
            )}
          </div>
        )}
      </section>

      {/* Hidden while the now-playing bar is up — the mini-player carries its own
          BOOST button, and the episode's inline SHARE · SUPPORT · BOOST cluster
          remains — so the FAB would just overlap the bar. */}
      {hasValue && !playerVisible && (
        <button
          type="button"
          onClick={() => setBoostFor(episode)}
          className="btn-bolt fixed right-4 z-40 shadow-xl rounded-full"
          style={{ bottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}
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
