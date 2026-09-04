/**
 * The favorites list as a downloadable BACKUP of the Nostr event.
 *
 * This file used to build a document of its own — the store maps with titles,
 * artwork and `addedAt` stamps folded in. It was replaced, and the reason is
 * worth keeping because the first version looked more useful:
 *
 * **A backup of a replaceable event has to BE the event.** kind:10333 is one
 * event per pubkey that every writer replaces wholesale, so the thing worth
 * saving is the thing that can be put back. A document assembled here cannot
 * be put back: `id` is a hash over the whole event and `sig` needs the secret
 * key, so a rebuilt list is unverifiable and unpublishable by any other tool.
 * It is a transcript, not a backup.
 *
 * **And most of what the old file added was not on the relays at all.** Title,
 * author, artwork and feed URL come from Podcast Index; `addedAt` is when this
 * device resolved the row. None of it is stored anywhere but here, so a file
 * carrying it answers "what does my phone know" when the question was "what is
 * on the relays". Those fields were also the ones that came back `null`,
 * because resolution runs after the read — so the additions were exactly the
 * part that made the file look broken.
 *
 * What survives from the old version is the honesty rule, moved one step
 * earlier: rather than writing a caveat INTO the file, a read that cannot be
 * trusted produces NO file. See `backupRefusal`.
 */
import { verifyEvent, type Event } from 'nostr-tools';

export interface BackupReadState {
  /** The relay read may be believed. See `readIsTrustworthy`. */
  trustworthy: boolean;
  /** An event was found. */
  exists: boolean;
  /**
   * Where this account's favorites go. `null` means never chosen.
   *
   * Spelled out rather than imported as `FavoritesPrivacy`. An aliased
   * import is what stops this file loading under
   * `node --experimental-strip-types`, and `scripts/import-free.mjs` rejects
   * a TYPE-only one too, on the reasoning CLAUDE.md gives: type-stripping
   * erases it, so it passes every check while leaving the module one `type`
   * deletion away from an unloadable import. Drift is not silent —
   * `<DownloadFavorites>` hands this `storage.favPrivacy.get(...)`, which is
   * typed `FavoritesPrivacy | null`, so a fourth mode fails `npm run
   * typecheck` at that call site. `check:favbackup` also reads the union out
   * of `favorites-list.ts` by text and asserts the two still agree.
   */
  mode: 'public' | 'private' | 'off' | null;
}

/**
 * Why no file may be written, or `null` to go ahead.
 *
 * **A backup taken from a degraded read is worse than no backup**, which is
 * why this refuses rather than annotating. The two failures are not symmetric:
 * a missing file sends the user back tomorrow, while a file holding an OLDER
 * event than the relays now have is indistinguishable from a good one — and
 * the moment it is restored it replaces the newer list wholesale, which is the
 * exact loss this whole feature exists to insure against. Every other guard in
 * the favorites path makes the same call: never write over what you could not
 * read.
 *
 * Each refusal names what the user can do about it, because a control that
 * declines without a reason reads as broken.
 */
export function backupRefusal(read: BackupReadState): string | null {
  if (!read.trustworthy) {
    return 'the relays could not be read just now, so this would risk saving an older list than the one stored — try again in a moment';
  }
  if (!read.exists) {
    return read.mode === 'off'
      ? 'favorites are set to stay on this device, so nothing is stored on the relays to back up'
      : 'no favorites list is stored on the relays for this account yet';
  }
  return null;
}

/**
 * The event as a file, in NIP-01 field order.
 *
 * Rebuilt as a literal rather than passed to `JSON.stringify(event)` for one
 * reason: nostr-tools attaches non-enumerable helpers to a received event on
 * some paths, and an extra key in a file that is supposed to BE the event is
 * the kind of thing another tool rejects. Naming the seven fields is also what
 * guarantees nothing else can ever leak into a file the user shares.
 */
export function serializeFavoritesBackup(event: Event): string {
  return `${JSON.stringify({
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  }, null, 2)}\n`;
}

/**
 * `boostmebitch-favorites-2026-09-01-a1b2c3d4.json`.
 *
 * Two deliberate choices, both for the case this exists to serve — keeping
 * several backups and knowing which is which:
 *
 *  - The date is the EVENT's `created_at`, not today. It says when the list
 *    was last written, so two downloads of an unchanged list produce the same
 *    name rather than one file per day of identical bytes.
 *  - The first 8 of the event id disambiguate two lists written on one day,
 *    and let a file be matched against a relay without opening it.
 *
 * The site name is the first label of the deploy's own domain, so the two
 * deploys write distinguishable files and neither hard-codes the other's word.
 *
 * **`domain` is a parameter rather than a read of `BRAND`, and the reason is
 * the check script.** A `check:*` runs the SHIPPING module under
 * `node --experimental-strip-types`, which resolves no `@/` alias — so one
 * value import through the alias makes this whole file unloadable and
 * `check:favbackup` dies at startup with `ERR_MODULE_NOT_FOUND`, exactly as
 * CLAUDE.md records for `lib/util.ts`. The caller passes `BRAND.domain`; the
 * rule that turns a domain into a filename stays here, where it is pinned.
 */
