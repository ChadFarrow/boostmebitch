'use client';
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Episode, FavoriteEpisode, FavoritePodcast, Podcast, ValueBlock } from '@/lib/types';
import { useApp } from '@/lib/store';
import { fmtDate, fmtDuration, fmtLiveTime } from '@/lib/format';
import { hasValueRecipients, isMusicMedium } from '@/lib/util';
import { loadEpisodeFromFeed, resolvePodcastByGuid } from '@/lib/podcast-meta';
import { storage } from '@/lib/storage';
import { BoostModal } from './boost-modal';
import { BoltIcon, ShareIcon, CoinIcon } from './icons';
import { PodcastCover } from './podcast-cover';
import { PodcastNostrFeed } from './podcast-nostr-feed';
import { DeferredOnScroll } from './deferred-on-scroll';
import { Podroll } from './podroll';
import { FavEpisodeHeart, FavEpisodeRowHeart, FavHeart } from './fav-heart';
import { ValueSplitRows } from './value-split-rows';
import { useStreamPanel } from './streaming-settings';
import { applyLiveStatuses } from '@/lib/live-status';
import { useLiveStatusPoll } from '@/lib/use-live-status-poll';

// Re-exported for the surfaces that have always imported it from here.
export { FavEpisodeHeart, FavEpisodeRowHeart, FavHeart };

// `shrink-0 whitespace-nowrap` on both branches: .stamp is inline-flex with
// neither, and this sits in a flex row beside a truncating title with no slack,
// so on a phone `● LIVE` wrapped to two lines and blew up the row height.
function LiveBadge({ status }: { status: NonNullable<Episode['liveStatus']> }) {
  if (status === 'live') {
    return (
      <span className="stamp shrink-0 whitespace-nowrap text-nostr border-nostr/60 bg-nostr/10 animate-bolt">
        ● LIVE
      </span>
    );
  }
  if (status === 'pending') {
    return <span className="stamp shrink-0 whitespace-nowrap text-bolt border-bolt/60">PENDING</span>;
  }
  return null;
}

function ShareButton({ podcast }: { podcast: Podcast }) {
  const [copied, setCopied] = useState(false);
  const guid = podcast.podcastGuid;
  if (!guid) return null;

  async function onClick() {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.origin + window.location.pathname);
    url.searchParams.set('podcast', guid!);
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — silent no-op */
    }
  }

  return (
    <button
      onClick={onClick}
      className="btn-ghost btn-compact"
      title="Copy link to this show"
      aria-label="Copy link to this show"
    >
      <ShareIcon /> {copied ? 'COPIED' : 'SHARE'}
    </button>
  );
}

// <podcast:funding> — the host's non-Lightning support link (Patreon, etc.),
// shown next to the V4V BOOST button. Uses the first funding entry; its message
// is the tooltip. Renders nothing when the feed carries no funding tag.
function SupportButton({ podcast }: { podcast: Podcast }) {
  const funding = podcast.funding?.[0];
  if (!funding?.url) return null;
  return (
    <a
      href={funding.url}
      target="_blank"
      rel="noopener noreferrer"
      className="btn-ghost btn-compact"
      title={funding.message || 'Support this show'}
    >
      <CoinIcon /> SUPPORT
    </a>
  );
}

// One row used by both the search-results panel and the favorites panel.
// `showV4VStamp` is on for search results (where the value-block is known)
// and off for favorites (the cache only carries metadata, not value).
function PodcastRow({
  podcast,
  selected,
  onSelect,
  showV4VStamp,
}: {
  podcast: Podcast;
  selected: boolean;
  onSelect: (p: Podcast) => void;
  showV4VStamp: boolean;
}) {
  return (
    <li
      onClick={() => onSelect(podcast)}
      className={`flex gap-3 py-3 px-1 cursor-pointer group transition ${
        selected ? 'bg-bolt/10' : 'hover:bg-bone/5'
      }`}
    >
      <PodcastCover
        image={podcast.image}
        artwork={podcast.artwork}
        title={podcast.title}
        seed={podcast.podcastGuid ?? String(podcast.id)}
        className="w-14 h-14 border border-bone/20 flex-shrink-0 text-xl"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-display text-base leading-tight truncate">{podcast.title}</span>
          {podcast.isPreview && (
            <span className="stamp text-muted border-muted/40">NOT IN PI</span>
          )}
          {podcast.medium === 'publisher' && (
            <span className="stamp text-muted border-muted/40">▸ ALBUMS</span>
          )}
          {showV4VStamp && podcast.value && (
            <span className="stamp text-bolt border-bolt/60">⚡ V4V</span>
          )}
        </div>
        <div className="text-xs text-muted truncate">{podcast.author}</div>
      </div>
      <FavHeart podcast={podcast} />
    </li>
  );
}

