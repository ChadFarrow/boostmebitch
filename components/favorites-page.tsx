'use client';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Event as NostrEvent } from 'nostr-tools';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { clearShowSelection, useApp } from '@/lib/store';
import { storage, type FavView } from '@/lib/storage';
import { BRAND } from '@/lib/brand';
import {
  backupRefusal, backupSummary, favoritesBackupFilename, parseFavoritesBackup,
  serializeFavoritesBackup,
} from '@/lib/favorites-export';
import {
  auditHalves, auditSummary, favoriteIds, type PrivateOnlyEntry,
} from '@/lib/favorites-audit';
import {
  fetchFavoritesList, hydrateFavorites, publishFavoritesTags, resolvePublishRelays,
  syncFavoritesNow,
} from '@/lib/nostr';
import {
  EMPTY_PARSED, baselineOfList, parseFavoritesList, type ParsedList,
} from '@/lib/nostr/favorites-list';
import { getErrorMessage } from '@/lib/util';
import {
  loadEpisodeFromFeed, resolveEpisodeByGuid, resolvePodcastByGuid,
  warmEpisodeCache, warmPodcastCache,
} from '@/lib/podcast-meta';
import { FavoritesSyncNotice } from '@/components/favorites-sync-notice';
import { MutesSyncNotice } from '@/components/mutes-sync-notice';
import { FavoritesPrivacyControl } from '@/components/favorites-privacy';
import { SelectMenu, type SelectOption } from '@/components/select-menu';
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

  // DERIVED, not stored, and it must land on a state the segmented row can
  // SHOW. `bmb:fav_view` is a device setting, not a cache, so it holds whatever
  // an older build of this page wrote and holds it across sessions — and a
  // `split` the row has no segment for renders the whole strip with nothing
  // active over a list that is still filtered. Nothing writes `split` back on
  // its own, so that state never heals; the user sees a short library and no
  // control claiming responsibility for it.
  //
  // Two ways in, and the derivation closes both. `{tab: 'music', split: 'all'}`
  // is what every medium press wrote before the two rows became one, so it is
  // sitting in storage on real devices today. And a half can vanish under the
  // user — unfavorite the last music track and `music|items` stops being a
  // segment while `view.split` still says 'items'.
  //
  // The rule is the same one `splitChips` builds by: a half is only meaningful
  // where the medium has BOTH, because with one half the medium segment and the
  // half segment would select the identical rows. Anything else falls to 'all',
  // which every medium always has.
  const activeTab = tabs.find((t) => t.key === tab);
  const tabHasBothHalves = !!activeTab && activeTab.feedCount > 0 && activeTab.itemCount > 0;
  const split =
    tab === 'all' || !tabHasBothHalves || view.split === 'all' ? 'all' : view.split;

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
   * The library filter's options.
   *
   * A single word for a half across the whole library would have to be a
   * compound — "albums & shows" — which is two concepts in one box on a library
   * that is nearly all one medium. So a half is always named INSIDE a medium
   * and every option sets both axes at once. That is why there is no separate
   * medium control: one press, one unambiguous state.
   *
   * Built from `tabs`, so only media the user actually has appear — there is no
   * hand-written list of media here for the same reason the medium strip had
   * none, and `~unknown` keeps its own entry.
   *
   * CLUSTERED BY MEDIUM, each cluster opening with the medium itself and its
   * halves indented under it. The medium entry is not decoration: it is the
   * "all of this medium, both halves" state, which the two-row version had as a
   * first-class control and which `bmb:fav_view` still holds on devices that
   * used it (see the `split` derivation). Without it that stored state has
   * nothing to select, and the control names a filter that is not in its own
   * list.
   *
   * A HALF ONLY WHERE THE MEDIUM HAS BOTH. `~unknown` routinely holds items and
   * no feeds; there, the medium entry and an `items` entry would select the
   * identical rows, so the pair would be two controls doing one thing — and the
   * derivation folds that half back to 'all' to match.
   *
   * IT IS A MENU, NOT A ROW, and it got there the same way the search box's
   * selector did — see `<SelectMenu>`. As a row this was up to sixteen
   * segments once every medium carried three, and at 390px it ran off the edge
   * mid-word: `ALL 287 · MUSIC 261 · ALBUMS · SINGLES · PO…`. It scrolled, but
   * a strip whose last option is sliced in half reads as broken rather than
   * scrollable, and the options past the cut are the ones nobody goes looking
   * for. The `id` is `<tab>|<split>` so the two axes travel as one value.
   */
  const filterOptions = useMemo<SelectOption<string>[]>(
    () => [
      { id: 'all|all', label: 'all', count: total },
      ...tabs.flatMap((t) => {
        const bothHalves = t.feedCount > 0 && t.itemCount > 0;
        return [
          { id: `${t.key}|all`, label: t.label, count: t.count },
          ...(bothHalves
            ? (['feeds', 'items'] as const).map((k) => ({
                id: `${t.key}|${k}`,
                label: crossSplitLabel(t.key, t.label, k),
                // The trigger says which medium's half. "albums" alone does
                // not, and the trigger is the only thing on screen naming the
                // filter once the menu is shut.
                triggerLabel: `${t.label} · ${crossSplitLabel(t.key, t.label, k)}`,
                indent: true,
              }))
            : []),
        ];
      }),
    ],
    [tabs, total],
  );

  const showFeeds = split !== 'items';
  const showItems = split !== 'feeds';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h1 className="headline text-4xl sm:text-5xl">favorites<span className="text-bolt">.</span></h1>
        <div className="flex items-center gap-3">
          {/* Pre-mount this says nothing rather than "0 saved" — the store has
              not been read yet, and an empty claim here is a lie for anyone
              returning. */}
          {mounted && total > 0 && (
            <span className="text-[11px] uppercase tracking-widest text-muted">{total} saved</span>
          )}
          {/* THE SECOND WAY INTO /playlists, and the app is down to two.
              <PlaylistsLink> in the header is gone with the rest of the
              header's navigation, and playlists are not a tab in <TabBar> —
              they are content, not a destination. That left exactly one route
              in: the hero's BROWSE PLAYLISTS button on /, which is gated on an
              empty home page and hides the moment the visitor searches or
              opens a show. From here, from a search, or from a drilled-in show
              there was no way to the collection at all.
              The two that remain are different controls, which is why this is
              a link and not a copy of the hero button: that one is DISCOVERY
              and hides as soon as you use the page, this one is NAVIGATION and
              is here whatever state the library is in. It sits above the
              loading / empty / rows split so it is reachable in all three.
              A bare <Link>, no logic, nothing to drift. */}
          <Link href="/playlists" className="btn-ghost btn-compact text-xs">
            PLAYLISTS
          </Link>
        </div>
      </div>

      {/* Above the controls, not inside a section: a filter or a fold must not
          hide the reason the list is short. Self-hiding unless signed in AND
          degraded. */}
      <FavoritesSyncNotice />
      <MutesSyncNotice />

      {/* Above the loading/empty/rows split on purpose, so it is reachable in
          every one of them. A signed-in user with nothing saved yet is exactly
          who most wants to set this BEFORE their first favorite, and putting it
          inside the rows branch would hide it from them. Self-hiding signed
          out, where all three options describe the same behaviour. */}
      <FavoritesPrivacyControl />

      {/* Directly under the privacy control, which is the other question about
          the list ON THE RELAYS — and on its own full-width row rather than in
          the header cluster beside `N saved`, because a refusal here is a
          sentence, not a word, and beside the count it wrapped to four lines in
          a column two thirds of the page wide. It is deliberately NOT gated on
          `total`: this reads the relays, so a device holding nothing local can
          still hold the account's list, and the empty branch below is exactly
          where somebody checking what is stored would look.
          NOT folded away, either — <PrivateFavoritesTool> inside it exists to
          make a both-halves state VISIBLE, and a disclosure defaulting closed
          would undo that (see its comment: deleted as clutter once, restored
          the same night). */}
      <RelayTools />

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
            {/* The library filter — one menu naming the current one of up to
                sixteen (medium, half) states. See `filterOptions` above for
                what is in it and `<SelectMenu>` for why it is a menu rather
                than the strip of segments it replaced. It sits ABOVE the
                filter box, matching where the search box's selector sits
                relative to its input: the mode is a question about the whole
                list, the text box narrows what the mode returned. */}
            <SelectMenu
              options={filterOptions}
              active={`${tab}|${split}`}
              onChange={(id) => {
                const [nextTab, nextSplit] = id.split('|');
                update({ tab: nextTab, split: nextSplit as FavView['split'] });
              }}
              label="Show"
              className="w-fit"
            />
            <div className="flex items-center gap-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="filter by title, show or artist…"
                aria-label="Filter favorites"
                className="input h-11 flex-1"
              />
              {/* One toggle, not two chips: the sort has exactly two states
                  and the label names the one you are in. */}
              <button
                type="button"
                onClick={() => update({ sort: view.sort === 'recent' ? 'az' : 'recent' })}
                className="btn-ghost h-11 shrink-0 text-xs"
                aria-label={view.sort === 'recent' ? 'Sorted by most recent; switch to A–Z' : 'Sorted A–Z; switch to most recent'}
              >
                {view.sort === 'recent' ? 'Recent' : 'A–Z'}
              </button>
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

