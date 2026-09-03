import type { EventTemplate } from 'nostr-tools';
import { escapeJsonForAmber } from './amber-safe-text';
import { DEFAULT_RELAYS } from './relays';
import { signAndPublish, type PublishedNote } from './publish';
import {
  getNip04,
  getNip44,
  withDecryptTimeout,
  decryptWithTimeout,
  type DecryptPurpose,
} from './signer';
import { fetchLatestEvent } from './event-queries';
import { createScheduledPublish } from './debounced-publish';

// NIP-51 mute list (kind:10000).
//
// The same event holds two parallel lists:
//   - PUBLIC mutes: tag entries on the event itself (anyone can read).
//   - PRIVATE mutes: an encrypted JSON array of tag entries inside
//     `event.content`. Only the author can decrypt, with their own pubkey.
//
// THE PRIVATE HALF IS NOT ALWAYS NIP-04, and assuming it was is what this
// module got wrong. NIP-51 originally specified NIP-04 and later moved private
// list items to NIP-44, so the relays hold a mixture; a few clients leave the
// tags unencrypted there altogether. `classifyMuteContent` decides which from
// the bytes before any signer is asked, and `privateCipher` carries the answer
// through to the republish so we never re-encode somebody else's list. See
// ./mute-state.ts for why the order of those tests matters.
//
// Damus and most modern Nostr clients default to the private form, so we
// must read and write both to interoperate. We only manage `p` tags; non-`p`
// entries (e.g. `e` thread mutes, `t` hashtags, `word` keywords) round-trip
// untouched on either side so we never clobber another client's work.

export const MUTES_KIND = 10000;

// The shape and its empty constructor live in ./mute-state, an import-free leaf,
// so lib/storage.ts can share them without closing a storage → mutes → relays →
// storage cycle. Re-exported here so this module stays the one place the rest of
// the app imports mute types from.
export {
  emptyMuteState,
  classifyMuteContent,
  parseMuteTags,
  privateHalfAlreadyOpened,
  type MuteListState,
  type MuteCipher,
} from './mute-state';
import { classifyMuteContent, parseMuteTags } from './mute-state';
import type { MuteListState, MuteCipher } from './mute-state';

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
 * tags and (best-effort) its encrypted private content.
 *
 * WHICH CIPHER IS DECIDED FROM THE BYTES, not assumed. `classifyMuteContent`
 * answers `'plaintext'`, `'nip04'`, `'nip44'` or `'unknown'`, and the verdict is
 * recorded on the returned state as `privateCipher` so the republish writes the
 * form it read. A `'plaintext'` half needs no signer at all.
 *
 * If the content is non-empty but we cannot open it — the signer doesn't expose
 * the cipher it is written in, we declined to ask, the decrypt failed, or the
 * plaintext was not a tag array — the raw ciphertext is parked in
 * `unreadablePrivateContent` so a future republish preserves it verbatim
 * instead of clobbering private mutes set in another client (e.g. Damus).
 *
 * `decryptPrivate: false` parks the blob WITHOUT asking the signer, and is
 * not an optimization — it is how a caller declines to spend a user-facing
 * approval prompt. A decrypt is a signer round trip, and on Amber or a
 * phone-hosted bunker that round trip leaves the browser entirely. Callers that
 * run without the user having asked for anything (page-load hydration) pass
 * `false`; callers acting on something the user just did pass the default
 * `true`. The parked blob is the same first-class state the no-cipher path
 * already produces, so a later republish still round-trips the private list
 * verbatim. **It does not suppress the `'plaintext'` branch**, which spends no
 * prompt because it needs no signer.
 *
 * `purpose` rides down to `decryptWithTimeout` on the NIP-44 branch, which
 * refuses an `'unattended'` decrypt on Amber as a backstop. It belongs to the
 * CALL, never hardcoded here — see the note on `decryptWithTimeout`.
 *
 * A half we DID open records the ciphertext it came from in
 * `knownPrivateContent`, so a later load that is not allowed to ask the signer
 * can recognize the same document and reuse this device's plaintext instead of
 * parking it again. See `privateHalfAlreadyOpened` in ./mute-state.
 */
