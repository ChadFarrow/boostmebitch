'use client';

// The two favorites panels — favorited SHOWS and favorited EPISODES/TRACKS —
// plus the grouped rows they render.
//
// Both lists are driven by the store's `favorites` / `favoriteEpisodes` maps,
// which are the source of truth for what gets PUBLISHED, not a render cache: an
// id with no resolved Podcast Index metadata still gets a row, as an
// <UnresolvedFavoriteRow> placeholder. Dropping unresolved entries here would
// make a PI outage look like the user had removed them.

import { useId, useMemo } from 'react';
import type { FavoriteEpisode, FavoritePodcast, Podcast } from '@/lib/types';
import { useApp } from '@/lib/store';
import { loadEpisodeFromFeed, resolvePodcastByGuid } from '@/lib/podcast-meta';
import { PodcastCover } from '../podcast-cover';
import { FavEpisodeRowHeart } from '../fav-heart';
import { PodcastRow } from './podcast-results';
import {
  groupByMedium, itemNoun, feedNoun,
  useCollapsedGroups, CollapsibleHeading, useRevealed, ShowMore,
} from './grouping';

export function FavoritesList({
  selected,
  onSelect,
}: {
  selected: number | null;
  onSelect: (p: Podcast) => void;
}) {
  const favorites = useApp((s) => s.favorites);
  const list = useMemo(
    () =>
      Object.values(favorites).sort((a, b) => {
        // Unresolved entries have no title. Sink them rather than letting an
        // empty string sort them to the top of the user's library.
        if (!a.title !== !b.title) return a.title ? -1 : 1;
        return (a.title ?? '').localeCompare(b.title ?? '', undefined, { sensitivity: 'base' });
      }),
    [favorites],
  );

  const groups = useMemo(() => groupByMedium(list, (p) => p.medium), [list]);
  // ONE hook for the whole list — see the note on useCollapsedGroups.
  const [collapsed, toggle] = useCollapsedGroups();

  if (!list.length) return null;

  return (
    <>
      {groups.map((g) => {
        // Namespaced: the episodes list groups by medium too, and 'music'
        // appears in both. A shared key folds a user's albums away the moment
        // they fold away their tracks.
        const key = `show:${g.key}`;
        return (
          <ShowGroup
            key={g.key}
            groupKey={g.key}
            label={groups.length > 1 ? g.label : null}
            rows={g.rows}
            collapsed={collapsed.has(key)}
            onToggle={() => toggle(key)}
            selected={selected}
            onSelect={onSelect}
          />
        );
      })}
    </>
  );
}

/**
 * One medium's worth of favorited shows: foldable as a whole, and revealed
 * FAV_PAGE at a time while open.
 *
 * The two limits are independent and both are needed. Collapsing hides a group
 * the user isn't working in; `useRevealed` bounds what an OPEN group costs,
 * which collapsing can't do — an expanded 227-row group would otherwise mount
 * every row and fetch every cover, the 59.2 MB page load FAV_PAGE exists to
 * stop.
 *
 * `shown` lives here rather than in the parent, so folding a group and
 * reopening it keeps however far the user had already revealed.
 */
function ShowGroup({
  groupKey,
  label,
  rows,
  collapsed,
  onToggle,
  selected,
  onSelect,
}: {
  groupKey: string;
  label: string | null;
  rows: FavoritePodcast[];
  collapsed: boolean;
  onToggle: () => void;
  selected: number | null;
  onSelect: (p: Podcast) => void;
}) {
  const { visible, remaining, more } = useRevealed(rows);
  const listId = useId();
  return (
        <div>
          {/* `rows.length`, NOT the revealed slice and not a number that changes
              when the group folds: this states how many favorites the group HAS.
              A count that shrank to match what happened to be on screen would be
              a worse lie than a long list. */}
          <CollapsibleHeading
            label={
              <>
                {label && `${label} — `}
                {rows.length} favorite {feedNoun(groupKey, rows.length)}
              </>
            }
            collapsed={collapsed}
            onToggle={onToggle}
            controls={listId}
            className="mt-3 mb-1"
          />
          {/* The rows are UNMOUNTED, not merely hidden. The empty <ul> stays in
              the DOM regardless, because `aria-controls` above must point at
              something that exists. */}
          <ul id={listId} className="divide-y divide-bone/10" hidden={collapsed}>
            {collapsed ? null : visible.map((p) => {
              const title = p.title;
              // No title means Podcast Index hasn't answered for this guid — a
              // feed that was never indexed, or has since been delisted. Render
              // it rather than hiding it: it is still the user's favorite and is
              // still republished, and a row they can see is one they can clean
              // up.
              if (!title) {
                return <UnresolvedFavoriteRow key={p.podcastGuid} id={p.podcastGuid} kind="show" />;
              }
              // FavoritePodcast → Podcast: the cache doesn't carry the value
              // block, so the value-aware stamp is hidden via showV4VStamp.
              const minimal: Podcast = {
                id: p.id,
                podcastGuid: p.podcastGuid,
                title,
                author: p.author,
                image: p.image,
                artwork: p.artwork,
                url: p.url,
              };
              return (
                <PodcastRow
                  key={p.podcastGuid}
                  podcast={minimal}
                  selected={selected === p.id}
                  onSelect={onSelect}
                  showV4VStamp={false}
                />
              );
            })}
          </ul>
          {/* Suppressed while folded, or a closed group still offers to reveal
              twelve more of the rows it is currently hiding. */}
          {!collapsed && <ShowMore remaining={remaining} onClick={more} noun="shows" />}
        </div>
  );
}

