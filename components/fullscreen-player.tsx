'use client';
import { CopyLinkButton } from './copy-link-button';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { OutPortal, type HtmlPortalNode } from 'react-reverse-portal';
import { useApp } from '@/lib/store';
import { fmt } from '@/lib/format';
import { chapterState, buildChapterNav, type ChapterEntry } from '@/lib/chapters';
import { nowPlayingArt } from '@/lib/track-art';
import { lockScroll } from '@/lib/scroll-lock';
import { ChapterTicks, ChapterLabel } from './chapter-ui';
import type { TranscriptCue } from '@/lib/transcript';
import { TranscriptPanel } from './transcript-ui';
import { EpisodeContents } from './episode-contents';
import { LivePlayedTracks } from './live-played-tracks';
import type { Episode, Podcast, ValueTimeSplit } from '@/lib/types';
import { parseStreamId, isLiveStreamId } from '@/lib/nostr';
import { nip19 } from 'nostr-tools';
import { BoltIcon, PipIcon, FullscreenIcon, ExitFullscreenIcon } from './icons';
import {
  episodeContentsLabel,
  hasValueRecipients,
  payableValue,
  isMusicMedium,
  showShareUrl,
  targetWord,
  stripHtml,
  fullscreenElement,
  fullscreenSupported,
  toggleFullscreen,
  exitFullscreen,
} from '@/lib/util';
import { EpisodeSocialThread } from './episode-social-thread';
import { LinkedText } from './linked-text';
import { UnderlineTabs } from './underline-tabs';
import { PodcastCover } from './podcast-cover';
import { FavEpisodeHeart, FavHeart } from './fav-heart';
import { ValueSplitRows } from './value-split-rows';
import { TransportControls } from './transport-controls';
import { VideoToggle } from './video-toggle';
import { LiveChat } from './live-chat';
import { StreamMeter, useStreamPanel } from './streaming-settings';
import { useLiveBlockImage } from './live-now-playing';

