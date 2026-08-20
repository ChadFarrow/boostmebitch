'use client';
import { useEffect, useState } from 'react';
import { useApp } from '@/lib/store';
import { fmtDate, fmtDuration } from '@/lib/format';
import { episodeContentsLabel, hasValueRecipients, httpUrl, stripHtml } from '@/lib/util';
import { ValueSplitRows } from './value-split-rows';
import { useChapters } from '@/lib/chapters';
import { useResolvedSplits } from '@/lib/track-art';
import { EpisodeContents } from './episode-contents';
import { LivePlayedTracks } from './live-played-tracks';
import { useTranscript, transcriptIndexAt } from '@/lib/transcript';
import { TranscriptPanel } from './transcript-ui';
import { useNotesFollows } from './notes-follows';
import { LinkedText } from './linked-text';
import { BoltIcon, ShareIcon, CoinIcon } from './icons';
import { PodcastCover } from './podcast-cover';
import { FavEpisodeHeart } from './fav-heart';
import { BoostModal } from './boost-modal';
import { BoostAllModal } from './boost-all-modal';
import { EpisodeNostrFeed } from './episode-nostr-feed';
import { useStreamPanel } from './streaming-settings';
import type { Episode, ValueBlock } from '@/lib/types';

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
      <ValueSplitRows value={value} />
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
// Mirrors the fullscreen player's EpisodeInfoPanel (About/Contents/Transcript),
// plus a Boosts tab for the episode's Nostr feed.
//
// `contents` is ONE tab holding the tracks and the chapters interleaved — see
// <EpisodeContents>. They were two tabs of near-identical rows that largely
// named the same songs.
type InfoTab = 'notes' | 'contents' | 'transcript' | 'boosts';

