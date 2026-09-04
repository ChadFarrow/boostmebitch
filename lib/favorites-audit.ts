/**
 * What the two halves of the kind:10333 list actually hold, compared.
 *
 * Pure and read-only: it counts identifiers and answers no question about what
 * to do next. The decrypt, the signer prompt and the rendering live in
 * `components/favorites-page.tsx`.
 *
 * **Why this exists.** A list can hold entries in the plaintext `i` tags and in
 * the encrypted `content` AT THE SAME TIME — nothing in the format forbids it,
 * and three ordinary routes lead there: another app wrote the private half, or
 * a mode switch ran on a device whose baseline claimed nothing and therefore
 * copied instead of moving, or the account changed mode twice. From the app's
 * own screens that state is invisible: the public half renders, the private
 * half is carried byte for byte, and nothing counts either.
 *
 * It matters because the decision it informs is expensive. Switching to
 * Private moves entries the device's baseline claims and copies the rest, so
 * "is my list already in both halves" decides whether a switch tidies the list
 * or doubles it. Guessing costs a publish to a shared replaceable event.
 *
 * **A group WITH items is not a favorite.** A group is opened for every parent
 * of a favorited track, so only an ITEMLESS one is an album or show the user
 * chose — the same rule `hydrateFavorites` applies when it paints. Counting
 * every `podcast:guid:` tag as a favorite would have reported 217 albums to a
 * user who has 56, and would then have overstated the overlap between the
 * halves by the same 161.
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

export interface HalfAudit {
  /** Favorites in the plaintext tags. */
  publicCount: number;
  /** Favorites in the decrypted `content`. */
  privateCount: number;
  /** Identifiers present in BOTH halves — the stored-twice number. */
  inBoth: number;
  publicOnly: number;
  privateOnly: number;
  /**
   * Public `podcast:guid:` groups that exist only to hold items.
   *
   * Reported because they are the difference between the tag count a person
   * sees in a raw event and the number of favorites the app shows them, and
   * that gap is otherwise inexplicable — 161 against 56 on the account this
   * was built for.
   */
  publicPlacementGroups: number;
  /**
   * The private-only entries themselves, in wire order.
   *
   * A count alone cannot be acted on. "3 entries exist only in the encrypted
   * half" leaves a user with no way to tell a favorite they deleted from one
   * another app wrote, and that difference is what decides whether the half is
   * safe to retire. Only these are listed: the overlap is by definition
   * already visible on the page.
   */
  privateOnlyEntries: PrivateOnlyEntry[];
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

/** Just the identifiers, for the set arithmetic. */
export function favoriteIds(list: ParsedList): string[] {
  return favoriteEntries(list).map((e) => e.id);
}

/** Groups that carry items, and so name a parent rather than a favorite. */
export function placementGroups(list: ParsedList): number {
  return list.nodes.filter((n) => n.t === 'group' && n.group.itemGuids.length > 0).length;
}

/**
 * Compare the halves.
 *
 * Sets, not arrays: a half may legitimately name an id twice (two writers'
 * groups for one feed survive a merge), and counting that as two favorites
 * would inflate every number here.
 */
export function auditHalves(publicList: ParsedList, privateList: ParsedList): HalfAudit {
  const pub = new Set(favoriteIds(publicList));
  const privEntries = favoriteEntries(privateList);
  const priv = new Set(privEntries.map((e) => e.id));
  let inBoth = 0;
  for (const id of priv) if (pub.has(id)) inBoth += 1;
  // Deduped by id as well: a half may name one entry twice when two writers'
  // groups for a feed both survive a merge, and listing it twice would make
  // the rows disagree with the count above them.
  const seen = new Set<string>();
  const privateOnlyEntries = privEntries.filter((e) => {
    if (pub.has(e.id) || seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  return {
    publicCount: pub.size,
    privateCount: priv.size,
    inBoth,
    publicOnly: pub.size - inBoth,
    privateOnly: priv.size - inBoth,
    publicPlacementGroups: placementGroups(publicList),
    privateOnlyEntries,
  };
}

/**
 * The finding, in sentences.
 *
 * Separate from the arithmetic so the numbers can be checked without reading
 * prose, and so every branch is visible in one place. Each says what is true
 * and what it means for a switch to Private — which is the decision this
 * whole control exists to inform.
 *
 * **One word for one thing: the halves are PUBLIC and PRIVATE here, never
 * "plaintext tags" and "encrypted half".** Those are the wire's names and they
 * are correct, but the segmented control directly above this panel says PUBLIC
 * / PRIVATE / NOT ON NOSTR, and a finding that answers in a second vocabulary
 * leaves the reader working out whether "encrypted half" is the same thing as
 * the Private setting they can see. It is. The mechanism is named once, in the
 * control's own title text, and nowhere else.
 */
export function auditSummary(audit: HalfAudit, mode?: string): string[] {
  const lines: string[] = [];
  // Noun AND verb, because a count of one is the ordinary case here and
  // "1 entry sit in both halves" is the kind of wrong that makes a reader
  // distrust the number beside it.
  const s = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const verb = (n: number, singular: string, plural: string) => (n === 1 ? singular : plural);

  if (audit.privateCount === 0) {
    lines.push(`No private favorites. All ${s(audit.publicCount, 'favorite')} on the relays are public, readable by anyone.`);
    return lines;
  }

  lines.push(`Public: ${s(audit.publicCount, 'favorite')}. Private: ${s(audit.privateCount, 'favorite')}.`);

  if (audit.inBoth > 0) {
    lines.push(`${s(audit.inBoth, 'entry', 'entries')} ${verb(audit.inBoth, 'sits', 'sit')} in BOTH halves — already public, and stored privately a second time.`);
  }
  if (audit.privateOnly > 0) {
    // The mode is READ, never assumed. This sentence hardcoded "set to Public"
    // and was printed to a user whose whole list had just moved into the
    // encrypted half — telling them their setting was the thing it was not.
    // Absent means never chosen, which is its own answer and not 'public'.
    const where = mode === 'private'
      ? 'They are hidden until this device claims them.'
      : mode
        ? `Nothing in this app shows ${verb(audit.privateOnly, 'it', 'them')} while your favorites are set to ${mode === 'off' ? 'Not on Nostr' : 'Public'}.`
        : `Nothing in this app shows ${verb(audit.privateOnly, 'it', 'them')} until this account's favorites setting is chosen.`;
    lines.push(`${s(audit.privateOnly, 'entry', 'entries')} ${verb(audit.privateOnly, 'exists', 'exist')} only in the private half. ${where}`);
  }
  if (audit.inBoth > 0 && audit.privateOnly === 0) {
    lines.push('So the private half is a duplicate of entries you already publish in the clear. Switching to Private would hide them from now on; it cannot retract what the relays already served.');
  }
  return lines;
}
