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
  baselineFrom,
  itemsFromTags,
  otherTagsFrom,
  mergeSharedFavorites,
  tagsForSharedFavorites,
  LEGACY_D_TAG,
  LEGACY_FAVORITES_KIND,
  type SharedFavoriteItem,
} from './favorites-merge';
import { favoritesAddressFor } from './favorites-gate';

// ---------------------------------------------------------------------------
// Cross-app favorites — the I/O half. The wire format and the merge live in
// `favorites-merge.ts`, which is import-free so scripts/check-favsync.mjs can
// load the real thing; everything there is re-exported below so callers only
// import this module.
//
// This event is SHARED with other podcast apps (StableKraft first). It is a
// replaceable event at a well-known address, so every writer can destroy every
// other writer's data with one blind publish. That is why there is no exported
// "publish my favorites" — only `syncFavorites`, which reads first.
//
// It lives at NIP-78 kind 30078, deliberately NOT NIP-51 kind 30003 — see the
// note on SHARED_FAVORITES_KIND in favorites-merge.ts. The legacy read is the
// one place 30003 still appears.
// ---------------------------------------------------------------------------

export * from './favorites-merge';

export interface SharedFavorites {
  /** Every `i` tag, in event order, including kinds this app can't read. */
  items: SharedFavoriteItem[];
  /** Tags belonging to other writers, preserved verbatim on republish. */
  otherTags: string[][];
  /** unix seconds, from event.created_at. 0 when no event exists. */
  updatedAt: number;
  /** An event was found. */
  exists: boolean;
  /**
   * The read can be trusted. False means "nothing answered", NOT "the list is
   * empty" — never merge or publish on top of a false here, or a relay wobble
   * silently wipes favorites this device never saw.
   */
  trustworthy: boolean;
}

async function fetchList(
  pubkey: string,
  kind: number,
  dTag: string,
  relays: string[],
): Promise<SharedFavorites> {
  const { event, trustworthy } = await fetchLatestEventDetailed(
    relays,
    { kinds: [kind], authors: [pubkey], '#d': [dTag], limit: 1 },
    QUERY_MAX_WAIT_MS,
    // Belt and braces on the one read where a wrong event is worst: whatever
    // lands here is merged over and republished under the user's key, so an
    // event for another pubkey, kind or list would be laundered into their
    // favorites. Rejected at intake so it can never displace the real one.
    { pubkey, kinds: [kind], dTag },
  );
  if (!event) {
    return { items: [], otherTags: [], updatedAt: 0, exists: false, trustworthy };
  }
  return {
    items: itemsFromTags(event.tags),
    otherTags: otherTagsFrom(event.tags),
    updatedAt: event.created_at,
    exists: true,
    trustworthy: true, // an event in hand is its own proof the query worked
  };
}

/**
 * Read this account's favorites list.
 *
 * The address depends on the account: allowlisted accounts use the shared
 * cross-app list, everyone else keeps reading the address their favorites have
 * always been at. See `favorites-gate.ts` for why that beats an on/off switch.
 *
 * `queryRelays` is REQUIRED, and the missing default is the point. It used to
 * fall back to `DEFAULT_RELAYS` while every publish went to
 * `resolvePublishRelays` (the user's NIP-65 write set ∪ the defaults), so a
 * newer event living only on the user's own write relay was invisible to the
 * read and got published over on the next merge — a narrower read than write is
 * exactly how you overwrite data you never saw. Pass the publish set.
 */
export function fetchSharedFavorites(
  pubkey: string,
  queryRelays: string[],
): Promise<SharedFavorites> {
  const { kind, feeds } = favoritesAddressFor(pubkey);
  return fetchList(pubkey, kind, feeds, queryRelays);
}

/**
 * Read the items list — episodes and tracks — or resolve to an explicitly
 * ABSENT result in legacy single-list mode, where no such address exists.
 *
 * `trustworthy: false` would be wrong for the legacy case and actively
 * dangerous: it is the flag that blocks publishing, and a permanent false would
 * wedge the feature for everyone not on the allowlist. `exists: false` with
 * `trustworthy: true` is the honest answer — there is nothing at that address
 * and we are sure of it, because there is no such address.
 */
