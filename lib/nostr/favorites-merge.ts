// ---------------------------------------------------------------------------
// Cross-app favorites — the pure half: wire format and merge, no I/O.
//
// DELIBERATELY IMPORT-FREE. `scripts/check-favsync.mjs` loads this module
// directly under plain Node to pin the merge, and every import here — even a
// type-only one, since the relative specifiers in this repo carry no extension
// — would break that. A reimplemented copy in the check script would stay green
// while the shipping merge drifted, which is the exact failure being guarded.
//
// The I/O half (fetch / publish / debounce) is `favorites.ts`, which re-exports
// everything below so callers only ever import one module.
//
// Wire format is specified in docs/pc20-favorites.md. Keep the two in step —
// that doc, not this file, is what a third app implements against.
// ---------------------------------------------------------------------------

/**
 * The shared, app-neutral list address.
 *
 * **Kind 30078 (NIP-78 application data), NOT 30003 (NIP-51 bookmark sets)** —
 * and the difference is the whole reason this moved. Kind 30003 is *user-named
 * bookmark collections*: saved links and articles. Two things follow from
 * putting podcast favorites there, and both are bad:
 *
 *   - A generic Nostr client lists someone's podcast favorites among their
 *     bookmarks, which is the wrong category.
 *   - Any bookmark client that lets them EDIT a set will clobber this list. It
 *     has no baseline discipline and no reason to have one — 30003 is its to
 *     write, and its author is doing nothing wrong.
 *
 * 30078 is app-defined data at a `d`-addressed slot. No generic client renders
 * or rewrites it, which is exactly the property this needs.
 *
 * `content` stays empty and PUBLIC, unlike most 30078 events (settings-backup.ts
 * and wallet-backup.ts both NIP-44 encrypt to self). A second app has to be able
 * to read this one.
 */
export const SHARED_FAVORITES_KIND = 30078;
export const SHARED_D_TAG = 'podcast:favorites';

/**
 * This app's pre-sync private list. Read once for migration, never written.
 *
 * Still at kind 30003 because that is where the data already is — this app
 * published podcast favorites into bookmark-set space before the shared format
 * existed. The migration reads it; nothing writes it again.
 */
export const LEGACY_FAVORITES_KIND = 30003;
export const LEGACY_D_TAG = 'boostmebitch:favorites';

export const SHOW_PREFIX = 'podcast:guid:';
export const ITEM_PREFIX = 'podcast:item:guid:';

export const LIST_TITLE = 'Podcast Favorites';

// Tags we rebuild from the item set on every publish. Anything else on the
// event belongs to another writer and is preserved verbatim. `k` is only
// partly ours — see `otherTagsFrom`.
const MANAGED_TAGS = new Set(['d', 'title', 'i']);

/**
 * The NIP-73 identifier kinds Podcasting 2.0 defines. Longest first, so a kind
 * that is a prefix of another can't shadow it.
 *
 * This has to be a TABLE, not string-scanning. The obvious "everything before
 * the last colon" is wrong and fails silently: item guids are very often
 * permalink URLs, so `podcast:item:guid:https://example.com/ep/42` yields
 * `podcast:item:guid:https` — a `k` tag no relay filter will ever match, which
 * breaks discovery without breaking anything visible.
 */
const KNOWN_IDENTIFIER_KINDS = [
  'podcast:publisher:guid',
  'podcast:item:guid',
  'podcast:guid',
];

// Podcasting 2.0 <podcast:guid> is a UUID (v5 in spec, but tolerate any
// version). Older versions of this app — and other clients that reused the
// legacy d-tag — wrote feed IDs and live-episode strings into the i-tag. They
// 404 against PI, so we don't try to *render* them, but see `interpretShows`:
// they are still preserved on the wire, because "this app can't read it" and
// "this is junk" are different claims and only the user gets to make the second.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One entry in the shared list, kept as the raw NIP-73 identifier plus its
 * optional hints. The merge never interprets `id` — that happens at render
 * time — so a third app's identifier kind survives a round trip through here.
 */
