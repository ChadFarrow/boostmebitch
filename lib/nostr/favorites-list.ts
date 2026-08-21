// ---------------------------------------------------------------------------
// Cross-app podcast favorites — the wire format and the merge.
//
// DELIBERATELY IMPORT-FREE. `scripts/check-favsync.mjs` loads this module
// directly under plain Node (`node --experimental-strip-types`) to pin the real
// thing; every import here — even a type-only one, since the relative
// specifiers in this repo carry no extension — would break that. A
// reimplemented copy in the check script would stay green while the shipping
// format drifted, which is the exact failure being guarded. Same arrangement as
// `read-trust.ts`.
//
// The format is specified OUTSIDE this repo, so neither implementing app owns
// it: github.com/ChadFarrow/PC20-Nostr/blob/main/pc20-favorites.md. A format
// change is a PR there before it is a commit here.
//
// ONE plain (non-`d`-tagged) replaceable event at kind 10333, so there is
// exactly one per pubkey and republishing replaces it wholesale. The single
// most important property, and the one with no analogue in the two-address
// design this replaced:
//
//   TAG ORDER IS THE DATA.
//
// An `i` tag is bare — `['i', '<identifier>']`, two elements. An item's parent
// feed and its medium are carried by POSITION IN THE ARRAY and by nothing on
// the entry itself: `['medium', v]` is a running value applying to every entry
// after it, and an item belongs to the most recently opened feed group. So a
// client that parses entries into structs and rebuilds the array from them —
// sorting, deduping, or emitting groups in a different order — silently
// reattaches every item to the wrong feed, and nothing else in the format
// recovers the association.
//
// That is why the parsed model here is an ORDERED NODE LIST rather than the
// maps this app renders from, and why `tagsFromList` walks `nodes` in place
// instead of iterating a Map. The predecessor of this rule cost this repo every
// tag position past the third on every publish for the entire life of the
// feature; this is the same mistake one level up, with a bigger blast radius.
// ---------------------------------------------------------------------------

export const FAVORITES_KIND = 10333;

/** NIP-31 label. We always emit our own — see `parseFavoritesList`. */
export const LIST_ALT = 'PC 2.0 Favorites';

export const SHOW_KIND = 'podcast:guid';
export const ITEM_KIND = 'podcast:item:guid';
export const PUBLISHER_KIND = 'podcast:publisher:guid';

export const SHOW_PREFIX = `${SHOW_KIND}:`;
export const ITEM_PREFIX = `${ITEM_KIND}:`;

/**
 * Longest-first, and matched as a table rather than by scanning for the last
 * colon. Item guids are routinely permalink URLs, so "everything before the
 * last colon" on `podcast:item:guid:https://example.com/ep/42` yields
 * `podcast:item:guid:https` — a `k` value no relay filter will ever match,
 * which breaks `#k` discovery without breaking anything visible.
 */
const KNOWN_IDENTIFIER_KINDS = [PUBLISHER_KIND, ITEM_KIND, SHOW_KIND];