/**
 * A favorite whose identifier this device can't resolve.
 *
 * It exists because the favorite is the guid, not the metadata: an entry
 * Podcast Index doesn't know is not an entry we may drop, so it has to have
 * somewhere to go on screen. Deliberately inert — there is nothing to open.
 */
function UnresolvedFavoriteRow({ id, kind }: { id: string; kind: 'show' | 'episode' }) {
  return (
    <li className="flex gap-3 py-3 px-1 items-center">
      <div className="w-14 h-14 border border-bone/20 flex-shrink-0 grid place-items-center text-muted text-xl">
        ?
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-display text-base leading-tight text-muted">
          Couldn&apos;t load this {kind}
        </div>
        <div className="text-[11px] font-mono text-muted/70 truncate">{id}</div>
      </div>
    </li>
  );
}

/**
 * Favorited episodes. Selecting one opens that EPISODE's page.
 *
 * It used to stop at the parent show, and the reason was sound as far as it
 * went: a FavoriteEpisode is a display cache, not an Episode — no value block,
 * no chapters, no transcript — so fabricating one to hand to the player or the
 * boost modal would push a half-formed object into the money path. That
 * argument forbids *inventing* an episode; it never justified making the user
 * find their own favorite again in a fifty-row list.
 *
 * So the show is still selected first, and then the real episode is looked up
 * out of the show's own feed (`loadEpisodeFromFeed`) and handed to
 * `openEpisode` — the same object `<EpisodeList>` would have given it, from the
 * same endpoint. Nothing is fabricated. Selecting the show first is not just
 * ordering: `selectPodcast` clears `selectedEpisode`, `<EpisodeDetailView>`
 * reads `selectedPodcast` for the show art and SUPPORT link, and closing the
 * episode falls back to the show page, so the back chain reads
 * episode → show → favorites the way it does from anywhere else.
 */
export function FavoriteEpisodesList({ onSelect }: { onSelect: (p: Podcast) => void }) {
  const favoriteEpisodes = useApp((s) => s.favoriteEpisodes);
  // Item favorites another app added are ordinary rows now. They used to need a
  // separate store slot: on the two-address design, copying an item entry found
  // on the FEEDS list over to the ITEMS list made it removable from one and not
  // the other, so unfavoriting it brought it back on every load, forever. One
  // event means no relocation, so the hazard is gone and the quarantine with
  // it — what keeps another app's entries safe now is the baseline, per entry.
  const list = useMemo(
    () => Object.values(favoriteEpisodes).sort((a, b) => b.addedAt - a.addedAt),
    [favoriteEpisodes],
  );

  const groups = useMemo(() => groupByMedium(list, (ep) => ep.medium), [list]);
  // ONE hook for the whole list — see the note on useCollapsedGroups.
  const [collapsed, toggle] = useCollapsedGroups();

  if (!list.length) return null;

  return (
    <>
      {groups.map((g) => {
        // 'ep:', against the shows list's 'show:' — both lists group by medium
        // and 'music' is in each, so one shared key would fold a user's albums
        // away the moment they folded their tracks.
        const key = `ep:${g.key}`;
        return (
          <EpisodeGroup
            key={g.key}
            groupKey={g.key}
            label={groups.length > 1 ? g.label : null}
            rows={g.rows}
            collapsed={collapsed.has(key)}
            onToggle={() => toggle(key)}
            onSelect={onSelect}
          />
        );
      })}
    </>
  );
}

/**
 * One medium's worth of favorited items: foldable as a whole, and revealed
 * FAV_PAGE at a time while open. Mirror of {@link ShowGroup} — see its note for
 * why both limits are needed and why `shown` lives here.
 */
