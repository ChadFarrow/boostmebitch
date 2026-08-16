// The NIP-51 mute-list SHAPE, split out from ./mutes so both readers can share
// one definition without an import cycle.
//
// Why this file exists at all: `emptyMuteState` was duplicated verbatim in
// lib/storage.ts and lib/nostr/mutes.ts, and the obvious dedup — have storage.ts
// import it from mutes.ts — closes a cycle, because
//
//     storage.ts → mutes.ts → relays.ts → storage.ts
//
// (relays.ts reads `storage.relays` for the user's relay override). So the
// shared piece moves DOWN to a leaf instead of sideways.
//
// This module therefore has NO IMPORTS, deliberately, and must keep none —
// that is the whole property that makes it safe for both sides to depend on.
// The same import-free-leaf pattern is used by favorites-list.ts, read-trust.ts
// and lease.ts, for the same structural reason. ./mutes re-exports both names,
// so every existing consumer of `mutes.ts` is unaffected.

export interface MuteListState {
  /** `p` tags from the event's plaintext tag array. */
  publicPubkeys: string[];
  /** Non-`p` tags from the event's plaintext tag array — preserved verbatim. */
  publicOtherTags: string[][];
  /** `p` tags decoded from the encrypted `.content`. Empty if absent or
   *  unreadable (see `unreadablePrivateContent`). */
  privatePubkeys: string[];
  /** Non-`p` tags decoded from the encrypted `.content`. Preserved verbatim. */
  privateOtherTags: string[][];
  /** Raw ciphertext we couldn't decrypt (signer doesn't expose nip04, or
   *  decrypt threw). When set, we treat the private list as opaque and
   *  preserve the blob byte-for-byte on republish so we don't destroy
   *  private mutes set in another client. */
  unreadablePrivateContent?: string;
  /** unix seconds, from event.created_at. */
  updatedAt: number;
}

/**
 * A mute state with nothing in it.
 *
 * Note what it is NOT: a state whose `unreadablePrivateContent` is absent, which
 * means "there is no private blob to preserve". Callers that build an empty
 * state to stand in for a FAILED read must not publish it — that would drop
 * another client's private mutes. See the republish path in ./mutes.
 */
export function emptyMuteState(): MuteListState {
  return {
    publicPubkeys: [],
    publicOtherTags: [],
    privatePubkeys: [],
    privateOtherTags: [],
    updatedAt: 0,
  };
}
