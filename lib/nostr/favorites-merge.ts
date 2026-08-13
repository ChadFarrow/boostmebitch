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
// Wire format is specified by an external, app-neutral spec:
// github.com/ChadFarrow/PC20-Nostr/specs/pc20-favorites.md
// That doc, not this file, is what a third app implements against, and it is
// not ours to change unilaterally — a format change is a PR there first, then
// here. This file follows it.
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
 * One entry in the shared list: the raw `i` tag, exactly as it came off the
 * wire, plus its identifier lifted out as the merge key.
 *
 * **It carries the whole tag rather than a parsed struct, and that is the
 * point.** The natural implementation — parse each tag into
 * `{id, feedUrl, feedRef}`, merge those, write them back out — silently deletes
 * every position past the third, on every entry, on every publish, with no
 * error and nothing on screen to show for it. This app did exactly that, and
 * the spec names it by file and line: a `<podcast:medium>` another app wrote at
 * position 4 survived only until this one next republished the list.
 *
 * A struct with a `tail` field would fix that case and re-arm it for position
 * 6. Carrying the tag makes the truncation *unrepresentable* — there is no
 * rebuild step left to truncate. See `overlayTag`.
 *
 * Positions, per the spec:
 *   1  the NIP-73 identifier — the merge key, and the only thing `identifierKind`
 *      may ever read
 *   2  legacy RSS feed URL — preserve what you find, never originate
 *   3  parent feed guid, for items
 *   4  `<podcast:medium>` — advisory, strictly sticky
 *   5+ not defined; belongs to an app newer than this one
 */
export interface SharedFavoriteItem {
  /** Full NIP-73 identifier, e.g. `podcast:guid:<uuid>`. Mirrors `tag[1]`. */
  id: string;
  /** The whole `i` tag. `tag[0]` is always `'i'`, `tag[1]` always `id`. */
  tag: string[];
}

/** Trailing empty positions carry no information, so they never reach the wire.
 *  Applied once, at the end of every tag build, so that reading a tag and
 *  rewriting it unchanged is a fixed point rather than a slow drift. */
function trimTag(tag: string[]): string[] {
  const out = tag.slice();
  while (out.length > 2 && !out[out.length - 1]) out.pop();
  return out;
}

/**
 * Build a wire entry from what this device knows.
 *
 * Empty positions are held open with `''` rather than closed up, which
 * `trimTag` then removes only from the tail. So a feed entry that knows only
 * its medium is `['i', id, '', '', 'music']` — six bytes of padding that buy
 * the position its meaning. Shifting the medium down into position 3 would
 * have the next reader hand it to Podcast Index as a `podcastguid`.
 *
 * **There is deliberately no `feedUrl` parameter.** Position 2 is reserved: an
 * existing value is preserved forever, and a new one is never written. Every
 * app implementing this format has a Podcast Index key and `podcast:guid`
 * resolves without a hint, so the URL was redundant on every path that mattered
 * — while being the largest field on the tag and the one two apps were most
 * likely to disagree about (`http` vs `https`, a PI-canonical URL vs the
 * publisher's, a proxy vs the origin). The only way a position 2 exists is if
 * it came off the wire, so the only way to build an item carrying one is
 * `itemsFromTags`. Leaving the parameter here would make re-originating it a
 * one-word change; removing it makes it a compile error.
 */
export function itemFrom(parts: {
  id: string;
  feedRef?: string;
  medium?: string;
}): SharedFavoriteItem {
  return {
    id: parts.id,
    // Position 2 is held open, never filled — see above.
    tag: trimTag(['i', parts.id, '', parts.feedRef ?? '', parts.medium ?? '']),
  };
}

/** Position 2 — the legacy RSS feed URL. Read-only: never originated. */
export const feedUrlOf = (item: SharedFavoriteItem): string | undefined => item.tag[2] || undefined;
/** Position 3 — an item's parent feed guid. */
export const feedRefOf = (item: SharedFavoriteItem): string | undefined => item.tag[3] || undefined;
/** Position 4 — the entry's `<podcast:medium>`, if any writer has supplied one. */
export const mediumOf = (item: SharedFavoriteItem): string | undefined => item.tag[4] || undefined;

