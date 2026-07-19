'use client';

// "Up Next" — the user-managed listen queue. Distinct from the in-show
// episodeQueue: it mixes shows (each entry carries its own podcast) and
// persists. The core journey is "add from the Inbox → hit Play queue → auto-
// listen through it"; handlePlaybackEnded (in the store) drains each item as
// it finishes and auto-plays the next. Mirrors the album-tracklist idiom in
// fullscreen-player.tsx.

import { useApp, epKey } from '@/lib/store';
import { PodcastCover } from './podcast-cover';
import { fmtDuration } from '@/lib/format';

export function QueueList() {
  const queue = useApp((s) => s.listenQueue);
  const current = useApp((s) => s.current);
  const isPlaying = useApp((s) => s.isPlaying);
  const playFromQueue = useApp((s) => s.playFromQueue);
  const removeFromQueue = useApp((s) => s.removeFromQueue);
  const moveQueueItem = useApp((s) => s.moveQueueItem);
  const clearQueue = useApp((s) => s.clearQueue);

  const currentKey = current ? epKey(current.episode) : null;
  const empty = queue.length === 0;

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2 px-1">
        <span className="font-display text-2xl text-bolt">
          Up Next{empty ? '' : <span className="text-muted text-lg"> · {queue.length}</span>}
        </span>
        {!empty && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => playFromQueue(0)}
              className="btn-bolt text-xs"
              aria-label="Play the whole queue"
            >
              ▶ Play queue
            </button>
            <button
              type="button"
              onClick={clearQueue}
              className="btn-ghost text-xs"
              aria-label="Clear the queue"
            >
              clear
            </button>
          </div>
        )}
      </div>
      {empty && (
        <p className="text-xs text-muted px-1 pb-1">
          Add episodes from your inbox with <span className="text-bone">+ queue</span> to line them up here.
        </p>
      )}
      <ul className="divide-y divide-bone/10">
        {queue.map((item, i) => {
          const active = currentKey === epKey(item.episode);
          return (
            <li
              key={epKey(item.episode)}
              className={`flex items-center gap-3 py-2 px-1 ${active ? 'bg-bolt/10' : ''}`}
            >
              <button
                type="button"
                onClick={() => playFromQueue(i)}
                className="flex items-center gap-3 min-w-0 flex-1 text-left"
                aria-label={`Play ${item.episode.title}`}
              >
                <span className="text-muted tabular-nums w-5 flex-shrink-0 text-right text-xs">
                  {active && isPlaying ? '❚❚' : i + 1}
                </span>
                <PodcastCover
                  image={item.episode.image ?? item.podcast.image}
                  artwork={item.podcast.artwork}
                  title={item.podcast.title}
                  seed={item.podcast.podcastGuid ?? String(item.podcast.id)}
                  className="w-10 h-10 border border-bone/20 flex-shrink-0 text-sm"
                />
                <span className="min-w-0 flex-1">
                  <span className={`block text-sm leading-tight truncate ${active ? 'text-bolt' : ''}`}>
                    {item.episode.title}
                  </span>
                  <span className="block text-xs text-muted truncate">{item.podcast.title}</span>
                </span>
                {item.episode.duration ? (
                  <span className="text-muted tabular-nums text-xs flex-shrink-0">
                    {fmtDuration(item.episode.duration)}
                  </span>
                ) : null}
              </button>
              <div className="flex items-center flex-shrink-0">
                <button
                  type="button"
                  onClick={() => moveQueueItem(i, -1)}
                  disabled={i === 0}
                  className="btn-ghost text-xs px-1.5 disabled:opacity-30"
                  aria-label="Move up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => moveQueueItem(i, 1)}
                  disabled={i === queue.length - 1}
                  className="btn-ghost text-xs px-1.5 disabled:opacity-30"
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => removeFromQueue(epKey(item.episode))}
                  className="btn-ghost text-xs px-1.5"
                  aria-label="Remove from queue"
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
