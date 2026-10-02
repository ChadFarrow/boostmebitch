/**
 * The episode LIKE: the NIP-25 kind:17 this app publishes, the NIP-09 kind:5
 * that takes it back, and how a read of both becomes a number.
 *
 * **Fountain's shape IS the format.** NIP-25 says a reaction to anything that
 * is not a Nostr event MUST be kind:17 with NIP-73 `k` + `i` tags; Fountain
 * shipped exactly that for episodes, and on 2026-10-02 every podcast kind:17 on
 * the default relays was Fountain's — content `+`, item `k`/`i` then show
 * `k`/`i`. A like written in any other shape is one Fountain does not count.
 *
 * **IMPORT-FREE, and it must stay that way** — `check:likes` loads it under
 * plain Node and `scripts/import-free.mjs` enforces it. That is why the NIP-73
 * prefixes are spelled here rather than imported from `favorites-list.ts`.
 * The I/O half is `likes.ts`. → docs/nostr.md, "Episode likes".
 */

/** NIP-25: a reaction to EXTERNAL content. A kind:7 reacts to a Nostr event. */
export const EXTERNAL_REACTION_KIND = 17;
/** NIP-09 deletion request. */
export const DELETION_KIND = 5;

/**
 * The read's `limit`, and the size at which the answer stops being whole.
 * relay.fountain.fm — which holds nearly every like — returned exactly 500 to
 * a `limit: 2000` filter on 2026-10-02, so asking for more buys nothing.
 */
export const LIKE_READ_LIMIT = 500;

const ITEM_PREFIX = 'podcast:item:guid:';
const SHOW_PREFIX = 'podcast:guid:';

/** The NIP-73 identifier a like of this episode is filed under. */
export function itemLikeTarget(itemGuid: string): string {
  return `${ITEM_PREFIX}${itemGuid}`;
}

/** NIP-25: "`+` or an empty string" is a like. `-` is a dislike, and an emoji
 *  is a reaction to show, not a vote to count. */
export function isLikeContent(content: string): boolean {
  return content === '+' || content === '';
}

export interface LikeTarget {
  itemGuid: string;
  /** The item's PARENT feed — never a playlist that merely lists it. */
  feedGuid: string;
  /** NIP-73 URL hints. Absent means a two-element `i` tag, never an empty third. */
  itemHint?: string | null;
  showHint?: string | null;
}

function iTag(id: string, hint: string | null | undefined): string[] {
  return hint ? ['i', id, hint] : ['i', id];
}

/**
 * The tags of a like, in Fountain's order. The caller adds `client`.
 *
 * Both guids are required. Without the item there is nothing to like, and
 * without the feed the like is missing the show tag every Fountain like carries.
 */
export function likeTags(t: LikeTarget): string[][] {
  if (!t.itemGuid) throw new Error('like: no item guid');
  if (!t.feedGuid) throw new Error('like: no feed guid');
  return [
    ['k', 'podcast:item:guid'],
    iTag(itemLikeTarget(t.itemGuid), t.itemHint),
    ['k', 'podcast:guid'],
    iTag(`${SHOW_PREFIX}${t.feedGuid}`, t.showHint),
  ];
}

/**
 * The tags of an UNLIKE: a NIP-09 deletion of `likeIds`.
 *
 * **The item `i` tag is the point.** The read is a `#i` filter, and a bare
 * deletion — `e` + `k` only — never matches it, so on a relay that keeps
 * deleted events the like reads back on the next load and the tile turns
 * itself back on. Another app already writes `e`, `k:17` and `i` on the one
 * real kind:17 deletion found on the default relays ("vote retracted").
 */
export function unlikeTags(likeIds: readonly string[], itemGuid: string): string[][] {
  if (likeIds.length === 0) throw new Error('unlike: no like to delete');
  if (!itemGuid) throw new Error('unlike: no item guid');
  return [
    ...likeIds.map((id) => ['e', id]),
    ['k', String(EXTERNAL_REACTION_KIND)],
    ['i', itemLikeTarget(itemGuid)],
  ];
}

/** The fields the tally reads — a nostr-tools `Event` satisfies it. */
export interface LikeWireEvent {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  tags: string[][];
}

/** The like names a show, and not `show`. Naming none proves nothing. */
function filedUnderAnotherShow(e: LikeWireEvent, show: string | null): boolean {
  if (!show) return false;
  const shows = e.tags.filter((t) => t[0] === 'i' && typeof t[1] === 'string' && t[1].startsWith(SHOW_PREFIX));
  return shows.length > 0 && !shows.some((t) => t[1] === show);
}

export interface LikeTally {
  /** People, not events: Fountain publishes each like twice. */
  count: number;
  /** The viewer's STANDING likes of this episode ON THIS SHOW, in read order —
   *  every one, so an unlike deletes a double publish whole. Empty when the
   *  viewer has none in hand. */
  viewerLikeIds: string[];
  /** The read filled `limit`, so `count` is a lower bound. */
  capped: boolean;
}

/**
 * Count the people who like `itemGuid`, from one read of kind:17 + kind:5.
 *
 * - **People, not events.** One author's two likes are one like.
 * - **A deletion counts only from the like's own author.** A relay that
 *   ignores NIP-09 hands every reader every kind:5, so honoring one blindly
 *   lets anybody un-like anybody.
 * - **The filter is a request.** A relay may send another episode's like, or a
 *   kind:7; each is checked here rather than trusted.
 * - A like is `+` or `''`.
 * - **A like filed under ANOTHER show is not the viewer's to take back.** Item
 *   guids are not unique across feeds (`1`, `ep-1`), so the `#i` read can hand
 *   back the viewer's like of the same guid on a different show. Offering it
 *   would light the tile on a show they never liked, and an unlike would delete
 *   their like there. Given `feedGuid`, a like whose `podcast:guid:` tags name
 *   only other feeds is left out of `viewerLikeIds`; one naming no show at all
 *   stays in. The COUNT is not narrowed: it is filed the way Fountain files it.
 */
export function tallyLikes(
  events: readonly LikeWireEvent[],
  itemGuid: string,
  viewer: string | null,
  feedGuid: string | null = null,
  limit: number = LIKE_READ_LIMIT,
): LikeTally {
  const target = itemLikeTarget(itemGuid);
  const show = feedGuid ? `${SHOW_PREFIX}${feedGuid}` : null;
  // `${pubkey}:${id}` — what an author may delete is their own event, so the
  // key carries both halves of that rule.
  const deleted = new Set<string>();
  for (const e of events) {
    if (e.kind !== DELETION_KIND) continue;
    for (const t of e.tags) {
      if (t[0] === 'e' && typeof t[1] === 'string') deleted.add(`${e.pubkey}:${t[1]}`);
    }
  }
  const people = new Set<string>();
  const viewerLikeIds: string[] = [];
  for (const e of events) {
    if (e.kind !== EXTERNAL_REACTION_KIND) continue;
    if (!isLikeContent(e.content)) continue;
    if (!e.tags.some((t) => t[0] === 'i' && t[1] === target)) continue;
    if (deleted.has(`${e.pubkey}:${e.id}`)) continue;
    people.add(e.pubkey);
    if (viewer !== null && e.pubkey === viewer && !filedUnderAnotherShow(e, show)) viewerLikeIds.push(e.id);
  }
  return { count: people.size, viewerLikeIds, capped: events.length >= limit };
}
