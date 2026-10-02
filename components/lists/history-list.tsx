'use client';

// The Listen tab's HISTORY: podcast episodes this device played for a minute,
// newest first, each with a BOOST.
//
// WHY IT EXISTS. Listeners queue several episodes, hear a few, and then want to
// go back and boost them — and the queue drains each item as it ends, so the
// episodes they came to boost were the ones no longer on the tab. What goes in,
// and when, is `use-play-history.ts`; the order and the cap are
// `addToHistory`; the money rules for the BOOST are `<HistoryBoostButton>`.
//
// SAME ROW AS <QueueList>, deliberately: art, title, show line, and the
// controls as SIBLINGS of the row's tap target (a button may not contain a
// button). No index column — the order here is time, which the show line
// already says, not a play order anybody chose.

import { useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { boostedOnDevice, epKey, PLAY_HISTORY_CAP } from '@/lib/util';
import { timeAgo } from '@/lib/format';
import type { StoredBoost } from '@/lib/types';
import { PodcastCover } from '../podcast-cover';
import { PlayedMark } from './played-mark';
import { ResumeLeft } from './resume-left';
import { HistoryBoostButton } from './history-boost-button';

export function HistoryList() {
  const history = useApp((s) => s.playHistory);
  const current = useApp((s) => s.current);
  const isPlaying = useApp((s) => s.isPlaying);
  const saved = useApp((s) => s.playHistorySaved);
  const togglePlay = useApp((s) => s.togglePlay);
  const play = useApp((s) => s.play);
  const removeFromHistory = useApp((s) => s.removeFromHistory);
  const clearHistory = useApp((s) => s.clearHistory);
  const identity = useApp((s) => s.identity);
  const boostsTick = useApp((s) => s.boostsTick);
  const [confirmClear, setConfirmClear] = useState(false);

  // The sent-boost log, re-read when a boost is sent or the identity changes —
  // `<GlobalNostrFeed>`'s pattern. Per identity: the mark says what THIS
  // account boosted, while the history itself is the device's.
  const boosts = useMemo<StoredBoost[]>(
    () => storage.boosts.get(identity?.npub),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identity?.npub, boostsTick],
  );

  // The page draws the empty state; this list only ever draws rows.
  if (!history.length) return null;

  const currentKey = current ? epKey(current.episode) : null;

  return (
    // No top rule: `<ListenPage>`'s tab strip draws the line and the count.
    <div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-[11px] uppercase tracking-widest text-muted">
          {history.length} of {PLAY_HISTORY_CAP} · newest first
        </p>
        {/* <QueueList>'s two-press confirm, for its reasons: up to fifty
            entries, no undo, and no native dialog over the installed app. */}
        <button
          type="button"
          onClick={() => { if (confirmClear) { clearHistory(); setConfirmClear(false); } else setConfirmClear(true); }}
          onBlur={() => setConfirmClear(false)}
          className={`btn-mini ${confirmClear ? 'border-nostr/60 text-nostr' : ''}`}
          aria-label={confirmClear ? 'Confirm clearing the history' : 'Clear the history'}
        >
          {confirmClear ? 'REALLY CLEAR?' : 'CLEAR'}
        </button>
      </div>

      {!saved && (
        <p className="text-[11px] text-muted mb-2">
          Held for this session only — device storage is full or blocked.
        </p>
      )}

      <ul className="space-y-1 text-sm sm:space-y-0.5">
        {history.map((item) => {
          const key = epKey(item.episode);
          const active = currentKey === key;
          const boosted = boostedOnDevice(boosts, item.episode, item.podcast);
          return (
            <li key={key} className="flex items-center gap-1 sm:gap-2">
              <button
                type="button"
                // The active row TOGGLES, as in <QueueList>: re-selecting the
                // current item would write `isPlaying: true` over `true` and do
                // nothing at all.
                onClick={() => (active ? togglePlay() : play(item.episode, item.podcast))}
                className={`flex-1 min-w-0 flex items-center gap-3 text-left transition py-1.5 px-2 -mx-2 sm:py-2.5 ${
                  active ? 'bg-bolt/10 text-bolt' : 'text-bone/80 hover:bg-bone/5'
                }`}
                aria-label={
                  active && isPlaying ? `Pause ${item.episode.title}`
                    : active ? `Resume ${item.episode.title}`
                      : `Play ${item.episode.title}`
                }
              >
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
                  <span className="block truncate text-xs text-muted sm:text-sm sm:mt-0.5">{item.podcast.title}</span>
                  {/* THREE LINES, not <QueueList>'s two. On one line with the
                      show, "just now · 40 min left · ⚡ 2,100 boosted" left a
                      long show name 0px and ran 66px under BOOST at 390px
                      (measured under CDP). Here the marks WRAP instead of
                      overflowing; at 390 a row with a saved place AND a boost
                      takes a fourth line, which is the price of showing both. */}
                  <span className="flex flex-wrap items-baseline gap-x-1 text-xs text-muted sm:text-sm">
                    <span className="whitespace-nowrap">{timeAgo(item.at / 1000)}</span>
                    <ResumeLeft episode={item.episode} podcast={item.podcast} />
                    <PlayedMark episode={item.episode} podcast={item.podcast} />
                    {/* What this account already sent to it, so a second boost
                        is a choice and not a mistake. `?` when a wallet never
                        answered for a leg: it may have paid (invariant 11). */}
                    {(boosted.sats > 0 || boosted.unsure) && (
                      <span
                        className="whitespace-nowrap text-bolt"
                        title={boosted.unsure
                          ? 'A wallet did not answer for part of a boost — those sats may have been sent'
                          : 'Sats this account sent to this episode from this device'}
                      >
                        · ⚡ {boosted.sats > 0 ? boosted.sats.toLocaleString() : ''}{boosted.unsure ? '?' : ''} boosted
                      </span>
                    )}
                  </span>
                </span>
              </button>

              <HistoryBoostButton episode={item.episode} podcast={item.podcast} />
              <button
                type="button"
                onClick={() => removeFromHistory(key)}
                className="min-h-[24px] min-w-[24px] sm:min-h-[36px] sm:min-w-[36px] inline-flex items-center justify-center text-xs sm:text-base text-muted hover:text-bone transition flex-shrink-0"
                aria-label={`Remove ${item.episode.title} from the history`}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