export function PodcastResults({
  feeds,
  selected,
  onSelect,
}: {
  feeds: Podcast[];
  selected: number | null;
  onSelect: (p: Podcast) => void;
}) {
  if (!feeds.length) {
    return <p className="text-muted text-sm py-8 px-1">no results yet — try another phrase</p>;
  }
  return (
    <ul className="divide-y divide-bone/10">
      {feeds.map((p) => (
        <PodcastRow
          key={p.id}
          podcast={p}
          selected={selected === p.id}
          onSelect={onSelect}
          showV4VStamp
        />
      ))}
    </ul>
  );
}

/**
 * Group order for the favorites lists. Anything not named here sorts
 * alphabetically after these, and **medium-unknown is last and is its own
 * bucket** — never folded into `podcast`.
 *
 * That last part is the whole point of the position-4 hint. The list carries
 * podcasts and music at once by design, so whichever way you default you are
 * wrong about half of it, and an entry with no medium is one nobody has told us
 * about — which is not the same claim as "it's a podcast".
 */
const MEDIUM_ORDER = ['music', 'podcast', 'audiobook', 'film', 'video', 'newsletter', 'blog', 'publisher'];

/**
 * Split rows into medium buckets, in {@link MEDIUM_ORDER}, unknown last.
 *
 * Case is folded for BUCKETING only. The wire value is never normalized — the
 * medium vocabulary is open, so a value we don't recognize is one a newer app
 * does, and it gets its own bucket under its own label rather than being
 * dropped or coerced.
 */
function groupByMedium<T>(rows: T[], mediumOf: (row: T) => string | undefined) {
  const buckets = new Map<string, { label: string; rows: T[] }>();
  const unknown: T[] = [];
  for (const row of rows) {
    const raw = mediumOf(row);
    if (!raw) { unknown.push(row); continue; }
    const key = raw.toLowerCase();
    const bucket = buckets.get(key) ?? { label: raw, rows: [] };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  }
  const rank = (key: string) => {
    const i = MEDIUM_ORDER.indexOf(key);
    return i === -1 ? MEDIUM_ORDER.length : i;
  };
  const groups = [...buckets.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([key, b]) => ({ key, label: b.label, rows: b.rows }));
  if (unknown.length) groups.push({ key: '~unknown', label: 'medium unknown', rows: unknown });
  return groups;
}

/**
 * What one row of a favorited feed is called, by medium.
 *
 * A music feed's items are singles, not episodes — calling a track an episode
 * is wrong in the one place the user is most likely to be looking, since music
 * is the bulk of this list. Anything else keeps "episode": the alternatives
 * (chapters for an audiobook, and so on) are guesses about an open vocabulary,
 * and a wrong specific word reads worse than a right generic one.
 */
function itemNoun(mediumKey: string, n: number): string {
  const one = mediumKey === 'music' ? 'single' : 'episode';
  return n === 1 ? one : `${one}s`;
}

/**
 * What one favorited FEED is called, by medium — the `itemNoun` above one
 * level up. A favorited music feed is an album, not a show.
 */
function feedNoun(mediumKey: string, n: number): string {
  const one = mediumKey === 'music' ? 'album' : 'show';
  return n === 1 ? one : `${one}s`;
}