export interface SharedFavoriteItem {
  /** Full NIP-73 identifier, e.g. `podcast:guid:<uuid>`. The merge key. */
  id: string;
  /** NIP-73 optional URL hint (tag position 2): the feed's RSS URL. */
  feedUrl?: string;
  /** Additive extension (tag position 3): `podcast:guid:<feedGuid>` of an
   *  item's parent feed. PI's /episodes/byguid wants `podcastguid`, so
   *  carrying it inline saves a feed-URL→guid round trip. */
  feedRef?: string;
}

// --- identifier helpers ----------------------------------------------------

export const showId = (feedGuid: string) => `${SHOW_PREFIX}${feedGuid}`;
export const itemId = (itemGuid: string) => `${ITEM_PREFIX}${itemGuid}`;

/** `podcast:guid:<uuid>` → uuid, or null when it isn't a readable show id. */
export function parseShowGuid(id: string): string | null {
  if (!id.startsWith(SHOW_PREFIX)) return null;
  const guid = id.slice(SHOW_PREFIX.length);
  return UUID_RE.test(guid) ? guid : null;
}

/** `podcast:item:guid:<guid>` → guid. Item guids are not UUID-constrained by
 *  the spec (any globally-unique string is legal), so this only strips. */
export function parseItemGuid(id: string): string | null {
  if (!id.startsWith(ITEM_PREFIX)) return null;
  const guid = id.slice(ITEM_PREFIX.length);
  return guid.length > 0 ? guid : null;
}

/** The `k` value for an identifier, or null when we don't recognize its kind. */
export function identifierKind(id: string): string | null {
  for (const kind of KNOWN_IDENTIFIER_KINDS) {
    if (id.startsWith(`${kind}:`)) return kind;
  }
  return null;
}

// --- reading ---------------------------------------------------------------

/** Every `i` tag on an event, in order, deduped by identifier. */
export function itemsFromTags(tags: string[][]): SharedFavoriteItem[] {
  const items: SharedFavoriteItem[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (tag[0] !== 'i' || !tag[1]) continue;
    if (seen.has(tag[1])) continue; // a duplicate id is one favorite
    seen.add(tag[1]);
    items.push({
      id: tag[1],
      feedUrl: tag[2] || undefined,
      feedRef: tag[3] || undefined,
    });
  }
  return items;
}

/**
 * Tags belonging to other writers, to be replayed verbatim on republish.
 *
 * A `k` tag naming a kind we generate is ours and gets rebuilt. One naming a
 * kind we've never heard of belongs to whichever app wrote it — dropping it
 * would strip that app's `#k` discovery filter off the event every time this
 * one publishes.
 */
export function otherTagsFrom(tags: string[][]): string[][] {
  return tags.filter((t) => {
    if (MANAGED_TAGS.has(t[0])) return false;
    if (t[0] === 'k') return !!t[1] && !KNOWN_IDENTIFIER_KINDS.includes(t[1]);
    return true;
  });
}

/**
 * Show guids this app can render, split from the ones it can't. The malformed
 * half is reported so `bmbCleanFavorites()` can offer an explicit purge — it is
 * NOT dropped automatically, because the merge preserves every identifier.
 */
export function interpretShows(items: SharedFavoriteItem[]): {
  guids: string[];
  malformed: string[];
} {
  const guids: string[] = [];
  const malformed: string[] = [];
  for (const item of items) {
    if (!item.id.startsWith(SHOW_PREFIX)) continue;
    const guid = parseShowGuid(item.id);
    if (guid) guids.push(guid);
    else malformed.push(item.id.slice(SHOW_PREFIX.length));
  }
  return { guids, malformed };
}

/** Episode entries this app can render, with their parent feed hint. */
export function interpretItems(items: SharedFavoriteItem[]): Array<{
  itemGuid: string;
  feedGuid?: string;
  feedUrl?: string;
}> {
  const out: Array<{ itemGuid: string; feedGuid?: string; feedUrl?: string }> = [];
  for (const item of items) {
    const itemGuid = parseItemGuid(item.id);
    if (!itemGuid) continue;
    out.push({
      itemGuid,
      feedGuid: item.feedRef ? parseShowGuid(item.feedRef) ?? undefined : undefined,
      feedUrl: item.feedUrl,
    });
  }
  return out;
}

// --- merging ---------------------------------------------------------------

