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
//
// It is now enforced rather than merely asserted: `npm run check:mutes` loads
// this module under `node --experimental-strip-types` and calls
// `scripts/import-free.mjs`. That scan rejects TYPE-ONLY relative imports too,
// which is why `MuteCipher` and the classifier below live here beside
// `MuteListState` rather than in a file of their own — a second leaf could not
// `import type { MuteCipher } from './mute-state'` without breaking the rule.

/**
 * How the private half of a mute list is encoded on the wire.
 *
 * `'plaintext'` is not an encoding this app would ever choose to write — see
 * `classifyMuteContent` — but it is one that occurs and has to be readable.
 */
export type MuteCipher = 'plaintext' | 'nip04' | 'nip44' | 'unknown';

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
  /** Raw ciphertext we couldn't decrypt (signer doesn't expose the cipher it
   *  is written in, the decrypt threw, or the plaintext wasn't a tag array).
   *  When set, we treat the private list as opaque and preserve the blob
   *  byte-for-byte on republish so we don't destroy private mutes set in
   *  another client. */
  unreadablePrivateContent?: string;
  /**
   * The EXACT `content` string whose plaintext produced `privatePubkeys` and
   * `privateOtherTags` on this device.
   *
   * It exists so a private half we have already opened is not opened again. An
   * out-of-browser signer gets no unattended decrypt (`unattendedDecryptOk`), so
   * without this every cold start parks the same ciphertext, applies the cached
   * entries, and tells the user their private list stayed shut — forever, on a
   * list this device decoded weeks ago. The user presses the button, it works,
   * and the notice is back on the next load.
   *
   * It is only ever meaningful COMPARED BYTE FOR BYTE against the content the
   * wire is carrying right now — see `privateHalfAlreadyOpened`. On its own it
   * says nothing: another client may have rewritten the private half since, and
   * the cached entries would then describe a document that no longer exists.
   */
  knownPrivateContent?: string;
  /**
   * Which cipher the wire actually used, recorded on the read so the republish
   * cannot change it.
   *
   * Absent means no `content` was observed — a list this app is about to
   * create. It is NOT a synonym for `'unknown'`, which means we saw content and
   * did not recognize its shape.
   */
  privateCipher?: MuteCipher;
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

/**
 * Has this device already opened the exact private half the relay is carrying?
 *
 * `read` is what `fetchMutedPubkeys` just returned; `cached` is `storage.muted`.
 * True means the parked blob is one whose plaintext we hold, so the caller may
 * treat the half as READ: apply `cached.privatePubkeys`, drop the park, and say
 * nothing on screen.
 *
 * **The comparison is exact string equality and must stay one.** Not a prefix,
 * not a length, not a hash. Everything this predicate licences — suppressing the
 * notice, and republishing the private half from decoded entries rather than
 * round-tripping the blob — is safe only because the two strings are the same
 * document. A loose test hands another client's rewritten list the trust we
 * earned on the one we actually read, and the republish then writes OUR older
 * entries over THEIR newer ones, silently, on their device, with no undo.
 *
 * A wire carrying no parked blob answers false, and that is not a near-miss: it
 * means either there is no private half or the caller just read it, and both are
 * already handled without asking here.
 */
export function privateHalfAlreadyOpened(
  read: MuteListState,
  cached: MuteListState,
): boolean {
  const blob = read.unreadablePrivateContent;
  if (!blob) return false;
  return typeof cached.knownPrivateContent === 'string'
    && cached.knownPrivateContent === blob;
}

// ---------------------------------------------------------------------------
// Which cipher is `event.content` written in?
//
// WHY THIS EXISTS. A kind:10000's `content` has never had exactly one encoding.
// NIP-51 originally specified NIP-04 and later moved private list items to
// NIP-44, so what sits on the relays today is a mixture written by whichever
// client the user happened to use — and a third shape occurs too: `content`
// left as a plain JSON tag array by a client that never encrypted it.
//
// This app read every one of them as NIP-04. A NIP-44 payload carries no `?iv=`
// separator, so a NIP-04 decrypt splits on it, gets `undefined` for the IV, and
// throws while base64-decoding that — which is how a Clave sign-in on iOS came
// back with `nip04_decrypt failed: Invalid base64`. Nothing was destroyed, because
// the failure parks the blob; it meant the private half was unreadable forever,
// and that a request which could not succeed was fired at the user's phone on
// every cold start.
//
// So the cipher is decided FROM THE BYTES, before any signer is asked for
// anything.
// ---------------------------------------------------------------------------

