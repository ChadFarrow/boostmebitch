// "Up Next" — the user-assembled listen queue, the first tab of /listen.
//
// ONE MOUNT: `<ListenPage>`, the route the dock points at. It was also inside
// <FullscreenPlayer> until 2026-09-19 ("I don't think the queue should be on
// the now playing page") and on the home page before the dock tab existed;
// docs/ui.md, "Where the panel lives", has both stories.
//
// `<ListenPage>` says something when the queue is EMPTY, not this list: a list
// under a heading is right to render nothing, and a page somebody navigated to
// is not. Watching the drain — the row you just finished leaving — is this
// tab's job now, and the drained episodes go to HISTORY (the second tab) once
// they were heard for a minute, which is where they can be boosted.

import { useState } from 'react';
import { useApp } from '@/lib/store';
import { epKey, LISTEN_QUEUE_CAP } from '@/lib/util';
import { fmtDuration } from '@/lib/format';
import { PodcastCover } from '../podcast-cover';
import { PlayedMark } from './played-mark';

export function QueueList() {
  const queue = useApp((s) => s.listenQueue);
  const current = useApp((s) => s.current);
  const isPlaying = useApp((s) => s.isPlaying);
  const saved = useApp((s) => s.listenQueueSaved);
  const togglePlay = useApp((s) => s.togglePlay);
  const playFromQueue = useApp((s) => s.playFromQueue);
  const removeFromQueue = useApp((s) => s.removeFromQueue);
  const moveQueueItem = useApp((s) => s.moveQueueItem);
  const clearQueue = useApp((s) => s.clearQueue);
  const [confirmClear, setConfirmClear] = useState(false);

  // No empty state, deliberately: the panel does not render at all when the
  // queue is empty, so it can never make an emptiness claim over data that has
  // not answered. There is nothing to wait for here — the queue is local — but
  // rendering "nothing queued" under a heading is still worse than rendering
  // nothing at all, on either of the two surfaces this mounts on.
  if (!queue.length) return null;

  const currentKey = current ? epKey(current.episode) : null;

  return (
    // No top rule: `<ListenPage>`'s tab strip draws the line and the count.
    <div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-[11px] uppercase tracking-widest text-muted">
          {queue.length} of {LISTEN_QUEUE_CAP} · in play order
        </p>
        {/* An inline two-press confirm, the same shape <DownloadsPage>'s DELETE
            ALL uses and for the same reasons: this is the one control here that
            destroys everything, up to fifty items with no undo, and a native
            dialog in the installed PWA is a system sheet over the app. It also
            settles `.btn-mini`, whose own note justifies being under 44px on
            the grounds that these "carry confirmations behind them". */}
        <button
          type="button"
          onClick={() => { if (confirmClear) { clearQueue(); setConfirmClear(false); } else setConfirmClear(true); }}
          onBlur={() => setConfirmClear(false)}
          className={`btn-mini ${confirmClear ? 'border-nostr/60 text-nostr' : ''}`}
          aria-label={confirmClear ? 'Confirm clearing the queue' : 'Clear the queue'}
        >
          {confirmClear ? 'REALLY CLEAR?' : 'CLEAR'}
        </button>
      </div>

      {/* A write that did not reach disk holds for the session and is gone on
          the next load, which reads as the app forgetting the queue rather than
          as a full store. Saying so is the same rule the favorites and mutes
          notices follow: a guard that withholds must not do it silently. */}
      {!saved && (
        <p className="text-[11px] text-muted mb-2">
          Held for this session only — device storage is full or blocked.
        </p>
      )}

      {/* Not height-capped: this has ONE mount, the /listen route, so the page
          scrolls — an inner 320px scroll box on a page of its own hid most of
          the queue on desktop. */}
      <ul className="space-y-1 text-sm sm:space-y-0.5">
        {queue.map((item, i) => {
          const active = currentKey === epKey(item.episode);
          return (
            <li key={epKey(item.episode)} className="flex items-center gap-1">
              {/* The row's tap target is a real <button> and the three controls
                  are its SIBLINGS — a button may not contain a button, and a
                  row whose only handler sits on the <li> cannot be reached from
                  a keyboard. */}
              <button
                type="button"
                onClick={() => {
                  // The active row TOGGLES: it pauses while playing and resumes
                  // while paused. Re-selecting the current item writes
                  // `isPlaying: true` over `true` and re-runs neither of the
                  // player's effects, so the press would be a silent no-op —
                  // the same trap the album tracklist below documents.
                  if (active) togglePlay();
                  else playFromQueue(i);
                }}
                className={`flex-1 min-w-0 flex items-center gap-3 text-left transition py-1.5 px-2 -mx-2 sm:py-2.5 ${
                  active ? 'bg-bolt/10 text-bolt' : 'text-bone/80 hover:bg-bone/5'
                }`}
                // The name says what the press DOES, so it reads the same two
                // facts as the glyph below. It read `active` alone, and a
                // reload leaves the queue head active and PAUSED: a screen
                // reader heard "Pause" on a row whose press starts playback.
                // Found on a Pixel 6, 2026-09-21.
                aria-label={
                  active && isPlaying ? `Pause ${item.episode.title}`
                    : active ? `Resume ${item.episode.title}`
                      : `Play ${item.episode.title}`
                }
              >
                <span className="text-muted tabular-nums w-5 flex-shrink-0 text-right sm:w-7 sm:text-base">
                  {active && isPlaying ? '❚❚' : i + 1}
                </span>
                <PodcastCover
                  image={item.episode.image ?? item.podcast.image}
                  artwork={item.podcast.artwork}
                  title={item.podcast.title}
                  seed={item.podcast.podcastGuid ?? String(item.podcast.id)}
                  className="w-9 h-9 sm:w-14 sm:h-14 border border-bone/20 flex-shrink-0 text-xs"
                />
                <span className="min-w-0 flex-1">
                  {/* TWO LINES, the episode rows' rule (`line-clamp-2 break-words`): one
                      line cut "#217 - Lee Cronin - AI Will N…" on a phone, and the
                      title is how you tell which episode to boost or play. No
                      `block` beside the clamp — it overrides the clamp's display. */}
                  <span className="line-clamp-2 break-words leading-tight sm:font-display sm:text-base">{item.episode.title}</span>
                  {/* The show, on every row. The queue mixes them, so a title
                      alone does not say what you are about to hear. */}
                  {/* The show truncates and the PLAYED mark does not, or a long
                      show name cuts the mark off on a phone. */}
                  <span className="flex min-w-0 items-baseline gap-1 text-xs text-muted sm:text-sm sm:mt-0.5">
                    <span className="truncate">{item.podcast.title}</span>
                    <PlayedMark episode={item.episode} podcast={item.podcast} />
                  </span>
                </span>
                {item.episode.duration ? (
                  <span className="text-muted tabular-nums text-xs flex-shrink-0 sm:text-sm">
                    {fmtDuration(item.episode.duration)}
                  </span>
                ) : null}
              </button>

              {/* Each is at least 24x24 (WCAG 2.5.8) by its own min-h/min-w —
                  the glyph and the padding alone do not get there, which is how
                  a control passes review looking right and cannot be hit. */}
              <div className="flex items-center flex-shrink-0">
                <button
                  type="button"
                  onClick={() => moveQueueItem(i, -1)}
                  disabled={i === 0}
                  className="min-h-[24px] min-w-[24px] sm:min-h-[36px] sm:min-w-[36px] inline-flex items-center justify-center text-xs sm:text-base text-muted hover:text-bone disabled:opacity-30 transition"
                  aria-label={`Move ${item.episode.title} up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => moveQueueItem(i, 1)}
                  disabled={i === queue.length - 1}
                  className="min-h-[24px] min-w-[24px] sm:min-h-[36px] sm:min-w-[36px] inline-flex items-center justify-center text-xs sm:text-base text-muted hover:text-bone disabled:opacity-30 transition"
                  aria-label={`Move ${item.episode.title} down`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => removeFromQueue(epKey(item.episode))}
                  className="min-h-[24px] min-w-[24px] sm:min-h-[36px] sm:min-w-[36px] inline-flex items-center justify-center text-xs sm:text-base text-muted hover:text-bone transition"
                  aria-label={`Remove ${item.episode.title} from the queue`}
                >
                  ✕
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