export function favoritesBackupFilename(event: Event, domain: string): string {
  const site = domain.split('.')[0];
  const d = new Date(event.created_at * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${site}-favorites-${stamp}-${event.id.slice(0, 8)}.json`;
}

/**
 * What to say on screen after a successful download.
 *
 * The file is the bare event, so anything the user should know about it has to
 * be said HERE — there is no note field any more, on purpose. Two things are
 * worth saying and neither is visible in the JSON at a glance: how many
 * favorites it holds, and that a private half is stored encrypted and stays
 * that way in the file. The second matters because a private list looks EMPTY
 * in a raw event: its entries are ciphertext in `content` and the tag list is
 * short or bare.
 *
 * **`entryCount` is passed in because counting `i` tags HERE was wrong.** This
 * read `event.tags.filter((t) => t[0] === 'i').length`, and in this wire format
 * an `i` tag is either a favorite or a **placement group** — a parent feed
 * opened only because a track under it was favorited. So the sentence
 * overstated the file, by 161 on the account `lib/favorites-audit.ts` was
 * built against: 217 tags over 56 albums. A count the user cannot reconcile
 * with the `N SAVED` on the same page is worse than no count, because the one
 * thing a backup has to be is believable.
 *
 * `favoriteIds(parseFavoritesList(event.tags)).length` is the number, and
 * `⇧ RESTORE FROM BACKUP` already computed it that way. Taking it as an
 * argument is also what keeps this file loadable under plain Node — see
 * `favoritesBackupFilename`.
 */
export function backupSummary(event: Event, entryCount: number): string {
  const entries = entryCount;
  const noun = entries === 1 ? 'entry' : 'entries';
  const encrypted = event.content.length > 0;
  const base = `saved ${entries} public ${noun}`;
  return encrypted
    ? `${base}, plus a private half that stays encrypted in the file`
    : base;
}

// ---------------------------------------------------------------------------
// Reading a backup file back in
// ---------------------------------------------------------------------------

export type BackupParse =
  | { ok: true; event: Event }
  | { ok: false; error: string };

/**
 * Turn a chosen file into an event we are willing to republish, or a reason.
 *
 * **Every check here is a refusal to publish something under the user's key
 * that they did not sign.** A restore writes the whole kind:10333 event, so a
 * file that is wrong in any of these ways would replace a real list with
 * someone else's, or with an edited one:
 *
 *  - **`verifyEvent`** is the load-bearing one. It proves the bytes are a
 *    genuine signed event and that nothing in `tags` or `content` was altered
 *    after it was written. A backup edited in a text editor — even to "fix"
 *    something — fails here, which is correct: the whole value of the file is
 *    that it is the event, and an edited one is a new list wearing an old
 *    signature.
 *  - **The pubkey must be the signed-in account's.** Restoring another
 *    person's list under your key is not a recoverable mistake: it replaces
 *    yours wholesale and publishes theirs as yours to every relay.
 *  - **The kind must be 10333.** The other backups this app can write
 *    (wallets, settings) are addressable events at the same pubkey, and
 *    publishing one of those as a favorites list destroys both.
 *
 * It deliberately does NOT check `created_at` against what is on the relays.
 * Restoring an older list over a newer one is the entire point of the feature;
 * whether that is wanted is the confirmation's question, not the parser's.
 */
export function parseFavoritesBackup(text: string, expectPubkey: string): BackupParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'that file is not JSON' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'that file does not hold a Nostr event' };
  }
  const e = raw as Partial<Event>;
  if (typeof e.id !== 'string' || typeof e.sig !== 'string' || typeof e.pubkey !== 'string'
    || typeof e.created_at !== 'number' || typeof e.kind !== 'number'
    || typeof e.content !== 'string' || !Array.isArray(e.tags)) {
    return { ok: false, error: 'that file is missing fields a Nostr event must have' };
  }
  if (e.kind !== FAVORITES_BACKUP_KIND) {
    return { ok: false, error: `that is a kind:${e.kind} event, not a favorites list` };
  }
  if (e.pubkey !== expectPubkey) {
    return { ok: false, error: 'that backup belongs to a different Nostr account' };
  }
  if (!e.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'))) {
    return { ok: false, error: 'that file\'s tags are malformed' };
  }
  const event = raw as Event;
  if (!verifyEvent(event)) {
    return { ok: false, error: 'that backup\'s signature does not verify — it was edited, or it is not a real event' };
  }
  return { ok: true, event };
}

/** The kind a favorites backup must be. Named so the parser cannot drift. */
export const FAVORITES_BACKUP_KIND = 10333;