/** Standard base64 alphabet, anchored, optional padding. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * A NIP-44 v2 payload is base64 of `version || nonce(32) || ciphertext || mac(32)`,
 * so it is at least 99 bytes — 132 base64 characters — and its version byte is
 * `0x02`, whose top six bits are zero, so it ALWAYS encodes to a leading `A`.
 *
 * Strict on purpose. A payload this refuses is parked and shown to the user
 * rather than sent to a signer, which is the safe direction: parking is never
 * destructive, and the whole point of classifying is to stop spending a
 * user-facing prompt on a request that cannot succeed. Loosen it only against a
 * real payload that it wrongly refuses — `npm run probe:mutes` prints the
 * evidence beside the verdict for exactly that.
 */
function looksNip44(s: string): boolean {
  return s.length >= 132 && s.length % 4 === 0 && s.startsWith('A') && BASE64.test(s);
}

/**
 * Decide which cipher `event.content` is written in.
 *
 * The tests run in a fixed order and THE ORDER IS THE CORRECTNESS PROPERTY:
 *
 *  1. A JSON array whose every element is an array — plaintext tags.
 *  2. Contains the literal `?iv=` — NIP-04.
 *  3. NIP-44 v2 shaped — NIP-44.
 *  4. Anything else — `'unknown'`. Carry it; ask no signer.
 *
 * **Step 1 must precede step 2.** A mute list can legitimately mute the keyword
 * `a?iv=b`, so a plaintext list may contain the exact separator NIP-04 uses:
 * `[["word","a?iv=b"]]`. A `?iv=` test placed first classifies that as NIP-04
 * and spends a doomed decrypt on a document that needed no signer at all. The
 * reverse mistake is impossible — the base64 alphabet holds no `[`, `"` or `,`,
 * so a real ciphertext can never parse as a JSON array — which is what makes
 * this order safe rather than merely lucky.
 *
 * **Step 2 is exact in its own direction** for the same reason: the base64
 * alphabet holds no `?`, so `?iv=` cannot occur inside either half of a real
 * NIP-04 payload. Finding it means the separator, never data.
 *
 * Step 1 requires EVERY element to be an array, not merely one of them, and
 * that strictness is load-bearing because this verdict drives the WRITE path as
 * well as the read. `["hello"]` is not a tag array; reading it as an empty
 * plaintext list would licence republishing over it, which is the one way this
 * function can destroy data. A document we only half understand is parked, and
 * a parked document round-trips byte for byte.
 *
 * Empty content answers `'unknown'`. Callers guard on `content` being non-empty
 * before asking, because "there is no private half" is a different state from
 * "there is one and we can't read it".
 */
export function classifyMuteContent(content: string): MuteCipher {
  if (!content || !content.trim()) return 'unknown';

  try {
    const parsed: unknown = JSON.parse(content);
    if (Array.isArray(parsed) && parsed.every((t) => Array.isArray(t))) return 'plaintext';
  } catch {
    // Not JSON. Every ciphertext lands here — this is the ordinary path.
  }

  if (content.includes('?iv=')) return 'nip04';
  if (looksNip44(content)) return 'nip44';
  return 'unknown';
}

/**
 * Decode a private half — decrypted, or never encrypted — into tag arrays.
 * `null` means it is not a tag array at all.
 *
 * A loose element inside a well-formed array is DROPPED rather than rejected:
 * it belongs to a writer newer or older than us, and refusing a whole document
 * over one entry we cannot read would park a list we otherwise understand. Same
 * "carry what you can't read" trade the favorites parser makes, one level down.
 *
 * **A top level that is not an array returns `null`, and the caller must treat
 * that exactly like a decrypt that threw.** This is not defensive tidying: it
 * is what a decrypt that "succeeded" against the wrong key looks like, and the
 * shipping code returned an empty private list for it WITHOUT parking the blob.
 * The next republish then wrote `content: ''` over another client's private
 * mutes — silently, on someone else's device, with no undo.
 */
export function parseMuteTags(plaintext: string): string[][] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.filter((t): t is string[] => Array.isArray(t));
}