/**
 * Reconstruct an `i` tag by overlaying what this device knows onto the tag that
 * came back from the relay, index by index — never by rebuilding it from our
 * own fields.
 *
 * **A non-empty value you didn't write is not yours to change.** Fill positions
 * that are empty or absent; leave the rest alone, even when you resolved a
 * different value and are confident yours is better. The tempting rule —
 * "prefer my own resolved value" — is what makes two apps holding different
 * values rewrite the event against each other on every publish, forever.
 * Neither is wrong, neither converges, and nothing looks wrong from either
 * side: each publish is locally reasonable and the only symptom is that it
 * never stops. Stickiness terminates instead.
 *
 * Three invariants here, each a way to lose someone's data:
 *
 *   - **Positions 5+ come from `latest` only.** We never originate there, so we
 *     have nothing to say about them; copying from `mine` could only invent
 *     something. They belong to an app newer than this one.
 *   - **`latest[4]` is never normalized.** Not lowercased, not dropped for
 *     being unrecognized — the medium vocabulary is open, and a value we don't
 *     know is one a newer app does.
 *   - **Membership is decided elsewhere.** This runs as a subordinate pass over
 *     an entry the merge has already decided to keep; it can never add an
 *     entry, remove one, or change its identifier.
 */
export function overlayTag(latest: string[] | null, mine: string[] | null): string[] {
  if (!latest) return trimTag(mine ?? []);
  if (!mine) return trimTag(latest);
  const out = ['i', latest[1] ?? mine[1] ?? ''];
  for (let p = 2; p <= 4; p += 1) out.push(latest[p] || mine[p] || '');
  for (let p = 5; p < latest.length; p += 1) out.push(latest[p] ?? '');
  return trimTag(out);
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

/**
 * Every `i` tag on an event, in order, deduped by identifier.
 *
 * The tag is copied WHOLE and verbatim — no interpretation, no truncation to
 * the positions this app happens to understand. `.slice()` rather than the
 * array itself so nothing downstream can mutate the event we read.
 */
export function itemsFromTags(tags: string[][]): SharedFavoriteItem[] {
  const items: SharedFavoriteItem[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (tag[0] !== 'i' || !tag[1]) continue;
    if (seen.has(tag[1])) continue; // a duplicate id is one favorite
    seen.add(tag[1]);
    items.push({ id: tag[1], tag: tag.slice() });
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
    const ref = feedRefOf(item);
    out.push({
      itemGuid,
      feedGuid: ref ? parseShowGuid(ref) ?? undefined : undefined,
      feedUrl: feedUrlOf(item),
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
    // Membership was decided above, on raw identifier strings and nothing else.
    // THIS is the subordinate hint pass: it may fill an empty position from
    // what this device knows, and may never touch one another writer filled.
    const mine = localById.get(item.id);
    out.push({ id: item.id, tag: overlayTag(item.tag, mine?.tag ?? null) });
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
  // The address is a parameter because, during the trial, accounts that aren't
  // allowlisted keep publishing to this app's own legacy d-tag rather than the
  // shared one. Defaults to the shared address so every existing caller and
  // every pinned vector is unchanged. See `favorites-gate.ts`.
  dTag: string = SHARED_D_TAG,
): string[][] {
  const tags: string[][] = [
    ['d', dTag],
    ['title', LIST_TITLE],
    ...otherTags,
  ];
  const kinds = new Set<string>();
  for (const item of items) {
    // The tag goes out AS IT CAME IN. There is deliberately no rebuild here
    // from known fields — that is what deleted other writers' positions on
    // every publish. `itemFrom` and `overlayTag` are the only places a tag is
    // ever constructed, and both are lossless. Copied so a caller mutating the
    // returned tags can't reach back into the item.
    tags.push(item.tag.slice());
    // Derived from position 1 ONLY. Never from position 4: a `["k", "music"]`
    // names nothing any app subscribes to and pollutes the `#k` discovery
    // filter for everyone who does.
    const kind = identifierKind(item.id);
    if (kind) kinds.add(kind);
  }
  // One `k` per distinct identifier kind. The old code emitted one per
  // favorite; harmless, but N copies of the same two strings.
  for (const kind of kinds) tags.push(['k', kind]);
  return tags;
}