export async function fetchMutedPubkeys(
  pubkey: string,
  queryRelays?: string[],
  opts?: { decryptPrivate?: boolean; purpose?: DecryptPurpose },
): Promise<MuteListState | null> {
  const decryptPrivate = opts?.decryptPrivate ?? true;
  const purpose: DecryptPurpose = opts?.purpose ?? 'unattended';
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
    let privateCipher: MuteCipher | undefined;
    // Set ONLY where the half was actually decoded, and set to the ciphertext we
    // decoded rather than to a flag: the next cold start compares it byte for
    // byte against what the wire is carrying, which is the only thing that makes
    // reusing this device's plaintext safe. Every `park()` below leaves it
    // undefined, and so does the catch.
    let knownPrivateContent: string | undefined;

    if (newest.content) {
      privateCipher = classifyMuteContent(newest.content);
      // One park for every way of not reading it, so the blob is preserved
      // byte-for-byte on republish whichever way we failed.
      const park = (why: string) => {
        unreadablePrivateContent = newest.content;
        // eslint-disable-next-line no-console
        console.info(`[mutes] private mute list left unread — ${why}`);
      };

      if (privateCipher === 'plaintext') {
        // Not encrypted at all. No signer, no prompt, and so no reason to
        // honour `decryptPrivate` — that flag exists to avoid spending an
        // approval, and this branch spends none.
        const tags = parseMuteTags(newest.content);
        if (tags) {
          const split = partitionTags(tags);
          privatePubkeys = split.pubkeys;
          privateOtherTags = split.other;
          knownPrivateContent = newest.content;
        } else {
          park('it looked like a plaintext tag array and did not parse as one');
        }
      } else if (privateCipher === 'unknown') {
        park('this app does not recognize the shape of its content');
      } else if (!decryptPrivate) {
        park('not spending a signer prompt here — the local cache still filters');
      } else {
        const api = privateCipher === 'nip44' ? getNip44() : getNip04();
        if (!api) {
          park(`the signer does not expose ${privateCipher.toUpperCase().replace('NIP', 'NIP-')}`);
        } else {
          try {
            // Bounded, not bare. A NIP-07 extension in Safari can have its
            // background killed while the relay query above is in flight, and the
            // decrypt issued afterwards then never settles — no rejection, no
            // error, just a promise that stays pending. `hydrateMutes` awaits
            // this, and its caller swallows failures, so the whole mute list is
            // lost in silence. A timeout turns that into the park below, which
            // preserves the ciphertext verbatim and keeps this device's cached
            // private entries.
            //
            // The NIP-44 branch goes through `decryptWithTimeout` instead, which
            // adds the same bound plus the refusal that stops an unattended
            // Amber decrypt rendering a plaintext the user never asked to see.
            const plaintext = privateCipher === 'nip44'
              ? await decryptWithTimeout(pubkey, newest.content, purpose)
              : await withDecryptTimeout(api.decrypt(pubkey, newest.content), 'nip04 decrypt');
            const tags = parseMuteTags(plaintext);
            if (tags) {
              const split = partitionTags(tags);
              privatePubkeys = split.pubkeys;
              privateOtherTags = split.other;
              knownPrivateContent = newest.content;
            } else {
              // A decrypt that "succeeded" against the wrong key looks exactly
              // like this. Parking is the whole point: the shipping code took
              // the empty list and left the blob unparked, so the next
              // republish wrote `content: ''` over another client's mutes.
              park('it decrypted to something that is not a tag array');
            }
          } catch (e) {
            unreadablePrivateContent = newest.content;
            // eslint-disable-next-line no-console
            console.warn(
              `[mutes] ${privateCipher} decrypt failed — preserving as opaque blob:`,
              (e as Error)?.message ?? e,
            );
          }
        }
      }
    }

    return {
      publicPubkeys,
      publicOtherTags,
      privatePubkeys,
      privateOtherTags,
      unreadablePrivateContent,
      knownPrivateContent,
      privateCipher,
      updatedAt: newest.created_at,
    };
  } catch {
    return null;
  }
}

/**
 * Sign and publish a kind:10000 reflecting the given state.
 *
 * The encrypted content is rebuilt from `privatePubkeys` + `privateOtherTags`
 * unless we're sitting on an `unreadablePrivateContent` blob — in that case the
 * blob is passed through unchanged so we don't destroy private mutes we
 * couldn't decrypt.
 *
 * **IT RE-ENCRYPTS IN THE CIPHER IT READ.** `state.privateCipher` carries what
 * `fetchMutedPubkeys` saw on the wire, and rewriting a NIP-44 list as NIP-04
 * (or the reverse) makes it unreadable to the client that wrote it — a silent
 * loss on someone else's device, from a publish that looks entirely successful
 * here. Absent, meaning this app is creating the list, it prefers NIP-44:
 * that is what NIP-51 specifies today and what this repo's private-favorites
 * half already writes.
 *
 * If the signer can't provide the wanted cipher, decoded private entries fall
 * back to public-tag form so the user's mute intent isn't silently lost. It
 * deliberately does NOT quietly swap to the other cipher — that is the
 * downgrade this function exists to prevent.
 */
