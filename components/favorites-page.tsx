'use client';
import { useEffect, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { clearShowSelection, useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { loadEpisodeFromFeed, resolvePodcastByGuid } from '@/lib/podcast-meta';
import { FavoritesSyncNotice } from '@/components/favorites-sync-notice';
import { FavoritesPrivacyControl } from '@/components/favorites-privacy';
import { FavoriteFeedRows, FavoriteItemRows, sortFavorites } from '@/components/lists/favorites';
import {
  groupByMedium, feedNoun, itemNoun, splitLabels, crossSplitLabel,
  useCollapsedGroups, CollapsibleHeading,
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
  // Signed in AND the relay read came back untrustworthy. Same expression
  // <FavoritesSyncNotice> gates itself on — 'idle' is the pre-hydration and
  // signed-out state, never a failure. Read here too because the EMPTY branch
  // below must not describe a degraded read as an empty library.
  const degraded = useApp((s) => !!s.identity && s.favoritesSync === 'degraded');
  // "Not on Nostr" — chosen, not pending. See `favoritesSync` in lib/store.ts.
  const syncOff = useApp((s) => !!s.identity && s.favoritesSync === 'off');
  // Signed in and the relay read has not answered yet — 'idle' is the state
  // before `runHydrate` starts, 'loading' is while it runs, and BOTH have to
  // count. Hydration no longer begins on the same tick as the mount (it waits
  // for this account's NIP-65 write set when the device has none cached), so
  // 'idle' is a real window rather than a theoretical one.
  //
  // Signed out is excluded on purpose: favorites are local with no key to sync
  // them under, so there is no read in flight and an empty list is known
  // immediately and honestly.
  const checking = useApp(
    (s) => !!s.identity && (s.favoritesSync === 'idle' || s.favoritesSync === 'loading'),
  );
  const selectPodcast = useApp((s) => s.selectPodcast);
  const setShowOrigin = useApp((s) => s.setShowOrigin);
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
      ...feedRows.map((r) => ({ medium: r.medium, kind: 'feeds' as const })),
      ...itemRows.map((r) => ({ medium: r.medium, kind: 'items' as const })),
    ];
    // Counted per HALF as well as per medium, because the mixed tab offers one
    // chip per (medium, half) pair and a chip that filters to nothing is worse
    // than no chip — `~unknown` routinely holds items and no feeds.
    return groupByMedium(merged, (r) => r.medium).map((g) => ({
      key: g.key,
      label: g.label,
      count: g.rows.length,
      feedCount: g.rows.filter((r) => r.kind === 'feeds').length,
      itemCount: g.rows.filter((r) => r.kind === 'items').length,
    }));
  }, [feedRows, itemRows]);

  // A medium can disappear under the user (the last album of it unfavorited),
  // and a tab that no longer exists would filter everything away with no way
  // back. Fall through to All rather than showing an empty page.
  const tab = tabs.some((t) => t.key === view.tab) ? view.tab : 'all';

  // DERIVED, not stored, and that is what keeps the two rows honest. On the
  // mixed tab a split chip names a medium as well as a half, so pressing one
  // moves the tab too — which leaves 'all' as the only split state that tab can
  // display. Reading `view.split` there instead would render five chips with
  // none of them active over a list silently filtered to half of it, reachable
  // by picking MUSIC + ALBUMS and then pressing ALL.
  //
  // Kept even though every tab press now writes `split: 'all'` itself: the
  // stored tab can also stop existing under the user (the last album of a
  // medium unfavorited), and that path falls through to ALL without any click
  // to reset the half.
  const split = tab === 'all' ? 'all' : view.split;

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
    // AFTER selectPodcast, never before: that action clears `showOrigin` so an
    // ordinary selection resets it without knowing the field exists. The show
    // page's back control reads this to offer a return HERE — it used to say
    // "← back to results" and clear the selection in place, which on this path
    // named a results list the visitor had never seen and left no way back to
    // the library they came from.
    setShowOrigin(FAVORITES_ORIGIN);
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
    setShowOrigin(FAVORITES_ORIGIN); // see openFeed
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
  //
  // Passed as FUNCTIONS: <PagedList> labels a "show N more …" control and the
  // only number that word is read against is what remains, which the page does
  // not know. `feedNoun`/`itemNoun` own the whole vocabulary now, including the
  // two keys that name no medium — 'all' and '~unknown' both resolve to the
  // generic word rather than asserting "show"/"episode" over a bucket that
  // exists precisely because nobody told us.
  const feedWord = (n: number) => feedNoun(tab, n);
  const itemWord = (n: number) => itemNoun(tab, n);

  // The split chips and the two section headings share ONE pair of words. They
  // sit one row apart, so a chip reading ALBUMS above a heading reading
  // "albums & shows" is the same confusion the compound caused in the first
  // place — the label has to say what the control did. See `splitLabels` for
  // why 'all' and '~unknown' keep the compound instead of guessing a noun.
  const half = splitLabels(tab);

  /**
   * The second row: EVERYTHING, then one chip per half.
   *
   * Under a medium tab that is two chips and each sets the half alone. Under
   * ALL a single word for a half would have to be a compound — "albums &
   * shows" — which is two concepts in one box on a library that is nearly all
   * one medium, so the row offers one chip per (medium, half) PAIR instead and
   * each chip sets both. Pressing SHOWS moves the tab above to PODCAST, which
   * is the point: the two rows describe one filter and must never disagree
   * about it.
   *
   * Built from `tabs`, so only media the user actually has appear — there is no
   * hand-written list of media here for the same reason the tab strip has none.
   * Feed chips first, then item chips: grouping by half reads as two ranks
   * (things you play through, things you play) where interleaving by medium
   * reads as an arbitrary order.
   *
   * A pair with no rows gets no chip. `~unknown` typically holds items and no
   * feeds, and a chip that filters to an empty section is worse than an absent
   * one.
   */
  const splitChips = useMemo(() => {
    if (tab !== 'all') {
      return [
        { id: 'feeds', label: half.feeds, tab, split: 'feeds' as const },
        { id: 'items', label: half.items, tab, split: 'items' as const },
      ];
    }
    return [
      ...tabs
        .filter((t) => t.feedCount > 0)
        .map((t) => ({
          id: `${t.key}|feeds`,
          label: crossSplitLabel(t.key, t.label, 'feeds'),
          tab: t.key,
          split: 'feeds' as const,
        })),
      ...tabs
        .filter((t) => t.itemCount > 0)
        .map((t) => ({
          id: `${t.key}|items`,
          label: crossSplitLabel(t.key, t.label, 'items'),
          tab: t.key,
          split: 'items' as const,
        })),
    ];
  }, [tabs, tab, half.feeds, half.items]);

  const showFeeds = split !== 'items';
  const showItems = split !== 'feeds';

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

      {/* Above the loading/empty/rows split on purpose, so it is reachable in
          every one of them. A signed-in user with nothing saved yet is exactly
          who most wants to set this BEFORE their first favorite, and putting it
          inside the rows branch would hide it from them. Self-hiding signed
          out, where all three options describe the same behaviour. */}
      <FavoritesPrivacyControl />

      {/* `checking` shares this branch with the pre-mount gate, and it is not
          cosmetic. Without it a signed-in user whose read was still in flight
          fell straight through to <EmptyLibrary>, which says "Nothing saved
          yet." in the largest type on the page — a positive claim about their
          library, made while the app did not yet know. That is the exact
          failure the comment on <EmptyLibrary> describes for a degraded read,
          one state earlier: it does not withhold silently, it withholds while
          asserting the opposite. Reported from a phone — the favorites button
          showed an empty library on the first press and the real list on the
          second, because the read landed in between. It self-corrects, which
          is what makes it worse: nobody presses twice after being told there
          is nothing there. */}
      {!mounted || (total === 0 && checking) ? (
        <p className="text-muted text-sm py-8">loading your favorites…</p>
      ) : total === 0 ? (
        <EmptyLibrary signedIn={!!identity} degraded={degraded} off={syncOff} />
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
              {/* A tab press clears the half back to EVERYTHING. The two rows
                  are one filter, and this is the row that names the WIDER of
                  the two axes — pressing it reads as "show me this medium",
                  not "show me this medium, still narrowed to whatever half I
                  was in three clicks ago". Carrying the half over is defensible
                  and was worse in practice: press SHOWS, then press MUSIC, and
                  you land on albums with no tracks and nothing on screen
                  saying a second filter is still on. */}
              <Chip active={tab === 'all'} onClick={() => update({ tab: 'all', split: 'all' })}>
                all <span className="opacity-60">{total}</span>
              </Chip>
              {tabs.map((t) => (
                <Chip
                  key={t.key}
                  active={tab === t.key}
                  onClick={() => update({ tab: t.key, split: 'all' })}
                >
                  {t.label} <span className="opacity-60">{t.count}</span>
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Chip active={split === 'all'} onClick={() => update({ split: 'all' })}>everything</Chip>
              {splitChips.map((c) => (
                <Chip
                  key={c.id}
                  active={tab === c.tab && split === c.split}
                  onClick={() => update({ tab: c.tab, split: c.split })}
                >
                  {c.label}
                </Chip>
              ))}
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
                  heading={half.feeds}
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
                  heading={half.items}
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

/** Read by `<HomePage>`'s back control — see `showOrigin` in lib/store.ts. */
const FAVORITES_ORIGIN = { path: '/favorites', label: 'favorites' };

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
 * Nothing to show. TWO different claims share this component, and telling them
 * apart is the whole reason it takes `degraded`.
 *
 * `total === 0` is reached in two ways, and only one of them is an empty
 * library. The other is a degraded relay read on a device with no cache — a new
 * browser, a private tab, a second device — which is precisely the case
 * <FavoritesSyncNotice> exists for. "Nothing saved yet." is a positive claim
 * about the user's library, in the largest type on the page, and in that case
 * it is false: the list may be full and unreadable.
 *
 * Putting the notice above this branch is necessary and was not sufficient.
 * Two elements on one screen made opposite claims and the louder one was wrong,
 * which is the same failure as the silent guard this repo already paid for
 * once, one step further along: it no longer withholds silently, it withholds
 * while asserting the opposite. So the headline changes with the read, and the
 * degraded copy never says "saved" — it says what this DEVICE holds and points
 * at the retry.
 *
 * The signed-out half is unaffected: with no key there is no relay read to
 * degrade, so `degraded` is false and the onboarding copy stands.
 */
function EmptyLibrary({
  signedIn,
  degraded,
  off,
}: { signedIn: boolean; degraded: boolean; off: boolean }) {
  return (
    <div className="card p-6 flex flex-col gap-3 items-start">
      <p className="font-display text-xl">
        {degraded ? 'Nothing on this device.' : 'Nothing saved yet.'}
      </p>
      <p className="text-sm text-muted leading-relaxed max-w-prose">
        {degraded
          ? 'Your favorites could not be read from the relays, so anything saved in another app or on another device is not shown. Use retry above once you are back online.'
          : 'Tap ♡ on any show, album, episode or track and it lands here.'}
        {/* Signed in but not syncing is its own sentence. Without it the line
            below fires instead — "sign in with Nostr to sync them" — told to
            somebody who IS signed in and turned syncing off on purpose. */}
        {signedIn && off && !degraded
          && ' Favorites are set to stay on this device, so nothing saved in another app is shown here.'}
        {!signedIn && ' Favorites are stored on this device — sign in with Nostr to sync them across apps.'}
      </p>
      {/* Clears the selection for the same reason <AppHeader>'s wordmark does
          on this route — see `clearShowSelection`. */}
      <Link href="/" onClick={clearShowSelection} className="btn-ghost text-xs">
        ← back to search
      </Link>
    </div>
  );
}
