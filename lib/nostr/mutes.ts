import type { EventTemplate } from 'nostr-tools';
import { DEFAULT_RELAYS } from './relays';
import { signAndPublish, type PublishedNote } from './publish';
import { getNip04 } from './signer';
import { fetchLatestEvent } from './event-queries';
import { createScheduledPublish } from './debounced-publish';

// NIP-51 mute list (kind:10000).
//
// The same event holds two parallel lists:
//   - PUBLIC mutes: tag entries on the event itself (anyone can read).
//   - PRIVATE mutes: NIP-04-encrypted JSON-array of tag entries inside
//     `event.content`. Only the author can decrypt with their own pubkey.
//
// Damus and most modern Nostr clients default to the private form, so we
// must read and write both to interoperate. We only manage `p` tags; non-`p`
// entries (e.g. `e` thread mutes, `t` hashtags, `word` keywords) round-trip
// untouched on either side so we never clobber another client's work.

export const MUTES_KIND = 10000;

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

export function emptyMuteState(): MuteListState {
  return {
    publicPubkeys: [],
    publicOtherTags: [],
    privatePubkeys: [],
    privateOtherTags: [],
    updatedAt: 0,
  };
}

/** Union of public + private p-tags. This is what feed surfaces filter against. */
export function unionMutedPubkeys(state: MuteListState): Set<string> {
  return new Set([...state.publicPubkeys, ...state.privatePubkeys]);
}

function partitionTags(tags: string[][]): { pubkeys: string[]; other: string[][] } {
  const pubkeys: string[] = [];
  const other: string[][] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (tag[0] === 'p' && typeof tag[1] === 'string' && tag[1]) {
      if (!seen.has(tag[1])) {
        seen.add(tag[1]);
        pubkeys.push(tag[1]);
      }
    } else {
      other.push(tag);
    }
  }
  return { pubkeys, other };
}

/**
 * Fetch the user's kind:10000 from the relays and decode both its public
 * tags and (best-effort) its NIP-04-encrypted private content.
 *
 * Decryption is only attempted when `window.nostr.nip04` is available. If
 * the content is non-empty but decrypt fails or isn't supported, the raw
 * ciphertext is parked in `unreadablePrivateContent` so a future republish
 * can preserve it verbatim instead of clobbering the user's private mutes
 * set in another client (e.g. Damus).
 */
export async function fetchMutedPubkeys(
  pubkey: string,
  queryRelays?: string[],
): Promise<MuteListState | null> {
  const useRelays = queryRelays ?? DEFAULT_RELAYS;
  try {
    const newest = await fetchLatestEvent(useRelays, {
      kinds: [MUTES_KIND],
      authors: [pubkey],
      limit: 1,
    });
    if (!newest) return null;

    const { pubkeys: publicPubkeys, other: publicOtherTags } = partitionTags(newest.tags);

    let privatePubkeys: string[] = [];
    let privateOtherTags: string[][] = [];
    let unreadablePrivateContent: string | undefined;

    if (newest.content) {
      const nip04 = getNip04();
      if (!nip04) {
        unreadablePrivateContent = newest.content;
        // eslint-disable-next-line no-console
        console.warn(
          '[mutes] kind:10000 has encrypted content but signer has no NIP-04 — private mutes will round-trip opaquely',
        );
      } else {
        try {
          const plaintext = await nip04.decrypt(pubkey, newest.content);
          const parsed = JSON.parse(plaintext);
          if (Array.isArray(parsed)) {
            const tagArrays = parsed.filter((t): t is string[] => Array.isArray(t));
            const split = partitionTags(tagArrays);
            privatePubkeys = split.pubkeys;
            privateOtherTags = split.other;
          }
        } catch (e) {
          unreadablePrivateContent = newest.content;
          // eslint-disable-next-line no-console
          console.warn(
            '[mutes] private mute list decrypt failed — preserving as opaque blob:',
            (e as Error)?.message ?? e,
          );
        }
      }
    }

    return {
      publicPubkeys,
      publicOtherTags,
      privatePubkeys,
      privateOtherTags,
      unreadablePrivateContent,
      updatedAt: newest.created_at,
    };
  } catch {
    return null;
  }
}

/**
 * Sign and publish a kind:10000 reflecting the given state. The encrypted
 * content is rebuilt from `privatePubkeys` + `privateOtherTags` unless we're
 * sitting on an `unreadablePrivateContent` blob — in that case the blob is
 * passed through unchanged so we don't destroy private mutes we couldn't
 * decrypt. If the signer can't NIP-04-encrypt, decoded private entries fall
 * back to public-tag form so the user's mute intent isn't silently lost.
 */
export async function publishMuteList(
  ownerPubkey: string,
  state: MuteListState,
  relays: string[],
): Promise<PublishedNote> {
  const tags: string[][] = [];
  for (const t of state.publicOtherTags) tags.push(t);
  for (const pk of state.publicPubkeys) tags.push(['p', pk]);

  let content = '';
  if (state.unreadablePrivateContent) {
    // Preserve verbatim — we never decoded it, so we mustn't rewrite it.
    content = state.unreadablePrivateContent;
  } else if (state.privatePubkeys.length > 0 || state.privateOtherTags.length > 0) {
    const nip04 = getNip04();
    if (nip04) {
      const innerTags: string[][] = [
        ...state.privateOtherTags,
        ...state.privatePubkeys.map((pk) => ['p', pk]),
      ];
      content = await nip04.encrypt(ownerPubkey, JSON.stringify(innerTags));
    } else {
      // Degraded: signer can't encrypt, so we surface privates as publics
      // rather than silently drop them.
      // eslint-disable-next-line no-console
      console.warn(
        '[mutes] signer has no NIP-04 encrypt — falling back to public p-tags for new mutes',
      );
      for (const t of state.privateOtherTags) tags.push(t);
      for (const pk of state.privatePubkeys) {
        if (!state.publicPubkeys.includes(pk)) tags.push(['p', pk]);
      }
    }
  }

  const template: EventTemplate = {
    kind: MUTES_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
  };
  return signAndPublish(template, relays);
}

// Debounced wrapper — collapses rapid mute/unmute toggles into a single
// signing prompt. The getter form lets the caller read the latest store
// state at fire-time so chained toggles only publish the final shape.
const _schedulePublish = createScheduledPublish('mutes');
export function schedulePublishMuteList(
  ownerPubkey: string,
  getState: () => MuteListState,
  relays: string[],
  delayMs = 1500,
) {
  _schedulePublish(() => publishMuteList(ownerPubkey, getState(), relays), delayMs);
}