/**
 * Remembered collapsed state for the favorites group headings.
 *
 * Initialized LAZILY from storage rather than loaded in an effect. That is safe
 * here for a specific reason: both favorites lists render only inside
 * `<HomePage>`'s favorites panel, which is gated on its `mounted` flag (the
 * store's `identity` starts null, so `favoritesDegraded` can't open the panel on
 * the first pass either), and both return null on an empty list — so there is no
 * server render for this value to disagree with. An effect would instead paint
 * every group expanded for a frame and then snap them shut, which is precisely
 * the flash that persisting the state is meant to avoid.
 *
 * **Call this ONCE PER LIST, never per group.** The two lists each holding a Set
 * is safe (see the toggle below); N groups each holding one would not be, since
 * their key spaces overlap within a list.
 */
function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(storage.favCollapsed.get()));
  const toggle = (key: string) => {
    // Read-modify-write against STORAGE, not against local state. Both lists
    // mount this hook independently and the key holds one flat array covering
    // both namespaces, so writing `[...myOwnSet]` from the shows list would
    // silently erase every `ep:` key the episodes list had written, and vice
    // versa. The two in-memory Sets are then allowed to drift, because each
    // list only ever asks about keys in its own namespace.
    const next = new Set(storage.favCollapsed.get());
    if (!next.delete(key)) next.add(key);
    storage.favCollapsed.set([...next]);
    setCollapsed(next);
  };
  return [collapsed, toggle] as const;
}

/**
 * A group heading that folds its own group away.
 *
 * It always renders, including for a lone group — which reverses the old rule
 * that a single "PODCAST" banner was noise. That rule was right about a *banner*
 * and wrong about a *control*: the one-medium library is the one with no second
 * group to distinguish it from, and it is also the only one long enough to be
 * worth folding away.
 *
 * `controls` must be an id the caller got from `useId()`, NOT one built out of
 * the group key. A medium is feed-supplied and `groupByMedium` deliberately
 * never normalizes it beyond lowercasing, so `music video` — or any value with
 * stray whitespace — yields an id containing a space, and `aria-controls` is a
 * space-separated IDREF list. It would silently resolve to nothing for exactly
 * the unrecognized-medium groups that bucket exists to carry.
 */
function CollapsibleHeading({
  label,
  collapsed,
  onToggle,
  controls,
  className,
}: {
  label: React.ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  controls: string;
  className: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-controls={controls}
      className={`w-full text-[11px] uppercase tracking-widest text-muted px-1 flex items-center justify-between gap-2 hover:text-bone ${className}`}
    >
      <span className="text-left">{label}</span>
      <span aria-hidden className="text-bone/60">{collapsed ? '▸' : '▾'}</span>
    </button>
  );
}

/**
 * How many rows of one favorites group render before "show more".
 *
 * This is a BYTES cap wearing a UI hat. Each row mounts a <PodcastCover>
 * pointing at arbitrary third-party artwork, and podcast art in the wild is
 * routinely megabytes — measured on a real library: 55.6 MB of images across 84
 * requests, with a single 7.9 MB JPEG and a 4.8 MB animated GIF, all to paint
 * 56x56 tiles. On a slow connection that is minutes of downloading, and the
 * page never finishes.
 *
 * `loading="lazy"` alone was not enough: the browser still fetched most of a
 * long list because so much of it sits within its "near the viewport"
 * threshold. Not rendering the row at all is the reliable lever.
 *
 * Per GROUP rather than across the whole list, so each medium's heading can
 * keep stating its true total — a count that shrank to match what happened to
 * be revealed would be a worse lie than a long list.
 */
const FAV_PAGE = 12;

/** Reveal a list in FAV_PAGE-sized steps. Returns the visible slice + control. */
function useRevealed<T>(rows: T[]) {
  const [shown, setShown] = useState(FAV_PAGE);
  // A shorter list (an unfavorite, a medium filter change) must not leave the
  // counter stranded above it, or "show more" renders with nothing to add.
  const visible = rows.slice(0, shown);
  const remaining = Math.max(0, rows.length - visible.length);
  return {
    visible,
    remaining,
    more: () => setShown((n) => n + FAV_PAGE),
  };
}

/** The "show N more" control, shared by both favorites lists. */
function ShowMore({ remaining, onClick, noun }: { remaining: number; onClick: () => void; noun: string }) {
  if (remaining <= 0) return null;
  return (
    <button type="button" onClick={onClick} className="btn-ghost w-full mt-2 text-xs">
      show {Math.min(remaining, FAV_PAGE)} more {noun}
      {remaining > FAV_PAGE ? ` (${remaining} left)` : ''}
    </button>
  );
}

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

