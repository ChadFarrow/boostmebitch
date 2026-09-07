// "Up Next" — the user-assembled listen queue.
//
// TWO MOUNTS, ONE COMPONENT: the /queue route the dock points at, and
// <FullscreenPlayer> (where you are while listening, beside the album
// tracklist this is modelled on). That is not the drift this repo warns about
// — two hand-rolled lists would be. Same arrangement <ValueSplitRows> has.
//
// IT WAS ON THE HOME PAGE TOO, AND THE DOCK TAB IS WHY IT IS NOT. That mount
// existed because the queue had no destination of its own: the panel had to
// sit where somebody would find it, including on a show page, which is why it
// deliberately skipped `!inDetailView`. Once /queue became a dock tab the
// queue was one press away from every route, and the home-page block was a
// screen's worth of vertical space on a phone — measured against a 390px
// screenshot, it pushed the global boost feed below the fold — spent on a
// second way to reach something already one tap away.
//
// The /queue mount is the only one that has to say something when the queue is
// EMPTY, and it does that in <QueuePage> rather than here: a panel under other
// content is right to render nothing, and a page somebody navigated to is not.
//
// THE HOME-PAGE MOUNT IS NOT BEHIND `!inDetailView`, and that is the whole
// reason it works. The two optional sections around it are, because they are
// relay-backed and a deep link should not pay for them. This one reads the
// store and touches no network — and a show page is exactly where somebody
// presses `+ queue`, so a panel that vanished at that moment would be useless
// at the one moment it is used.
//
// THE PLAYER MOUNT IS WHERE THE DRAIN IS OBSERVABLE: you watch the row you
// just finished leave. It is also why `revealQueue` exists — <Player> renders
// nothing without a `current`, and `current` is in-memory while the queue is
// not, so every reload would otherwise hide this panel from that surface.

import { useApp } from '@/lib/store';
import { epKey } from '@/lib/util';
import { fmtDuration } from '@/lib/format';
import { PodcastCover } from '../podcast-cover';

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

  // No empty state, deliberately: the panel does not render at all when the
  // queue is empty, so it can never make an emptiness claim over data that has
  // not answered. There is nothing to wait for here — the queue is local — but
  // rendering "nothing queued" under a heading is still worse than rendering
  // nothing at all, on either of the two surfaces this mounts on.
  if (!queue.length) return null;

  const currentKey = current ? epKey(current.episode) : null;

  return (
    <div className="border-t border-bone/10 pt-5">
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-[11px] uppercase tracking-widest text-muted">
          Up Next · {queue.length}
        </p>
        <button type="button" onClick={clearQueue} className="btn-mini" aria-label="Clear the queue">
          CLEAR
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

      <ul className="space-y-1 text-sm max-h-80 overflow-y-auto pr-2">
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
                  // The active row draws ❚❚, so it has to pause. Re-selecting
                  // the current item writes `isPlaying: true` over `true` and
                  // re-runs neither of the player's effects, so the press would
                  // be a silent no-op — the same trap the album tracklist below
                  // documents.
                  if (active) togglePlay();
                  else playFromQueue(i);
                }}
                className={`flex-1 min-w-0 flex items-center gap-3 text-left transition py-1.5 px-2 -mx-2 ${
                  active ? 'bg-bolt/10 text-bolt' : 'text-bone/80 hover:bg-bone/5'
                }`}
                aria-label={active ? `Pause ${item.episode.title}` : `Play ${item.episode.title}`}
              >
                <span className="text-muted tabular-nums w-5 flex-shrink-0 text-right">
                  {active && isPlaying ? '❚❚' : i + 1}
                </span>
                <PodcastCover
                  image={item.episode.image ?? item.podcast.image}
                  artwork={item.podcast.artwork}
                  title={item.podcast.title}
                  seed={item.podcast.podcastGuid ?? String(item.podcast.id)}
                  className="w-9 h-9 border border-bone/20 flex-shrink-0 text-xs"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate leading-tight">{item.episode.title}</span>
                  {/* The show, on every row. The queue mixes them, so a title
                      alone does not say what you are about to hear. */}
                  <span className="block truncate text-xs text-muted">{item.podcast.title}</span>
                </span>
                {item.episode.duration ? (
                  <span className="text-muted tabular-nums text-xs flex-shrink-0">
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
                  className="min-h-[24px] min-w-[24px] inline-flex items-center justify-center text-xs text-muted hover:text-bone disabled:opacity-30 transition"
                  aria-label={`Move ${item.episode.title} up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => moveQueueItem(i, 1)}
                  disabled={i === queue.length - 1}
                  className="min-h-[24px] min-w-[24px] inline-flex items-center justify-center text-xs text-muted hover:text-bone disabled:opacity-30 transition"
                  aria-label={`Move ${item.episode.title} down`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => removeFromQueue(epKey(item.episode))}
                  className="min-h-[24px] min-w-[24px] inline-flex items-center justify-center text-xs text-muted hover:text-bone transition"
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
