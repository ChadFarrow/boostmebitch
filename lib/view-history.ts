/**
 * Browser history for the views `<HomePage>` draws on `/`.
 *
 * A show, an episode, its discussion and the publisher aside are not routes.
 * They are state — `selectedPodcast`, `selectedEpisode` and `discussionEpisode`
 * in the store, `publisherSource` in `<HomePage>` — mirrored into the query
 * string. The mirror used `history.replaceState` only, so every view on `/`
 * shared ONE history entry, and the browser's back button (and Android's, in the
 * TWA, which is the same history) left the site from a show three clicks deep.
 * Reported 2026-11-09: "the back button seems to take me away from the site even
 * if i've opened multiple pages within the site … it should take me to the
 * previous thing i was look at".
 *
 * So a view change pushes an entry, and a `popstate` on `/` puts the view back.
 * Three rules hold it together:
 *
 * 1. **The first write after `<HomePage>` mounts REPLACES; every later view
 *    change PUSHES.** The first write describes the entry the visitor landed on:
 *    a deep link being restored, or a show handed over from `/favorites` through
 *    `router.push('/')`, whose entry Next.js has already pushed. The caller
 *    decides by the mount, never by `history.state`, because Next.js drops a
 *    custom field from the current entry on a same-URL link navigation and on a
 *    refresh (`preserveCustomHistoryState = false` in its navigate and refresh
 *    reducers).
 * 2. **An entry carries only an id; the view itself lives in `records`.** A
 *    `Podcast` and an `Episode` are large, and `history.state` is
 *    structured-cloned and size-capped per browser. The map dies with the page,
 *    so an entry it does not know — one from before a reload, or one whose id
 *    Next.js dropped — is answered by `viewForEntry` from its URL: a bare `/` is
 *    the browse view, and anything else returns `null`, which `<HomePage>`
 *    answers with a reload so the ordinary URL restore runs.
 * 3. **An in-app back button steps BACK when the entry behind it already holds
 *    its target** (`backOr`). Otherwise "← back to results" would push a second
 *    copy of the results, and the browser's back button would then return to the
 *    show just left.
 *
 * Next.js 15 patches `history.pushState`/`replaceState`: it copies its own
 * `__NA` and tree into the data passed here and keeps custom fields through its
 * restore action, so these calls neither confuse the router nor trip its
 * "entry from another router → reload" branch on `popstate`.
 */
import { useApp } from '@/lib/store';
import type { Episode, Podcast } from '@/lib/types';
import { isPlaylistMedium } from '@/lib/util';

export interface HomeView {
  selectedPodcast: Podcast | null;
  selectedEpisode: Episode | null;
  discussionEpisode: Episode | null;
  /** Carried so a step back into a show opened from `/favorites` still offers
   *  "← back to favorites". Not in the URL. */
  showOrigin: { path: string; label: string } | null;
  /** The publisher aside. `<HomePage>` component state, not the store. */
  publisher: Podcast | null;
}

export const EMPTY_VIEW: HomeView = {
  selectedPodcast: null,
  selectedEpisode: null,
  discussionEpisode: null,
  showOrigin: null,
  publisher: null,
};

/** The patch every "← back to results" applies: no show, no episode, no thread. */
export const NO_SELECTION: Partial<HomeView> = {
  selectedPodcast: null,
  selectedEpisode: null,
  discussionEpisode: null,
  showOrigin: null,
};

interface EntryRecord {
  view: HomeView;
  /** `viewKey(view)`: what decides "same view" — the URL params, nothing else. */
  key: string;
  /** The id of the entry this one was pushed on top of — the entry immediately
   *  behind it. The entries behind an entry never change while it exists. */
  prev: string | null;
}

const STATE_FIELD = 'bmbView';
/** Plenty for a session; the oldest go first. A dropped record costs only a
 *  reload on a step back that far. */
const MAX_RECORDS = 200;
const records = new Map<string, EntryRecord>();

