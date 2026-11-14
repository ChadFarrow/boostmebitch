'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useApp } from '@/lib/store';
import { fetchMovedCandidates } from '@/lib/podcast-meta';
import { favoriteFromEpisode, favoriteFromPodcast } from '@/lib/nostr/favorites-hydrator';
import { requestFavoritesSync } from '@/lib/nostr/favorites-sync';
import { matchTracks, movedFooterKind, planSwap } from '@/lib/moved-feeds';
import type { Episode, MovedAnswer, Podcast } from '@/lib/types';

/**
 * Where a favorite whose feed host CLOSED may have gone under a new guid, with
 * a REPLACE that swaps it — only on a press (Chad, 2026-11-14).
 *
 * Mounted as the footer of a favorites row whose feed (or track) is still on a
 * closed host after the resolvers tried the same-guid copy. Asks `/api/moved`
 * once per guid per tab (`fetchMovedCandidates`) and renders NOTHING until it
 * answers, and nothing on an empty or failed answer — the row is already there,
 * and an offer we could not make is not news.
 *
 * The swap is the store actions a heart uses, in an order that matters:
 * - every ADD before every REMOVE: each write goes through `markClearedIfEmpty`,
 *   so on a one-entry list remove-first would pass through an empty store, which
 *   reads as a deliberate clear-all;
 * - an unmatched track is never removed (`planSwap`): losing a favorite is worse
 *   than keeping a dead one;
 * - a carried row gets the information and no button: this device does not
 *   publish it, so a swap would change nothing on the wire;
 * - ONE `requestFavoritesSync`, which already handles the mode, a degraded read
 *   and a refused publish.
 *
 * The new rows keep the old `addedAt`, so they land where the old ones were, and
 * the result line is shown under the NEW row (`useMovedNotices`) — the old row,
 * and this offer with it, leaves the list the moment the swap lands.
 */