export function EpisodeDetailView() {
  const episode = useApp((s) => s.selectedEpisode);
  const podcast = useApp((s) => s.selectedPodcast);
  const closeEpisode = useApp((s) => s.closeEpisode);
  const play = useApp((s) => s.play);
  const requestSeek = useApp((s) => s.requestSeek);
  const togglePlay = useApp((s) => s.togglePlay);
  const current = useApp((s) => s.current);
  const isPlaying = useApp((s) => s.isPlaying);
  const positionSec = useApp((s) => s.positionSec);
  const openDiscussion = useApp((s) => s.openDiscussion);

  const [boostFor, setBoostFor] = useState<Episode | null>(null);
  const [boostAllFor, setBoostAllFor] = useState<Episode | null>(null);
  const [valueOpen, setValueOpen] = useState(false);
  // Above the early return below, so hook order stays stable.
  const { button: streamButton, panel: streamPanel } = useStreamPanel(
    podcast,
    hasValueRecipients(episode?.value ?? podcast?.value),
  );
  const [infoTab, setInfoTab] = useState<InfoTab>('notes');

  // Lifted here (not in child components) so the tab strip below knows which
  // sections have content. Both hooks no-op on an empty url. Above the early
  // return for stable hook order.
  const { chapters, loading: chaptersLoading } = useChapters(episode?.chaptersUrl ?? '');
  const { cues: transcriptCues, loading: transcriptLoading } = useTranscript(
    episode?.transcriptUrl ?? '',
    episode?.transcriptType,
  );
  // The episode's tracks. Same reason as the two above — the tab strip has to
  // know whether the section has content. Fetched here rather than passed in:
  // this view is showing a *chosen* episode, which is usually not the one
  // playing, so <Player>'s copy is for a different episode entirely. The
  // endpoint is CDN-cached for an hour and shared with both boost modals, and
  // the hook issues nothing at all for an episode with no windows.
  const splits = useResolvedSplits(episode ?? undefined);
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
  // `link` is raw feed text, and React does NOT block a `javascript:` href —
  // it only warns in dev. Same allowlist rule the show-notes sanitizer applies
  // to every other feed-supplied URL that reaches the DOM.
  const episodePageUrl = httpUrl(episode.link);
  const hasTracks = !!splits?.length;
  const hasChapters = !!chapters?.length;
  // One tab for both — <EpisodeContents> interleaves them.
  const hasContents = hasTracks || hasChapters;
  // One label for both sources — chapters win when present. See
  // `episodeContentsLabel`; the fullscreen player's tab strip shares it.
  const contentsLabel = episodeContentsLabel(splits, chapters);
  const hasTranscript = !!transcriptCues?.length;
  const hasBoosts = !!episode.guid; // the feed owns its own loading/empty state
  const chaptersPending = !!episode.chaptersUrl && chaptersLoading;
  const transcriptPending = !!episode.transcriptUrl && transcriptLoading;
  const anyInfo = hasShowNotes || hasContents || hasTranscript || hasBoosts || chaptersPending || transcriptPending;

  const infoTabs: InfoTab[] = [];
  if (hasShowNotes) infoTabs.push('notes');
  if (hasContents) infoTabs.push('contents');
  if (hasTranscript) infoTabs.push('transcript');
  if (hasBoosts) infoTabs.push('boosts');
  const showInfoTabs = infoTabs.length >= 2;
  const activeInfo: InfoTab =
    showInfoTabs && infoTabs.includes(infoTab) ? infoTab
    : infoTabs.length ? infoTabs[0]
    : chaptersPending ? 'contents'
    : transcriptPending ? 'transcript'
    : 'notes';
  const infoTabCls = (on: boolean) =>
    `shrink-0 whitespace-nowrap text-xs font-semibold uppercase tracking-widest px-4 py-2 rounded-full transition ${
      on ? 'bg-bolt text-ink shadow-sm' : 'text-muted hover:text-bone hover:bg-bone/5'
    }`;
  const infoLabel = (t: InfoTab) =>
    t === 'contents' ? contentsLabel
    : t === 'transcript' ? 'Transcript'
    : t === 'boosts' ? 'Boosts'
    : 'Show notes';

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
              <span>{fmtDate(episode.datePublished)}</span>
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
          <FavEpisodeHeart episode={episode} podcast={podcast} size="md" />
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
          {/* Streaming is a SHOW-scoped setting, so this edits the same keys as
              the show header's ≋ STREAM — it's here because this is the page a
              listener is on when they decide to play something, and sending it
              back to the show header to turn streaming on for what they're
              about to hear is a detour with no reason behind it. SUPPORT above
              is show-scoped from an episode page for the same reason. */}
          {streamButton}
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

        {streamPanel && <div className="border-t border-bone/10 pt-4">{streamPanel}</div>}

        {/* The songs a live broadcast has played so far, each favoritable — the
            live twin of the contents tab below, which has no timeline to list on
            a live item. Above the tabs rather than inside them: the log only
            exists while the show is on air, and a tab is a thing you have to
            know to open. Renders nothing on an ordinary episode, and nothing on
            a live item that is not the one playing — the log belongs to the
            broadcast being listened to, not to whichever page is open. */}
        <LivePlayedTracks
          episode={episode}
          fallbackImg={episode.image || podcast.image || podcast.artwork}
          className="border-t border-bone/10 pt-4"
        />

        {/* Show notes / Chapters / Transcript — tabbed so they don't all stack. */}
        {anyInfo && (
          <div className="border-t border-bone/10 pt-4">
            {showInfoTabs ? (
              <div className="inline-flex max-w-full overflow-x-auto gap-1 mb-4 p-1 rounded-full border border-bone/15 bg-bone/5">
                {infoTabs.map((t) => (
                  <button key={t} type="button" onClick={() => setInfoTab(t)} className={infoTabCls(activeInfo === t)}>
                    {t === 'contents' ? contentsLabel
                      : t === 'transcript' ? 'Transcript'
                      : t === 'boosts' ? 'Boosts'
                      : 'Show notes'}
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
                  <div className="text-sm text-bone/80 leading-relaxed whitespace-pre-wrap break-words overflow-x-hidden">
                    <LinkedText text={description} />
                  </div>
                ) : null}
                {/* Link out to the episode's own web page (some feeds' pages
                    carry richer content than the feed; PC20's mirrors the feed). */}
                {episodePageUrl && (
                  <a
                    href={episodePageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 mt-4 text-xs font-semibold uppercase tracking-widest text-muted hover:text-bolt transition"
                  >
                    Episode page ↗
                  </a>
                )}
              </>
            )}

            {/* The episode's own timeline — the tracks it played and its
                chapters, in ONE list. See <EpisodeContents>: the heart still
                rides on the valueTimeSplit window, and no chapter is ever mapped
                to one.

                `currentSec` is UNDEFINED unless this is the episode actually
                playing, so nothing highlights on a list someone is only reading
                — 0 would be a real position and would light up any window
                authored at startTime 0.

                `||`, never `??`, and `artwork` is not optional. Podcast Index
                returns "" rather than omitting an absent image, and `'' ?? x` is
                `''` — so on exactly the episodes with no art of their own, the
                ones this fallback exists for, it silently did nothing.
                `podcast.artwork` is the third link because a dead channel
                <image> beside a working <itunes:image> is the documented case
                (Homegrown Hits) that PodcastCover was written for; omitting it
                here fell back to a 404. */}
            {activeInfo === 'contents' && (
              hasContents ? (
                <EpisodeContents
                  splits={splits}
                  chapters={chapters}
                  currentSec={isThisPlaying ? positionSec : undefined}
                  onSeek={seekEpisodeTo}
                  fallbackImg={episode.image || podcast?.image || podcast?.artwork}
                />
              ) : (
                <p className="text-xs text-muted">Loading chapters…</p>
              )
            )}

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