// About-this-episode text + the episode's tracks + Podcasting 2.0 chapters +
// transcript, toggled by a tab strip. Tabs show only for sections with real
// content (2+); a lone section renders under a plain label. A still-loading
// section renders its own loading state. Returns null when there's nothing to
// show and nothing loading.
//
// `contents` is ONE tab holding the tracks and the chapters interleaved — see
// <EpisodeContents>. They were two tabs of near-identical rows that largely
// named the same songs.
type InfoTab = 'about' | 'contents' | 'transcript';
function EpisodeInfoPanel({
  description,
  splits,
  chapters,
  chaptersLoading,
  hasChaptersUrl,
  transcriptCues,
  transcriptLoading,
  transcriptActiveIdx,
  hasTranscriptUrl,
  onSeek,
  currentSec,
  shareUrlFor,
  chapterFallbackImg,
}: {
  description: string;
  /** Resolved `<podcast:valueTimeSplit>` windows — the tracks this episode
   *  played. Fetched once by <Player> for the same reason `chapters` is: this
   *  component is always mounted, so its own hook would double the request. */
  splits: ValueTimeSplit[] | null;
  chapters: ChapterEntry[] | null;
  chaptersLoading: boolean;
  hasChaptersUrl: boolean;
  transcriptCues: TranscriptCue[] | null;
  transcriptLoading: boolean;
  transcriptActiveIdx: number;
  hasTranscriptUrl: boolean;
  onSeek: (s: number) => void;
  currentSec: number;
  /** Builds a link to one moment of this episode, for the rows of
   *  <EpisodeContents>. Threaded from the render site rather than rebuilt here:
   *  this panel has never taken `episode`/`podcast`, and the guard against
   *  `showShareUrl(guid, undefined, t)` falling through to a SHOW link belongs
   *  where those are in scope. */
  shareUrlFor?: (startSec: number) => string | null;
  // The episode's own art, for chapters that ship no `img` of their own.
  chapterFallbackImg?: string;
}) {
  const [tab, setTab] = useState<InfoTab>('about');

  const hasDescription = !!description;
  const hasTracks = !!splits?.length;
  const hasChapters = !!chapters?.length;
  // One tab for both — <EpisodeContents> interleaves them.
  const hasContents = hasTracks || hasChapters;
  // One label for both sources — chapters win when present. See
  // `episodeContentsLabel`; the episode page's tab strip shares it.
  const contentsLabel = episodeContentsLabel(splits, chapters);
  const hasTranscript = !!transcriptCues?.length;
  const chaptersPending = hasChaptersUrl && chaptersLoading;
  const transcriptPending = hasTranscriptUrl && transcriptLoading;
  if (
    !hasDescription && !hasContents && !hasTranscript
    && !chaptersPending && !transcriptPending
  ) {
    return null;
  }

  // Only sections with loaded content get a tab; a pending section joins once
  // it resolves.
  const tabs: InfoTab[] = [];
  if (hasDescription) tabs.push('about');
  if (hasContents) tabs.push('contents');
  if (hasTranscript) tabs.push('transcript');

  const showTabs = tabs.length >= 2;
  const active: InfoTab =
    showTabs && tabs.includes(tab) ? tab
    : tabs.length ? tabs[0]
    : chaptersPending ? 'contents'
    : 'transcript';

  const label = (t: InfoTab) =>
    t === 'contents' ? contentsLabel
    : t === 'transcript' ? 'Transcript'
    : 'About this episode';

  return (
    <div className="border-t border-bone/10 pt-5">
      {showTabs ? (
        // One strip shared with the episode page — see <UnderlineTabs>. The
        // tab says "About" where the lone-section label below says "About this
        // episode": a tab is one word among peers, a label stands alone.
        <UnderlineTabs
          className="mb-4"
          tabs={tabs.map((t) => ({ id: t, label: t === 'about' ? 'About' : label(t) }))}
          active={active}
          onChange={setTab}
        />
      ) : (
        <p className="text-[11px] uppercase tracking-widest text-muted mb-2">{label(active)}</p>
      )}

      {active === 'about' && hasDescription && (
        <div className="text-sm text-bone/80 leading-relaxed whitespace-pre-wrap break-words">
          {/* Bare URLs a feed wrote as plain text become real links — this pane
              renders the stripHtml'd description, so without it a "Links:"
              block is text you can only select and paste. */}
          <LinkedText text={description} />
        </div>
      )}

      {/* The episode's own timeline — the tracks it played and its chapters, in
          ONE list, each row seekable and each TRACK row favoritable. The heart
          rides on the valueTimeSplit window; no chapter is ever mapped to one.
          See <EpisodeContents>. */}
      {active === 'contents' &&
        (hasContents ? (
          <EpisodeContents
            splits={splits}
            chapters={chapters}
            currentSec={currentSec}
            onSeek={onSeek}
            shareUrlFor={shareUrlFor}
            fallbackImg={chapterFallbackImg}
          />
        ) : (
          <p className="text-xs text-muted">Loading chapters…</p>
        ))}

      {active === 'transcript' && (
        <TranscriptPanel
          cues={transcriptCues}
          activeIdx={transcriptActiveIdx}
          onSeek={onSeek}
          loading={transcriptLoading}
        />
      )}
    </div>
  );
}

// SHARE for a Nostr live stream. It hands out the PERMANENT per-host link
// `/live/<npub>` — not the per-broadcast `/stream/<naddr>` — so a show can
// share one URL that stays valid across broadcasts (each gets a fresh dTag).
// The npub is the HOST's (episode.liveHostPubkey), NOT the stream id's author
// half: platform-published streams (Shosho, zap.stream) are authored by the
// PLATFORM's key, and `/live/<platform npub>` resolves to whatever that
// platform streams next — a different show entirely.
//
// Separate from <ShareTargets> below, and not a branch inside it: this renders
// only in the live-chat pane, where `liveStreamId` is the condition of the
// branch, so the podcast case was unreachable code that read as a fallback.
function LiveShareButton({
  liveStreamId,
  liveHostPubkey,
}: {
  liveStreamId: string;
  liveHostPubkey?: string;
}) {
  function buildUrl(): string | null {
    if (typeof window === 'undefined') return null;
    const parsed = parseStreamId(liveStreamId);
    if (!parsed) return null;
    return `${window.location.origin}/live/${nip19.npubEncode(liveHostPubkey ?? parsed.pubkey)}`;
  }

  return <CopyLinkButton url={buildUrl()} title="Copy link to this stream" />;
}

