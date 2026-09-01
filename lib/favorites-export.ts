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
import type { Event } from 'nostr-tools';
import { BRAND } from '@/lib/brand';
import type { FavoritesPrivacy } from '@/lib/nostr/favorites-list';

export interface BackupReadState {
  /** The relay read may be believed. See `readIsTrustworthy`. */
  trustworthy: boolean;
  /** An event was found. */
  exists: boolean;
  /** Where this account's favorites go. `null` means never chosen. */
  mode: FavoritesPrivacy | null;
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
 * The site name is the first label of `BRAND.domain`, so the two deploys write
 * distinguishable files and neither hard-codes the other's word.
 */
export function favoritesBackupFilename(event: Event): string {
  const site = BRAND.domain.split('.')[0];
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
 */
export function backupSummary(event: Event): string {
  const entries = event.tags.filter((t) => t[0] === 'i').length;
  const noun = entries === 1 ? 'entry' : 'entries';
  const encrypted = event.content.length > 0;
  const base = `saved ${entries} public ${noun}`;
  return encrypted
    ? `${base}, plus a private half that stays encrypted in the file`
    : base;
}