export function fetchSharedFavoriteItems(
  pubkey: string,
  queryRelays: string[],
): Promise<SharedFavorites> {
  const { kind, items } = favoritesAddressFor(pubkey);
  if (!items) {
    return Promise.resolve({
      items: [], otherTags: [], updatedAt: 0, exists: false, trustworthy: true,
    });
  }
  return fetchList(pubkey, kind, items, queryRelays);
}

/** Read this app's pre-sync list. Migration only — never republished here. */
export function fetchLegacyFavorites(
  pubkey: string,
  queryRelays: string[],
): Promise<SharedFavorites> {
  return fetchList(pubkey, LEGACY_FAVORITES_KIND, LEGACY_D_TAG, queryRelays);
}

/**
 * Publish the merged list back to whichever address this account reads from.
 *
 * `pubkey` is required rather than optional on purpose: a default would mean a
 * caller could publish the shared list for an account that reads the legacy
 * one, which puts a user's favorites at an address their own app never checks.
 *
 * Throws {@link NoRelayAcceptedError} when the event reached nobody. The assert
 * lives HERE rather than at each call site because all three writers —
 * `syncFavorites`, `migrateLegacyList`, `bmbCleanFavorites` — record a baseline
 * immediately afterwards, and a baseline written for an event that never landed
 * permanently stops that entry from being retried. Three places to remember is
 * three places to forget.
 */
export async function publishSharedFavorites(
  items: SharedFavoriteItem[],
  otherTags: string[][],
  relays: string[],
  pubkey: string,
): Promise<PublishedNote> {
  const address = favoritesAddressFor(pubkey);
  const template: EventTemplate = {
    kind: address.kind,
    created_at: Math.floor(Date.now() / 1000),
    tags: tagsForSharedFavorites(items, otherTags, address.feeds),
    content: '',
  };
  return assertPublished(await signAndPublish(template, relays), 'favorites');
}

export interface SyncOptions {
  pubkey: string;
  relays: string[];
  /** This device's current favorites, as wire items. */
  local: () => SharedFavoriteItem[];
  /** The id list this device last agreed with the relay on. */
  lastSynced: () => string[];
  /** Called with the published id list once the event lands. */
  onSynced: (ids: string[]) => void;
  /**
   * Called instead of publishing when the read came back untrustworthy. The
   * skip is correct (see below) but invisible, and a heart-tap that never
   * propagates looks exactly like one that did — so the caller gets told.
   * Injected like `onSynced` rather than reaching for the store here, which
   * keeps this module free of React and browser globals.
   */
  onDegraded?: () => void;
}

/**
 * Read → merge → publish, in one step. The read is what makes the write safe,
 * so they are never separated: a caller that could publish without reading is
 * a caller that can wipe another app's favorites.
 *
 * Returns null without recording anything in two cases: the read was degraded,
 * or the publish reached no relay. Losing a republish is recoverable — the next
 * toggle or page load retries it — whereas publishing over a list we couldn't
 * read is not, and recording a baseline for an event that never landed is what
 * stops the retry from ever happening.
 */
export async function syncFavorites(opts: SyncOptions): Promise<PublishedNote | null> {
  const latest = await fetchSharedFavorites(opts.pubkey, opts.relays);
  if (!latest.trustworthy) {
    opts.onDegraded?.();
    // eslint-disable-next-line no-console
    console.warn('[favorites] skipping publish — could not read the current list');
    return null;
  }
  const local = opts.local();
  const next = mergeSharedFavorites({
    latest: latest.items,
    lastSynced: opts.lastSynced(),
    local,
  });
  let published: PublishedNote;
  try {
    published = await publishSharedFavorites(next, latest.otherTags, opts.relays, opts.pubkey);
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
  // Only our own contribution goes into the baseline — see `baselineFrom`. This
  // line is why the assert above exists: it is a promise that `local` will keep
  // asserting these ids, and it may only be made about an event that landed.
  opts.onSynced(baselineFrom(next, local));
  return published;
}

// The debounce that used to live here now sits in `favorites-sync.ts`, next to
// the serializer it has to compose with: every cycle must be both debounced AND
// queued behind any other in-flight cycle, and a scheduler exported from here
// would be a second, unserialized way in. This module can't import
// favorites-sync (that's the cycle it exists to avoid), so the pair lives
// there. See `serializeFavoritesCycle`.