function EpisodeGroup({
  groupKey,
  label,
  rows,
  collapsed,
  onToggle,
  onSelect,
}: {
  groupKey: string;
  label: string | null;
  rows: FavoriteEpisode[];
  collapsed: boolean;
  onToggle: () => void;
  onSelect: (p: Podcast) => void;
}) {
  const { visible, remaining, more } = useRevealed(rows);
  const listId = useId();
  const openEpisode = useApp((s) => s.openEpisode);
  const syncSelectedPodcast = useApp((s) => s.syncSelectedPodcast);
  return (
        <div>
          {/* Counted PER MEDIUM so each group can use its own noun — a track on
              a music feed is a single, not an episode. One combined heading
              would have to pick one word and be wrong for half the list, the
              same trap `MEDIUM_ORDER` exists to avoid. The overall total is on
              the panel header.
              `rows.length`, NOT the revealed slice: this states how many
              favorites the group HAS, which neither paging nor folding may
              appear to change. The count deliberately stays on screen while
              collapsed — a heading that hid what it was hiding would just look
              like a shorter list. */}
          <CollapsibleHeading
            label={
              <>
                {label && `${label} — `}
                {rows.length} favorite {itemNoun(groupKey, rows.length)}
              </>
            }
            collapsed={collapsed}
            onToggle={onToggle}
            controls={listId}
            className="mt-4 mb-2"
          />
          <ul id={listId} className="divide-y divide-bone/10" hidden={collapsed}>
            {collapsed ? null : visible.map((ep) => {
              const { title, feedGuid } = ep;
              // Unresolved: no parent feed guid to look up, or PI had nothing for
              // it. Still the user's favorite, still republished — see
              // <UnresolvedFavoriteRow>.
              if (!title) return <UnresolvedFavoriteRow key={ep.itemGuid} id={ep.itemGuid} kind="episode" />;
              return (
                <li
                  key={ep.itemGuid}
                  className="flex gap-3 py-3 px-1 cursor-pointer group transition hover:bg-bone/5"
                  onClick={async () => {
                    // feedId is present for anything this device resolved through
                    // PI. An entry synced from another app before its backfill ran
                    // has only the guid, so fall back to resolving it on demand.
                    if (!feedGuid) return;
                    const podcast: Podcast | null = ep.feedId
                      ? {
                          id: ep.feedId,
                          podcastGuid: feedGuid,
                          title: ep.podcastTitle ?? title,
                          image: ep.image,
                          url: ep.feedUrl,
                        }
                      : await resolvePodcastByGuid(feedGuid);
                    if (!podcast) return;
                    // The show goes up FIRST and unconditionally: it is what the
                    // user sees while the feed loads, it is where they land if the
                    // episode can't be found, and `selectPodcast` clears
                    // `selectedEpisode`, so opening the episode before it would
                    // immediately undo itself.
                    //
                    // It also means <EpisodeList> mounts and fetches the same
                    // feed alongside this call. That looks like waste and isn't:
                    // <EpisodeList> is the only writer of `episodeQueue`, which
                    // is what <TransportControls> computes prev/next from — skip
                    // it and the transport on the episode we just opened would
                    // still be pointing at whatever show was loaded last.
                    onSelect(podcast);
                    const loaded = await loadEpisodeFromFeed(podcast.id, ep.itemGuid);
                    if (!loaded) return;
                    // A second tap (or a tap on BACK) during the fetch must win —
                    // otherwise a slow response drags the user into an episode of
                    // a show they already left. Same guard the URL restore in
                    // <HomePage> makes for the same reason.
                    const selected = useApp.getState().selectedPodcast;
                    if (!selected || selected.id !== podcast.id) return;
                    // Fill in the RSS-derived funding/medium/podroll the by-guid
                    // resolve doesn't carry, so the episode page shows the same
                    // SUPPORT link it would if opened from the show.
                    syncSelectedPodcast(loaded.podcast);
                    // No episode means the feed doesn't list this guid (PI returns
                    // the latest 50), which is a real state for an old favorite.
                    // The show page is already on screen — leave them there rather
                    // than assembling an episode out of the display cache.
                    if (loaded.episode) openEpisode(loaded.episode);
                  }}
                >
                  <PodcastCover
                    image={ep.image}
                    title={title}
                    seed={ep.itemGuid}
                    className="w-14 h-14 border border-bone/20 flex-shrink-0 text-xl"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-display text-base leading-tight truncate">{title}</div>
                    {/* Only when it says something the title didn't. A single
                        names its album after its one track, so printing both
                        renders the same words twice and reads as an album
                        sitting in the episodes list — 74 of one user's 227
                        tracks. */}
                    {ep.podcastTitle && ep.podcastTitle !== title && (
                      <div className="text-xs text-muted truncate">{ep.podcastTitle}</div>
                    )}
                  </div>
                  <div className="flex-shrink-0 self-center">
                    <FavEpisodeRowHeart favorite={ep} />
                  </div>
                </li>
              );
            })}
          </ul>
          {/* Suppressed while folded — see the same call in <ShowGroup>. */}
          {!collapsed && (
            <ShowMore remaining={remaining} onClick={more} noun={itemNoun(groupKey, remaining)} />
          )}
        </div>
  );
}
