/**
 * NIP-09 deletion requests against the notes a feed renders.
 *
 * A relay that honors NIP-09 drops a note once its author publishes a kind:5
 * naming it. Many do not, so the feed reads the kind:5 events itself and takes
 * the note off screen. Two rules, each a way to get it wrong:
 *
 * - **A deletion counts only from the note's own author.** A kind:5 is a signed
 *   event anyone can publish naming any id, and a relay that ignores NIP-09
 *   hands it to every reader. Honoring it blindly lets one stranger take any
 *   boost off every feed. Same rule as `tallyLikes` and the read index's
 *   `deletion_requests`.
 * - **A deleted reply takes its subtree with it.** The replies under it hang off
 *   a parent that is no longer rendered; `assembleFromBundle` drops a reply
 *   whose parent is outside the bundle for the same reason, rather than
 *   promoting it to the top level.
 *
 * Only `e` tags. An `a` tag addresses a replaceable event, and no note this
 * applies to is one.
 *
 * IMPORT-FREE on purpose (`scripts/import-free.mjs`), so `check:deletions` loads
 * this exact module under plain Node.
 */

/** NIP-09 deletion request. The same number as `DELETION_KIND` in
 *  `like-tally.ts`, restated because this leaf may import nothing. */
export const NOTE_DELETION_KIND = 5;

/** The fields of a kind:5 this reads. A nostr-tools `Event` satisfies it. */
export interface DeletionRequest {
  kind: number;
  pubkey: string;
  tags: string[][];
}

/** The fields of a note this reads. */
export interface NoteRef {
  id: string;
  pubkey: string;
}

/** The ids in `notes` that their OWN author asked to delete. */
export function deletedNoteIds(
  deletions: readonly DeletionRequest[],
  notes: readonly NoteRef[],
): Set<string> {
  const asked = new Set<string>();
  for (const d of deletions) {
    if (d.kind !== NOTE_DELETION_KIND) continue;
    for (const t of d.tags) {
      if (t[0] === 'e' && typeof t[1] === 'string') asked.add(`${d.pubkey}:${t[1]}`);
    }
  }
  const out = new Set<string>();
  if (!asked.size) return out;
  for (const n of notes) if (asked.has(`${n.pubkey}:${n.id}`)) out.add(n.id);
  return out;
}

/**
 * `notes` without the deleted ones, at every depth, and without the replies
 * under a deleted one.
 *
 * Returns the SAME array, and the same objects, where nothing under them
 * changed: `<NoteCard>` is memoized, and a fresh object per note would
 * re-render the whole feed for a deletion that touched none of it.
 */
export function withoutDeleted<T extends { id: string; replies: T[] }>(
  notes: T[],
  deleted: ReadonlySet<string>,
): T[] {
  if (!deleted.size) return notes;
  let changed = false;
  const out: T[] = [];
  for (const n of notes) {
    if (deleted.has(n.id)) { changed = true; continue; }
    const replies = withoutDeleted(n.replies, deleted);
    if (replies !== n.replies) { changed = true; out.push({ ...n, replies }); }
    else out.push(n);
  }
  return changed ? out : notes;
}