export async function publishMuteList(
  ownerPubkey: string,
  state: MuteListState,
  relays: string[],
  onPrivateContentKnown?: (content: string) => void,
): Promise<PublishedNote> {
  const tags: string[][] = [];
  for (const t of state.publicOtherTags) tags.push(t);
  for (const pk of state.publicPubkeys) tags.push(['p', pk]);

  let content = '';
  if (state.unreadablePrivateContent) {
    // Preserve verbatim — we never decoded it, so we mustn't rewrite it.
    content = state.unreadablePrivateContent;
    // AND SAY WHAT THAT COSTS. `mutePubkey` adds every new mute to
    // `privatePubkeys` (Damus's default), and this branch ignores that field
    // entirely — so while the blob is parked a new mute filters on this device,
    // persists on this device, and never reaches a relay. That is the right
    // trade, because merging into a document we cannot read would destroy it,
    // but it was completely silent: the mute is simply absent on the user's
    // other device. Opening the half once (the <MutesSyncNotice> button) clears
    // the park and this stops applying.
    if (state.privatePubkeys.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[mutes] ${state.privatePubkeys.length} private mute(s) are NOT in this publish — `
        + 'the private half is an unopened blob and merging into it would destroy it. '
        + 'They filter on this device only until the private half is opened.',
      );
    }
  } else if (state.privatePubkeys.length > 0 || state.privateOtherTags.length > 0) {
    const innerTags: string[][] = [
      ...state.privateOtherTags,
      ...state.privatePubkeys.map((pk) => ['p', pk]),
    ];
    // Escaped, not encoded: another client reads this half, so it must stay
    // plain JSON, and `\u003f` is `?` to every JSON reader while being no `?`
    // to Amber's URI splitter. A muted word with a question mark otherwise
    // fails the whole publish on Android — see lib/nostr/amber-safe-text.ts.
    const plaintext = escapeJsonForAmber(JSON.stringify(innerTags));

    // A list we read as plaintext is not a form to preserve: kind:10000's
    // `content` is specified as encrypted, so plaintext there is a malformed
    // event rather than another writer's choice — and re-encoding it loses
    // nothing, because we read it. Treated as "no observed cipher".
    const observed = state.privateCipher === 'nip04' || state.privateCipher === 'nip44'
      ? state.privateCipher
      : null;
    const nip44 = getNip44();
    const nip04 = getNip04();
    const wanted = observed ?? (nip44 ? 'nip44' : 'nip04');
    const api = wanted === 'nip44' ? nip44 : nip04;

    if (api) {
      content = await api.encrypt(ownerPubkey, plaintext);
    } else {
      // Degraded: signer can't encrypt with the cipher this list uses, so we
      // surface privates as publics rather than silently drop them.
      // eslint-disable-next-line no-console
      console.warn(
        `[mutes] signer has no ${wanted === 'nip44' ? 'NIP-44' : 'NIP-04'} encrypt — `
        + 'falling back to public p-tags for new mutes',
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
  const note = await signAndPublish(template, relays);

  // TELL THE CALLER WHICH CIPHERTEXT IT NOW HOLDS THE PLAINTEXT OF.
  //
  // Encryption is non-deterministic — a fresh nonce per call — so this string
  // cannot be recomputed later from the same entries. Without capturing it here,
  // a device that opens its private half once and then mutes anybody is back to
  // an unrecognized blob on the next load: it published a ciphertext it built
  // itself and then forgot it, so the notice returns after every mute. That is
  // the reported bug wearing a different hat.
  //
  // Gated on a relay actually accepting it, because that is what decides which
  // bytes the next read will find. If nothing accepted, the relays still carry
  // the previous ciphertext and the caller must keep describing THAT one.
  //
  // Not called on the parked branch: there the content is a blob we never
  // decoded, and claiming to know it is the one way this mechanism could
  // republish our entries over another client's.
  if (!state.unreadablePrivateContent && note.acceptedRelays.length > 0) {
    onPrivateContentKnown?.(content);
  }
  return note;
}

// Debounced wrapper — collapses rapid mute/unmute toggles into a single
// signing prompt. The getter form lets the caller read the latest store
// state at fire-time so chained toggles only publish the final shape.
const _schedulePublish = createScheduledPublish('mutes');
export function schedulePublishMuteList(
  ownerPubkey: string,
  getState: () => MuteListState,
  relays: string[],
  onPrivateContentKnown?: (content: string) => void,
  delayMs = 1500,
) {
  _schedulePublish(
    () => publishMuteList(ownerPubkey, getState(), relays, onPrivateContentKnown),
    delayMs,
  );
}
