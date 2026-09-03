// The PC20-Nostr favorites conformance suite, pointed at THIS app's merge.
//
//   npm run check:conformance
//
// `../PC20-Nostr/conformance/vectors.test.mjs` is the spec's 24 vectors as
// code, driven through the small contract in `conformance/adapter.d.ts`. This
// file is the shim: it maps that contract onto the real `favorites-list.ts`
// under plain Node, the same way `check-favsync.mjs` loads it — so a failure
// here is this app's merge disagreeing with the document it implements, never
// a copy drifting from the shipping code.
//
// WHAT IS WIRED, AND WHAT IS STOOD IN FOR. `plan()` replays the orchestration
// in `lib/nostr/favorites.ts#syncFavorites` — mode decision, both merges, the
// whole-list folds, `planFavoritesPublish` — over the pure functions, because
// that wiring is where this feature's bugs have lived and is what the vectors
// exercise. Two things cannot exist here and are modelled: the signer (a
// reversible, unauthenticated `seal`, standing in for NIP-44 encrypt-to-self
// exactly as the spec's reference does) and the read (the vector hands us the
// event, so `trustworthy` is always true — vector 2's `read: null` is the
// degraded case). The hydrator's seeding of a never-chosen mode is replayed
// too, since `mode: null` in the contract is that state.
//
// Keep this a THIN mapping. Logic added here is logic the suite runs that the
// app does not, which is the copy-drifts-from-the-real-thing failure the whole
// arrangement exists to prevent.

import {
  EMPTY_LOCAL,
  EMPTY_PARSED,
  FAVORITES_KIND,
  ITEM_KIND,
  PUBLISHER_KIND,
  SHOW_KIND,
  WHOLE_LIST_PRIVACY_MOVE,
  baselineHalf,
  claimedByBaseline,
  correctedModeFromWire,
  decodePrivateFavorites,
  effectiveListMode,
  encodePrivateFavorites,
  foldHalves,
  groupLocalFavorites,
  identifierKind,
  itemId,
  mergeFavoritesList,
  parseFavoritesList,
  partitionList,
  planFavoritesPublish,
  seedModeFromWire,
  showId,
} from '../lib/nostr/favorites-list.ts';

// --- the signer stand-in ----------------------------------------------------

const PRIV_PREFIX = 'PRIV1:';

/** NOT encryption. Stands in for NIP-44 encrypt-to-self, reversibly. */
export const seal = (text) => PRIV_PREFIX + Buffer.from(text, 'utf8').toString('base64');

const unseal = (content) =>
  content.startsWith(PRIV_PREFIX)
    ? Buffer.from(content.slice(PRIV_PREFIX.length), 'base64').toString('utf8')
    : null;

/** The real plaintext codec — `?` escaped, non-array refused. */
export const encodePlaintext = (tags) => encodePrivateFavorites(tags ?? []);
export const decodePlaintext = (text) => decodePrivateFavorites(text);

export const encodePrivate = (tags) =>
  !tags || tags.length === 0 ? '' : seal(encodePlaintext(tags));

export function decodePrivate(content) {
  if (!content) return [];
  const text = unseal(content);
  return text === null ? null : decodePlaintext(text);
}

// --- parsing ----------------------------------------------------------------

export const kindOf = (id) => (typeof id === 'string' ? identifierKind(id) : null);

const MANAGED = new Set(['alt', 'medium', 'i', 'k', 'visibility']);