/**
 * The three controls that ask the RELAYS something, on one row.
 *
 * They are siblings rather than one widget because they answer different
 * questions and cost different things: `⇩ BACKUP` writes a file from a plain
 * read, `⌕ CHECK PRIVATE FAVORITES` spends a signer prompt to open the
 * encrypted half and, where there is something to repair, repairs it, and
 * `⇧ RESTORE FROM BACKUP` puts a file back. Sharing a row is what says they
 * are about the same subject — the list as stored, not the list as painted.
 *
 * **The private-half controls were deleted on 2026-09-03 as clutter and
 * restored the same night, and the reason is the strongest argument they
 * have.** Within hours the reference account reached the both-halves state
 * again — 451 public `i` tags beside 38,320 characters of ciphertext — on a
 * fresh device whose baseline claimed nothing, which is the copy-instead-of-
 * move route this file's own comments describe. With them gone there was no
 * way to see that had happened and no way to undo it: the ordinary Public sync
 * only empties `content` for entries the baseline CLAIMS, and nothing else
 * writes that claim. A restore cannot substitute, because
 * `parseFavoritesBackup` verifies the signature and so refuses a hand-made
 * file. **Do not delete them again without a replacement for both halves of
 * that job — seeing the state, and clearing it.**
 *
 * <PrivateFavoritesTool> is that replacement and it keeps both halves. What
 * changed is WHEN it is on screen: it hides itself for an account the app has
 * positively observed to have no encrypted half, which is the answer to the
 * clutter complaint that does not cost anybody the repair.
 */