function ValueBlockDetails({ value }: { value: ValueBlock }) {
  const suggestedSats =
    value.suggested && Number.isFinite(parseFloat(value.suggested))
      ? Math.round(parseFloat(value.suggested) * 100_000_000)
      : null;

  return (
    <div className="border-b border-bone/15 pb-4 mb-1">
      <div className="text-[11px] uppercase tracking-widest text-muted pt-3 pb-2 flex items-center justify-between gap-4 flex-wrap">
        <span>value-block splits ({value.type} · {value.method})</span>
        {suggestedSats !== null && (
          <span className="text-bolt">suggested: {suggestedSats} sats / min</span>
        )}
      </div>
      <ValueSplitRows value={value} />
    </div>
  );
}

export function EpisodeList({ feedId, feedUrl }: { feedId: number | null; feedUrl?: string }) {
  const [data, setData] = useState<{ podcast: Podcast | null; episodes: Episode[] }>({
    podcast: null, episodes: [],
  });
  const [loading, setLoading] = useState(false);
  // A failed load used to fall through to the `not found` branch below, which
  // says the show doesn't exist when what actually happened is that the network
  // dropped. Separate state, separate message, and a way back.
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Generation counter for the feed fetch — the same guard lib/nostr/use-feed.ts
  // and components/podroll.tsx already use. See the effect below for why this
  // one is not merely a render optimisation.
  const feedGenRef = useRef(0);
  const [showBoostOpen, setShowBoostOpen] = useState(false);
  const [boostTrack, setBoostTrack] = useState<Episode | null>(null);
  const [valueOpen, setValueOpen] = useState(false);
  // Episodes are revealed 10 at a time behind a "Load more" button. The Nostr
  // comments feed sits below this list, so a button (not infinite scroll) keeps
  // it at a stable, reachable position on mobile.
  const [visibleCount, setVisibleCount] = useState(10);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Consecutive-miss counters for the two-misses-before-ended rule in
  // applyLiveStatuses — keyed per feedId so a stale count from the previous
  // show can't end an item on this one's very first poll.
  const liveMissesRef = useRef<Record<string, number>>({});
  const play = useApp((s) => s.play);
  const togglePlay = useApp((s) => s.togglePlay);
  const isPlaying = useApp((s) => s.isPlaying);
  const current = useApp((s) => s.current);
  const openEpisode = useApp((s) => s.openEpisode);
  const setEpisodeQueue = useApp((s) => s.setEpisodeQueue);
  const syncSelectedPodcast = useApp((s) => s.syncSelectedPodcast);

  useEffect(() => {
    setValueOpen(false);
    setVisibleCount(10);
    liveMissesRef.current = {};
    // setLoading(false) matters on this branch: it returns before the fetch
    // below, so a `loading` left true by a PREVIOUS run was never cleared and
    // the render — which checks `loading` first — sat on "loading episodes…"
    // forever. Reachable whenever a favorite hasn't resolved an id yet, which
    // is exactly the state a slow or failed metadata fetch leaves behind.
    if (!feedId) { setData({ podcast: null, episodes: [] }); setLoading(false); setLoadError(false); return; }
    setLoading(true);
    // Preview (not-in-PI) feeds load by URL — the synthetic id can't be
    // resolved server-side. PI feeds load by numeric id as before.
    const endpoint = feedUrl
      ? `/api/feed?url=${encodeURIComponent(feedUrl)}`
      : `/api/feed?id=${feedId}`;
    // The generation guard is a CORRECTNESS gate, not a perf one. Switching
    // shows quickly can land A's response after B's, and the handler below
    // writes `episodeQueue` — the array <TransportControls> computes prev/next
    // from and playNext() traverses. A late response therefore repointed the
    // transport at the previous show while this one was on screen.
    //
    // The `.catch` is the other half. `.finally` does NOT handle rejection, so
    // an offline fetch, a 5xx serving an HTML body, or any r.json() parse
    // failure was an unhandled promise rejection: loading cleared, data stayed
    // empty, and the page rendered `not found`.
    const gen = ++feedGenRef.current;
    setLoadError(false);
    fetch(endpoint)
      .then((r) => r.json())
      .then((d) => {
        if (gen !== feedGenRef.current) return;
        // An `{ error }` body parses fine and would otherwise put `undefined`
        // into the store as the episode queue.
        const episodes = Array.isArray(d?.episodes) ? d.episodes : [];
        if (!d?.podcast) { setLoadError(true); return; }
        setData({ podcast: d.podcast, episodes });
        setEpisodeQueue(episodes);
        // Push the RSS-enriched podcast (funding/medium/podroll) back into the
        // store so the episode detail view — which reads selectedPodcast — shows
        // the SUPPORT link the show page gets. No-op if it's a different show.
        syncSelectedPodcast(d.podcast);
      })
      .catch(() => {
        if (gen === feedGenRef.current) setLoadError(true);
      })
      .finally(() => {
        if (gen === feedGenRef.current) setLoading(false);
      });
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    // `reloadKey` is what the retry button below bumps — it re-runs this effect
    // without needing the feed to change.
  }, [feedId, feedUrl, reloadKey, setEpisodeQueue, syncSelectedPodcast]);

  // Above the early returns — hook order has to stay stable, and the hook
  // itself no-ops (returns nulls) while the podcast is still null.
  const { button: streamButton, panel: streamPanel } = useStreamPanel(
    data.podcast,
    hasValueRecipients(data.podcast?.value),
  );

  // A live item's status is fixed at load time otherwise: /api/feed is fetched
  // once per feedId and nothing asks again. Polls only while this feed has a
  // live item on screen, and patches liveStatus/liveStartTime in place —
  // setEpisodeQueue and syncSelectedPodcast are deliberately NOT re-fired, so
  // playback is undisturbed.
  const hasLiveItem = data.episodes.some((e) => !!e.liveStatus && e.liveStatus !== 'ended');
  useLiveStatusPoll(feedId, hasLiveItem, (items) => {
    // Plain read of `data` (not a setData updater): useLiveStatusPoll refreshes
    // its callback ref on every render, so this closure is always the latest by
    // the time a poll actually fires — and computing the ref mutation outside
    // setState avoids double-counting misses under React 18 Strict Mode's
    // double-invoke of updater functions.
    const { episodes, misses } = applyLiveStatuses(data.episodes, items, liveMissesRef.current);
    liveMissesRef.current = misses;
    if (episodes !== data.episodes) setData((prev) => ({ ...prev, episodes }));
  });

  if (!feedId) {
    return (
      <div ref={containerRef} className="text-muted text-sm py-12 text-center px-4 border border-dashed border-bone/15">
        <span className="lg:hidden">select a podcast above to see episodes</span>
        <span className="hidden lg:inline">select a podcast on the left to see episodes</span>
      </div>
    );
  }
  if (loading) return <div ref={containerRef} className="text-muted text-sm py-8">loading episodes…</div>;
  // A dropped connection is not the same answer as "this show doesn't exist",
  // and telling a user the second when the first happened sends them looking
  // for a problem that isn't there.
  if (loadError) {
    return (
      <div ref={containerRef} className="text-sm py-8 flex flex-wrap items-center gap-3">
        <span className="text-muted">couldn&apos;t load this show — check your connection</span>
        <button type="button" className="btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
          ↻ retry
        </button>
      </div>
    );
  }
  if (!data.podcast) return <div ref={containerRef} className="text-muted text-sm py-8">not found</div>;

  const showHasValue = hasValueRecipients(data.podcast.value);
  const isMusic = isMusicMedium(data.podcast);
  // First non-pending track — for music feeds episodes are sorted track-order ascending.
  const firstPlayable = data.episodes.find((e) => e.liveStatus !== 'pending') ?? data.episodes[0];
  // Is the currently-playing track part of this show?
  const showIsCurrent = !!current && (
    (!!data.podcast.podcastGuid && current.podcast.podcastGuid === data.podcast.podcastGuid) ||
    current.podcast.id === data.podcast.id
  );
  // Music feeds show the whole album (track order); other shows paginate 10 at a time.
  const visibleEpisodes = isMusic ? data.episodes : data.episodes.slice(0, visibleCount);
  const remaining = data.episodes.length - visibleEpisodes.length;

  return (
    <div ref={containerRef}>
      {/* NOT sticky on phones. Pinned, this header plus the app header held 282px
          of an 844px viewport — a third of the screen — and tracks scrolled
          underneath the album art, reading as three stacked layers fighting each
          other. It earns its keep on desktop, where it's ~156px of 900+ and the
          tracklist is long; on a phone it just eats the content.
          `top-` MUST stay sm:-prefixed: `top` on a *relative* element offsets it
          rather than pinning it, so an unprefixed value would shove the whole
          header a header's-height down the page.
          `gap-x-4` keeps the original 16px cover-to-text gap; `gap-y-3`
          reproduces the `mt-3` that came OFF the action cluster when it was
          hoisted out of the text column below. */}
      <header className="relative sm:sticky sm:top-[var(--app-header-h)] z-10 bg-ink/90 backdrop-blur -mx-4 px-4 flex flex-wrap items-start gap-x-4 gap-y-3 pb-4 border-b border-bone/15">
        {isMusic && firstPlayable ? (
          <button
            type="button"
            onClick={() => {
              if (showIsCurrent) togglePlay();
              else if (data.podcast) play(firstPlayable, data.podcast);
            }}
            className="group relative w-20 h-20 flex-shrink-0"
            title={showIsCurrent && isPlaying ? 'Pause' : 'Play album'}
            aria-label={showIsCurrent && isPlaying ? 'Pause' : 'Play album'}
          >
            <PodcastCover
              image={data.podcast.image}
              artwork={data.podcast.artwork}
              title={data.podcast.title}
              seed={data.podcast.podcastGuid ?? String(data.podcast.id)}
              className="w-full h-full border border-bone/20 group-hover:border-bolt text-3xl"
            />
            <div
              className={`absolute inset-0 grid place-items-center bg-ink/45 transition pointer-events-none text-2xl ${
                showIsCurrent && isPlaying ? 'text-bolt' : 'text-bone group-hover:text-bolt group-hover:bg-ink/55'
              }`}
            >
              {showIsCurrent && isPlaying ? '❚❚' : '▶'}
            </div>
          </button>
        ) : (
          <PodcastCover
            image={data.podcast.image}
            artwork={data.podcast.artwork}
            title={data.podcast.title}
            seed={data.podcast.podcastGuid ?? String(data.podcast.id)}
            className="w-20 h-20 border border-bone/20 flex-shrink-0 text-3xl"
          />
        )}
        <div className="min-w-0 flex-1">
          {/* text-lg on phones is sized to the COLUMN, not chosen for looks: the
              cover eats 80px + a 16px gap, leaving ~244px, and one long word
              ("Deprogramming") plus its article overflows that at text-xl and
              above — which orphaned "The" on its own line and pushed the rest
              past the clamp, ellipsizing an ordinary album title. The clamp
              bounds a STICKY header, so it has to stay, but at this size three
              lines hold ~60 characters before anything is lost. */}
          <h2 className="font-display text-lg sm:text-3xl leading-tight font-semibold break-words line-clamp-3 sm:line-clamp-none">
            {data.podcast.title}
          </h2>
          <p className="text-sm text-muted mt-1">{data.podcast.author}</p>
          {/* Both stamps share one wrapper. They are `inline-flex` and each used
              to carry its own `mt-2`, so a preview feed that ALSO has a value
              block rendered them separated by nothing but a JSX whitespace node
              — which collides at 326px. */}
          {(data.podcast.isPreview || data.podcast.value) && (
            <div className="flex flex-wrap items-center gap-2 mt-2">
              {data.podcast.isPreview && (
                <span
                  className="stamp text-muted border-muted/40"
                  title="This feed isn't in Podcast Index — parsed directly from RSS for preview"
                >
                  NOT IN PI · PREVIEW
                </span>
              )}
              {data.podcast.value && (
                <button
                  type="button"
                  onClick={() => setValueOpen((v) => !v)}
                  className="stamp text-bolt border-bolt/60 hover:bg-bolt/10 transition cursor-pointer"
                  aria-expanded={valueOpen}
                  title={valueOpen ? 'Hide split details' : 'Show split details'}
                >
                  ⚡ {data.podcast.value.recipients?.length ?? 0} recipients
                  <span className="ml-1">{valueOpen ? '▾' : '▸'}</span>
                </button>
              )}
            </div>
          )}
        </div>
        {/* A `basis-full` SIBLING of the text column, not a child of it. DOM
            nesting can't be responsive, and nested under the author line this
            cluster is capped at ~230px on a 390px screen — which stacks five
            ~105px controls one-per-line into a ragged column. As a basis-full
            sibling it claims the header's whole width at every breakpoint (the
            header is `flex-wrap` for exactly this). Order is documented in
            docs/ui.md; all five controls stay, none hide behind a menu. */}
        <div className="basis-full flex flex-wrap items-center gap-2">
          <FavHeart podcast={data.podcast} size="md" />
          <ShareButton podcast={data.podcast} />
          <SupportButton podcast={data.podcast} />
          {streamButton}
          {showHasValue && (
            <button
              onClick={() => setShowBoostOpen(true)}
              className="btn-bolt btn-compact"
              title="Boost the show"
            >
              <BoltIcon /> BOOST
            </button>
          )}
        </div>
      </header>
      {streamPanel && (
        <div className="px-4 sm:px-6 pb-4 border-b border-bone/10">{streamPanel}</div>
      )}
      {valueOpen && data.podcast.value && (
        <ValueBlockDetails value={data.podcast.value} />
      )}
      <ul className="divide-y divide-bone/10">
        {visibleEpisodes.map((e, idx) => {
          const playing = current?.episode.id === e.id;
          const prev = idx > 0 ? visibleEpisodes[idx - 1] : null;
          const isFirstLive = !!e.liveStatus && (!prev || !prev.liveStatus);
          const isFirstRegular = !e.liveStatus && !!prev?.liveStatus;
          return (
            <Fragment key={e.id}>
              {isFirstLive && (
                <li className="text-[10px] uppercase tracking-[0.18em] text-muted pt-3 pb-1 border-b-0">
                  Live &amp; upcoming
                </li>
              )}
              {isFirstRegular && (
                <li className="text-[10px] uppercase tracking-[0.18em] text-muted pt-4 pb-1 border-b-0">
                  Episodes
                </li>
              )}
            <li
              className={`group transition ${
                playing ? 'bg-bolt/10' : 'hover:bg-bone/5'
              } cursor-pointer`}
              onClick={() => {
                // Tracks carry little extra metadata, so a row tap just plays
                // the track rather than opening the episode detail view.
                if (isMusic) {
                  if (e.liveStatus !== 'pending' && data.podcast) play(e, data.podcast);
                } else {
                  openEpisode(e);
                }
              }}
            >
              <div className="flex gap-2 sm:gap-3 py-3 pr-1 sm:pr-3">
              <button
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  if (e.liveStatus === 'pending') return;
                  if (data.podcast) play(e, data.podcast);
                }}
                disabled={e.liveStatus === 'pending'}
                className="relative w-12 h-12 flex-shrink-0 disabled:cursor-not-allowed"
                title={e.liveStatus === 'pending' ? 'Not started yet' : playing ? 'Now playing' : 'Play'}
                aria-label={playing ? 'Now playing' : 'Play'}
              >
                <PodcastCover
                  image={e.image}
                  artwork={e.feedImage || data.podcast?.artwork}
                  title={e.title}
                  seed={e.guid ?? String(e.id)}
                  className="w-full h-full border border-bone/40 group-hover:border-bolt text-base"
                />
                {e.liveStatus !== 'pending' && (
                  <div
                    className={`absolute inset-0 grid place-items-center bg-ink/55 transition pointer-events-none ${
                      playing
                        ? 'opacity-100 text-bolt'
                        : 'opacity-0 group-hover:opacity-100 text-bone group-hover:text-bolt'
                    }`}
                  >
                    {playing ? '❚❚' : '▶'}
                  </div>
                )}
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  {e.liveStatus && <LiveBadge status={e.liveStatus} />}
                  <div className="text-base font-display font-medium leading-tight truncate">{e.title}</div>
                </div>
                {/* Wraps, deliberately NOT truncates: at ~150px the date and
                    duration fit line 1 and `· ⚡ V4V` drops to line 2, whereas a
                    truncate here would silently eat the V4V signal. Without the
                    wrap these spans couldn't shrink below their content and
                    painted out sideways under the BOOST button. */}
                <div className="text-xs text-muted flex flex-wrap gap-x-2 gap-y-0.5 min-w-0 mt-0.5">
                  {e.liveStatus && e.liveStartTime ? (
                    <span className="whitespace-nowrap">
                      {e.liveStatus === 'pending' ? 'starts ' : 'started '}
                      {fmtLiveTime(e.liveStartTime)}
                    </span>
                  ) : (
                    e.datePublished && (
                      <span className="whitespace-nowrap">
                        {fmtDate(e.datePublished)}
                      </span>
                    )
                  )}
                  {e.duration && <span className="whitespace-nowrap">· {fmtDuration(e.duration)}</span>}
                  {e.value && <span className="text-bolt whitespace-nowrap">· ⚡ V4V</span>}
                </div>
                {/* These were bare inline <span>s carrying `mt-0.5`, which does
                    nothing on a non-replaced inline element, and they abutted
                    with only a JSX whitespace node between them when both ran. */}
                {e.socialInteract?.length || e.valueTimeSplits?.length ? (
                  <div className="flex flex-wrap items-center gap-x-2 text-[11px] mt-0.5">
                    {e.socialInteract?.length ? (
                      <span className="text-nostr">💬 discussion</span>
                    ) : null}
                    {e.valueTimeSplits?.length ? (
                      <span className="text-bolt">⚡ {e.valueTimeSplits.length} tracks</span>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {hasValueRecipients(e.value) && (
                // Icon-only below sm: — the word cost ~100px of a ~314px row and
                // left the title ~24px ("Vi…", "Co…"). aria-label is REQUIRED
                // now, not decorative: `title` is not an accessible name, so
                // without it this button reads as unlabelled once the word goes.
                <button
                  type="button"
                  onClick={(ev) => { ev.stopPropagation(); setBoostTrack(e); }}
                  className="btn-bolt btn-compact self-center flex-shrink-0 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0"
                  title="Boost this track"
                  aria-label="Boost this track"
                >
                  <BoltIcon />
                  <span className="hidden sm:inline">BOOST</span>
                </button>
              )}
              <div className="self-center flex-shrink-0">
                <FavEpisodeHeart episode={e} podcast={data.podcast} />
              </div>
              </div>
            </li>
            </Fragment>
          );
        })}
      </ul>
      {remaining > 0 && (
        <button
          type="button"
          onClick={() => setVisibleCount((c) => Math.min(c + 10, data.episodes.length))}
          className="btn-ghost w-full mt-3"
        >
          Load more episodes ({remaining})
        </button>
      )}

      {/* No placeholder: <Podroll> renders its own skeleton while resolving and
          nothing at all if no entry resolves, so a placeholder heading here
          would flash in and then vanish. */}
      {data.podcast.podroll?.length ? (
        <DeferredOnScroll>
          <Podroll items={data.podcast.podroll} />
        </DeferredOnScroll>
      ) : null}

      {data.podcast.podcastGuid && (
        <DeferredOnScroll
          placeholder={
            <h3 className="font-display text-lg mt-8 text-muted">
              <span className="text-nostr">#</span> Boosts &amp; chatter on Nostr
              {data.podcast.title ? (
                <span className="text-muted text-sm"> · {data.podcast.title}</span>
              ) : null}
            </h3>
          }
        >
          <PodcastNostrFeed
            podcastGuid={data.podcast.podcastGuid}
            podcastTitle={data.podcast.title}
            episodeGuids={
              isMusic
                ? data.episodes.map((e) => e.guid).filter((g): g is string => !!g)
                : undefined
            }
          />
        </DeferredOnScroll>
      )}

      {showBoostOpen && data.podcast && showHasValue && (
        <BoostModal
          podcast={data.podcast}
          onClose={() => setShowBoostOpen(false)}
        />
      )}

      {boostTrack && data.podcast && (
        <BoostModal
          episode={boostTrack}
          podcast={data.podcast}
          onClose={() => setBoostTrack(null)}
        />
      )}

    </div>
  );
}