/** The contract's flat entry list, derived from this app's ordered node list. */
export function parseTags(tags) {
  const input = tags ?? [];
  const list = parseFavoritesList(input);
  const entries = [];
  const groups = [];
  const foreign = [];

  // Tag positions, so a reader can check that order survived. First unused
  // match, because a duplicate group names the same identifier twice.
  const used = new Set();
  const indexOf = (id) => {
    for (let i = 0; i < input.length; i++) {
      if (!used.has(i) && input[i][0] === 'i' && input[i][1] === id) {
        used.add(i);
        return i;
      }
    }
    return -1;
  };

  for (const node of list.nodes) {
    if (node.t === 'group') {
      const id = showId(node.group.feedGuid);
      const medium = node.group.medium ?? null;
      const items = node.group.itemGuids.map(itemId);
      entries.push({ id, kind: SHOW_KIND, medium, parent: null, index: indexOf(id) });
      for (const item of items) {
        entries.push({ id: item, kind: ITEM_KIND, medium, parent: id, index: indexOf(item) });
      }
      groups.push({ id, medium, items });
      continue;
    }
    const tag = node.loose.tag;
    const kind = kindOf(tag[1]);
    const index = indexOf(tag[1]);
    if (kind === null) foreign.push({ index, tag });
    else entries.push({ id: tag[1], kind, medium: node.loose.medium ?? null, parent: null, index });
  }
  entries.sort((a, b) => a.index - b.index);

  input.forEach((tag, index) => {
    if (!MANAGED.has(tag[0])) foreign.push({ index, tag });
  });
  foreign.sort((a, b) => a.index - b.index);

  return {
    entries,
    groups,
    kinds: input.filter((t) => t[0] === 'k').map((t) => t[1]),
    foreign,
  };
}

// --- shapes -----------------------------------------------------------------

const isFeedId = (id) => {
  const k = identifierKind(id);
  return k === SHOW_KIND || k === PUBLISHER_KIND;
};

/** Contract groups -> this app's `LocalList`, through the real grouper. */
function localList(groups) {
  const entries = [];
  for (const g of groups ?? []) {
    entries.push({ id: g.id, medium: g.medium ?? undefined });
    for (const item of g.items ?? []) {
      entries.push({ id: item, feedRef: g.id, medium: g.medium ?? undefined });
    }
  }
  return groupLocalFavorites(entries);
}

/** `{public, private}` id lists -> this app's per-half feeds/items record. */
function toBaseline(b) {
  const split = (ids) => ({
    feeds: (ids ?? []).filter(isFeedId),
    items: (ids ?? []).filter((id) => !isFeedId(id)),
  });
  const pub = split(b?.public);
  const priv = split(b?.private);
  return { feeds: pub.feeds, items: pub.items, privateFeeds: priv.feeds, privateItems: priv.items };
}

const fromBaseline = (b) => ({
  public: [...b.feeds, ...b.items],
  private: [...(b.privateFeeds ?? []), ...(b.privateItems ?? [])],
});

/**
 * What the store holds once this cycle lands — the contract's `holds`.
 *
 * This app's local state is a CACHE OF THE MERGE: `<FavoritesHydrator>` paints
 * the active half whole and the inactive half only as far as the baseline
 * claims it (`claimedByBaseline`). So an entry adopted off the relay is held
 * from then on, and the next cycle's `local` is this, not the vector's input.
 */
function holdsFrom(active, inactive, baseline, inactiveHalf) {
  const groups = new Map();
  const group = (feedGuid, medium) => {
    const id = showId(feedGuid);
    if (!groups.has(id)) groups.set(id, { id, medium: medium ?? null, items: [] });
    return groups.get(id);
  };
  const take = (part) => {
    for (const f of part.feeds) group(f.feedGuid, f.medium);
    for (const it of part.items) {
      if (!it.feedGuid) continue;
      const g = group(it.feedGuid, it.medium);
      if (!g.items.includes(itemId(it.itemGuid))) g.items.push(itemId(it.itemGuid));
    }
  };
  // A half that could not be read is carried, never painted.
  if (active) take(partitionList(active));
  if (inactive) take(claimedByBaseline(partitionList(inactive), baseline, inactiveHalf));
  return [...groups.values()];
}

/** Refusals that record NOTHING in `syncFavorites`. Everything else records. */
const RECORDS_NOTHING = new Set(['degraded', 'wholesale-delete', 'private-unreadable', 'private-too-large']);

// --- one cycle --------------------------------------------------------------

