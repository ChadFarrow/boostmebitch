import type { EventTemplate } from 'nostr-tools';
import {
  assertPublished,
  NoRelayAcceptedError,
  signAndPublish,
  type PublishedNote,
} from './publish';
import { fetchLatestEventDetailed } from './event-queries';
import { QUERY_MAX_WAIT_MS } from './pool';
import {
  FAVORITES_KIND,
  mergeFavoritesList,
  parseFavoritesList,
  planFavoritesPublish,
  type FavoritesBaseline,
  type LocalList,
  type ParsedList,
} from './favorites-list';
// ---------------------------------------------------------------------------
// Cross-app favorites — the I/O half. The wire format and the merge live in
// `favorites-list.ts`, which is import-free so scripts/check-favsync.mjs can
// load the real thing; everything there is re-exported below so callers only
// import this module.
//
// This event is SHARED with other podcast apps, at a single well-known address
// per pubkey, and it is REPLACEABLE — so every writer can destroy every other
// writer's data with one blind publish, and there is no partial update to fall
// back on. That is why there is no exported "publish my favorites": only
// `syncFavorites`, which reads first, and `publishFavoritesTags`, which takes
// an already-merged tag array and is not exported beyond this module's own
// callers.
// ---------------------------------------------------------------------------

export * from './favorites-list';

export interface FavoritesRead {
  /** The parsed node list, in wire order. */
  list: ParsedList;
  /**
   * The raw tags exactly as they arrived, or [] when no event exists.
   *
   * Kept alongside the parsed form because "did anything change" is a BYTE
   * comparison against what the relay holds, not a membership one — order and
   * grouping are semantic here, so two lists with identical membership can mean
   * different things.
   */
  tags: string[][];
  /** unix seconds, from event.created_at. 0 when no event exists. */
  updatedAt: number;
  exists: boolean;
  /**
   * The read can be trusted. False means "nothing answered", NOT "the list is
   * empty" — never merge or publish on top of a false here. Under wholesale
   * replacement this is the most expensive mistake the format allows: one bad
   * read, republished, is the entire list gone.
   */
  trustworthy: boolean;
}

const EMPTY_READ: FavoritesRead = {
  list: { nodes: [], foreignTags: [], foreignKinds: [] },
  tags: [],
  updatedAt: 0,
  exists: false,
  trustworthy: true,
};

/**
 * Read this account's favorites list.
 *
 * `queryRelays` is REQUIRED, and the missing default is the point. It used to
 * fall back to `DEFAULT_RELAYS` while every publish went to
 * `resolvePublishRelays` (the user's NIP-65 write set ∪ the defaults), so a
 * newer event living only on the user's own write relay was invisible to the
 * read and got published over on the next merge — a narrower read than write is
 * exactly how you overwrite data you never saw. Pass the publish set.
 */
export async function fetchFavoritesList(
  pubkey: string,
  queryRelays: string[],
): Promise<FavoritesRead> {
  const { event, trustworthy } = await fetchLatestEventDetailed(
    queryRelays,
    { kinds: [FAVORITES_KIND], authors: [pubkey], limit: 1 },
    QUERY_MAX_WAIT_MS,
    // Belt and braces on the one read where a wrong event is worst: whatever
    // lands here is merged over and republished under the user's key, so an
    // event for another pubkey or kind would be laundered into their favorites.
    //
    // `dTag: ''` matches an event with NO `d` tag (see `acceptsEvent`), which is
    // what kind 10333 is — a plain replaceable event, one per pubkey. Without
    // it an addressable event that happened to share the kind would be
    // accepted, and its `d` tag would then be dropped on republish.
    { pubkey, kinds: [FAVORITES_KIND], dTag: '' },
  );
  if (!event) return { ...EMPTY_READ, trustworthy };
  return {
    list: parseFavoritesList(event.tags),
    tags: event.tags,
    updatedAt: event.created_at,
    exists: true,
    trustworthy: true, // an event in hand is its own proof the query worked
  };
}