function RelayTools() {
  const identity = useApp((s) => s.identity);
  // Signed out there is no event, no key that signed one, and no signer.
  if (!identity) return null;
  return (
    <div className="flex flex-wrap items-start gap-2">
      <DownloadFavorites />
      <PrivateFavoritesTool />
      <RestoreBackup />
    </div>
  );
}

/** One state for four causes — see `FavoritesRead.privateUnreadable`. */
const SIGNER_REFUSED =
  'Your signer did not open the encrypted half. If it opened a moment ago it most likely '
  + 'timed out — bring your signer to the front, unlock it, and press this again. If it never '
  + 'opens, the half was written in a cipher this signer cannot read: the app carries it '
  + 'untouched and never shows it, and switching to Private stays refused, because writing a '
  + 'new encrypted half would destroy this one.';

/** What `check()` found, painted before the titles arrive. */
interface Finding {
  audit: ReturnType<typeof auditHalves>;
  /** The decrypted half, kept so the repair needs no second read. */
  privateList: ParsedList;
  lines: string[];
}

/**
 * See the encrypted half, and clear it — ONE control, ONE read, ONE prompt.
 *
 * **Why it is a control rather than something the page just knows.** A list
 * can hold entries in the plaintext tags and in the encrypted `content` at
 * once, and from every other screen in this app that state is invisible: the
 * public half renders, the private half is carried byte for byte, and nothing
 * counts either. See `lib/favorites-audit.ts`.
 *
 * **The decrypt is `'user-initiated'`, and that word is the whole reason this
 * is a button.** Everything stored encrypted-to-self is otherwise read on page
 * load, before the user touches anything, which is why `decryptPrivate`
 * defaults to false and why `purpose` is a required argument. An external
 * signer renders the plaintext on its approval sheet, so a decrypt nobody
 * asked for puts a list of somebody's private favorites on screen uninvited.
 * The purpose is passed straight through from this click and never hardcoded
 * further down — hardcoding it one level up is how `fetchEncryptedMnemonic`
 * silently overrode every caller.
 *
 * **A refusal to decrypt is a real answer, not an error.** Not every signer
 * implements NIP-44, and the half may be another app's, written in a cipher
 * this one cannot open. That state is what makes a switch to Private
 * impossible (`planFavoritesPublish` refuses on `private-unreadable`), so it is
 * reported as the finding it is rather than as a failure.
 *
 * **It used to be two buttons and that is what made it unusable.** Looking
 * cost one signer prompt, acting cost a second one over the same bytes, and
 * the success message sent the user back for a third to confirm. Three
 * approval sheets, two panels of numbers that did not use the same words, and
 * no statement anywhere of what to do about it. The read is now done once and
 * the action is offered from the finding it produced. Building the plan from
 * that earlier read is no less safe: `syncFavoritesNow` re-reads before it
 * publishes, and an entry another app adds in between is simply not claimed by
 * the baseline, so it is carried rather than deleted — the correct direction
 * to fail in.
 *
 * **It is hidden unless it is needed.** `favoritesPrivateHalf` is read off
 * `content` being non-empty during ordinary hydration, at no cost — see the
 * store field. 'none' hides this; 'present' shows it; 'unknown' shows it only
 * while `favoritesSync` is 'degraded', because a read that never answered is
 * not evidence of an empty half and must not hide the one control that repairs
 * one. `engaged` then pins it open for the rest of the session, or a merge
 * that empties the half would unmount the message saying so.
 *
 * **The repair is refused in Private mode, where it would do the opposite of
 * its label.** `syncFavorites` in mode 'private' puts everything the store
 * holds INTO the encrypted half, so "move them into my public list" would have
 * emptied the public tags instead. The mode switch is the right instrument
 * there, and this says so rather than offering the button.
 *
 * **The merge itself is three steps and the order is the whole safety
 * argument.**
 *
 *  1. ADOPT the private-only entries into the local store first. They are
 *     about to stop existing in the half that holds them, and the public merge
 *     publishes what the STORE holds — so an entry not adopted before the sync
 *     is deleted rather than moved. Their `medium` hint comes along, because
 *     for an entry Podcast Index cannot resolve it is the only description
 *     that will ever exist.
 *  2. CLAIM the private half in the baseline, from the read we just verified.
 *     This is the promise the merge is waiting for: the removal is gated on
 *     `baselineHalf(baseline, 'private')`, and a device that never published
 *     the private half claims nothing in it, so without this the ciphertext
 *     rides forward on every publish forever. Found on a real account at 284
 *     entries in both halves at once. The guard is right to be there — a
 *     baseline is a promise that these entries are ours to delete — and what
 *     was missing was the evidence, which the decrypt above produces.
 *  3. SYNC normally. Nothing bespoke publishes here: the ordinary cycle sees a
 *     store holding everything and a private baseline claiming the half, and
 *     converges to one public list by itself.
 *
 * **What it deliberately cannot reach.** `baselineOfList` claims GROUPS only,
 * so a loose node in the private half — an identifier kind outside our table,
 * or an item that appeared before any feed group — is never claimed and
 * therefore never dropped. If another writer's entry is in there in a shape
 * this app does not model, it survives this repair. That is the correct
 * direction to fail in.
 *
 * **A refusal is a `null`, not a throw.** `syncFavoritesNow` returns null
 * without recording anything on a degraded read, a wholesale-delete guard, an
 * unreadable private half, or a publish that reached no relay. `await` looks
 * like success and a `try/catch` catches nothing, so the return value is
 * tested — telling someone their list was merged when it was not is the one
 * error they cannot check without another round trip. The success sentence is
 * DERIVED from `note.event.content` for the same reason: "the encrypted half
 * is empty" is a claim about bytes we just published, and the published event
 * is right there to be read rather than assumed.
 */
