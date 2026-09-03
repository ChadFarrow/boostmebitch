/**
 * Which identifiers a kind:10333 list actually claims as favorites.
 *
 * Pure and read-only: it reads a `ParsedList` and answers no question about
 * what to do next. Everything that decrypts, prompts a signer or renders lives
 * in `components/favorites-page.tsx`.
 *
 * **A group WITH items is not a favorite, and that is the whole reason this
 * file exists.** A group is opened for every parent of a favorited track, so
 * only an ITEMLESS one is an album or show the user chose — the same rule
 * `hydrateFavorites` applies when it paints. `list.nodes.length`, or a raw
 * count of `i` tags, is therefore NOT the number of favorites: on the account
 * this was built for, counting every `podcast:guid:` tag reported **217 albums
 * to a user who has 56**.
 *
 * That gap is why both backup controls come through here rather than counting
 * tags themselves. `⇩ BACKUP` states how many entries the file holds and
 * `⇧ RESTORE FROM BACKUP` states how many are about to replace how many — and
 * a number a user can compare against the `N SAVED` on the same page is the
 * only thing that makes either statement checkable.
 *
 * **This file used to compare the two halves as well.** `auditHalves`,
 * `auditSummary`, `placementGroups` and `HalfAudit` served `⌕ CHECK PRIVATE
 * HALF` and `⇄ MERGE ENCRYPTED HALF IN`, both removed on 2026-09-03; see
 * "Removed" in [`docs/ui.md`](../docs/ui.md). The state they detected — a list
 * holding entries in the plaintext tags and the encrypted `content` at once —
 * is not prevented by anything, so that section is kept rather than deleted.
 */
import type { ParsedList } from '@/lib/nostr/favorites-list';

/**
 * One entry that exists in the encrypted half and nowhere else.
 *
 * `parentFeedGuid` comes from the group the item sits under IN THE PRIVATE
 * HALF, and it is the only way these can ever be named: Podcast Index resolves
 * an item by `(podcastguid, guid)` and the wire records the parent as
 * ADJACENCY, not as a field. Take it from the public half and an entry that is
 * private-only by definition has no parent there to take.
 */
export interface PrivateOnlyEntry {
  /** Full NIP-73 identifier, as the wire carries it. */
  id: string;
  kind: 'feed' | 'item';
  guid: string;
  /** Present for an item whose private-half group named a parent. */
  parentFeedGuid?: string;
  /**
   * `<podcast:medium>` as the half's own `medium` block declared it.
   *
   * Carried because for an entry Podcast Index cannot resolve it is the ONLY
   * description that will ever exist, and an entry adopted out of the private
   * half without it becomes a bare guid in a bucket labelled "medium unknown".
   */
  medium?: string;
}

/**
 * The identifiers one half claims as favorites, in wire order.
 *
 * Loose nodes are included: a loose entry is a real entry on the list, either
 * ours (a favorite whose parent feed we never learned) or another writer's.
 * Excluding them would undercount a half whose writer groups differently.
 */
export function favoriteEntries(list: ParsedList): PrivateOnlyEntry[] {
  const out: PrivateOnlyEntry[] = [];
  for (const node of list.nodes) {
    if (node.t === 'loose') {
      const id = node.loose.tag[1];
      // A loose node's identifier kind is whatever its writer used, so it is
      // classified by its prefix rather than assumed. Anything unrecognized is
      // still listed — it is on the list — and simply cannot be resolved.
      if (id) {
        const medium = node.loose.medium;
        out.push(id.startsWith('podcast:item:guid:')
          ? { id, kind: 'item', guid: id.slice(18), medium }
          : { id, kind: 'feed', guid: id.replace(/^podcast:guid:/, ''), medium });
      }
      continue;
    }
    const { feedGuid, itemGuids, medium } = node.group;
    if (itemGuids.length === 0) {
      out.push({ id: `podcast:guid:${feedGuid}`, kind: 'feed', guid: feedGuid, medium });
      continue;
    }
    for (const guid of itemGuids) {
      out.push({
        id: `podcast:item:guid:${guid}`, kind: 'item', guid, parentFeedGuid: feedGuid, medium,
      });
    }
  }
  return out;
}

/** Just the identifiers. `favoriteIds(list).length` is the favorite COUNT. */
export function favoriteIds(list: ParsedList): string[] {
  return favoriteEntries(list).map((e) => e.id);
}