/**
 * The player's two SHARE buttons: one for the show, one for the episode on
 * screen, each naming its target the way the two hearts beside them do.
 *
 * They are two controls rather than one because this surface presents two
 * things and the links are not interchangeable: a show link opens the show, an
 * episode link opens that episode. A single button has to pick, and whichever
 * it picks is wrong for someone — sharing the show loses the episode you were
 * listening to, sharing the episode loses the way to hand somebody the show.
 * Neither failure is visible from here: the copy succeeds, the URL reads
 * plausibly, and the person who finds out is the one who opens it.
 *
 * `targetWord` supplies the noun, so a music feed reads `[↗ ALBUM] [↗ TRACK]`
 * and the hearts above never disagree with the shares below about what an item
 * is called.
 */
function ShareTargets({ podcast, episode }: { podcast: Podcast; episode: Episode }) {
  const showWord = targetWord('feed', podcast);
  const itemWord = targetWord('item', podcast);
  // Never `showShareUrl(guid, undefined)` for the episode button: that returns
  // the SHOW link, so a guid-less episode would render two identical links
  // under two different words.
  const episodeUrl = episode.guid ? showShareUrl(podcast.podcastGuid, episode.guid) : null;
  return (
    <>
      <CopyLinkButton
        url={showShareUrl(podcast.podcastGuid)}
        title={`Copy link to this ${showWord.toLowerCase()}`}
        word={showWord}
      />
      <CopyLinkButton
        url={episodeUrl}
        title={`Copy link to this ${itemWord.toLowerCase()}`}
        word={itemWord}
      />
    </>
  );
}

