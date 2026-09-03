'use client';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Event as NostrEvent } from 'nostr-tools';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { clearShowSelection, useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { BRAND } from '@/lib/brand';
import {
  backupRefusal, backupSummary, favoritesBackupFilename, parseFavoritesBackup,
  serializeFavoritesBackup,
} from '@/lib/favorites-export';
import { favoriteIds } from '@/lib/favorites-audit';
import {
  fetchFavoritesList, hydrateFavorites, publishFavoritesTags, resolvePublishRelays,
} from '@/lib/nostr';
import { parseFavoritesList } from '@/lib/nostr/favorites-list';
import { getErrorMessage } from '@/lib/util';
import { loadEpisodeFromFeed, resolvePodcastByGuid } from '@/lib/podcast-meta';
import { Chip } from '@/components/chip';
import { FavoritesSyncNotice } from '@/components/favorites-sync-notice';
import { MutesSyncNotice } from '@/components/mutes-sync-notice';
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
          where somebody checking what is stored would look. */}
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

/**
 * The two controls that ask the RELAYS something, on one row.
 *
 * They are one pair and one subject: the kind:10333 event as STORED, rather
 * than the list as painted. `⇩ BACKUP` writes that event to a file and
 * `⇧ RESTORE FROM BACKUP` puts the file back, so neither is complete without
 * the other on screen beside it — a backup nobody can restore is a file, not
 * insurance.
 *
 * **This row held four controls until 2026-09-03.** `⌕ CHECK PRIVATE HALF` and
 * `⇄ MERGE ENCRYPTED HALF IN` were removed; what they were for, and the state
 * they were the only detector and the only repair for, is written down under
 * "Removed" in [`docs/ui.md`](../docs/ui.md) rather than deleted, because the
 * state itself did not go away with them.
 */
function RelayTools() {
  const identity = useApp((s) => s.identity);
  // Signed out there is no event, no key that signed one, and no signer.
  if (!identity) return null;
  return (
    <div className="flex flex-wrap items-start gap-2">
      <DownloadFavorites />
      <RestoreBackup />
    </div>
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