/** Tag types this module owns. Anything else belongs to another writer. */
const MANAGED_TAGS = new Set(['alt', 'medium', 'i', 'k']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Identifier vocabulary
// ---------------------------------------------------------------------------

export const showId = (feedGuid: string): string => `${SHOW_PREFIX}${feedGuid}`;
export const itemId = (itemGuid: string): string => `${ITEM_PREFIX}${itemGuid}`;

/**
 * The identifier's kind, or null when we have no definition for it.
 *
 * Note this is deliberately laxer than {@link parseShowGuid}: a malformed feed
 * guid like `podcast:guid:920666` (written by old versions of this app) still
 * IS a `podcast:guid` identifier and still earns that `k` tag. It just isn't a
 * feed we can open a group for — see `parseFavoritesList`, where it becomes a
 * loose entry and is carried untouched rather than dropped.
 */
export function identifierKind(id: string): string | null {
  for (const kind of KNOWN_IDENTIFIER_KINDS) {
    if (id.startsWith(`${kind}:`)) return kind;
  }
  return null;
}

/**
 * The feed guid inside a `podcast:guid:` identifier, UUID-gated.
 *
 * The gate is load-bearing for idempotence, not decoration. A group can only be
 * emitted as `podcast:guid:<x>`, so if we opened groups for values this
 * function rejects, the very next read would fail to recognise our own output
 * and demote it to a loose entry — the array would never reach a fixed point
 * and two writers would rewrite the event at each other forever. Whatever this
 * rejects must therefore ALSO be rejected by {@link bareFeedGuid}.
 */
export function parseShowGuid(id: string): string | null {
  if (!id.startsWith(SHOW_PREFIX)) return null;
  const guid = id.slice(SHOW_PREFIX.length);
  return UUID_RE.test(guid) ? guid : null;
}

/**
 * The item guid inside a `podcast:item:guid:` identifier. NOT UUID-gated — an
 * RSS `<guid>` is an arbitrary publisher-chosen string. The live list this was
 * written against carries `thenogs-donkey-01-porky-piggin-it` alongside 226
 * UUIDs, and permalink URLs are common elsewhere.
 */
export function parseItemGuid(id: string): string | null {
  if (!id.startsWith(ITEM_PREFIX)) return null;
  const guid = id.slice(ITEM_PREFIX.length);
  return guid.length > 0 ? guid : null;
}

/**
 * A parent-feed reference in either form — bare, or carrying the
 * `podcast:guid:` prefix that the predecessor format wrote at tag position 3 —
 * reduced to the bare guid. UUID-gated for the reason on {@link parseShowGuid}:
 * a parent we can't emit and read back is not a parent we may group under.
 */
export function bareFeedGuid(ref: string | undefined | null): string | undefined {
  if (!ref) return undefined;
  const bare = ref.startsWith(SHOW_PREFIX) ? ref.slice(SHOW_PREFIX.length) : ref;
  return UUID_RE.test(bare) ? bare : undefined;
}

/** Whether a guid is worth spending a Podcast Index lookup on. */
export const looksLikeFeedGuid = (guid: string): boolean => UUID_RE.test(guid);

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** One favorite as this device holds it, before grouping. */
export interface FavoriteEntry {
  /** Full NIP-73 identifier. */
  id: string;
  /** Parent feed for an item, either form. Ignored for a feed entry. */
  feedRef?: string;
  /**
   * `<podcast:medium>` as the feed DECLARED it. Never an app's own default —
   * publishing a guess makes it look authoritative, and a guess on this list is
   * sticky because no other app has any reason to correct it.
   */
  medium?: string;
}

/** A feed group and the items beneath it, in wire order. */
export interface FeedGroup {
  feedGuid: string;
  /** undefined means "not told". NEVER defaulted — see `tagsFromList`. */
  medium?: string;
  itemGuids: string[];
}

/**
 * An `i` tag we cannot place: an identifier kind outside our table, an item
 * that appeared before any feed group, or a `podcast:guid:` whose guid is
 * malformed.
 *
 * The whole tag is carried, not the identifier, because a writer newer than us
 * may be using NIP-73's third element (the spec's open questions reserve it for
 * a feed-URL fallback). Rebuilding it from the id would delete that on every
 * publish — the same truncation the predecessor format shipped for its entire
 * life, one position over.
 */
export interface LooseEntry {
  tag: string[];
  medium?: string;
}

export type ListNode =
  | { t: 'group'; group: FeedGroup }
  | { t: 'loose'; loose: LooseEntry };

export interface ParsedList {
  /** Groups and loose entries, IN READ ORDER. The order is the data. */
  nodes: ListNode[];
  /** Tag types belonging to another writer, replayed verbatim. */
  foreignTags: string[][];
  /** `k` values outside our table — a kind a newer writer emits. */
  foreignKinds: string[];
}

/** This device's favorites, grouped for the wire. */
export interface LocalList {
  groups: FeedGroup[];
  loose: LooseEntry[];
}

/**
 * The identifiers this device last agreed with the relay on, as full NIP-73
 * identifier strings.
 *
 * It answers the one question a SECOND writer must answer and a single writer
 * never faces: an entry on the relay and absent from local state is either
 * something another app added, or something this device just unfavorited.
 * Prefer the relay and unfavoriting silently stops working; prefer local state
 * and you delete the other app's entries. Only a baseline tells them apart.
 *
 * `feeds` records every group this device EMITTED, favorited or opened purely
 * to place an item — the question it answers is "did I write this group", which
 * is what licenses dropping it once its last item is gone. It is emphatically
 * not "did the user favorite this feed"; that lives in the store.
 */
export interface FavoritesBaseline {
  feeds: string[];
  items: string[];
}

export const EMPTY_BASELINE: FavoritesBaseline = { feeds: [], items: [] };

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Parse an event's tags into the ordered node list.
 *
 * `k` is ignored entirely and the kind is taken from the identifier at position
 * 1. That is not an optimization — it is what makes the two published layouts
 * the same event. An earlier revision of the spec paired a `k` with every `i`;
 * the current one emits one per distinct kind at the end. A reader that walks
 * `i`/`k` in pairs reads a current-form list as an EMPTY LIBRARY rather than as
 * an error, which is the worst available failure for a format whose writers
 * republish wholesale.
 *
 * `alt` is discarded and re-emitted canonically. It is a NIP-31 rendering hint
 * for clients that have no definition for this kind, not user data.
 */
export function parseFavoritesList(tags: string[][]): ParsedList {
  const nodes: ListNode[] = [];
  const foreignTags: string[][] = [];
  const foreignKinds: string[] = [];
  let medium: string | undefined;
  let current: FeedGroup | null = null;

  for (const tag of tags) {
    const type = tag[0];

    if (type === 'alt') continue;

    if (type === 'k') {
      const value = tag[1];
      if (value && !KNOWN_IDENTIFIER_KINDS.includes(value) && !foreignKinds.includes(value)) {
        foreignKinds.push(value);
      }
      continue;
    }

    if (type === 'medium') {
      // An empty value is "not told", not the empty-string medium.
      medium = tag[1] || undefined;
      continue;
    }

    if (type !== 'i' || !tag[1]) {
      if (!MANAGED_TAGS.has(type)) foreignTags.push(tag.slice());
      continue;
    }

    const id = tag[1];

    const feedGuid = parseShowGuid(id);
    if (feedGuid !== null) {
      current = { feedGuid, medium, itemGuids: [] };
      nodes.push({ t: 'group', group: current });
      continue;
    }

    const itemGuid = parseItemGuid(id);
    if (itemGuid !== null && current) {
      if (!current.itemGuids.includes(itemGuid)) current.itemGuids.push(itemGuid);
      continue;
    }

    // Either an item with no group open yet (an orphan, which the spec permits
    // and which our own emitter produces for a parentless favorite), or an
    // identifier kind we have no placement for.
    //
    // A loose entry deliberately does NOT close `current`. An unrecognized `i`
    // sitting between two items must not silently re-parent every item after
    // it — the entries around it belong to a writer that knew what it meant,
    // and our not understanding one of them is not licence to move the others.
    nodes.push({ t: 'loose', loose: { tag: tag.slice(), medium } });
  }

  return { nodes, foreignTags, foreignKinds };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const mediumOfNode = (n: ListNode): string | undefined =>
  (n.t === 'group' ? n.group.medium : n.loose.medium);

/**
 * Group this device's flat favorites for the wire.
 *
 * A feed group is opened for EVERY parent of a favorited item, whether or not
 * the feed itself is favorited — it is the only way to name an item's parent.
 * That is why a group with items under it cannot be read back as a feed
 * favorite; see `partitionList`.
 */
export function groupLocalFavorites(entries: FavoriteEntry[]): LocalList {
  const groups: FeedGroup[] = [];
  const byGuid = new Map<string, FeedGroup>();
  const loose: LooseEntry[] = [];

  const ensure = (feedGuid: string, medium?: string): FeedGroup => {
    const existing = byGuid.get(feedGuid);
    if (existing) {
      // Fill a gap, never overwrite. Two entries under one feed may disagree
      // only because one of them was never told.
      if (!existing.medium && medium) existing.medium = medium;
      return existing;
    }
    const group: FeedGroup = { feedGuid, medium, itemGuids: [] };
    byGuid.set(feedGuid, group);
    groups.push(group);
    return group;
  };

  for (const entry of entries) {
    const feedGuid = parseShowGuid(entry.id);
    if (feedGuid !== null) {
      ensure(feedGuid, entry.medium);
      continue;
    }

    const itemGuid = parseItemGuid(entry.id);
    if (itemGuid === null) {
      // An identifier kind we don't place. Carried, not dropped.
      loose.push({ tag: ['i', entry.id], medium: entry.medium });
      continue;
    }

    const parent = bareFeedGuid(entry.feedRef);
    if (!parent) {
      // A favorited item whose parent we don't know, or know only as a
      // malformed guid. It rides as an orphan rather than being dropped: the
      // spec permits items ahead of any group, and losing a track because we
      // can't name its album is a worse trade than an unplaceable entry.
      loose.push({ tag: ['i', entry.id], medium: entry.medium });
      continue;
    }

    const group = ensure(parent, entry.medium);
    if (!group.itemGuids.includes(itemGuid)) group.itemGuids.push(itemGuid);
  }

  return { groups, loose };
}

/**
 * Emit the tag array.
 *
 * Layout, and every line of it is a rule from the spec:
 *
 *   ['alt', …]                one, ours, first
 *   foreign tag types         verbatim, in read order
 *   unknown-medium nodes      BEFORE any ['medium', …] tag
 *   ['medium', v] + its nodes one block per distinct medium, contiguous
 *   ['k', kind]               trailing, one per distinct kind
 *
 * Unknown-medium nodes go first rather than last because appending them would
 * make them inherit whatever medium was declared last, and minting a
 * `['medium','unknown']` tag would write a value no reader has been told about.
 * Placing them ahead of the first `medium` tag is the one position that says
 * "not told" without inventing anything.
 *
 * Where preserving read order and keeping same-medium groups contiguous
 * conflict — because the writer before us interleaved them — CONTIGUITY WINS.
 * Reordering groups within a medium block reattaches nothing, since an item
 * always travels directly beneath its own feed entry, whereas a broken block
 * silently re-labels every entry after the boundary.
 */
export function tagsFromList(list: ParsedList): string[][] {
  const tags: string[][] = [['alt', LIST_ALT]];

  for (const tag of list.foreignTags) tags.push(tag.slice());

  const emit = (node: ListNode) => {
    if (node.t === 'loose') {
      // The tag WHOLE, never rebuilt from its identifier.
      tags.push(node.loose.tag.slice());
      return;
    }
    tags.push(['i', showId(node.group.feedGuid)]);
    for (const guid of node.group.itemGuids) tags.push(['i', itemId(guid)]);
  };

  for (const node of list.nodes) if (!mediumOfNode(node)) emit(node);

  const mediums: string[] = [];
  for (const node of list.nodes) {
    const m = mediumOfNode(node);
    if (m && !mediums.includes(m)) mediums.push(m);
  }
  for (const medium of mediums) {
    tags.push(['medium', medium]);
    for (const node of list.nodes) if (mediumOfNode(node) === medium) emit(node);
  }

  // Derived from what we actually emitted, in emission order — never from the
  // model, so a `k` can't name a kind that isn't on the list.
  const kinds: string[] = [];
  for (const tag of tags) {
    if (tag[0] !== 'i' || !tag[1]) continue;
    const kind = identifierKind(tag[1]);
    if (kind && !kinds.includes(kind)) kinds.push(kind);
  }
  for (const kind of kinds) tags.push(['k', kind]);
  for (const kind of list.foreignKinds) {
    if (!kinds.includes(kind)) tags.push(['k', kind]);
  }

  return tags;
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

export interface MergeInput {
  /** What the relay holds. Never call this on an untrustworthy read. */
  read: ParsedList;
  /** What this device holds. */
  local: LocalList;
  /** What this device last agreed with the relay on. */
  baseline: FavoritesBaseline;
}

/**
 * Combine the relay's list with this device's, using the baseline to tell a
 * foreign entry from one we removed.
 *
 * The output is closed over the input type: merging is an edit of the ordered
 * node list, never a rebuild from local state. A writer built from local state
 * alone is the natural way to write one and it deletes every entry the other
 * app added — that is the spec's own test vector 1.
 *
 * Five points where this deliberately diverges from the reference
 * implementation in StableKraft, each because that one has no baseline and so
 * cannot answer the question:
 *
 *  1. Item removals are reconciled under EVERY group, not only groups we still
 *     hold. Otherwise unfavoriting a track whose album we've since dropped
 *     never propagates.
 *  2. A group we published keeps its place while any item under it survives.
 *     Deleting the group would take the other app's items with it — the group
 *     is the only thing naming their parent.
 *  3. Items read off the wire keep their wire position; local-only items
 *     append. Imposing our own order on every republish means two apps reorder
 *     the event at each other forever, each publish locally reasonable, the
 *     only symptom being that it never stops.
 *  4. The append pass honours the baseline, so an entry another app REMOVED is
 *     not resurrected by this device on the next cycle.
 *  5. Loose entries exist at all, so an identifier kind or tag position we
 *     don't understand survives us.
 */
export function mergeFavoritesList({ read, local, baseline }: MergeInput): ParsedList {
  const localByGuid = new Map(local.groups.map((g) => [g.feedGuid, g]));
  const publishedFeeds = new Set(baseline.feeds);
  const publishedItems = new Set(baseline.items);
  const localItems = new Set(local.groups.flatMap((g) => g.itemGuids));

  /** Ours, and we no longer hold it ⇒ the user removed it here. */
  const weRemovedItem = (guid: string) =>
    publishedItems.has(itemId(guid)) && !localItems.has(guid);

  const localLooseIds = new Set(local.loose.map((l) => l.tag[1]).filter(Boolean));

  const nodes: ListNode[] = [];
  const taken = new Set<string>();

  for (const node of read.nodes) {
    if (node.t === 'loose') {
      const id = node.loose.tag[1];
      // Not ours to interpret is not ours to drop — UNLESS the baseline says we
      // put it there and we no longer hold it, which is a removal like any
      // other. The baseline only ever names identifiers this device emitted, so
      // this can never reach another writer's entry. Without it a favorite that
      // rides loose (an item whose parent guid we never learned) would be
      // carried forever and could never be unfavorited on any device.
      // Both halves are consulted, not just `items`: a loose entry may be a
      // malformed `podcast:guid:` that an older baseline recorded on the feeds
      // side. Which half it landed in is an accident of history; whether we
      // published it is the question.
      if (id && (publishedItems.has(id) || publishedFeeds.has(id)) && !localLooseIds.has(id)) continue;
      nodes.push({ t: 'loose', loose: { tag: node.loose.tag.slice(), medium: node.loose.medium } });
      continue;
    }

    const group = node.group;
    if (taken.has(group.feedGuid)) continue; // a duplicate group on the wire
    taken.add(group.feedGuid);

    const kept = group.itemGuids.filter((guid) => !weRemovedItem(guid));
    const mine = localByGuid.get(group.feedGuid);

    if (!mine) {
      // We opened this group once and no longer hold the feed. Drop it only
      // when there is nothing left to place; while any item survives, the group
      // must stay to name their parent. (The spec is explicit that unfavoriting
      // a feed whose track is still favorited is inexpressible — expressing it
      // anyway deletes another app's tracks.)
      if (publishedFeeds.has(showId(group.feedGuid)) && kept.length === 0) continue;
      nodes.push({ t: 'group', group: { ...group, itemGuids: kept } });
      continue;
    }

    nodes.push({
      t: 'group',
      group: {
        feedGuid: group.feedGuid,
        // Fill a gap, never overwrite a value another writer set.
        medium: group.medium ?? mine.medium,
        // Local items the read didn't carry are either NEW here, or ones we
        // published that another writer has since removed. Only the first may
        // go up: re-adding the second is the resurrection loop, the same one
        // `fresh` guards against below for a group absent from the read.
        //
        // **This is the branch that shipped without the filter**, and the
        // asymmetry is why it hid: whether an unfavorite stuck depended on
        // whether its album happened to still have a second track on the list,
        // which is invisible from the device doing the removing. The baseline
        // is the discriminator — absence from the read alone would suppress a
        // favorite the user just made.
        itemGuids: [
          ...kept,
          ...mine.itemGuids.filter(
            (g) => !kept.includes(g) && !publishedItems.has(itemId(g)),
          ),
        ],
      },
    });
  }

  for (const group of local.groups) {
    if (taken.has(group.feedGuid)) continue;

    // Absent from the read entirely. Anything we already published and the relay
    // no longer has was removed by another writer, and re-adding it is the
    // resurrection loop — so only genuinely NEW entries go up.
    const fresh = group.itemGuids.filter((guid) => !publishedItems.has(itemId(guid)));

    // The group itself is ours-and-removed only if we published it. Skipping on
    // that alone would be wrong: a track the user has just favorited under an
    // album another app removed still has to be published, and it needs its
    // parent group reopened to say which album it came from. Skip only when
    // there is nothing new to carry.
    if (publishedFeeds.has(showId(group.feedGuid)) && fresh.length === 0) continue;

    taken.add(group.feedGuid);
    nodes.push({ t: 'group', group: { ...group, itemGuids: fresh } });
  }

  for (const loose of local.loose) {
    const id = loose.tag[1];
    if (!id) continue;
    if (read.nodes.some((n) => n.t === 'loose' && n.loose.tag[1] === id)) continue;
    if (publishedItems.has(id) || publishedFeeds.has(id)) continue;
    nodes.push({ t: 'loose', loose: { tag: loose.tag.slice(), medium: loose.medium } });
  }

  return { nodes, foreignTags: read.foreignTags, foreignKinds: read.foreignKinds };
}

/**
 * What this device is asserting, recorded ONLY once a publish has landed.
 *
 * A baseline written for an event that never reached a relay permanently stops
 * that entry from being retried: `local − baseline` is empty for it from then
 * on, so it is never published again while the UI reports success. That is why
 * every caller gates this on `assertPublished`.
 */
export function baselineFrom(local: LocalList): FavoritesBaseline {
  return {
    feeds: local.groups.map((g) => showId(g.feedGuid)),
    items: [
      ...local.groups.flatMap((g) => g.itemGuids.map((i) => itemId(i))),
      // Loose entries this device asserted (a favorite whose parent we never
      // learned) are recorded too — an identifier we published and cannot later
      // retract is a favorite the user can never remove.
      ...local.loose.map((l) => l.tag[1]).filter((id): id is string => !!id),
    ],
  };
}

// ---------------------------------------------------------------------------
// Planning a publish
// ---------------------------------------------------------------------------

export type PublishReason = 'degraded' | 'unchanged' | 'nothing-to-create' | 'publish';

export interface FavoritesPlanInput {
  merged: ParsedList;
  /** The raw tags of the event we read, or [] when there is none. */
  readTags: string[][];
  exists: boolean;
  trustworthy: boolean;
  local: LocalList;
}

export interface FavoritesPlan {
  publish: boolean;
  reason: PublishReason;
  tags: string[][];
  /** Record only once the publish lands. Meaningful even when `publish` is false. */
  baseline: FavoritesBaseline;
}

/**
 * Decide whether to publish, and what.
 *
 * `changed` is a BYTE comparison against what the relay actually holds, not a
 * membership comparison — order and grouping are semantic here, so two lists
 * with identical membership can mean different things. Comparing against the
 * read rather than against a digest of our own last publish is also what lets
 * us notice that another app has since edited the event.
 *
 * Byte-equality with the read IS the spec's idempotence vector, executed on
 * every cycle in production rather than only in the check script.
 */
export function planFavoritesPublish(input: FavoritesPlanInput): FavoritesPlan {
  const tags = tagsFromList(input.merged);
  const baseline = baselineFrom(input.local);

  // Never write on top of a read that may have failed silently. Wholesale
  // replacement makes this the most expensive mistake the format allows: one
  // bad read, republished, is the entire list gone.
  if (!input.trustworthy) return { publish: false, reason: 'degraded', tags, baseline };

  if (JSON.stringify(tags) === JSON.stringify(input.readTags)) {
    return { publish: false, reason: 'unchanged', tags, baseline };
  }

  // Don't mint an empty event for a user who has no favorites — otherwise every
  // signed-in visitor gets a kind:10333 they never asked for.
  if (!input.exists && input.merged.nodes.length === 0) {
    return { publish: false, reason: 'nothing-to-create', tags, baseline };
  }

  return { publish: true, reason: 'publish', tags, baseline };
}

// ---------------------------------------------------------------------------
// Projecting back out, for rendering
// ---------------------------------------------------------------------------

export interface ListFeed {
  feedGuid: string;
  medium?: string;
  /**
   * No items under this group.
   *
   * TRUE is the only unambiguous statement the format makes about a feed
   * favorite. A group is opened for every parent of a favorited item, so a
   * group WITH items may exist solely to name that parent — reading it as a
   * favorite manufactures albums the user never chose. Measured on the live
   * list this was built against: 197 groups carrying 38 unambiguous favorites.
   */
  itemless: boolean;
}

export interface ListItem {
  itemGuid: string;
  /** undefined for an orphan — an item that named no parent. */
  feedGuid?: string;
  medium?: string;
}

export interface PartitionedList {
  feeds: ListFeed[];
  items: ListItem[];
  /** Loose entries we could not place, for diagnostics and the cleanup hook. */
  loose: LooseEntry[];
  /** `podcast:guid:` identifiers whose guid is not a UUID. */
  malformed: string[];
}

/** Flatten the node list into the rows the app renders. */
export function partitionList(list: ParsedList): PartitionedList {
  const feeds: ListFeed[] = [];
  const items: ListItem[] = [];
  const loose: LooseEntry[] = [];
  const malformed: string[] = [];

  for (const node of list.nodes) {
    if (node.t === 'group') {
      const { feedGuid, medium, itemGuids } = node.group;
      feeds.push({ feedGuid, medium, itemless: itemGuids.length === 0 });
      // PC 2.0 has no per-item medium; an item takes its group's.
      for (const itemGuid of itemGuids) items.push({ itemGuid, feedGuid, medium });
      continue;
    }

    loose.push(node.loose);
    const id = node.loose.tag[1];
    if (!id) continue;
    if (id.startsWith(SHOW_PREFIX)) {
      malformed.push(id);
      continue;
    }
    const itemGuid = parseItemGuid(id);
    if (itemGuid !== null) items.push({ itemGuid, medium: node.loose.medium });
  }

  return { feeds, items, loose, malformed };
}

/**
 * The inverse of {@link groupLocalFavorites}: the flat entries that regroup
 * into this list.
 *
 * Used to pin that the store rebuild is a fixed point — what we render is what
 * we would republish, so a rendering pass can never quietly change the wire.
 * Loose entries are excluded: they are carried from the read, never asserted by
 * this device.
 */
export function entriesFromList(list: ParsedList): FavoriteEntry[] {
  const entries: FavoriteEntry[] = [];
  for (const node of list.nodes) {
    if (node.t !== 'group') continue;
    const { feedGuid, medium, itemGuids } = node.group;
    if (itemGuids.length === 0) {
      entries.push({ id: showId(feedGuid), medium });
      continue;
    }
    for (const itemGuid of itemGuids) {
      entries.push({ id: itemId(itemGuid), feedRef: feedGuid, medium });
    }
  }
  return entries;
}