/** The URL params the views own. `t` is not one: it is a one-shot arrival
 *  param that `viewUrl` always deletes. */
const VIEW_PARAMS = ['playlist', 'podcast', 'feed', 'episode', 'discussion', 'publisher'] as const;

/**
 * `href` with the view's params written in — the one place the mapping lives.
 *
 * - `?podcast=<guid>` when the show has one, else `?feed=<id>`. A preview feed
 *   (not in PI) has a synthetic negative id and no guid, so it is not
 *   restorable and nothing is written for it — except a musicL PLAYLIST, which
 *   restores exactly from `?playlist=<feed url>` because `/api/playlist` keys
 *   off the feed URL.
 * - `?episode=<guid>` from the episode view, or from the discussion when it was
 *   restored without one; `?discussion=1` on top. Neither for a preview feed.
 * - `?publisher=<feed url>` for the aside.
 * - `t` is DELETED unconditionally: the view carries no playback position, so
 *   left alone a stale one would ride along onto the next episode, and a
 *   refresh would start that episode at the wrong second.
 */
export function viewUrl(href: string, view: HomeView): string {
  const url = new URL(href);
  const p = url.searchParams;
  const selected = view.selectedPodcast;
  const isPreview = !!selected?.isPreview;
  const playlistUrl = selected && !selected.podcastGuid && isPlaylistMedium(selected)
    ? selected.url : undefined;
  if (playlistUrl) p.set('playlist', playlistUrl);
  else p.delete('playlist');
  if (selected?.podcastGuid) {
    p.set('podcast', selected.podcastGuid);
    p.delete('feed');
  } else if (selected && !isPreview) {
    p.set('feed', String(selected.id));
    p.delete('podcast');
  } else {
    p.delete('podcast');
    p.delete('feed');
  }
  const episodeForUrl = view.selectedEpisode ?? view.discussionEpisode;
  if (episodeForUrl?.guid && !isPreview) p.set('episode', episodeForUrl.guid);
  else p.delete('episode');
  if (view.discussionEpisode && !isPreview) p.set('discussion', '1');
  else p.delete('discussion');
  if (view.publisher?.url) p.set('publisher', view.publisher.url);
  else p.delete('publisher');
  p.delete('t');
  return url.toString();
}

/** The view's params in a fixed order, independent of the page's other params. */
function viewKey(view: HomeView): string {
  return new URL(viewUrl('http://k/', view)).search;
}

/** Whether `href` names any view at all — a bare `/` is the browse view. */
function hasViewParams(href: string): boolean {
  const p = new URL(href).searchParams;
  return VIEW_PARAMS.some((k) => p.has(k));
}

function idOf(state: unknown): string | null {
  const id = (state as Record<string, unknown> | null)?.[STATE_FIELD];
  return typeof id === 'string' ? id : null;
}

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function remember(id: string, rec: EntryRecord) {
  records.delete(id);
  records.set(id, rec);
  while (records.size > MAX_RECORDS) {
    const oldest = records.keys().next().value;
    if (oldest === undefined) break;
    records.delete(oldest);
  }
}

/**
 * Whether Next.js has patched `history` yet. It does so in an effect of its
 * App Router — a PARENT of `<HomePage>` — and React runs a child's effects
 * before its parent's, so on the first mount this page's first write reaches
 * the browser's own `replaceState`.
 */
function nextHasPatched(): boolean {
  return window.history.replaceState !== History.prototype.replaceState;
}