/**
 * Publish an already-merged tag array.
 *
 * Takes tags rather than a model on purpose: the array IS the data, and a
 * function that rebuilt it here would be a second emitter to keep in step with
 * `tagsFromList`. Everything that reaches this point has been through the
 * merge.
 *
 * Throws {@link NoRelayAcceptedError} when the event reached nobody. The assert
 * lives HERE rather than at each call site because every writer records a
 * baseline immediately afterwards, and a baseline written for an event that
 * never landed permanently stops those entries from being retried — `local −
 * baseline` is empty for them from then on, so they are never published again
 * while the UI reports success.
 */
export async function publishFavoritesTags(
  tags: string[][],
  relays: string[],
): Promise<PublishedNote> {
  const template: EventTemplate = {
    kind: FAVORITES_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
  return assertPublished(await signAndPublish(template, relays), 'favorites');
}

export interface SyncOptions {
  pubkey: string;
  relays: string[];
  /** This device's current favorites, grouped for the wire. */
  local: () => LocalList;
  /** What this device last agreed with the relay on. */
  baseline: () => FavoritesBaseline;
  /** Called with the new baseline once the event lands. */
  onSynced: (baseline: FavoritesBaseline) => void;
  /**
   * Called instead of publishing when the read came back untrustworthy. The
   * skip is correct but invisible, and a heart-tap that never propagates looks
   * exactly like one that did — so the caller gets told. Injected like
   * `onSynced` rather than reaching for the store here, which keeps this module
   * free of React and browser globals.
   */
  onDegraded?: () => void;
}

/**
 * Read → merge → publish, in one step. The read is what makes the write safe,
 * so they are never separated: a caller that could publish without reading is a
 * caller that can wipe another app's favorites.
 *
 * Returns null without recording anything in three cases: the read was
 * degraded, nothing changed, or the publish reached no relay. Losing a
 * republish is recoverable — the next toggle or page load retries it — whereas
 * publishing over a list we couldn't read is not.
 */
export async function syncFavorites(opts: SyncOptions): Promise<PublishedNote | null> {
  const read = await fetchFavoritesList(opts.pubkey, opts.relays);
  const local = opts.local();

  const plan = planFavoritesPublish({
    merged: mergeFavoritesList({ read: read.list, local, baseline: opts.baseline() }),
    readTags: read.tags,
    exists: read.exists,
    trustworthy: read.trustworthy,
    local,
  });

  if (plan.reason === 'degraded') {
    opts.onDegraded?.();
    // eslint-disable-next-line no-console
    console.warn('[favorites] skipping publish — could not read the current list');
    return null;
  }

  if (!plan.publish) {
    // Nothing to say: the relay already holds exactly these bytes. Still record
    // the baseline — without it the first unfavorite on this device has nothing
    // to diff against and silently fails to propagate.
    opts.onSynced(plan.baseline);
    return null;
  }

  try {
    const published = await publishFavoritesTags(plan.tags, opts.relays);
    // This line is why `assertPublished` exists: the baseline is a promise that
    // `local` will keep asserting these ids, and it may only be made about an
    // event that actually landed.
    opts.onSynced(plan.baseline);
    return published;
  } catch (e) {
    // Only the reached-nobody case is a relay problem. A signing rejection is
    // the user saying no, and reporting that as "couldn't reach the relays"
    // would be a lie — it rethrows to the debounce's own warn instead.
    if (!(e instanceof NoRelayAcceptedError)) throw e;
    opts.onDegraded?.();
    // eslint-disable-next-line no-console
    console.warn('[favorites] publish reached no relay — baseline unchanged, next toggle retries');
    return null;
  }
}

// The debounce that used to live here now sits in `favorites-sync.ts`, next to
// the serializer it has to compose with: every cycle must be both debounced AND
// queued behind any other in-flight cycle, and a scheduler exported from here
// would be a second, unserialized way in. This module can't import
// favorites-sync (that's the cycle it exists to avoid), so the pair lives
// there. See `serializeFavoritesCycle`.