function PrivateFavoritesTool() {
  const identity = useApp((s) => s.identity);
  const addFavorite = useApp((s) => s.addFavorite);
  const addFavoriteEpisode = useApp((s) => s.addFavoriteEpisode);
  const setFavoritesPrivateHalf = useApp((s) => s.setFavoritesPrivateHalf);
  const privateHalf = useApp((s) => s.favoritesPrivateHalf);
  const sync = useApp((s) => s.favoritesSync);
  const [engaged, setEngaged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [finding, setFinding] = useState<Finding | null>(null);
  const [named, setNamed] = useState<NamedEntry[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const needed = privateHalf === 'present' || sync === 'degraded';
  if (!identity || (!needed && !engaged)) return null;

  const mode = storage.favPrivacy.get(identity.npub) ?? undefined;

  async function check() {
    if (!identity) return;
    setEngaged(true);
    setBusy(true);
    setFinding(null);
    setNamed(null);
    setProblem(null);
    setConfirming(false);
    setDone(null);
    try {
      const read = await fetchFavoritesList(identity.pubkey, resolvePublishRelays(identity), {
        decryptPrivate: true,
        purpose: 'user-initiated',
      });
      // Same rule the backup runs on: a read that could not be trusted says
      // nothing about what is stored, and a confident "no private half" over a
      // failed query is the worst answer available here — it is the one that
      // would send someone into a mode switch.
      if (!read.trustworthy) {
        setProblem('The relays could not be read just now — try again in a moment.');
        return;
      }
      if (!read.exists) {
        setProblem('No favorites list is stored on the relays for this account.');
        return;
      }
      if (read.privateUnreadable) {
        // TWO answers in one sentence, because `privateUnreadable` is one state
        // for four causes and only one of them is permanent. A signer that goes
        // away does not reject — it HANGS, and `withDecryptTimeout` lands the
        // hang in this same branch — so the common case is a retry, and copy
        // that reads as a verdict sends the user to look for a problem with
        // their list instead of opening their signer.
        setProblem(SIGNER_REFUSED);
        return;
      }
      const privateList = read.privateList ?? EMPTY_PARSED;
      const audit = auditHalves(read.list, privateList);
      // The counts paint first and the titles fill in after: `nameEntries`
      // fans out to Podcast Index, and a panel that waits for it reads as a
      // button that did nothing for several seconds.
      setFinding({ audit, privateList, lines: auditSummary(audit, mode) });
      // A free observation from a trustworthy read: keep the row's visibility
      // honest without waiting for the next page load.
      setFavoritesPrivateHalf(read.content !== '' ? 'present' : 'none');
      setNamed(await nameEntries(audit.privateOnlyEntries));
    } catch (e) {
      setProblem(getErrorMessage(e, 'The read failed.'));
    } finally {
      setBusy(false);
    }
  }

  async function merge(f: Finding) {
    if (!identity) return;
    setBusy(true);
    setProblem(null);
    try {
      // 1. Adopt, BEFORE the baseline claim — see the note above.
      const now = Date.now();
      for (const e of f.audit.privateOnlyEntries) {
        if (e.kind === 'feed') {
          addFavorite({ id: 0, podcastGuid: e.guid, medium: e.medium, addedAt: now });
        } else if (e.parentFeedGuid) {
          addFavoriteEpisode({
            itemGuid: e.guid, feedGuid: e.parentFeedGuid, medium: e.medium, addedAt: now,
          });
        }
      }
      // 2. Claim the half we just read. The public claims are left exactly as
      //    they were: this promise is about the private half only, and
      //    rewriting the public one would disown entries this device published.
      const priv = baselineOfList(f.privateList);
      const existing = storage.favBaseline.get(identity.npub);
      storage.favBaseline.set(identity.npub, {
        ...existing, privateFeeds: priv.feeds, privateItems: priv.items,
      });
      // 3. One ordinary cycle.
      const note = await syncFavoritesNow(identity, 'user-initiated');
      if (!note) {
        setProblem(
          'The merge was not published — the app refused the cycle rather than write over '
          + 'something it could not verify. Nothing on the relays changed. Try again in a moment.',
        );
        return;
      }
      // What we actually published, never what we meant to publish.
      const emptied = note.event.content === '';
      setFavoritesPrivateHalf(emptied ? 'none' : 'present');
      setFinding(null);
      setNamed(null);
      setConfirming(false);
      setDone(emptied
        ? 'Done. Your favorites are in the public tags only, and the encrypted half is now '
          + 'empty. Take a fresh ⇩ BACKUP.'
        : 'Published, but the encrypted half is not empty — part of it belongs to another app '
          + 'and this device cannot claim it. Your own entries are in the public list now. '
          + 'Take a fresh ⇩ BACKUP.');
    } catch (e) {
      setProblem(getErrorMessage(e, 'The merge failed.'));
    } finally {
      setBusy(false);
    }
  }

  // Nothing in the encrypted half means nothing to repair, so the panel states
  // the finding and offers no action. `mode === 'private'` means the entries
  // are exactly where the user asked them to be.
  const repairable = !!finding && finding.audit.privateCount > 0 && mode !== 'private';

  return (
    <span className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={check}
        disabled={busy}
        className="btn-ghost text-xs disabled:opacity-50"
        title="Open the encrypted half of your list and count what is in it. Nothing is published until you confirm."
      >
        {busy && !finding ? 'opening…' : '⌕ check private favorites'}
      </button>

      {problem && <span className="text-[11px] text-bone max-w-prose">{problem}</span>}
      {done && <span className="text-[11px] text-muted max-w-prose">{done}</span>}

      {finding && (
        <span className="card p-3 flex flex-col gap-2 items-start max-w-prose">
          {finding.lines.map((l) => (
            <span key={l} className="text-[11px] text-muted">{l}</span>
          ))}

          {named && named.length > 0 && (
            <ul className="text-[11px] text-muted flex flex-col gap-0.5">
              {named.map((e) => (
                <li key={e.id} className="flex flex-col">
                  <span className={e.title ? 'text-bone' : undefined}>
                    {e.title ?? 'Podcast Index does not know this track'}
                  </span>
                  {e.kind === 'item' && (
                    <span>
                      {e.parentTitle
                        ? `from ${e.parentTitle}`
                        : e.parentFeedGuid
                          ? `from feed ${e.parentFeedGuid}`
                          : 'no parent feed recorded — unopenable in any app'}
                    </span>
                  )}
                  {/* The identifier always, even when a title resolved: it is
                      what the entry IS, and it is the only thing that can be
                      matched against a raw event or handed to another app. */}
                  <span className="font-mono break-all opacity-70">{e.id}</span>
                </li>
              ))}
            </ul>
          )}

          {finding.audit.privateCount > 0 && mode === 'private' && (
            <span className="text-[11px] text-muted">
              Your favorites are set to Private, so this is where they belong. To bring them
              into the public list, press PUBLIC above — that moves them in one update.
            </span>
          )}

          {repairable && !confirming && (
            <button
              type="button"
              className="btn text-xs"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              move them into my public list
            </button>
          )}

          {repairable && confirming && (
            <span className="flex flex-col gap-2 items-start">
              <span className="text-[11px] text-bone">
                This will publish {finding.audit.publicCount + finding.audit.privateOnly}{' '}
                favorites as public tags and empty the encrypted half.
              </span>
              <span className="text-[11px] text-muted">
                {finding.audit.privateOnly > 0
                  ? `${finding.audit.privateOnly} of them ${finding.audit.privateOnly === 1 ? 'exists' : 'exist'} only in the encrypted half today and will be adopted first, so nothing is lost. `
                  : 'Every entry in the encrypted half is already public, so nothing new is published. '}
                The {finding.audit.inBoth} already in both halves
                {finding.audit.inBoth === 1 ? ' stays where it is' : ' stay where they are'}, in
                the clear.
              </span>
              {/* Named rather than implied: this is the irreversible half of the
                  operation, and "take a backup" is only useful advice before it. */}
              <span className="text-[11px] text-muted">
                Take a ⇩ BACKUP first if you have not. Emptying the encrypted half cannot be
                undone from inside this app.
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  className="btn text-xs"
                  disabled={busy}
                  onClick={() => merge(finding)}
                >
                  {busy ? 'moving…' : 'move'}
                </button>
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  cancel
                </button>
              </span>
            </span>
          )}

          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={busy}
            onClick={() => { setFinding(null); setNamed(null); setConfirming(false); }}
          >
            close
          </button>
        </span>
      )}
    </span>
  );
}

/**
 * Put a `⇩ BACKUP` file back on the relays. The most destructive control here.
 *
 * **It republishes the CONTENT of the backup, not the backup event.** A
 * replaceable event is superseded by `created_at`, so re-sending the original
 * signed bytes would be ignored by every relay already holding something newer
 * — which is exactly the case a restore is for. So this signs a NEW event
 * carrying the backup's `tags` and `content` verbatim. The signature in the
 * file is therefore not what lands; it is what proves the file is genuine
 * before we agree to publish it.
 *
 * **Every check in `parseFavoritesBackup` is a refusal to publish something
 * the user did not sign** — a verified signature, this account's pubkey, and
 * kind 10333. An edited file fails, which is correct: the value of a backup is
 * that it IS the event, and an edited one is a new list wearing an old
 * signature.
 *
 * **It refuses on a read it cannot trust, and that is not the usual reason.**
 * Elsewhere the danger of a bad read is writing over data we could not see.
 * Here the write happens regardless — the user asked for it — so the read is
 * what makes the CONFIRMATION honest. Without it the panel cannot say what is
 * being replaced, and "restore" with no statement of the cost is the one thing
 * this control must never be.
 *
 * **Afterwards the device is reset to a fresh-device state on purpose.** The
 * store and the baseline are cleared before `hydrateFavorites` runs, and the
 * ordering is the whole correctness argument: leave the OLD favorites in the
 * store and the next cycle reads them as local additions and republishes them,
 * silently undoing the restore; leave the OLD baseline and it claims ids the
 * restored list does not have, so the next cycle publishes their removal. An
 * empty store beside an empty baseline is the one combination that means
 * "adopt what the relay holds", which is precisely what we want and is the
 * path a new browser already takes. `favCleared` is cleared too, or the
 * wholesale-delete guard reads the empty store as a deliberate clear-all.
 */
function RestoreBackup() {
  const identity = useApp((s) => s.identity);
  const setFavorites = useApp((s) => s.setFavorites);
  const setFavoriteEpisodes = useApp((s) => s.setFavoriteEpisodes);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'no'; text: string } | null>(null);

  if (!identity) return null;

  async function chosen(file: File | undefined) {
    if (!identity || !file) return;
    setBusy(true);
    setPlan(null);
    setMsg(null);
    try {
      const parsed = parseFavoritesBackup(await file.text(), identity.pubkey);
      if (!parsed.ok) {
        setMsg({ tone: 'no', text: `Not restored — ${parsed.error}.` });
        return;
      }
      // The confirmation has to name what is being REPLACED, so the current
      // state is read before anything is offered. A degraded read means the
      // panel would have to guess, and a restore panel that guesses is worse
      // than no restore.
      const read = await fetchFavoritesList(identity.pubkey, resolvePublishRelays(identity));
      if (!read.trustworthy) {
        setMsg({
          tone: 'no',
          text: 'The relays could not be read, so this cannot say what the restore would replace. '
            + 'Nothing was changed — try again in a moment.',
        });
        return;
      }
      setPlan({
        event: parsed.event,
        backupCount: favoriteIds(parseFavoritesList(parsed.event.tags)).length,
        backupHasPrivate: parsed.event.content.length > 0,
        currentCount: read.exists ? favoriteIds(read.list).length : 0,
        currentExists: read.exists,
        currentAt: read.updatedAt,
      });
    } catch (e) {
      setMsg({ tone: 'no', text: getErrorMessage(e, 'That file could not be read.') });
    } finally {
      setBusy(false);
      // Always: without it, choosing the same file twice fires no change event.
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function apply(p: RestorePlan) {
    if (!identity) return;
    setBusy(true);
    setMsg(null);
    try {
      // `publishFavoritesTags` asserts the publish reached a relay, so a
      // resolved promise here is not the empty claim `publishSignedEvent`
      // would have made.
      await publishFavoritesTags(p.event.tags, p.event.content, resolvePublishRelays(identity));
      // Fresh-device state, in this order. See the note above.
      storage.favBaseline.set(identity.npub, { feeds: [], items: [] });
      storage.favCleared.set(identity.npub, false);
      setFavorites({});
      setFavoriteEpisodes({});
      await hydrateFavorites(identity, 'user-initiated');
      setPlan(null);
      setMsg({
        tone: 'ok',
        text: `Restored ${p.backupCount} favorites from the backup. `
          + 'The list on screen is what the relays now hold.',
      });
    } catch (e) {
      setMsg({
        tone: 'no',
        text: `${getErrorMessage(e, 'The restore failed.')} `
          + 'If it reached no relay, nothing changed; reload and check before trying again.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex flex-col items-start gap-1">
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => chosen(e.target.files?.[0])}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        className="btn-ghost text-xs disabled:opacity-50"
        title="Publish a backup file back to the relays, replacing the list stored there."
      >
        {busy && !plan ? 'reading file…' : '⇧ restore from backup'}
      </button>
      {plan && (
        <span className="card p-3 flex flex-col gap-2 items-start max-w-prose">
          <span className="text-[11px] text-bone">
            Replace the list on the relays with this backup?
          </span>
          <span className="text-[11px] text-muted">
            The backup holds {plan.backupCount} favorites, saved{' '}
            {new Date(plan.event.created_at * 1000).toLocaleString()}
            {plan.backupHasPrivate ? ', with an encrypted half' : ''}.{' '}
            {plan.currentExists
              ? `The relays currently hold ${plan.currentCount}, last written ${new Date(plan.currentAt * 1000).toLocaleString()}.`
              : 'The relays currently hold no list for this account.'}
          </span>
          {/* The number that decides it, stated as a loss rather than a diff:
              "replaces 287 with 284" is arithmetic a person has to do under
              pressure, and getting it wrong costs entries. */}
          {plan.currentExists && plan.currentCount > plan.backupCount && (
            <span className="text-[11px] text-bone">
              That is {plan.currentCount - plan.backupCount} fewer than you have now. Anything
              added since this backup was taken will be gone.
            </span>
          )}
          <span className="text-[11px] text-muted">
            This replaces the whole event, including for every other app that reads your
            favorites. It cannot be undone except by restoring another backup.
          </span>
          <span className="flex gap-2">
            <button type="button" className="btn text-xs" disabled={busy} onClick={() => apply(plan)}>
              {busy ? 'restoring…' : 'restore'}
            </button>
            <button type="button" className="btn-ghost text-xs" disabled={busy} onClick={() => setPlan(null)}>
              cancel
            </button>
          </span>
        </span>
      )}
      {msg && (
        <span className={`text-[11px] max-w-prose ${msg.tone === 'ok' ? 'text-muted' : 'text-bone'}`}>
          {msg.text}
        </span>
      )}
    </span>
  );
}

interface RestorePlan {
  event: NostrEvent;
  backupCount: number;
  backupHasPrivate: boolean;
  currentCount: number;
  currentExists: boolean;
  currentAt: number;
}

interface NamedEntry extends PrivateOnlyEntry {
  /** Null when Podcast Index has no answer, which is not a failure. */
  title: string | null;
  /**
   * The album or show this item sits under, resolved from `parentFeedGuid`.
   *
   * Worth its own lookup because it answers a different question and answers
   * it more often. "Which track is this" fails whenever Podcast Index has not
   * indexed the item — the normal case for a music track — while "which album
   * is it from" only needs the FEED, which PI is far more likely to hold. On
   * the account this was built for, 224 of 228 item favorites resolve to no
   * title at all, so without this a private-only entry is a bare guid and the
   * user has no way to recognise their own favorite.
   *
   * It cannot tell you a track was favorited from a PLAYLIST: a `musicL`
   * container is never recorded as an item's parent (`containerIsParent`),
   * because the playlist is not the track's publisher. The album is the truth
   * the wire keeps.
   */
  parentTitle: string | null;
}

/**
 * Put a title on each private-only entry, where Podcast Index has one.
 *
 * **Capped, and the cap is not cosmetic.** This fans out one resolve per
 * entry, and the number of entries is whatever another writer put in the
 * encrypted half — an unbounded list against our own per-IP limiter, which a
 * real favorites hydration already runs close to. `NAME_LIMIT` bounds it; the
 * summary above already states the true count, so nothing is hidden by
 * stopping.
 *
 * **Batch door first, then resolve**, per the rule `<Podroll>` learned: the
 * warm fills the same memory the per-entry resolvers read, so the second pass
 * usually issues no requests at all — while still keeping what a batch cannot
 * do, which is answer for a guid the warm could not ask about.
 *
 * **A failure returns the entries unnamed rather than nothing.** The
 * identifier is the answer; the title is a convenience, and an entry Podcast
 * Index has never indexed is exactly the kind most likely to be sitting
 * forgotten in a private half.
 */
const NAME_LIMIT = 25;

async function nameEntries(entries: PrivateOnlyEntry[]): Promise<NamedEntry[]> {
  const slice = entries.slice(0, NAME_LIMIT);
  const feeds = slice.filter((e) => e.kind === 'feed');
  const items = slice.filter((e) => e.kind === 'item' && e.parentFeedGuid);
  // The parents go through the SAME batch door as the feed favorites — one
  // request for both sets, deduped by the warm itself.
  const feedGuids = [
    ...feeds.map((e) => e.guid),
    ...items.map((e) => e.parentFeedGuid!),
  ];
  try {
    await Promise.all([
      feedGuids.length ? warmPodcastCache(feedGuids) : Promise.resolve(),
      items.length
        ? warmEpisodeCache(items.map((e) => ({ feedGuid: e.parentFeedGuid!, itemGuid: e.guid })))
        : Promise.resolve(),
    ]);
  } catch {
    // A warm is an accelerator; the per-entry pass below stands on its own.
  }
  return Promise.all(slice.map(async (e): Promise<NamedEntry> => {
    try {
      if (e.kind === 'feed') {
        const p = await resolvePodcastByGuid(e.guid);
        return { ...e, title: p?.title ?? null, parentTitle: null };
      }
      if (!e.parentFeedGuid) return { ...e, title: null, parentTitle: null };
      // Both lookups, and the parent is not a fallback for the item — it is a
      // second fact. An item PI has never indexed still has a parent it may
      // know perfectly well, which is what turns a bare guid into something
      // the user can recognise.
      const [ep, parent] = await Promise.all([
        resolveEpisodeByGuid(e.parentFeedGuid, e.guid),
        resolvePodcastByGuid(e.parentFeedGuid),
      ]);
      return { ...e, title: ep?.title ?? null, parentTitle: parent?.title ?? null };
    } catch {
      return { ...e, title: null, parentTitle: null };
    }
  }));
}

/**
 * Save the kind:10333 event to a file, exactly as the relays hold it.
 *
 * Module-private: one consumer, and the pure half — the refusal rule, the
 * serializer, the filename — is `lib/favorites-export.ts`. This half owns the
 * relay read, the Blob and the `<a download>`.
 *
 * **It re-reads the relays; it does not serialize the store.** The store is a
 * merged, resolved, device-local view — the very thing a backup must not be,
 * because it cannot be published back. `fetchFavoritesList` is the same reader
 * the sync cycle uses, filter and `dTag: ''` intake expectation included, so
 * this cannot drift into accepting an event the sync path would reject.
 *
 * **A read it cannot trust produces NO file.** The two failures are not
 * symmetric: no file sends the user back tomorrow, while a file holding an
 * older event than the relays now have looks identical to a good one and
 * replaces the newer list the moment it is restored. `backupRefusal` owns that
 * decision and the reason is rendered, never swallowed.
 *
 * **It never decrypts.** A private half rides into the file as the ciphertext
 * the relay served, which is both what a backup needs and what keeps a signer
 * prompt — and the user's plaintext favorites on disk — out of a control
 * nobody asked that of. `backupSummary` says so on screen, because a private
 * list looks empty in a raw event.
 */
function DownloadFavorites() {
  const identity = useApp((s) => s.identity);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'no'; text: string } | null>(null);

  // Signed out there is no event and no key to have signed one.
  if (!identity) return null;

  async function download() {
    if (!identity) return;
    setBusy(true);
    setMsg(null);
    try {
      const read = await fetchFavoritesList(identity.pubkey, resolvePublishRelays(identity));
      const refusal = backupRefusal({
        trustworthy: read.trustworthy,
        exists: read.exists,
        mode: storage.favPrivacy.get(identity.npub),
      });
      if (refusal || !read.event) {
        setMsg({ tone: 'no', text: refusal ?? 'no event came back from the relays' });
        return;
      }
      const blob = new Blob([serializeFavoritesBackup(read.event)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = favoritesBackupFilename(read.event, BRAND.domain);
      // In the document before the click: Firefox ignores a click on a
      // detached anchor, so the download silently never starts.
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Next macrotask, not immediately: revoking inside the same task can
      // cancel a download that has not yet been handed to the browser. It
      // touches no React state, so an unmount in between is harmless.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      // The COUNT, not the tag total: an `i` tag is a favorite or a
      // placement group, and `⇧ RESTORE FROM BACKUP` reads it the same way.
      const count = favoriteIds(parseFavoritesList(read.event.tags)).length;
      setMsg({ tone: 'ok', text: backupSummary(read.event, count) });
    } catch (e) {
      setMsg({ tone: 'no', text: getErrorMessage(e, 'the relay read failed') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={download}
        disabled={busy}
        className="btn-ghost text-xs disabled:opacity-50"
        title="Save the Nostr event holding your favorites, exactly as the relays store it."
      >
        {busy ? 'reading relays…' : '⇩ backup'}
      </button>
      {msg && (
        <span className={`text-[11px] ${msg.tone === 'ok' ? 'text-muted' : 'text-bone'}`}>
          {msg.tone === 'ok' ? msg.text : `no backup written — ${msg.text}`}
        </span>
      )}
    </span>
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