/**
 * Apply this device's delta on top of a freshly-read list.
 *
 * `lastSynced` is the id list this device last agreed with the relay on. It is
 * what makes "another app added this while I was offline" distinguishable from
 * "I removed this" — without it, publishing the local set alone deletes every
 * entry this app didn't know about, and publishing the union alone makes
 * unfavoriting impossible.
 *
 *   adds    = local  - lastSynced   (mine, new)
 *   removes = lastSynced - local    (mine, deleted → must propagate)
 *   next    = (latest ∪ adds) - removes
 *
 * Order is stable: surviving `latest` entries keep their position and new local
 * entries are appended, so a republish doesn't churn the event for cosmetic
 * reasons.
 */
export function mergeSharedFavorites(args: {
  latest: SharedFavoriteItem[];
  lastSynced: string[];
  local: SharedFavoriteItem[];
}): SharedFavoriteItem[] {
  const { latest, lastSynced, local } = args;
  const localById = new Map(local.map((i) => [i.id, i]));
  const baseline = new Set(lastSynced);
  const removed = new Set(lastSynced.filter((id) => !localById.has(id)));

  const out: SharedFavoriteItem[] = [];
  const kept = new Set<string>();
  for (const item of latest) {
    if (removed.has(item.id)) continue;
    if (kept.has(item.id)) continue;
    kept.add(item.id);
    // Hints improve over time and cost nothing to upgrade, but an existing
    // hint is never blanked by a local entry that happens to lack one.
    const mine = localById.get(item.id);
    out.push(
      mine
        ? {
            id: item.id,
            feedUrl: mine.feedUrl ?? item.feedUrl,
            feedRef: mine.feedRef ?? item.feedRef,
          }
        : item,
    );
  }
  for (const item of local) {
    if (kept.has(item.id)) continue;
    // In the baseline, but absent from `latest`: another app removed it while
    // this device still had it. Re-appending is the resurrection bug — the
    // user unfavorites in app A, opens app B, and B puts it straight back.
    // Only a genuine local ADD (not in the baseline) may be appended here.
    if (baseline.has(item.id)) continue;
    kept.add(item.id);
    out.push(item);
  }
  return out;
}

/**
 * The baseline to record after publishing — the ids THIS app contributed, not
 * the whole published list.
 *
 * That distinction is load-bearing and was wrong first time. `removes` is
 * computed as `baseline − local`, and `local` only ever contains entries this
 * app can represent. So a baseline holding the full list puts every foreign
 * identifier — a third app's `podcast:publisher:guid:`, an episode we couldn't
 * resolve — into `removes` on the very next publish, and the app deletes them.
 * That is the exact opposite of the "carry what you can't read" rule the whole
 * format rests on, and it would have fired on the second toggle.
 */
export function baselineFrom(
  published: SharedFavoriteItem[],
  local: SharedFavoriteItem[],
): string[] {
  const localIds = new Set(local.map((i) => i.id));
  return published.filter((i) => localIds.has(i.id)).map((i) => i.id);
}

// --- writing ---------------------------------------------------------------

/** Build the full tag set for a shared-favorites event. */
export function tagsForSharedFavorites(
  items: SharedFavoriteItem[],
  otherTags: string[][] = [],
): string[][] {
  const tags: string[][] = [
    ['d', SHARED_D_TAG],
    ['title', LIST_TITLE],
    ...otherTags,
  ];
  const kinds = new Set<string>();
  for (const item of items) {
    // Position 2 is NIP-73's optional URL hint; position 3 is our parent-feed
    // extension. An empty string holds position 2 open when only the feed ref
    // is known — consumers read position 2 as "absent" either way.
    if (item.feedRef) tags.push(['i', item.id, item.feedUrl ?? '', item.feedRef]);
    else if (item.feedUrl) tags.push(['i', item.id, item.feedUrl]);
    else tags.push(['i', item.id]);
    const kind = identifierKind(item.id);
    if (kind) kinds.add(kind);
  }
  // One `k` per distinct identifier kind. The old code emitted one per
  // favorite; harmless, but N copies of the same two strings.
  for (const kind of kinds) tags.push(['k', kind]);
  return tags;
}