let notices: Readonly<Record<string, string>> = {};
const listeners = new Set<() => void>();
function setNotice(guid: string, text: string) {
  notices = { ...notices, [guid]: text };
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
const EMPTY: Readonly<Record<string, string>> = {};

/** The result line of a REPLACE, keyed by the NEW feed guid or item guid. */
export function useMovedNotices(): Readonly<Record<string, string>> {
  return useSyncExternalStore(subscribe, () => notices, () => EMPTY);
}

/** `Fountain`, `Wavlake`, or the bare hostname. */
function hostLabel(url: string | undefined): string {
  let host = '';
  try {
    host = new URL(url ?? '').hostname.replace(/^www\./, '');
  } catch {
    return 'another host';
  }
  if (host === 'feeds.fountain.fm' || host === 'fountain.fm') return 'Fountain';
  if (host === 'wavlake.com') return 'Wavlake';
  return host;
}

/** The footer line under a row: indented to the row's text (56px cover + 12px gap). */
export function RowFooter({ children }: { children: React.ReactNode }) {
  return <div className="basis-full pl-[68px] pb-3 -mt-1 text-xs text-muted space-y-1.5">{children}</div>;
}

type Candidate = { podcast: Podcast; items: Episode[] };

/** How long a row waits before asking `/api/moved` again after "could not ask". */
const MOVED_RETRY_MS = 20_000;

/** A candidate's tracks as `planSwap` reads them; an item with no guid cannot
 *  become a favorite, so it is not offered as a match. */
function itemsOf(c: Candidate): { guid: string; title?: string }[] {
  return c.items.flatMap((e) => (e.guid ? [{ guid: e.guid, title: e.title }] : []));
}

export function MovedOffer({
  feedGuid,
  scope,
  carried,
}: {
  feedGuid: string;
  /** `'feed'` on an album row; the item guid on a track row. */
  scope: 'feed' | { itemGuid: string };
  carried?: boolean;
}) {
  const [answer, setAnswer] = useState<MovedAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    void fetchMovedCandidates(feedGuid).then((a) => {
      if (!live) return;
      if (a) { setAnswer(a); return; }
      // "Could not ask" — usually Podcast Index throttling a burst. ONE retry
      // while the row is on screen; after that the row stays as it was.
      retry = setTimeout(() => {
        void fetchMovedCandidates(feedGuid).then((b) => { if (live && b) setAnswer(b); });
      }, MOVED_RETRY_MS);
    });
    return () => { live = false; if (retry) clearTimeout(retry); };
  }, [feedGuid]);

  const itemGuid = scope === 'feed' ? null : scope.itemGuid;
  const track = useApp((s) => (itemGuid ? s.favoriteEpisodes[itemGuid] : undefined));
  // A track row offers only a copy that actually holds that track: a REPLACE
  // that could not place it would do nothing.
  const offered = !answer
    ? []
    : itemGuid
      ? answer.candidates.filter((c) => matchTracks([{ itemGuid, title: track?.title }], itemsOf(c)).moves.length > 0)
      : answer.candidates;
  const kind = movedFooterKind(answer, offered.length);
  if (!kind || !answer) return null;

  // No copy this row can use. Say so, and let the user drop it — the heart does
  // the same, but a dead row with no words on it read as a broken cover.
  if (kind === 'gone') {
    const remove = () => {
      const s = useApp.getState();
      if (itemGuid) s.removeFavoriteEpisode(itemGuid);
      else s.removeFavorite(feedGuid);
      requestFavoritesSync(s.identity);
    };
    return (
      <RowFooter>
        <div className="flex items-center gap-2 flex-wrap">
          <span>{answer.service} closed — no copy found.</span>
          {!carried && (
            <button
              type="button"
              className="btn-ghost text-[10px] py-1 px-2 min-h-[28px]"
              onClick={remove}
              aria-label={`Remove this favorite — ${answer.service} closed and no copy was found`}
            >
              REMOVE
            </button>
          )}
        </div>
      </RowFooter>
    );
  }

  function replace(c: Candidate) {
    const s = useApp.getState();
    const newGuid = c.podcast.podcastGuid;
    if (!newGuid || busy) return;
    setBusy(true);
    const oldFeed = s.favorites[feedGuid];
    const oldItems = Object.values(s.favoriteEpisodes).filter((e) => e.feedGuid === feedGuid);
    const plan = planSwap({
      scope,
      feedFav: oldFeed ?? null,
      newFeedIsFav: !!s.favorites[newGuid],
      oldItems: oldItems.map((e) => ({ itemGuid: e.itemGuid, title: e.title, carried: e.carried })),
      newItems: itemsOf(c),
      favItemGuids: new Set(Object.keys(s.favoriteEpisodes)),
    });

    // ADDS first — see the note on the component.
    if (plan.addFeed) {
      const fav = favoriteFromPodcast(c.podcast);
      if (fav) s.addFavorite({ ...fav, addedAt: oldFeed?.addedAt || fav.addedAt });
    }
    const placed: string[] = [];
    for (const m of plan.moves) {
      if (!m.addNew) { placed.push(m.oldItemGuid); continue; }
      const ep = c.items.find((e) => e.guid === m.newItemGuid);
      const old = s.favoriteEpisodes[m.oldItemGuid];
      const fav = ep ? favoriteFromEpisode(ep, newGuid) : null;
      if (!fav) continue;
      s.addFavoriteEpisode({ ...fav, addedAt: old?.addedAt || fav.addedAt, medium: c.podcast.medium ?? old?.medium });
      placed.push(m.oldItemGuid);
    }
    // Then REMOVES: only a track whose replacement is on the list now.
    for (const oldItemGuid of placed) s.removeFavoriteEpisode(oldItemGuid);
    if (plan.removeFeed && (plan.addFeed ? !!useApp.getState().favorites[newGuid] : true)) s.removeFavorite(feedGuid);
    requestFavoritesSync(s.identity);

    const host = hostLabel(c.podcast.url);
    const kept = plan.unmatched.length + (plan.moves.length - placed.length);
    const total = plan.moves.length + plan.unmatched.length;
    const text = `Replaced from ${answer?.service}.${kept ? ` ${kept} of ${total} tracks not found on ${host} — kept.` : ''}`;
    if (itemGuid) {
      const moved = plan.moves.find((m) => m.oldItemGuid === itemGuid);
      if (moved) setNotice(moved.newItemGuid, text);
    } else {
      setNotice(newGuid, text);
    }
    setBusy(false);
  }

  return (
    <RowFooter>
      <div>{answer.service} closed. Found:</div>
      {offered.map((c) => (
        <div key={c.podcast.id} className="flex items-center gap-2 flex-wrap">
          <span className="min-w-0 break-words">
            {c.podcast.title} — {c.podcast.author} · {hostLabel(c.podcast.url)}
          </span>
          {!carried && (
            <button
              type="button"
              className="btn-ghost text-[10px] py-1 px-2 min-h-[28px]"
              disabled={busy}
              onClick={() => replace(c)}
              aria-label={`Replace with ${c.podcast.title} on ${hostLabel(c.podcast.url)}`}
            >
              REPLACE
            </button>
          )}
        </div>
      ))}
    </RowFooter>
  );
}