export function plan({ read, local = [], baseline, mode = null, canReadPrivate = true, userChose = false }) {
  const unchanged = {
    publish: null,
    baselineIfLanded: {
      public: [...(baseline?.public ?? [])],
      private: [...(baseline?.private ?? [])],
    },
  };

  // Rule 1. The vector hands us the event, so a present read is trustworthy
  // and an absent one is the degraded case.
  if (read === null || read === undefined) return unchanged;

  const readTags = read.tags ?? [];
  const readContent = read.content ?? '';
  const list = parseFavoritesList(readTags);

  // `fetchFavoritesList`'s three answers about `content`: nothing there, read
  // it, or could not — where "could not" covers a signer with no NIP-44 and
  // bytes that decrypt to something other than a tag array alike.
  let readPrivateTags = [];
  let privateList = EMPTY_PARSED;
  let privateUnreadable = false;
  if (readContent !== '') {
    const text = canReadPrivate ? unseal(readContent) : null;
    const decoded = text === null ? null : decodePlaintext(text);
    if (decoded === null) privateUnreadable = true;
    else {
      readPrivateTags = decoded;
      privateList = parseFavoritesList(decoded);
    }
  }
  const hasPublic = readTags.some((t) => t[0] === 'i');
  const hasPrivate = readPrivateTags.some((t) => t[0] === 'i');

  // The hydrator's part: a device nobody has answered on follows the list —
  // the tag first, then emptiness — and asks when neither can say. A recorded
  // 'public' over a wire with no public entries is corrected before a cycle
  // runs on it (`correctedModeFromWire`); a choice is never corrected.
  let stored = mode;
  if (stored === null) {
    stored = list.visibility ?? seedModeFromWire(hasPublic, hasPrivate);
    if (stored === null) return unchanged;
  } else if (!userChose) {
    stored = correctedModeFromWire(stored, hasPublic, hasPrivate) ?? stored;
  }

  // From here on this is `syncFavorites`, line for line.
  const { mode: effective, stating } = effectiveListMode({
    stored,
    stated: list.visibility,
    userChose,
    canReadPrivate: !privateUnreadable,
    privateIsEmpty: !privateUnreadable && !hasPrivate,
  });
  const m = effective ?? stored;

  const all = localList(local);
  const b = toBaseline(baseline);
  const publicLocal = m === 'private' ? EMPTY_LOCAL : all;
  const privateLocal = m === 'private' ? all : EMPTY_LOCAL;

  const merged = mergeFavoritesList({
    read: list,
    local: publicLocal,
    baseline: baselineHalf(b, 'public'),
  });
  const privateMerged = privateUnreadable
    ? null
    : mergeFavoritesList({
      read: privateList,
      local: privateLocal,
      baseline: baselineHalf(b, 'private'),
    });

  const movingWholeList = WHOLE_LIST_PRIVACY_MOVE && m === 'private' && privateMerged !== null;
  const licensedPublic = m === 'public' && privateMerged !== null
    && (list.visibility === 'public' || (stating === 'public' && !!userChose));
  const movingWholePublic = licensedPublic && privateMerged.nodes.length > 0;

  const activeMerged = movingWholeList
    ? foldHalves(privateMerged, merged)
    : movingWholePublic
      ? EMPTY_PARSED
      : privateMerged;
  const publicMerged = movingWholeList
    ? EMPTY_PARSED
    : movingWholePublic
      ? foldHalves(merged, privateMerged)
      : merged;

  const p = planFavoritesPublish({
    merged: publicMerged,
    readTags,
    exists: readTags.length > 0 || readContent !== '',
    trustworthy: true,
    local: publicLocal,
    mode: m,
    privateMerged: activeMerged,
    readPrivateTags,
    readContent,
    privateUnreadable,
    privateLocal,
    previousBaseline: b,
    stating,
  });

  const holds = m === 'private'
    ? holdsFrom(activeMerged, publicMerged, p.baseline, 'public')
    : holdsFrom(publicMerged, activeMerged, p.baseline, 'private');

  if (!p.publish) {
    return RECORDS_NOTHING.has(p.reason)
      ? unchanged
      : { publish: null, baselineIfLanded: fromBaseline(p.baseline), holds };
  }
  const content = p.encryptPrivate && p.privateTags ? seal(encodePlaintext(p.privateTags)) : p.content;
  return {
    publish: { kind: FAVORITES_KIND, tags: p.tags, content },
    baselineIfLanded: fromBaseline(p.baseline),
    holds,
  };
}
