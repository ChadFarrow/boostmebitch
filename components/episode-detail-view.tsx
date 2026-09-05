'use client';
import { cloneElement, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '@/lib/store';
import { fmtDate, fmtDuration } from '@/lib/format';
import { episodeContentsLabel, hasValueRecipients, httpUrl, payableValue, showShareUrl, stripHtml } from '@/lib/util';
import { ValueSplitRows } from './value-split-rows';
import { useChapters } from '@/lib/chapters';
import { useResolvedSplits } from '@/lib/track-art';
import { EpisodeContents } from './episode-contents';
import { LivePlayedTracks } from './live-played-tracks';
import { useTranscript, transcriptIndexAt } from '@/lib/transcript';
import { TranscriptPanel } from './transcript-ui';
import { useNotesFollows } from './notes-follows';
import { LinkedText } from './linked-text';
import { CopyLinkButton } from './copy-link-button';
import { BoltIcon, CoinIcon } from './icons';
import { PodcastCover } from './podcast-cover';
import { FavEpisodeHeart } from './fav-heart';
import { BoostModal } from './boost-modal';
import { BoostAllModal } from './boost-all-modal';
import { EpisodeNostrFeed } from './episode-nostr-feed';
import { useStreamPanel } from './streaming-settings';
import { UnderlineTabs } from './underline-tabs';
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

/**
 * SHARE on the episode page — a link to THIS episode, not to its show.
 *
 * Two things it used to do itself and no longer does. It hand-rolled the
 * clipboard write and the COPIED flash, which is the fourth copy of a widget
 * whose whole reason for existing is that copies drift; `<CopyLinkButton>`
 * also clears its timeout on unmount, which this one never did. And it built
 * the URL from `window.location.pathname`, which `showShareUrl` exists to
 * forbid: `?podcast=`/`?episode=` are restored by `<HomePage>`'s mount effect
 * and by nothing else, so a pathname-based link is correct only while the app
 * is served from `/` — true of this view today, and silently false the moment
 * an episode renders anywhere else.
 *
 * The early return stays: on a page about one episode, a button labelled
 * "copy link to this episode" that copies a show link is worse than no button.
 */
function EpisodeShareButton({ episode, podcast }: { episode: Episode; podcast: NonNullable<ReturnType<typeof useApp.getState>['selectedPodcast']> }) {
  if (!episode.guid || !podcast.podcastGuid) return null;
  return (
    <CopyLinkButton
      url={showShareUrl(podcast.podcastGuid, episode.guid)}
      title="Copy link to this episode"
      className="tile"
    />
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
  // The MORE tile's menu — the two actions that are real but rare (boost every
  // track at once, open the episode's own web page). Dismissed on
  // outside-click and Escape, same as <AuthControl>'s dropdown.
  //
  // IT PORTALS TO document.body, and that is not a style choice. The layout
  // wraps {children} in `relative z-0` (app/layout.tsx), which is a stacking
  // context — so no z-index inside it can rise above the root-level <TabBar>
  // and mini-bar at z-30, whatever number it carries. Rendered in place at
  // z-40 the menu opened downward into the dock and its items were painted
  // over. This is the same reason CLAUDE.md requires modals to portal; a menu
  // that opens near the bottom of the viewport has the identical problem.
  //
  // OUTSIDE-CLICK TESTS BOTH ELEMENTS, and both tests are `?.` rather than a
  // `ref.current &&` guard. The trigger is CONDITIONALLY rendered — an episode
  // with no tracks and no `link` has no MORE tile at all — so a guard that
  // requires the ref to be live turns "the trigger went away" into "do
  // nothing": `moreOpen` stays true, the effect never re-runs its cleanup, and
  // both document listeners outlive the menu. Come back to an episode that
  // does have the tile and it is already open with no gesture.
  const [moreOpen, setMoreOpen] = useState(false);
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const [moreAt, setMoreAt] = useState<{ top?: number; bottom?: number; right: number } | null>(null);

  // Measured from the trigger each time, and again on scroll and resize: a
  // `fixed` element does not follow the page. Below the trigger when there is
  // room for the two rows, above it otherwise, and the right edge is clamped
  // to the viewport so the last tile in the row cannot push it off-screen.
  const placeMore = useCallback(() => {
    const el = moreBtnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const right = Math.max(8, window.innerWidth - r.right);
    setMoreAt(
      window.innerHeight - r.bottom >= 140
        ? { top: r.bottom + 8, right }
        : { bottom: window.innerHeight - r.top + 8, right },
    );
  }, []);

  useEffect(() => {
    if (!moreOpen) return;
    placeMore();
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (moreBtnRef.current?.contains(t) || moreMenuRef.current?.contains(t)) return;
      setMoreOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setMoreOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', placeMore, true);
    window.addEventListener('resize', placeMore);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', placeMore, true);
      window.removeEventListener('resize', placeMore);
    };
  }, [moreOpen, placeMore]);
  // Above the early return below, so hook order stays stable.
  const { button: streamButton, panel: streamPanel } = useStreamPanel(
    podcast,
    hasValueRecipients(payableValue(episode, podcast)),
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
    // A menu belongs to the episode it was opened on. Closing it here is the
    // belt to the outside-click brace above: the next episode may have no MORE
    // tile at all, and an open menu with no trigger is not something the user
    // can dismiss.
    setMoreOpen(false);
  }, [episode?.id]);

  if (!episode || !podcast) return null;

  const value = payableValue(episode, podcast);
  const hasValue = hasValueRecipients(value);
  const isThisPlaying = current?.episode.id === episode.id;
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

  // A link to one moment of this episode, for the rows of <EpisodeContents>.
  // `undefined` — not a builder returning null — when the episode has no guid:
  // `showShareUrl(guid, undefined, t)` returns a SHOW link, so a builder that
  // fell through would give every row a button copying the same link to the
  // whole show, which is the failure <ShareTargets> already documents.
  const rowShareUrl = episode.guid
    ? (t: number) => showShareUrl(podcast.podcastGuid, episode.guid, t)
    : undefined;

  return (
    <div>
      <button onClick={closeEpisode} className="btn-ghost text-xs mb-3">
        ← back to episodes
      </button>

      <section className="card p-4 space-y-5">
        {/* Cover beside the title, not above it. Centred at 192px the cover
            cost a phone the whole first screen before a word of the title;
            at 112px in the left column the title, show and date sit level
            with it and the actions land above the fold. Larger from sm: up,
            where there is room. */}
        <div className="grid grid-cols-[112px_1fr] sm:grid-cols-[160px_1fr] gap-4 items-start">
          <PodcastCover
            image={episode.image ?? podcast.image}
            artwork={podcast.artwork}
            title={episode.title}
            seed={episode.guid ?? String(episode.id)}
            className="w-28 h-28 sm:w-40 sm:h-40 border border-bone/20 text-3xl sm:text-4xl"
          />
          <div className="min-w-0">
            <h2 className="font-display text-xl sm:text-3xl font-semibold leading-tight">
              {episode.title}
            </h2>
            <p className="text-xs sm:text-sm text-muted mt-1">{podcast.title}</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted mt-2">
              {episode.datePublished && (
                <span>{fmtDate(episode.datePublished)}</span>
              )}
              {episode.duration ? <span>{fmtDuration(episode.duration)}</span> : null}
              {episode.episode ? <span>Episode {episode.episode}</span> : null}
              {episode.season ? <span>Season {episode.season}</span> : null}
            </div>
          </div>
        </div>

        {/* TWO primaries, then ONE row of peers.

            This was eight buttons in a wrapping row at four different sizes
            (.btn, .btn-ghost text-xs, .btn-ghost text-[11px], .stamp) — PLAY,
            FAVORITE, SHARE, SUPPORT, STREAM, BOOST, DISCUSSION and "Boost 12
            tracks" all competing as equals, and on a 390px screen BOOST wrapped
            to a line of its own. The page has two actions that matter: play
            it, and pay for it. Those are 44px and full width. Everything else
            is a `.tile` — glyph over word, one size — and the two rare ones
            (boost every track, open the episode page) live behind MORE rather
            than as a fifth and sixth peer.

            BOOST is gated on `hasValue` exactly as before; without a value
            block PLAY takes both columns. The FAB that used to float BOOST
            over the page while nothing was playing is gone: BOOST is a primary
            up here now, and the mini-bar carries its own once playback starts. */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={handlePlay}
            className={`h-11 w-full ${isThisPlaying ? 'btn-bolt-soft' : 'btn'} ${hasValue ? '' : 'col-span-2'}`}
            aria-label={isThisPlaying && isPlaying ? 'Pause' : isThisPlaying ? 'Resume' : 'Play'}
          >
            {isThisPlaying && isPlaying ? '❚❚ PAUSE' : isThisPlaying ? '▶ RESUME' : '▶ PLAY'}
          </button>
          {hasValue && (
            <button
              type="button"
              onClick={() => setBoostFor(episode)}
              className="btn-bolt h-11 w-full"
              aria-label="Boost this episode"
            >
              <BoltIcon /> BOOST
            </button>
          )}
        </div>
        {/* auto-fit at 56px: SUPPORT, STREAM and DISCUSS are each conditional,
            so the row is three to six tiles wide and every tile takes an equal
            share of whatever that is. */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(56px,1fr))] gap-2">
          <FavEpisodeHeart episode={episode} podcast={podcast} size="tile" />
          <EpisodeShareButton episode={episode} podcast={podcast} />
          {/* Streaming is a SHOW-scoped setting, so this edits the same keys as
              the show header's STREAM — it's here because this is the page a
              listener is on when they decide to play something, and sending
              them back to the show header to turn streaming on for what
              they're about to hear is a detour with no reason behind it.
              SUPPORT below is show-scoped from an episode page for the same
              reason.
              `cloneElement` to restyle rather than a prop on `useStreamPanel`:
              the hook lives in streaming-settings.tsx, a money-path file, and
              this is a class name. The button's handler, aria-expanded and
              title are untouched. */}
          {streamButton && cloneElement(
            streamButton,
            { className: 'tile' },
            <span aria-hidden className="text-lg leading-none">≋</span>,
            'STREAM',
          )}
          {podcast.funding?.[0]?.url ? (
            <a
              href={podcast.funding[0].url}
              target="_blank"
              rel="noopener noreferrer"
              className="tile"
              title={podcast.funding[0].message || 'Support this show'}
            >
              <CoinIcon /> SUPPORT
            </a>
          ) : null}
          {episode.socialInteract?.length ? (
            <button
              type="button"
              onClick={() => openDiscussion(episode)}
              className="tile hover:border-nostr/70 hover:text-nostr"
              aria-label="Open episode discussion"
            >
              <span aria-hidden className="text-lg leading-none">💬</span> DISCUSS
            </button>
          ) : null}
          {(episode.valueTimeSplits?.length || episodePageUrl) ? (
            <>
              <button
                ref={moreBtnRef}
                type="button"
                onClick={() => setMoreOpen((v) => !v)}
                className={`tile ${moreOpen ? 'border-bone bg-bone/5' : ''}`}
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                aria-label="More actions"
              >
                <span aria-hidden className="text-lg leading-none">⋯</span> MORE
              </button>
              {/* Portalled and `fixed` — see the state above for why an
                  in-place z-index cannot clear the dock. z-40 in the ROOT
                  stacking context, so it is over <TabBar> and the mini-bar
                  (z-30) and still under <ModalShell> (z-[60]) and the iOS
                  status strip (z-[70]). */}
              {moreOpen && moreAt && createPortal(
                <div
                  ref={moreMenuRef}
                  role="menu"
                  className="fixed w-64 max-w-[calc(100vw-1rem)] card bg-ink p-1 z-40 shadow-xl"
                  style={{ top: moreAt.top, bottom: moreAt.bottom, right: moreAt.right }}
                >
                  {episode.valueTimeSplits?.length ? (
                    <button
                      role="menuitem"
                      type="button"
                      onClick={() => { setMoreOpen(false); setBoostAllFor(episode); }}
                      className="w-full text-left px-3 h-11 hover:bg-bone/5 transition flex items-center gap-2 text-sm"
                    >
                      <span className="text-bolt">⚡</span>
                      <span>Boost all {episode.valueTimeSplits.length} tracks</span>
                    </button>
                  ) : null}
                  {/* `link` is raw feed text, and React does NOT block a
                      `javascript:` href — it only warns in dev. `httpUrl` is the
                      same allowlist the show-notes sanitizer applies. */}
                  {episodePageUrl ? (
                    <a
                      role="menuitem"
                      href={episodePageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setMoreOpen(false)}
                      className="w-full text-left px-3 h-11 hover:bg-bone/5 transition flex items-center gap-2 text-sm"
                    >
                      <span className="text-muted">↗</span>
                      <span>Open episode page</span>
                    </a>
                  ) : null}
                </div>,
                document.body,
              )}
            </>
          ) : null}
        </div>

        {/* Value split — a hairline disclosure row, not a stamp. The stamp was
            the one 10px bordered thing among 38px buttons, and it read as a
            badge rather than a control. A full-width 44px row is a control. */}
        {value && (
          <div className="border-t border-bone/10">
            <button
              type="button"
              onClick={() => setValueOpen((v) => !v)}
              className="flex w-full items-center gap-2 h-11 text-xs text-muted hover:text-bone transition"
              aria-expanded={valueOpen}
            >
              <BoltIcon className="w-3.5 h-3.5 text-bolt" />
              <span>Splits to {value.recipients?.length ?? 0} recipient{(value.recipients?.length ?? 0) === 1 ? '' : 's'}</span>
              <span aria-hidden className={`ml-auto transition-transform ${valueOpen ? 'rotate-180' : ''}`}>▾</span>
            </button>
            {valueOpen && <div className="pb-2"><ValueSplitSection value={value} /></div>}
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
              // One strip shared with the fullscreen player — see
              // <UnderlineTabs> for why it is an underline and not a pill.
              <UnderlineTabs
                className="mb-4"
                tabs={infoTabs.map((t) => ({ id: t, label: infoLabel(t) }))}
                active={activeInfo}
                onChange={setInfoTab}
              />
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
                  shareUrlFor={rowShareUrl}
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
