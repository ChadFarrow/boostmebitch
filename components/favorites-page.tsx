'use client';
import { useEffect, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { loadEpisodeFromFeed, resolvePodcastByGuid } from '@/lib/podcast-meta';
import { FavoritesSyncNotice } from '@/components/favorites-sync-notice';
import { FavoriteFeedRows, FavoriteItemRows, sortFavorites } from '@/components/lists/favorites';
import {
  groupByMedium, feedNoun, itemNoun, useCollapsedGroups, CollapsibleHeading,
} from '@/components/lists/grouping';
import type { FavoriteEpisode, FavoritePodcast, Podcast } from '@/lib/types';

/**
 * The favorites library at `/favorites`.
 *
 * It replaces a `max-h-[70vh]` aside on the home page that was collapsed by
 * default and showed twelve rows per medium. That was survivable at a dozen
 * favorites and not at two hundred, which is the size of a real list — and
 * favorites are the app's most consequential local state, being what gets
 * published to the shared kind:10333 event.
 *
 * Three things it inherits and must not lose:
 *
 *  - **Every entry gets a row, resolved or not.** The store maps are what gets
 *    published; a row hidden because Podcast Index didn't answer makes an
 *    outage look like the user removed something. The FILTER may hide rows,
 *    because that is the user's own action — a guard hiding them is not.
 *  - **Twelve rows at a time.** `useRevealed`'s cap is a bytes cap: each row
 *    mounts a cover against arbitrary third-party artwork.
 *  - **A degraded read must say so.** `<FavoritesSyncNotice>` sits above the
 *    controls, so neither a filter nor a folded section can hide the reason the
 *    list is short.
 */
export function FavoritesPage() {
  const favorites = useApp((s) => s.favorites);
  const favoriteEpisodes = useApp((s) => s.favoriteEpisodes);
  const identity = useApp((s) => s.identity);
  const selectPodcast = useApp((s) => s.selectPodcast);
  const syncSelectedPodcast = useApp((s) => s.syncSelectedPodcast);
  const openEpisode = useApp((s) => s.openEpisode);
  const router = useRouter();

  // `mounted` gate, for the reason <AuthControl> and the old home-page panel
  // both document: lib/store.ts hydrates `favorites` from localStorage at
  // MODULE scope, which is `{}` on the server and already populated on the
  // client before React hydrates. Everything below reads those maps, so a
  // first client render that used them would disagree with the server HTML and
  // React 19 would throw this subtree away and rebuild it. It also covers
  // `useCollapsedGroups`, whose lazy initializer reads storage for the same
  // reason.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [view, setView] = useState(() => storage.favView.get());
  const [q, setQ] = useState('');
  // Write through on every change: these are device settings, and a favorites
  // page you left filtered to music should still be filtered to music.
  function update(patch: Partial<typeof view>) {
    const next = { ...view, ...patch };
    setView(next);
    storage.favView.set(next);
  }

  const feedRows = useMemo(() => Object.values(favorites), [favorites]);
  const itemRows = useMemo(() => Object.values(favoriteEpisodes), [favoriteEpisodes]);
  const total = feedRows.length + itemRows.length;

  // The tab strip is `groupByMedium`'s own output, deliberately, rather than a
  // hand-written list of media. That keeps three properties this page would
  // otherwise have to re-earn: MEDIUM_ORDER's ordering, a feed-supplied label
  // never normalized beyond lowercasing for the bucket key, and — the one that
  // matters — `~unknown` as its OWN bucket. An entry whose medium nobody has
  // told us about is not a podcast, and folding it into one would make it
  // findable only by accident.
  const tabs = useMemo(() => {
    const merged = [
      ...feedRows.map((r) => ({ medium: r.medium })),
      ...itemRows.map((r) => ({ medium: r.medium })),
    ];
    return groupByMedium(merged, (r) => r.medium).map((g) => ({
      key: g.key, label: g.label, count: g.rows.length,
    }));
  }, [feedRows, itemRows]);

  // A medium can disappear under the user (the last album of it unfavorited),
  // and a tab that no longer exists would filter everything away with no way
  // back. Fall through to All rather than showing an empty page.
  const tab = tabs.some((t) => t.key === view.tab) ? view.tab : 'all';

  const query = q.trim().toLowerCase();
  const feeds = useMemo(
    () => sortFavorites(feedRows.filter((r) => inTab(r, tab) && matches(feedHay(r), query)), view.sort),
    [feedRows, tab, query, view.sort],
  );
  const items = useMemo(
    () => sortFavorites(itemRows.filter((r) => inTab(r, tab) && matches(itemHay(r), query)), view.sort),
    [itemRows, tab, query, view.sort],
  );

  // ONE hook for the whole page — see the note on useCollapsedGroups. Two
  // sections, two keys, and they are deliberately NOT the old 'show:<medium>' /
  // 'ep:<medium>' keys: those meant "this medium's group is folded", a
  // statement this page can no longer make. The stale ones sit inertly in
  // `bmb:fav_collapsed` and need no migration; the read is a membership test.
  const [collapsed, toggleCollapsed] = useCollapsedGroups();
  const feedsListId = useId();
  const itemsListId = useId();

  // Everything that changes WHICH rows these are. Sort is in it even though it
  // changes no count: after a re-sort, "revealed sixty" names a different sixty.
  const resetKey = `${query}|${tab}|${view.sort}`;

  /**
   * Open a favorited feed: set the selection, then go home.
   *
   * The show and episode views are `<HomePage>` state, so this is a handoff
   * rather than a navigation with a payload. Setting the store rather than
   * pushing `/?podcast=<guid>` is the safe direction: the store is
   * module-level and survives the route change, and `<HomePage>`'s restore
   * effect early-returns whenever a selection is already set — so a user who
   * had opened any show earlier in the session would have had their param
   * silently ignored and landed back on that show. `<HomePage>`'s own
   * selection-to-URL mirror then writes `?podcast=` for them, so the address
   * bar still ends up shareable.
   *
   * It also keeps working during a Podcast Index outage. A URL handoff would
   * route back through `resolvePodcastByGuid` and land on a blank home page,
   * which is the failure mode this repo has already paid for once.
   */
  function openFeed(p: Podcast) {
    selectPodcast(p);
    router.push('/');
  }

  /**
   * Open a favorited item. Same handoff, one step longer.
   *
   * The show goes up FIRST and unconditionally: it is what the user sees while
   * the feed loads, it is where they land if the episode can't be found, and
   * `selectPodcast` clears `selectedEpisode`, so opening the episode before it
   * would immediately undo itself. It also means `<EpisodeList>` mounts on `/`
   * and fetches the same feed alongside this call — that looks like waste and
   * isn't, because `<EpisodeList>` is the only writer of `episodeQueue`, which
   * is what `<TransportControls>` computes prev/next from.
   */
  async function openItem(ep: FavoriteEpisode) {
    const { feedGuid } = ep;
    // feedId is present for anything this device resolved through PI. An entry
    // synced from another app before its backfill ran has only the guid, so
    // fall back to resolving it on demand.
    if (!feedGuid) return;
    const podcast: Podcast | null = ep.feedId
      ? {
          id: ep.feedId,
          podcastGuid: feedGuid,
          title: ep.podcastTitle ?? ep.title ?? '',
          image: ep.image,
          url: ep.feedUrl,
        }
      : await resolvePodcastByGuid(feedGuid);
    if (!podcast) return;
    selectPodcast(podcast);
    router.push('/');
    const loaded = await loadEpisodeFromFeed(podcast.id, ep.itemGuid);
    if (!loaded) return;
    // A second tap (or a tap on BACK) during the fetch must win — otherwise a
    // slow response drags the user into an episode of a show they already left.
    // Compares ids, not mount identity, so it holds across the navigation.
    const selected = useApp.getState().selectedPodcast;
    if (!selected || selected.id !== podcast.id) return;
    // Fill in the RSS-derived funding/medium/podroll the by-guid resolve
    // doesn't carry, so the episode page shows the same SUPPORT link it would
    // if opened from the show.
    syncSelectedPodcast(loaded.podcast);
    // No episode means the feed doesn't list this guid (PI returns the latest
    // 50), which is a real state for an old favorite. The show page is already
    // on screen — leave them there rather than assembling an episode out of the
    // display cache.
    if (loaded.episode) openEpisode(loaded.episode);
  }

  // Nouns follow the tab, because that is the only place this page knows a
  // medium from. Under All it has a mixed list and has to pick a generic word,
  // which is the trade MEDIUM_ORDER's own note describes.
  const feedWord = tab === 'all' ? 'favorites' : feedNoun(tab, feeds.length);
  const itemWord = tab === 'all' ? 'favorites' : itemNoun(tab, items.length);

  const showFeeds = view.split !== 'items';
  const showItems = view.split !== 'feeds';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h1 className="headline text-4xl sm:text-5xl">favorites<span className="text-bolt">.</span></h1>
        {/* Pre-mount this says nothing rather than "0 saved" — the store has
            not been read yet, and an empty claim here is a lie for anyone
            returning. */}
        {mounted && total > 0 && (
          <span className="text-[11px] uppercase tracking-widest text-muted">{total} saved</span>
        )}
      </div>

      {/* Above the controls, not inside a section: a filter or a fold must not
          hide the reason the list is short. Self-hiding unless signed in AND
          degraded. */}
      <FavoritesSyncNotice />

      {!mounted ? (
        <p className="text-muted text-sm py-8">loading your favorites…</p>
      ) : total === 0 ? (
        <EmptyLibrary signedIn={!!identity} />
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="filter by title, show or artist…"
              aria-label="Filter favorites"
              className="input"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Chip active={tab === 'all'} onClick={() => update({ tab: 'all' })}>
                all <span className="opacity-60">{total}</span>
              </Chip>
              {tabs.map((t) => (
                <Chip key={t.key} active={tab === t.key} onClick={() => update({ tab: t.key })}>
                  {t.label} <span className="opacity-60">{t.count}</span>
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Chip active={view.split === 'all'} onClick={() => update({ split: 'all' })}>everything</Chip>
              <Chip active={view.split === 'feeds'} onClick={() => update({ split: 'feeds' })}>albums &amp; shows</Chip>
              <Chip active={view.split === 'items'} onClick={() => update({ split: 'items' })}>tracks &amp; episodes</Chip>
              <span className="ml-auto flex items-center gap-2">
                <Chip active={view.sort === 'recent'} onClick={() => update({ sort: 'recent' })}>recent</Chip>
                <Chip active={view.sort === 'az'} onClick={() => update({ sort: 'az' })}>a–z</Chip>
              </span>
            </div>
          </div>

          {/* A filter that matches nothing is NOT an empty library, and saying
              so in the same words would be the same mistake as reporting a
              degraded read as an empty list. The true total stays on screen. */}
          {query && !feeds.length && !items.length ? (
            <p className="text-muted text-sm py-8">
              Nothing matches “{q.trim()}”.{' '}
              <button type="button" onClick={() => setQ('')} className="underline underline-offset-2 hover:text-bone">
                clear the filter
              </button>{' '}
              to see all {total}.
            </p>
          ) : (
            <>
              {showFeeds && (
                <Section
                  listId={feedsListId}
                  heading="albums & shows"
                  shown={feeds.length}
                  ofTotal={query || tab !== 'all' ? feedRows.length : null}
                  collapsed={collapsed.has('favpage:feeds')}
                  onToggle={() => toggleCollapsed('favpage:feeds')}
                >
                  <FavoriteFeedRows
                    id={feedsListId}
                    rows={feeds}
                    resetKey={resetKey}
                    hidden={collapsed.has('favpage:feeds')}
                    noun={feedWord}
                    onSelect={openFeed}
                  />
                </Section>
              )}
              {showItems && (
                <Section
                  listId={itemsListId}
                  heading="tracks & episodes"
                  shown={items.length}
                  ofTotal={query || tab !== 'all' ? itemRows.length : null}
                  collapsed={collapsed.has('favpage:items')}
                  onToggle={() => toggleCollapsed('favpage:items')}
                >
                  <FavoriteItemRows
                    id={itemsListId}
                    rows={items}
                    resetKey={resetKey}
                    hidden={collapsed.has('favpage:items')}
                    noun={itemWord}
                    onOpen={openItem}
                  />
                </Section>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function inTab(row: { medium?: string }, tab: string): boolean {
  if (tab === 'all') return true;
  if (tab === '~unknown') return !row.medium;
  return row.medium?.toLowerCase() === tab;
}

/**
 * The guid is part of the haystack on purpose.
 *
 * An `<UnresolvedFavoriteRow>` has no title and prints its identifier — it is
 * the row a user is most likely to be hunting for, because it is the one they
 * might want to clean up. Matching only on titles would make every placeholder
 * vanish the moment anyone typed.
 */
function feedHay(r: FavoritePodcast): string {
  return `${r.title ?? ''} ${r.author ?? ''} ${r.podcastGuid}`.toLowerCase();
}
function itemHay(r: FavoriteEpisode): string {
  return `${r.title ?? ''} ${r.podcastTitle ?? ''} ${r.itemGuid}`.toLowerCase();
}
function matches(hay: string, query: string): boolean {
  return !query || hay.includes(query);
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider border transition ${
        active
          ? 'border-bolt text-bolt bg-bolt/10'
          : 'border-bone/30 text-muted hover:border-bone/60 hover:text-bone'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * One foldable section.
 *
 * `shown` / `ofTotal`: the heading states how many rows the section HAS, never
 * how many happen to be revealed — a count that shrank to match the visible
 * slice would be a worse lie than a long list. When a filter or a tab is
 * narrowing it, it says so explicitly rather than quietly restating a smaller
 * number as if it were the whole.
 */
function Section({
  listId, heading, shown, ofTotal, collapsed, onToggle, children,
}: {
  listId: string;
  heading: string;
  shown: number;
  ofTotal: number | null;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  if (!shown && ofTotal === null) return null;
  return (
    <section>
      <CollapsibleHeading
        label={
          <>
            {heading} — {shown}
            {ofTotal !== null && ofTotal !== shown ? ` of ${ofTotal}` : ''}
          </>
        }
        collapsed={collapsed}
        onToggle={onToggle}
        controls={listId}
        className="mt-3 mb-1"
      />
      {children}
    </section>
  );
}

/**
 * Nothing saved. Three states share this component and only two of them are
 * this one — a degraded read renders <FavoritesSyncNotice> above and must not
 * be told its library is empty, which is why that notice is outside this
 * branch and this copy never claims the relay agreed.
 */
function EmptyLibrary({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="card p-6 flex flex-col gap-3 items-start">
      <p className="font-display text-xl">Nothing saved yet.</p>
      <p className="text-sm text-muted leading-relaxed max-w-prose">
        Tap ♡ on any show, album, episode or track and it lands here.
        {!signedIn && ' Favorites are stored on this device — sign in with Nostr to sync them across apps.'}
      </p>
      <Link href="/" className="btn-ghost text-xs">← back to search</Link>
    </div>
  );
}
