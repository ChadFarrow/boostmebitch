'use client';

// Which address a user's favorites live at, while the cross-app list is being
// trialled.
//
// StableKraft's gate is a plain on/off switch: unset means the whole feature
// no-ops. That shape is WRONG here, and copying it would be a regression.
// Boost Me Bitch has published favorites to Nostr since long before this
// feature, at its own private address, and hydration is how a returning user
// gets them back on a new device. Switching that off would leave everyone else
// with no favorites sync at all — worse than before the feature, not neutral.
//
// So the gate picks an ADDRESS rather than enabling or disabling the machinery:
//
//   allowlisted → kind 30078 `podcast:favorites`   (shared with StableKraft)
//   everyone else → kind 30003 `boostmebitch:favorites`  (exactly where their
//                                                          favorites already are)
//
// Everyone keeps working sync; only the allowlisted account writes to the
// shared list. That also means an accidental production merge is a no-op for
// other users, which is the property this repo lacked when #163 went out by
// mistake and had to be reverted.
//
// The read-merge-publish discipline runs on BOTH addresses. On a single-writer
// legacy list it is redundant but harmless, and strictly safer than the blind
// publish it replaced — a degraded read still publishes nothing.
//
// This is scaffolding. Shipping to everyone means deleting this file and
// pointing the two callers back at the shared constants.

import { nip19 } from 'nostr-tools';

import {
  ITEMS_D_TAG,
  LEGACY_D_TAG,
  LEGACY_FAVORITES_KIND,
  SHARED_D_TAG,
  SHARED_FAVORITES_KIND,
} from './favorites-merge';

/**
 * Accounts trialling the shared cross-app list. npub or hex; both normalize to
 * hex. Empty means nobody, which is the safe default.
 */
const SHARED_FAVORITES_ALLOWLIST: string[] = [
  // Chad — same account allowlisted on the StableKraft side.
  'npub177fz5zkm87jdmf0we2nz7mm7uc2e7l64uzqrv6rvdrsg8qkrg7yqx0aaq7',
];

function normalizePubkey(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (!v.startsWith('npub1')) return v.toLowerCase();
  try {
    const decoded = nip19.decode(v);
    return decoded.type === 'npub' ? (decoded.data as string).toLowerCase() : null;
  } catch {
    // A malformed entry must never widen the gate.
    return null;
  }
}

/** Is this account on the shared cross-app list? */
export function sharedFavoritesEnabledFor(pubkey: string | null | undefined): boolean {
  if (!pubkey) return false;
  const allowed = [
    ...SHARED_FAVORITES_ALLOWLIST,
    // NEXT_PUBLIC_ so it can be read in the browser — which also means it is
    // baked at build time, so changing it needs a redeploy either way.
    ...(process.env.NEXT_PUBLIC_SHARED_FAVORITES_PUBKEYS?.split(',') ?? []),
  ]
    .map(normalizePubkey)
    .filter((v): v is string => !!v);
  return allowed.includes(pubkey.toLowerCase());
}

export interface FavoritesAddresses {
  kind: number;
  /** Shows, albums and publishers. Also the default home for any identifier
   *  kind the spec's table doesn't recognize. */
  feeds: string;
  /**
   * Episodes and tracks — or **null in legacy single-list mode**, where there
   * is exactly one list and everything shares it.
   *
   * `null` rather than a boolean on purpose: `if (addr.items)` is a branch the
   * compiler makes every caller handle, where a `shared` flag beside a second
   * d-tag constant is only a convention someone has to remember. The
   * non-allowlisted path is everyone, so forgetting it is not a corner case.
   */
  items: string | null;
  /** True when these are the shared cross-app addresses. */
  shared: boolean;
}

/** The addresses this account's favorites are read from and published to. */
export function favoritesAddressFor(pubkey: string | null | undefined): FavoritesAddresses {
  return sharedFavoritesEnabledFor(pubkey)
    ? { kind: SHARED_FAVORITES_KIND, feeds: SHARED_D_TAG, items: ITEMS_D_TAG, shared: true }
    // The legacy list predates the split and is single-writer, so there is
    // nothing to split it FOR: the size pressure the two addresses exist to
    // isolate is a property of a shared list many apps append to.
    : { kind: LEGACY_FAVORITES_KIND, feeds: LEGACY_D_TAG, items: null, shared: false };
}