function write(mode: 'push' | 'replace', id: string, url: string) {
  // Once patched: ONLY our field. The patch copies Next's `__NA` and tree in
  // itself, and dispatches a restore so the router (and `useSearchParams`)
  // follows the new URL — but it skips that dispatch for data that already
  // carries `__NA`, so passing Next's fields here would leave the router on
  // the old URL.
  //
  // Before the patch: carry them ourselves. The browser's `replaceState` keeps
  // only what it is given, and an entry without `__NA` makes Next.js RELOAD the
  // page on a step back to it — measured: back to `/` from a show reloaded the
  // home page and lost the search results, and every later step became a full
  // page load. The old `replaceState({})` mirror did the same to the entry a
  // visitor landed on.
  const data: Record<string, unknown> = { [STATE_FIELD]: id };
  if (!nextHasPatched()) {
    const cur = window.history.state as Record<string, unknown> | null;
    for (const k of ['__NA', '__PRIVATE_NEXTJS_INTERNALS_TREE']) {
      if (cur?.[k] !== undefined) data[k] = cur[k];
    }
  }
  if (mode === 'push') window.history.pushState(data, '', url);
  else window.history.replaceState(data, '', url);
}

/**
 * Bring the current history entry in line with `view`.
 *
 * - The URL already says this view: write nothing, but keep the record current
 *   (a selection enriched from RSS, a `showOrigin` set just after
 *   `selectPodcast`), and give an entry with no id one.
 * - `push`, and the view differs from this entry's: a new entry on top.
 * - Otherwise (landing, or a param outside the view such as `t`): replace.
 */
export function syncEntry(view: HomeView, mode: 'push' | 'replace') {
  const href = window.location.href;
  const url = viewUrl(href, view);
  const key = viewKey(view);
  const id = idOf(window.history.state);
  const known = id ? records.get(id) : undefined;
  if (url === href) {
    if (id) {
      remember(id, { view, key, prev: known?.prev ?? null });
    } else {
      const fresh = newId();
      write('replace', fresh, url);
      remember(fresh, { view, key, prev: null });
    }
    return;
  }
  if (mode === 'push' && known?.key !== key) {
    const fresh = newId();
    write('push', fresh, url);
    remember(fresh, { view, key, prev: id });
    return;
  }
  const keep = id ?? newId();
  write('replace', keep, url);
  remember(keep, { view, key, prev: known?.prev ?? null });
}

/**
 * The view a history entry holds, for a `popstate` or a mount on it.
 *
 * `null` means "only the URL knows": the entry predates this page's memory (a
 * reload), or Next.js dropped its id, and it names a show or a publisher. The
 * caller reloads, and the ordinary URL restore takes it from there.
 */
export function viewForEntry(state: unknown, href: string): HomeView | null {
  const id = idOf(state);
  const rec = id ? records.get(id) : undefined;
  if (rec) return rec.view;
  return hasViewParams(href) ? null : EMPTY_VIEW;
}

/** The record for the current entry, if this page made it. */
export function currentEntryView(): HomeView | null {
  const id = idOf(window.history.state);
  return (id && records.get(id)?.view) || null;
}

/** Put the store half of `view` on screen. The publisher half is `<HomePage>`'s. */
export function applyStoreView(view: HomeView) {
  useApp.setState({
    selectedPodcast: view.selectedPodcast,
    selectedEpisode: view.selectedEpisode,
    discussionEpisode: view.discussionEpisode,
    showOrigin: view.showOrigin,
  });
}

/**
 * An in-app back button: `history.back()` when the entry behind this one is
 * exactly the view `patch` leads to, else `apply()` — which then pushes, like
 * any other view change.
 *
 * `history.back()` keeps the history a straight line: browse → show → "← back to
 * results" → another show leaves browse, show-2 behind it, not browse, show-1,
 * browse, show-2. It also keeps whatever the entry behind held that the patch
 * does not describe, such as the `showOrigin` of a show opened from favorites.
 */
export function backOr(patch: Partial<HomeView>, apply: () => void) {
  if (typeof window === 'undefined') { apply(); return; }
  const id = idOf(window.history.state);
  const cur = id ? records.get(id) : undefined;
  const prev = cur?.prev ? records.get(cur.prev) : undefined;
  if (cur && prev && prev.key === viewKey({ ...cur.view, ...patch })) {
    window.history.back();
    return;
  }
  apply();
}