export function FullscreenPlayer({
  open,
  duration,
  onSeek,
  onSkip,
  videoNode,
  videoRef,
  isVideo,
  audioErr,
  artOk,
  splitArt,
  splits,
  pipAvailable,
  onPip,
  chapters,
  chaptersLoading,
  transcriptCues,
  transcriptLoading,
  transcriptActiveIdx,
  hasTranscriptUrl,
  onClose,
  onBoost,
}: {
  open: boolean;
  duration: number;
  /** Seek the active media element (audio or video) — owned by <Player>, which
      knows which element is live. Also updates the store position. */
  onSeek: (s: number) => void;
  /** Jump by a signed number of seconds from wherever playback actually is.
   *  Separate from `onSeek` because it is RELATIVE — see `skipBy` in
   *  <Player> for why that can't be built out of `onSeek` + `positionSec`. */
  onSkip: (deltaSec: number) => void;
  videoNode: HtmlPortalNode | null;
  /** The single <video> element, owned by <Player>. Needed only for the iPhone
   *  fullscreen fallback (`webkitEnterFullscreen`), which takes the element
   *  itself — everything else fullscreens the stage div around it. */
  videoRef: RefObject<HTMLVideoElement | null>;
  isVideo: boolean;
  /** Playback error from <Player> — the fullscreen surface must show it too,
      or a failing live stream reads as a silent black box (the mini-bar's tiny
      error line is hidden behind this overlay). */
  audioErr: string | null;
  /** False when audio is playing and the buffer can't afford heavy artwork —
   *  <Player>'s `artUsable`, which is the gate AND the "is anything actually
   *  playing" test, since a paused element has no enclosure to starve. Passed
   *  down rather than recomputed so both art surfaces share one verdict; a gate
   *  applied to only one of them doesn't help at all. */
  artOk: boolean;
  /** Cover of the track a <podcast:valueTimeSplit> is redirecting to right now,
   *  resolved once per episode by <Player> (`useResolvedSplits` + `splitArtAt`,
   *  `lib/track-art.ts`) — this component is
   *  always mounted, so its own hook would double every episode's request. */
  splitArt?: string;
  /** The same windows `splitArt` was picked out of, in full — the episode's
   *  tracks, for the Tracks tab. One fetch, two readers, for the reason above. */
  splits: ValueTimeSplit[] | null;
  pipAvailable: boolean;
  onPip: () => void;
  // Fetched once by <Player> and passed down (so it isn't fetched twice).
  chapters: ChapterEntry[] | null;
  chaptersLoading: boolean;
  transcriptCues: TranscriptCue[] | null;
  transcriptLoading: boolean;
  transcriptActiveIdx: number;
  hasTranscriptUrl: boolean;
  onClose: () => void;
  onBoost: () => void;
}) {
  // Per-field selectors (see the note in player.tsx) — a bare useApp() here
  // re-renders the whole fullscreen surface on every unrelated store write.
  const current = useApp((s) => s.current);
  const isPlaying = useApp((s) => s.isPlaying);
  const positionSec = useApp((s) => s.positionSec);
  const episodeQueue = useApp((s) => s.episodeQueue);
  const play = useApp((s) => s.play);
  const togglePlay = useApp((s) => s.togglePlay);
  const identity = useApp((s) => s.identity);
  const setSignInOpen = useApp((s) => s.setSignInOpen);
  const [valueOpen, setValueOpen] = useState(false);

  // Lock the page behind the overlay. This used to be a local `overflow:
  // hidden` on <html> and <body>, which is not a scroll lock on iOS: in the
  // installed home-screen app WebKit scrolled the web view anyway, and
  // `position: fixed` elements travel with the document when it does — so this
  // overlay slid off the top of the screen and the browse page showed in the
  // strip below it. The shared module is the fix AND the refcount: a BOOST
  // modal opens from in here, and two independent locks over one <body> mean
  // whichever releases first unlocks the page under the other one.
  useEffect(() => {
    if (!open) return;
    return lockScroll();
  }, [open]);

  // Above the `!current` return — hook order has to stay stable, and the hook
  // no-ops while there's nothing playing.
  const { button: streamButton, panel: streamPanel } = useStreamPanel(
    current?.podcast,
    hasValueRecipients(payableValue(current?.episode, current?.podcast)),
  );

  // Above the early return, like useStreamPanel — it takes an optional guid and
  // returns null for anything that isn't a live block, so hoisting costs nothing.
  const liveBlockImage = useLiveBlockImage(current?.episode.guid);

  // Native fullscreen for the video stage. `fsOk` is feature detection (recomputed
  // per item and per audio/video switch, mirroring <Player>'s pipOk effect — the
  // stage div only exists while isVideo, so it has to run after that render).
  const stageRef = useRef<HTMLDivElement>(null);
  const [fsOk, setFsOk] = useState(false);
  const [fsOn, setFsOn] = useState(false);

  useEffect(() => {
    setFsOk(isVideo && fullscreenSupported(stageRef.current, videoRef.current));
  }, [isVideo, current?.episode.id, videoRef]);

  // Keep the button's label honest. The iPhone path (webkitEnterFullscreen) fires
  // neither event and never sets document.fullscreenElement, so there the label
  // stays "Full screen" — iOS draws its own player chrome and owns the exit.
  useEffect(() => {
    const sync = () => setFsOn(!!fullscreenElement());
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);

  // Latches on first open and never resets — see the mount gate in the render
  // below for why the subtree is gated on this rather than on `open`.
  const [everOpened, setEverOpened] = useState(false);
  useEffect(() => { if (open) setEverOpened(true); }, [open]);

  // Collapsing the player while the stage is fullscreen would leave a top-layer
  // video covering the whole app with no way back — the overlay it belongs to is
  // gone. Exit with it.
  useEffect(() => {
    if (!open) void exitFullscreen();
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
  // Video mode hands the left column more of the screen at lg+ (60/40); audio
  // mode keeps the square-artwork 50/50. Both panes carry EXPLICIT complementary
  // widths: the media column is flex-shrink-0, so leaving the info pane at
  // sm:w-1/2 would make the real split a side effect of flex shrinking. The
  // widening starts at lg, not sm — between 640 and 1023 a 40% info pane is
  // 256–410px, too tight for the title + seek + transport/BOOST row it pins.
  const mediaPane = isVideo ? 'sm:w-1/2 lg:w-3/5' : 'sm:w-1/2';
  const infoPane = isVideo ? 'sm:w-1/2 lg:w-2/5' : 'sm:w-1/2';
  // NOT `episode.value ?? podcast.value`. On a PLAYLIST the container's block
  // is the curator's, and this one expression decides both the BOOST button and
  // (through useStreamPanel above) the unattended streaming payer.
  const value = payableValue(episode, podcast);
  const hasValue = hasValueRecipients(value);
  const description = episode.description ? stripHtml(episode.description) : '';
  const { index: activeIdx, chapter: activeChapter, end: activeChapterEnd } = chapterState(
    chapters,
    positionSec,
    duration,
  );

  function seekTo(s: number) {
    onSeek(s);
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
      {/* MOUNT GATE. "Closed" here is a CSS transform, not an unmount, so this
          whole subtree used to be live whenever an episode was loaded — and it
          is not a passive tree. <LiveChat> opens a SECOND SimplePool (~7
          WebSockets, a persistent subscription and a 12 s poll) and
          <EpisodeSocialThread> fires a BFS relay query per episode, both of them
          off-screen, for a user who may never open this player. The subtree also
          subscribes to positionSec, so it reconciled once a second while
          invisible.

          `everOpened`, not `open`: once the user has been in here, the panes
          keep their state (scroll position, selected tab, loaded chat history)
          across a close/reopen. The slide transition still works because the
          container itself is always mounted — only its contents are gated. */}
      {everOpened && (<>
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
      {/* `overscroll-contain` on this row, which is the overlay's scroll
          boundary: a swipe past its end chains outward to the document, and on
          iOS a document scroll drags every `position: fixed` element with it —
          this overlay and the mini-player bar both. Containing it here covers
          the nested lists too (the album list, the transcript box), because
          chaining walks outward to the nearest scrollable ancestor. */}
      <div className={`flex-1 min-h-0 flex flex-col sm:flex-row overscroll-contain ${liveStreamId ? 'overflow-hidden sm:overflow-y-auto' : 'overflow-y-auto'}`}>
        {/* Artwork (or live video) — centered in the left half; sticky so it
            stays put as the page scrolls. For HLS streams the shared <video>
            is displayed here via its OutPortal while the player is open; when
            closed it moves back to the mini-bar so audio keeps playing. */}
        {/* sm:h-full, NOT a calc against the viewport. Both panes used to be
            `h-[calc(100vh-3.5rem)]`, which guesses at the header's height and
            measures against the wrong viewport unit: the overlay is 100dvh, the
            header is whatever its buttons make it (the signed-out SIGN IN button
            alone changes it), and every pixel the guess is short by is overflow
            in this row — which is `overflow-y-auto`, so it shows up as a
            scrollbar down the whole page. `h-full` resolves against the row's own
            definite height, so the panes fit exactly whatever the header does. */}
        <div className={`flex flex-col items-center justify-center gap-4 p-4 sm:p-6 lg:p-10 flex-shrink-0 ${mediaPane} sm:sticky sm:top-0 sm:self-start sm:h-full`}>
          {isVideo ? (
            // The width cap is bounded by the AVAILABLE HEIGHT, not by a max-h:
            // the box is aspect-video, so height derives from width, and clamping
            // the height while w-full held the width would break the 16:9 frame.
            // 13rem is what the screen spends around it — the header (~3.5rem,
            // more when signed out), lg:p-10 top+bottom, the gap-4, and the
            // AUDIO/VIDEO pill — rounded UP deliberately: this column has no
            // overflow of its own, so anything it can't fit becomes a scrollbar
            // on the row. `video-stage` sheds all of this in the browser's top
            // layer (see app/globals.css).
            <div
              ref={stageRef}
              className="video-stage relative w-full max-w-md sm:max-w-lg lg:max-w-[min(64rem,calc((100dvh-13rem)*16/9))] aspect-video rounded-xl border border-bone/10 shadow-2xl overflow-hidden bg-black"
            >
              {open && videoNode && <OutPortal node={videoNode} />}
              {/* Play/pause lives on the video itself (tap anywhere to toggle).
                  The glyph is prominent while paused and fades out while playing
                  — reappearing on tap — so it doesn't cover the stream. */}
              <button
                type="button"
                onClick={() => togglePlay()}
                aria-label={isPlaying ? 'Pause' : 'Play'}
                className="group absolute inset-0 flex items-center justify-center"
              >
                <span
                  className={`flex items-center justify-center w-16 h-16 rounded-full bg-ink/55 text-bone text-2xl backdrop-blur-sm transition-opacity duration-200 ${
                    isPlaying ? 'opacity-0 group-hover:opacity-100 group-active:opacity-100' : 'opacity-100'
                  }`}
                >
                  {isPlaying ? '❚❚' : '▶'}
                </span>
              </button>
              {/* Playback error banner — sits over the (black) video so the
                  failure is readable right where the stream should be.
                  pointer-events-none keeps the tap-to-play surface intact. */}
              {audioErr && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-ink/85 backdrop-blur-sm px-3 py-2 text-center text-xs text-nostr break-words">
                  ⚠ {audioErr}
                </div>
              )}
              {/* Our own video controls. Chrome and Firefox paint their own PiP
                  control on hover in this same corner, which is why `pipAvailable`
                  is the stage-specific test (see pipNeedsOwnButton) rather than
                  plain PiP support. */}
              <div className="absolute top-2 right-2 z-10 flex items-center gap-2">
                {pipAvailable && (
                  <button
                    type="button"
                    onClick={onPip}
                    aria-label="Picture-in-Picture"
                    title="Picture-in-Picture"
                    className="flex items-center justify-center w-9 h-9 rounded-lg bg-ink/55 text-bone backdrop-blur-sm hover:bg-ink/75 transition-colors"
                  >
                    <PipIcon className="w-5 h-5" />
                  </button>
                )}
                {fsOk && (
                  <button
                    type="button"
                    onClick={() => void toggleFullscreen(stageRef.current, videoRef.current)}
                    aria-label={fsOn ? 'Exit full screen' : 'Full screen'}
                    title={fsOn ? 'Exit full screen' : 'Full screen'}
                    className="flex items-center justify-center w-9 h-9 rounded-lg bg-ink/55 text-bone backdrop-blur-sm hover:bg-ink/75 transition-colors"
                  >
                    {fsOn ? <ExitFullscreenIcon className="w-5 h-5" /> : <FullscreenIcon className="w-5 h-5" />}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="w-full max-w-md sm:max-w-lg lg:max-w-xl aspect-square">
              {/* Whatever is playing at this second, via `nowPlayingArt`: the
                  LIVE BLOCK's art first — on a Split Kit show that's the cover
                  of the record actually playing, and it's the one thing on
                  screen that makes a redirected payment self-evident — then the
                  track a <podcast:valueTimeSplit> redirects to (the same thing,
                  one episode later: BOOST pressed here pays that artist), then
                  the active chapter's artwork (Podcasting 2.0 chapters `img`).
                  PodcastCover falls back image→artwork→initial-tile, so a
                  broken/missing image degrades to the episode/podcast art. */}
              {/* lowPriority is not cosmetic here. This pane is ALWAYS MOUNTED —
                  the fullscreen player is translated off-screen when collapsed,
                  not unmounted — so without lazy loading a collapsed player
                  downloads the art for every chapter the listener passes, at
                  20–36 MB apiece on a real music feed, over the same connection
                  the audio is streaming on. See PodcastCover's own note. */}
              <PodcastCover
                image={
                  nowPlayingArt({
                    liveBlockImage,
                    splitImage: splitArt,
                    chapterImage: activeChapter?.img,
                    artOk,
                  }) || episode.image || podcast.image
                }
                artwork={podcast.artwork}
                title={podcast.title}
                seed={podcast.id?.toString()}
                lowPriority
                // The one surface that paints a cover large. Every other
                // caller takes the 320 default, which is a list tile at 2x.
                w={640}
                // The whole picture, letterboxed — never a crop. Episode art
                // is not reliably square: a show that reuses its video
                // thumbnail publishes 16:9, and `object-cover` in a square box
                // took a 16:9 episode cover's title off both edges. Cropping
                // is right for a tile, where the row's geometry matters more
                // than the edges of the art; here the picture IS the content.
                // The box stays square so nothing below it moves when the art
                // changes shape mid-episode (chapter art, a live block's
                // cover, a valueTimeSplit's track), and `bg-bone/5` makes the
                // letterbox read as a canvas rather than a gap in the layout.
                fit="contain"
                className="w-full h-full rounded-xl border border-bone/10 bg-bone/5 shadow-2xl text-5xl"
              />
            </div>
          )}
          {/* Audio/Video picker sits directly UNDER the art/video (centered), so
              it never covers the media. Only present when there's a video
              rendition (the component returns null otherwise). */}
          <VideoToggle className="inline-flex" />
        </div>

        {/* Right pane: kind:1311 live chat for Nostr streams, else episode info */}
        {liveStreamId ? (
          <div className={`flex-1 min-h-0 sm:flex-none ${infoPane} p-4 sm:p-6 lg:p-10 flex flex-col gap-3 sm:gap-4 sm:h-full`}>
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
              {/* Play/pause now lives on the video; prev/next aren't meaningful
                  for a single live stream, so this row is just the actions —
                  BOOST stretches as the primary one, FAV / SHARE share it. This
                  keeps the controls short and hands the space to the chat. */}
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={onBoost}
                  disabled={!hasValue}
                  className="btn-bolt flex-1 min-w-[7rem] disabled:opacity-40 disabled:cursor-not-allowed"
                  title={hasValue ? 'Send a boost' : 'Stream has no value block'}
                >
                  <BoltIcon /> BOOST
                </button>
                <FavHeart podcast={podcast} size="md" />
                <LiveShareButton
                  liveStreamId={liveStreamId}
                  liveHostPubkey={episode.liveHostPubkey}
                />
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <LiveChat streamId={liveStreamId} />
            </div>
          </div>
        ) : (
        <div className={`${infoPane} p-4 sm:p-6 lg:p-10 flex flex-col gap-5 min-w-0 sm:h-full`}>
          {/* Fixed header: title, seek + transport controls stay put; only the
              About/Chapters body below scrolls (on desktop). */}
          <div className="flex-shrink-0 flex flex-col gap-5">
            <div>
              <h1 className="font-display text-2xl lg:text-3xl leading-tight">{episode.title}</h1>
              <p className="text-sm text-muted mt-1.5">{podcast.title}</p>
              {podcast.author && (
                <p className="text-xs text-muted/70 mt-0.5">{podcast.author}</p>
              )}
              {audioErr && (
                <p className="text-xs text-nostr mt-2 break-words">⚠ {audioErr}</p>
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
              {/* `flex-wrap` + `basis-full sm:basis-auto` on BOOST, because the
                  transport is five buttons wide once skip is in it and they do
                  not fit beside BOOST on a phone. Measured at 390px: the pane's
                  p-4 leaves 358px, and ⏮ + −15 + ▶ + +30 + ⏭ is 248px of button
                  plus 48px of gap-3, so BOOST would have been left ~50px — the
                  same squeeze the mini-bar solved by shedding ⏮/⏭. Skip has
                  nowhere to be shed TO, so BOOST takes its own line instead and
                  gets the full width, which is the better shape for the primary
                  action anyway. Unchanged from sm: up, where it is flex-1 on one
                  line exactly as before. */}
              <div className="flex flex-wrap items-center gap-3">
                <TransportControls
                  size="lg"
                  prev={chapterNav?.prev}
                  next={chapterNav?.next}
                  // No fixed-interval skip on a live stream: there is no
                  // timeline to jump within, and the seek bar above is
                  // replaced by a ● LIVE stamp for the same reason.
                  onSkip={isLive ? undefined : onSkip}
                />
                <button
                  onClick={onBoost}
                  disabled={!hasValue}
                  className="btn-bolt basis-full sm:basis-auto sm:flex-1 disabled:opacity-40 disabled:cursor-not-allowed"
                  title={hasValue ? 'Send a boost' : 'Episode has no value block'}
                >
                  <BoltIcon /> BOOST
                </button>
              </div>
              {/* The one cluster holding BOTH hearts, so both name their target
                  (SHOW/EPISODE, or ALBUM/TRACK on a music feed). They otherwise
                  render the identical word side by side and nothing on screen
                  says which favorites what. */}
              <div className="flex items-center gap-2 flex-wrap">
                <FavHeart podcast={podcast} size="md" nameTarget />
                <FavEpisodeHeart episode={episode} podcast={podcast} size="md" nameTarget />
                <ShareTargets podcast={podcast} episode={episode} />
                {/* The meter below says what streaming is DOING; this is the
                    only place in the player you can change it. Without it the
                    reaction to "≋ streaming 10 sats/min" is to go hunting for
                    the switch, and the player is full-screen — there is nothing
                    else on screen to hunt through. Show-scoped, same keys as
                    the show header and episode page. */}
                {streamButton}
              </div>
            </div>

            {streamPanel && (
              <div className="-mt-1 border-t border-bone/10 pt-4">{streamPanel}</div>
            )}

            {/* Sits with the value split, which is what streaming pays into.
                Renders nothing unless streaming is actually running (or has
                failed), so it costs a signed-out / rate-off user no space. */}
            <StreamMeter className="-mt-1" />

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
                  <ValueSplitRows value={value} className="space-y-2 mt-3" />
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
                        {/* The active row draws ❚❚, so it has to pause.
                            `play()` on the current track writes
                            `isPlaying: true` over `true` and re-runs neither of
                            the player's two effects, so the press was a silent
                            no-op. */}
                        <button
                          type="button"
                          onClick={() => {
                            if (active) togglePlay();
                            else play(t, podcast);
                          }}
                          className={`w-full flex items-center gap-3 text-left transition py-1.5 px-2 -mx-2 ${
                            active ? 'bg-bolt/10 text-bolt' : 'text-bone/80 hover:bg-bone/5'
                          }`}
                        >
                          {/* THE FEED'S TRACK NUMBER, not the row's position.
                              `i + 1` only ever agreed with the track number by
                              coincidence — the server sorts an album by
                              `<podcast:episode>` ascending, so position matched
                              until a track was missing from the feed or the
                              list was reversed, at which point this panel
                              confidently labelled track 1 as "12". Position is
                              the fallback because a feed that numbers nothing
                              leaves nothing truer to show, and "which row am I
                              on" is the honest floor. */}
                          <span className="text-muted tabular-nums w-5 flex-shrink-0 text-right">
                            {active && isPlaying ? '❚❚' : t.episode ?? i + 1}
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

          {/* Scrollable body — About / Chapters / Transcript (+ discussion). */}
          <div className="flex-1 sm:min-h-0 sm:overflow-y-auto">
            {/* What this broadcast has played, with a heart on each song.
                <EpisodeContents> has nothing to list on a live item — there are
                no valueTimeSplit windows to enumerate, only the blocks that have
                already gone by — so this is its live twin and sits above it.
                Renders nothing on an ordinary episode. */}
            <LivePlayedTracks
              episode={episode}
              fallbackImg={episode.image || podcast.image || podcast.artwork}
              className="border-t border-bone/10 pt-5"
            />
            <EpisodeInfoPanel
              description={description}
              splits={splits}
              chapters={chapters}
              chaptersLoading={chaptersLoading}
              hasChaptersUrl={!isLive && !!episode.chaptersUrl}
              transcriptCues={transcriptCues}
              transcriptLoading={transcriptLoading}
              transcriptActiveIdx={transcriptActiveIdx}
              hasTranscriptUrl={hasTranscriptUrl}
              onSeek={seekTo}
              currentSec={positionSec}
              // `undefined`, not a builder returning null, when the episode has
              // no guid: `showShareUrl(guid, undefined, t)` returns a SHOW link,
              // so a builder that fell through would give every row a button
              // copying the same whole-show link. Same guard <ShareTargets>
              // makes a few hundred lines up, for the same reason.
              shareUrlFor={
                episode.guid
                  ? (t: number) => showShareUrl(podcast.podcastGuid, episode.guid, t)
                  : undefined
              }
              // `||` not `??`, plus artwork — see the same prop in
              // <ChaptersList> (episode-detail-view.tsx) for why.
              chapterFallbackImg={episode.image || podcast.image || podcast.artwork}
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
      </>)}
    </div>
  );
}
