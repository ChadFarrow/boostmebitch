// ---------------------------------------------------------------------------
// Cross-app podcast favorites — the wire format and the merge.
//
// DELIBERATELY IMPORT-FREE. `scripts/check-favsync.mjs` loads this module
// directly under plain Node (`node --experimental-strip-types`) to pin the real
// thing; every import here — even a type-only one, since the relative
// specifiers in this repo carry no extension — would break that. A
// reimplemented copy in the check script would stay green while the shipping
// format drifted, which is the exact failure being guarded. Same arrangement as
// `read-trust.ts`.
//
// The format is specified OUTSIDE this repo, so neither implementing app owns
// it: github.com/ChadFarrow/PC20-Nostr/blob/main/pc20-favorites.md. A format
// change is a PR there before it is a commit here.
//
// ONE plain (non-`d`-tagged) replaceable event at kind 10333, so there is
// exactly one per pubkey and republishing replaces it wholesale.
//
// AN `i` TAG IS `['i', feedId, itemId]`, AND POSITION 2 IS OPTIONAL. Four
// shapes are on the wire and a reader must accept all four:
//
//   ['i','podcast:guid:F']                            a feed favorite
//   ['i','podcast:guid:F','podcast:item:guid:X']      item X of feed F
//   ['i','podcast:item:guid:X']                       LEGACY item; its feed is
//                                                     the entry above it
//   ['i','podcast:publisher:guid:P']                  an artist; no feed
//
// The element count is the whole difference between a feed favorite and an item
// favorite — their position 1 is byte-for-byte the same string — so an entry is
// told apart BY LENGTH, never by position 1. Branch on position 1 alone and one
// saved episode reads as a followed show. An entry's kind is likewise the kind
// of its LAST identifier (`entryKind`), or `podcast:item:guid` never reaches
// the `k` tags and `#k` discovery stops finding item favorites.
//
// WHAT IS STILL POSITIONAL, AND WHAT IS NO LONGER.
//
// `['medium', v]` is still a running value applying to every entry after it, so
// the parsed model here stays an ORDERED NODE LIST rather than the maps this app
// renders from, and `tagsFromList` walks `nodes` in place instead of iterating a
// Map. A LEGACY two-element item is still positional too — it belongs to the
// most recently opened feed group — and that path is mandatory, not a courtesy:
// every list in production is full of them, and dropping it does not lose a
// label, it makes every item favorite already published unresolvable. An item
// guid is unique only inside its feed, so an item stripped of its feed cannot be
// looked up by anybody, ever.
//
// CARRY THE WHOLE TAG, NEVER REBUILD IT. A node records the `i` tag it was read
// from and emits that tag back verbatim. Rebuilding an entry as `['i', id]`
// type-checks, renders correctly, and strips every item on the list of half its
// address — and position 3 is undefined, which is exactly where a writer newer
// than us will put the next thing.
//
// TAG ORDER INSIDE A `medium` RUN IS PRESCRIBED, NOT PRESERVED. Four bands:
// items naming no feed, artists, feeds, then items grouped by the feed they
// name. Within a band the read order stands and a new entry lands at the END of
// its band. Preserving only converges if EVERY writer preserves; a prescribed
// order converges even against a writer that does not sort, which is what ended
// three weeks of two apps rewriting this event at each other in production.
// Sorting is safe at all only because an entry names its own feed.
//
// THIS APP IS AT STAGE 2 + 4 OF THE MIGRATION. It reads and writes the
// three-element form, rewrites a legacy item once (the identifier MOVES to
// position 2; reading the result back changes nothing), claims the (feed, item)
// PAIR in its baseline, and bands each run. **Stage 3 is deliberately not
// done**: a placement feed entry already on the wire is still carried, so a feed
// entry this device wrote before the migration is not retracted. It stops
// writing NEW ones, because an item now names its own feed and needs no group
// above it.
//
// A READER STILL ON STAGE 0 MISREADS EVERY ITEM ENTRY WE WRITE — it takes
// `podcast:guid:F` at position 1 and shows a followed show where one saved
// episode was meant. That is a deploy-order dependency, not a code one. See
// `pc20-favorites-feed-guid-migration.md` in the spec repo.
// ---------------------------------------------------------------------------

export const FAVORITES_KIND = 10333;

/** NIP-31 label. We always emit our own — see `parseFavoritesList`. */
export const LIST_ALT = 'PC 2.0 Favorites';

/**
 * Where this device puts the favorites it owns.
 *
 *   'public'  — plaintext `i` tags on the event. What every list is today.
 *   'private' — a NIP-44 encrypted-to-self tag array in `content`.
 *   'off'     — this device only. No read, no publish, nothing on a relay.
 *
 * ONE choice for the whole list, not one per entry. The spec permits a per-entry
 * split and this app deliberately does not offer one: the half we are NOT using
 * is still read, merged and carried, so another app's entries survive either
 * way, and a single choice is the difference between two merges and 2N of them.
 */
export type FavoritesPrivacy = 'public' | 'private' | 'off';

/**
 * THE PRIVATE HALF IS ON. Every writer of this list now carries `content`.
 *
 * `i` is a single-letter tag, so relays index it and a `#i` filter answers
 * "which pubkeys favorited this feed" — the public list is searchable in
 * reverse, not merely readable by someone who already has the pubkey. That is
 * the whole reason a private half exists.
 *
 * The condition this waited on has been met. Rule 4 ("carry what you can't
 * read") covered TAGS and said nothing about `content`, so a conforming writer
 * that had never heard of a private half republished the empty string the
 * format has specified from the start, erasing every private entry — silently,
 * on someone else's device, with no undo, while behaving correctly by the
 * document it was written against. The spec now states the carry rule for
 * `content` explicitly (PC20-Nostr#23), and StableKraft ships it
 * (ChadFarrow/stablekraft-app#225, in production).
 *
 * Turned on 2026-08-26, and not a moment early: StableKraft's list was already
 * private when this flipped, 436 entries of encrypted `content` sitting on the
 * relays that the previous value of this constant would have blanked on the
 * next favorite anyone toggled here.
 *
 * `privateFavoritesEnabled()` in `lib/nostr/favorites-sync.ts` ORs in a
 * per-device opt-in; the constant is here rather than there because this module
 * is the one a check script can load.
 */
export const PRIVATE_FAVORITES_ENABLED = true;

/**
 * Plaintext ceiling for the private half, in UTF-8 bytes.
 *
 * NIP-44 v2 as originally published capped plaintext at 65535 bytes. The
 * current text allows 2^32-1 and switches to a 6-byte length prefix at 65536,
 * so a library built to the older text REJECTS a payload across that line —
 * and a private list that cannot be decrypted is indistinguishable from an
 * empty one. Stay under it until signers catch up.
 *
 * The margin below 65536 is for the ciphertext, not for us: NIP-44 pads to a
 * power-of-two chunk and then base64-encodes, so `content` runs about 1.5× the
 * plaintext. 60 KB of entries is roughly 500 favorites.
 */
export const PRIVATE_PLAINTEXT_MAX = 60_000;

export const SHOW_KIND = 'podcast:guid';
export const ITEM_KIND = 'podcast:item:guid';
export const PUBLISHER_KIND = 'podcast:publisher:guid';

export const SHOW_PREFIX = `${SHOW_KIND}:`;
export const ITEM_PREFIX = `${ITEM_KIND}:`;

/**
 * Longest-first, and matched as a table rather than by scanning for the last
 * colon. Item guids are routinely permalink URLs, so "everything before the
 * last colon" on `podcast:item:guid:https://example.com/ep/42` yields
 * `podcast:item:guid:https` — a `k` value no relay filter will ever match,
 * which breaks `#k` discovery without breaking anything visible.
 */
const KNOWN_IDENTIFIER_KINDS = [PUBLISHER_KIND, ITEM_KIND, SHOW_KIND];

/** Tag types this module owns. Anything else belongs to another writer. */
const MANAGED_TAGS = new Set(['alt', 'medium', 'i', 'k', 'visibility']);

/** Which half the WHOLE list lives in. Never a per-entry property. */
export type ListVisibility = 'public' | 'private';

/**
 * The tag naming that half.
 *
 * Multi-letter on purpose: relays index single-letter tags, so a `["v", …]`
 * would let a `#v=private` filter enumerate the pubkeys that keep a private
 * list. It takes no part in grouping — treat it like `k`.
 *
 * It is in {@link MANAGED_TAGS} so a read does NOT carry it as a foreign tag.
 * Carrying it would replay the copy we read AND emit our own, so the event
 * would state the mode twice with the stale one second.
 */
export const VISIBILITY_TAG = 'visibility';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Identifier vocabulary
// ---------------------------------------------------------------------------

export const showId = (feedGuid: string): string => `${SHOW_PREFIX}${feedGuid}`;
export const itemId = (itemGuid: string): string => `${ITEM_PREFIX}${itemGuid}`;

/**
 * The identifier's kind, or null when we have no definition for it.
 *
 * Note this is deliberately laxer than {@link parseShowGuid}: a malformed feed
 * guid like `podcast:guid:920666` (written by old versions of this app) still
 * IS a `podcast:guid` identifier and still earns that `k` tag. It just isn't a
 * feed we can open a group for — see `parseFavoritesList`, where it becomes a
 * loose entry and is carried untouched rather than dropped.
 */
export function identifierKind(id: string): string | null {
  for (const kind of KNOWN_IDENTIFIER_KINDS) {
    if (id.startsWith(`${kind}:`)) return kind;
  }
  return null;
}

/**
 * The baseline claim for ONE item favorite: the pair, never the item guid.
 *
 * An item guid is unique only INSIDE its feed — `<podcast:guid>` is a UUIDv5
 * over the feed URL and globally unique, an item's `<guid>` is neither, which is
 * why Podcast Index refuses `/episodes/byguid` without a feed beside it. So a
 * baseline keyed on the item guid alone cannot tell two items in two feeds
 * apart: take one back and the merge reads the other as ours-and-removed and
 * deletes it, silently, and no other app will restate it.
 *
 * THE FEED COMES FIRST, and that is what makes the encoding safe to split. A
 * feed guid is a UUID and holds no `|`; an item guid is routinely a permalink
 * URL and may hold anything. Read it by splitting on the FIRST separator, never
 * the last.
 *
 * A claim written before this shipped is a bare `podcast:item:guid:…` with no
 * separator in it. {@link claimedItem} accepts both, so an existing baseline
 * keeps working and is rewritten in the paired form by the next publish. That
 * legacy form matches the item under ANY feed, which is exactly the imprecision
 * it always had — it is not made worse by being carried.
 */
const CLAIM_SEP = '|';

export const itemClaim = (itemIdentifier: string, feedGuid: string): string =>
  `${showId(feedGuid)}${CLAIM_SEP}${itemIdentifier}`;

/**
 * Is this claim about an ITEM?
 *
 * A paired claim OPENS with the feed's identifier, so `startsWith('podcast:guid:')`
 * answers "feed" for it and any caller that sorts claims by prefix files every
 * item claim under feeds. `FavoritesBaseline` keeps the two in separate arrays
 * and never has to ask — but anything that flattens the two into one list does,
 * and the conformance contract is exactly that shape.
 */
export const isItemClaim = (claim: string): boolean =>
  claim.includes(CLAIM_SEP) || claim.startsWith(ITEM_PREFIX);

/**
 * Does this set of claims name this (feed, item)?
 *
 * Takes the ITEM'S FULL IDENTIFIER and the BARE feed guid, matching
 * {@link itemClaim} — the two are the same question asked in two directions, so
 * they take the same arguments. Either claim form counts, which is what carries
 * a baseline written before the pair existed.
 */
export const claimedItem = (
  claims: Set<string>,
  itemIdentifier: string,
  feedGuid: string | undefined,
): boolean =>
  (feedGuid !== undefined && claims.has(itemClaim(itemIdentifier, feedGuid)))
  || claims.has(itemIdentifier);

/**
 * The kind an ENTRY declares, which is not always the kind at position 1.
 *
 * The rule is one line: an entry's kind is the kind of its LAST identifier —
 * position 2 when there is one, position 1 otherwise. A three-element
 * `podcast:guid:` entry is an item favorite and declares `podcast:item:guid`,
 * even though position 1 reads `podcast:guid`. Derive it from position 1 alone
 * and `podcast:item:guid` never reaches the event at all, so a `#k` filter stops
 * finding item favorites on every list.
 *
 * Still {@link identifierKind} underneath, so it is a table lookup rather than a
 * string split — and that matters most here, because a URL-shaped item guid is
 * exactly the value most likely to sit at position 2.
 */
export function entryKind(tag: string[]): string | null {
  const id = tag[2] ?? tag[1];
  return id ? identifierKind(id) : null;
}

/**
 * The feed guid inside a `podcast:guid:` identifier, UUID-gated.
 *
 * The gate is load-bearing for idempotence, not decoration. A group can only be
 * emitted as `podcast:guid:<x>`, so if we opened groups for values this
 * function rejects, the very next read would fail to recognise our own output
 * and demote it to a loose entry — the array would never reach a fixed point
 * and two writers would rewrite the event at each other forever. Whatever this
 * rejects must therefore ALSO be rejected by {@link bareFeedGuid}.
 */
export function parseShowGuid(id: string): string | null {
  if (!id.startsWith(SHOW_PREFIX)) return null;
  const guid = id.slice(SHOW_PREFIX.length);
  return UUID_RE.test(guid) ? guid : null;
}

/**
 * The item guid inside a `podcast:item:guid:` identifier. NOT UUID-gated — an
 * RSS `<guid>` is an arbitrary publisher-chosen string. The live list this was
 * written against carries `thenogs-donkey-01-porky-piggin-it` alongside 226
 * UUIDs, and permalink URLs are common elsewhere.
 */
export function parseItemGuid(id: string): string | null {
  if (!id.startsWith(ITEM_PREFIX)) return null;
  const guid = id.slice(ITEM_PREFIX.length);
  return guid.length > 0 ? guid : null;
}

/**
 * A parent-feed reference in either form — bare, or carrying the
 * `podcast:guid:` prefix that the predecessor format wrote at tag position 3 —
 * reduced to the bare guid. UUID-gated for the reason on {@link parseShowGuid}:
 * a parent we can't emit and read back is not a parent we may group under.
 */
export function bareFeedGuid(ref: string | undefined | null): string | undefined {
  if (!ref) return undefined;
  const bare = ref.startsWith(SHOW_PREFIX) ? ref.slice(SHOW_PREFIX.length) : ref;
  return UUID_RE.test(bare) ? bare : undefined;
}

/** Whether a guid is worth spending a Podcast Index lookup on. */
export const looksLikeFeedGuid = (guid: string): boolean => UUID_RE.test(guid);

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** One favorite as this device holds it, before grouping. */
export interface FavoriteEntry {
  /** Full NIP-73 identifier. */
  id: string;
  /** Parent feed for an item, either form. Ignored for a feed entry. */
  feedRef?: string;
  /**
   * `<podcast:medium>` as the feed DECLARED it. Never an app's own default —
   * publishing a guess makes it look authoritative, and a guess on this list is
   * sticky because no other app has any reason to correct it.
   */
  medium?: string;
}

/** A feed group and the LEGACY items beneath it, in wire order. */
export interface FeedGroup {
  feedGuid: string;
  /** undefined means "not told". NEVER defaulted — see `tagsFromList`. */
  medium?: string;
  itemGuids: string[];
  /**
   * The feed's `i` tag AS READ, when this group came off the wire.
   *
   * Emitted back verbatim so anything a newer writer parked past position 1
   * survives us. Absent on a group this device originated, which has nothing to
   * carry and emits the two-element form.
   */
  feedTag?: string[];
  /**
   * Did the user favorite the FEED, as opposed to this group existing only to
   * name some item's parent?
   *
   * Stated by {@link groupLocalFavorites} for a LOCAL group and left unstated
   * everywhere else. **Unstated is treated as favorited**, which is what this
   * module did before the field existed — a group built by hand keeps its old
   * behaviour, and only a grouper that actually knows the answer changes it.
   * Read as `favorited === false`, never as `!favorited`.
   *
   * It exists so a group opened purely to place an item whose tag is already on
   * the wire in three-element form is not emitted as a bare feed entry — which
   * under the current format reads as a feed favorite the user never made.
   */
  favorited?: boolean;
  /**
   * Each legacy item's `i` tag as read, by item guid. Same rule, same reason.
   *
   * Keyed rather than positional because `mergeFavoritesList` splices item guids
   * around — a parallel array would silently pair a tag with another item.
   */
  itemTags?: Record<string, string[]>;
}

/**
 * An item entry that NAMES ITS OWN FEED — the three-element form.
 *
 * It is not a group member: it depends on nothing above it, and moving it
 * changes nothing. This app does not originate one yet (stage 2), so every one
 * of these came off the wire and its `tag` is emitted back byte for byte.
 *
 * It is a separate node variant rather than a `LooseEntry` because we CAN read
 * it: the feed and the item are both known, so it renders, resolves and can be
 * unfavorited. `loose` means "no meaning for this", which is a different claim.
 */
export interface ItemEntry {
  /** Bare feed guid, off position 1 of its OWN tag. Never the entry above. */
  feedGuid: string;
  /** Item guid, off position 2. */
  itemGuid: string;
  medium?: string;
  /** The WHOLE tag as read. Never rebuilt from the two guids. */
  tag: string[];
}

/**
 * An `i` tag we cannot place: an identifier kind outside our table, an item
 * that appeared before any feed group, or a `podcast:guid:` whose guid is
 * malformed.
 *
 * The whole tag is carried, not the identifier, because a writer newer than us
 * may be using NIP-73's third element (the spec's open questions reserve it for
 * a feed-URL fallback). Rebuilding it from the id would delete that on every
 * publish — the same truncation the predecessor format shipped for its entire
 * life, one position over.
 */
export interface LooseEntry {
  tag: string[];
  medium?: string;
}

export type ListNode =
  | { t: 'group'; group: FeedGroup }
  | { t: 'item'; item: ItemEntry }
  | { t: 'loose'; loose: LooseEntry };

export interface ParsedList {
  /** Groups and loose entries, IN READ ORDER. The order is the data. */
  nodes: ListNode[];
  /**
   * The mode the event STATES, or null when it does not.
   *
   * Null is not 'public'. It means the list was written before this tag
   * existed, and the caller falls back to inferring the mode from whichever
   * half holds entries — which answers for every list that has any, and cannot
   * answer at all for one that has none.
   */
  visibility: ListVisibility | null;
  /** Tag types belonging to another writer, replayed verbatim. */
  foreignTags: string[][];
  /** `k` values outside our table — a kind a newer writer emits. */
  foreignKinds: string[];
  /**
   * How many emitted nodes exist because THIS DEVICE holds them.
   *
   * Set by {@link mergeFavoritesList}; absent on a plain parse, where the
   * question has no meaning. It is the only honest input to an "is this merge
   * empty" test, and the difference is not academic — `nodes.length` counts
   * CARRIED entries, which belong to another writer and are fed by no local
   * state at all. A single foreign entry in either half therefore makes a merge
   * built from an EMPTY local list look non-empty, which is exactly the input
   * the wholesale-delete guard exists to refuse.
   */
  localFed?: number;
}

/** This device's favorites, grouped for the wire. */
export interface LocalList {
  groups: FeedGroup[];
  loose: LooseEntry[];
}

/**
 * The identifiers this device last agreed with the relay on, as full NIP-73
 * identifier strings.
 *
 * It answers the one question a SECOND writer must answer and a single writer
 * never faces: an entry on the relay and absent from local state is either
 * something another app added, or something this device just unfavorited.
 * Prefer the relay and unfavoriting silently stops working; prefer local state
 * and you delete the other app's entries. Only a baseline tells them apart.
 *
 * `feeds` records every group this device EMITTED, favorited or opened purely
 * to place an item — the question it answers is "did I write this group", which
 * is what licenses dropping it once its last item is gone. It is emphatically
 * not "did the user favorite this feed"; that lives in the store.
 */
export interface FavoritesBaseline {
  feeds: string[];
  items: string[];
  /**
   * The same two questions for the ENCRYPTED half, and they must be separate
   * from the public ones or a mode switch deletes the list it is moving.
   *
   * Moving an entry from public to private is a removal on one side and an
   * addition on the other. Against a single shared baseline those two steps
   * cancel destructively: the public merge sees "ours, and we no longer hold
   * it" and drops the entry, and the private append pass sees the same id in
   * the baseline and skips it as "another app removed this, don't resurrect
   * it". The entry is gone from both halves, in one publish, with every guard
   * satisfied.
   *
   * Optional, and absent reads as `[]`, so a baseline written before this
   * shipped reads as all-public — which is exactly what it is.
   */
  privateFeeds?: string[];
  privateItems?: string[];
}

export const EMPTY_BASELINE: FavoritesBaseline = { feeds: [], items: [] };

/**
 * The two "nothing here" values, shared so the half a caller is NOT using is
 * spelled the same way everywhere.
 *
 * Under one whole-list choice every cycle passes one of these for the other
 * half, in three modules. Three literals is three chances for one of them to be
 * subtly different — a `nodes: []` with a stray `foreignTags` would silently
 * drop another writer's tags on the half nobody was looking at. Never mutated:
 * `mergeFavoritesList` and `tagsFromList` both build new arrays.
 */
export const EMPTY_LOCAL: LocalList = { groups: [], loose: [] };
export const EMPTY_PARSED: ParsedList = {
  nodes: [],
  visibility: null,
  foreignTags: [],
  foreignKinds: [],
};

/** Which half of the event a list lives in. */
export type ListHalf = 'public' | 'private';

/**
 * One half of a baseline, in the shape {@link mergeFavoritesList} takes.
 *
 * The merge is run once per half and knows nothing about halves; this is what
 * keeps it that way. Reading the wrong half here is the bug the split exists to
 * prevent, so the two callers go through one function.
 */
export function baselineHalf(baseline: FavoritesBaseline, half: ListHalf): FavoritesBaseline {
  if (half === 'public') return { feeds: baseline.feeds, items: baseline.items };
  return { feeds: baseline.privateFeeds ?? [], items: baseline.privateItems ?? [] };
}

/**
 * The baseline this device is asserting across BOTH halves.
 *
 * `baselineFrom` answers the question for one list; this is the pair, and it is
 * what reaches disk. Callers pass the local list they actually published into
 * each half — which, under one whole-list choice, means one of them is empty.
 */
/**
 * Which half an account keeps its favorites in, read off the wire — or null
 * when the wire cannot say.
 *
 * THE AMBIGUOUS CASE IS THE WHOLE POINT, AND IT MUST NOT GUESS. kind:10333 is
 * one shared, multi-writer event, so a single plaintext `i` tag from any other
 * writer — StableKraft, or this user's own second device still on Public —
 * sits happily beside an encrypted half. Nothing makes the two exclusive.
 *
 * Testing `hasPublic` first therefore fails OPEN. A device seeded 'public' over
 * a private account paints the decrypted entries into its store (the app
 * renders the union of both halves), and the next publish emits every one of
 * them as a plaintext `i` tag. `i` is a single-letter tag, so relays index it
 * and a `#i` filter answers *which pubkeys favorited this feed* — the list
 * becomes searchable in reverse, which is exactly the property the private half
 * exists to remove. kind:10333 is replaceable and keeps no history, relays keep
 * what they were sent, and nothing on screen changes. There is no retraction.
 *
 * Seeding the other way round is not symmetrical, so this does not simply
 * reverse the tests: an account that is genuinely public, beside another app's
 * private half, would be moved INTO `content` — no disclosure, but a real edit
 * to a shared event that an app without NIP-44 then reads as an empty list.
 *
 * So each half answers only for itself, and BOTH answers together mean
 * "unknowable from here" — which is a question for the user, not a coin toss.
 * A null mode publishes nothing at all (`requestFavoritesSync`), so the safe
 * state is also the default one.
 */
export function seedModeFromWire(hasPublic: boolean, hasPrivate: boolean): FavoritesPrivacy | null {
  if (hasPublic && hasPrivate) return null;
  if (hasPrivate) return 'private';
  if (hasPublic) return 'public';
  return null;
}

/**
 * A RECORDED mode the wire flatly contradicts, corrected — or null to leave it.
 *
 * `favPrivacy` rides in the kind:30078 settings backup, whose d-tag is
 * deliberately unbranded, so every device and both deploys restore the same
 * value. A stale `'public'` there is therefore not a local slip: it is applied
 * on every sign-in, everywhere, and `seedFavoritesMode` short-circuits on a
 * recorded mode and never asks the wire again.
 *
 * Measured on a real account: 0 public `i` tags, 880 private ones, and a
 * restored `'public'`. In public mode the private half is filtered by
 * `claimedByBaseline`, which on a device with no baseline drops ALL of it — 218
 * feeds and 230 items, to an empty library, with the cycle reporting no error.
 * The original device hides it, because its baseline claims those entries; only
 * a device that has never synced shows the fault.
 *
 * THE CORRECTION IS ONE-WAY, AND THAT ASYMMETRY IS THE SAFETY PROPERTY.
 * `'public'` → `'private'` moves nothing and discloses nothing: it is only
 * reached when the wire holds NO public entries, so there is nothing in
 * plaintext to be wrong about. The reverse is the disclosure this file exists
 * to prevent — a device that decided `'public'` over a private list republishes
 * every entry as an indexed `i` tag, and `#i` then answers *which pubkeys
 * favorited this feed*, permanently. So this never returns `'public'`.
 *
 * `hasPublic` must be FALSE, not merely outnumbered. One plaintext tag from any
 * other writer means the account may genuinely be public, and moving a real
 * public list into `content` is an edit to a shared event that every app
 * without NIP-44 then reads as empty.
 *
 * `'off'` is a deliberate opt-out and is never corrected — the user asked for
 * no sync at all, and the wire has no standing to overrule that.
 *
 * Local only. The caller does not republish the settings backup: that would be
 * an unattended write during hydration, and it is unnecessary — every device
 * applies this same correction off the same wire.
 */
/**
 * The mode this cycle writes, and whether it may say so on the wire.
 *
 * ONE function because the two answers are the same decision. Splitting them
 * is how a writer ends up publishing into one half while the tag names the
 * other, which is the split state stated as a fact.
 *
 * `stated` is the `visibility` tag as read, or null on a list written before
 * it. Null is not 'public': it means the list never said, so the old inference
 * from emptiness still stands and this returns `stored` untouched.
 *
 * THREE RULES, and each one is a thing that went wrong on a real account.
 *
 * 1. **A stated mode outranks a stored preference.** The mode is per-app and
 *    per-device while the event is shared, so two apps can hold opposite
 *    answers; letting whichever loaded last win is how a list of 287 entries
 *    flips halves on a page load with nothing on screen.
 *
 * 2. **Only a real choice may write or change the tag.** Stamping this app's
 *    standing default on a legacy list states a mode nobody picked — and on a
 *    list that already has a private half, that stamp is what would license
 *    disclosing it.
 *
 * 3. **Changing it also requires having read the other half.** A signer with
 *    no NIP-44 cannot move what it cannot see, so declaring the list public
 *    would publish a false claim about someone's privacy that the next writer
 *    converges on. An EMPTY private half is exempt: there is no half to be
 *    blind to, and treating it as opaque would freeze every new account on
 *    such a signer at whatever the first writer guessed.
 *
 * Spec: PC20-Nostr, "The list is public or private, and the event says which".
 */
export function effectiveListMode(input: {
  /** What this app has recorded, or null when the user has not been asked. */
  stored: FavoritesPrivacy | null;
  /** The `visibility` tag as read. */
  stated: ListVisibility | null;
  /** Is the user choosing right now, as opposed to this being the setting? */
  userChose?: boolean;
  /** Could this writer decrypt the private half? */
  canReadPrivate?: boolean;
  /** Is there no private half at all? Then there is nothing to be blind to. */
  privateIsEmpty?: boolean;
}): { mode: FavoritesPrivacy | null; stating: ListVisibility | null } {
  const { stored, stated } = input;
  const mayChange =
    !!input.userChose && (input.canReadPrivate !== false || !!input.privateIsEmpty);

  // Nobody has answered here. Follow the list rather than guessing, and state
  // nothing — adopting a mode is not choosing one.
  if (!stored) return { mode: stated, stating: stated };

  // 'off' is a LOCAL choice and is not on the wire — see the spec's "'Not on
  // Nostr' is a local choice". The tag such a device carries is whatever the
  // list already said; it states nothing of its own.
  if (stored === 'off') return { mode: 'off', stating: stated };

  const mode: ListVisibility = stated && stated !== stored && !mayChange ? stated : stored;

  // Carried forward once the list has a tag; written for the first time only
  // on a real choice.
  return { mode, stating: mayChange || stated ? mode : null };
}

/**
 * State the list's mode on a tag array that is about to become the EVENT.
 *
 * Kept out of `tagsFromList` on purpose. That function builds both halves, and
 * the private half is a tag array inside `content` — a mode stated there is a
 * claim about the list made where no reader may act on it, and this module's
 * own parser drops it. So the tag is added once, to the array that really is
 * the event's, and never to the other one.
 *
 * Inserted after `alt` so the head of the event is stable across republishes;
 * position is not semantic for either tag.
 */
export function withVisibility(
  tags: string[][],
  visibility: ListVisibility | null,
): string[][] {
  if (!visibility) return tags;
  const out = tags.filter((t) => t[0] !== VISIBILITY_TAG);
  const at = out.findIndex((t) => t[0] === 'alt');
  out.splice(at === -1 ? 0 : at + 1, 0, [VISIBILITY_TAG, visibility]);
  return out;
}

/** The mode a raw tag array states, or null. */
/**
 * A tag array put through THIS writer's framing, for the rule 5 comparison.
 *
 * Rule 5 is "publish only when the bytes change", and the trap is that it used
 * to be read literally: compare the merged array against the array as it
 * ARRIVED. **Two conforming events differ byte for byte.** A reader must accept
 * a `k` beside every `i`; a writer must emit one `k` per distinct kind at the
 * end. Both layouts are legal and mean the same list. The position of `alt`, the
 * position of `visibility` and the order of the `k` tags are free the same way.
 * Compare raw and every one of those reports a change on a list nobody touched —
 * and if the other app compares raw too, neither of you ever stops.
 *
 * So both sides go through this first. What it normalises is exactly what
 * carries no meaning:
 *
 *   - `alt` is regenerated (it is a NIP-31 label, and a reader discards it);
 *   - `visibility` is restated in our position;
 *   - `k` tags are dropped and rebuilt from the entries actually present.
 *
 * `medium` is positional and is left exactly where it is, and an entry we cannot
 * parse is passed through untouched — so a genuine difference still shows up as
 * one, and this app's own reordering (unknown-medium first, same-medium
 * contiguous) still publishes once and then settles.
 *
 * **Frame the read with the visibility IT states, never with ours.** Passing our
 * own would make a list that predates the tag differ from itself forever, so
 * every load would republish. A list that genuinely lacks the tag differs once,
 * and that publish is the migration.
 */
export function frameForCompare(
  tags: string[][],
  visibility: ListVisibility | null,
): string[][] {
  const framed: string[][] = [['alt', LIST_ALT]];
  const kinds: string[] = [];
  const foreignKinds: string[] = [];

  for (const tag of tags) {
    const type = tag[0];
    if (type === 'alt' || type === VISIBILITY_TAG) continue;
    if (type === 'k') {
      const value = tag[1];
      if (value && !KNOWN_IDENTIFIER_KINDS.includes(value) && !foreignKinds.includes(value)) {
        foreignKinds.push(value);
      }
      continue;
    }
    framed.push(tag.slice());
    if (type !== 'i' || !tag[1]) continue;
    const kind = entryKind(tag);
    if (kind && !kinds.includes(kind)) kinds.push(kind);
  }

  for (const kind of kinds) framed.push(['k', kind]);
  for (const kind of foreignKinds) {
    if (!kinds.includes(kind)) framed.push(['k', kind]);
  }
  return withVisibility(framed, visibility);
}

export function statedVisibility(tags: string[][]): ListVisibility | null {
  for (const tag of tags) {
    if (tag[0] !== VISIBILITY_TAG) continue;
    if (tag[1] === 'public' || tag[1] === 'private') return tag[1];
  }
  return null;
}

export function correctedModeFromWire(
  recorded: FavoritesPrivacy | null,
  hasPublic: boolean,
  hasPrivate: boolean,
): FavoritesPrivacy | null {
  if (recorded !== 'public') return null;
  if (hasPublic || !hasPrivate) return null;
  return 'private';
}

/**
 * The baseline a published list's GROUPS assert.
 *
 * **Groups only, and deliberately so: what we cannot represent is never
 * claimed.** A loose node is either ours (a favorite whose parent feed we never
 * learned) or another writer's (an identifier kind outside our table), and this
 * function cannot tell them apart — it only sees the merged wire. Claiming a
 * foreign one would hand this device permission to delete another app's entry.
 *
 * The other half of that rule is that OUR loose entries must still be claimed,
 * or they can never be unfavorited. Only the caller knows which are ours, so it
 * unions them in from the local list — see `looseIdsWePublished`.
 */
export function baselineOfList(list: ParsedList | null | undefined): FavoritesBaseline {
  if (!list) return EMPTY_BASELINE;

  // WALKED OFF THE NODE LIST, NOT REGROUPED THROUGH `entriesFromList`. The two
  // agreed until an item could name its own feed, and then they stopped: an
  // `item` node regroups into a group for its parent feed, so the round trip
  // claimed a feed entry THIS DEVICE NEVER WROTE.
  //
  // `feeds` means "did I write this group", and it is what licenses dropping a
  // group whose last item is gone. Claim one we did not write and the next cycle
  // reads another app's feed favorite for it as ours-and-removed and deletes it —
  // two cycles, no error, no undo, on someone else's device. Measured against
  // this module: a wire holding only a three-element item claimed its feed, and
  // the cycle after that took down the feed favorite another app had just added.
  //
  // A group node is a feed tag we emit, placement group included. An item node
  // is not, so it contributes its item and nothing else.
  const feeds: string[] = [];
  const items: string[] = [];
  for (const node of list.nodes) {
    if (node.t === 'item') {
      const id = itemClaim(itemId(node.item.itemGuid), node.item.feedGuid);
      if (!items.includes(id)) items.push(id);
      continue;
    }
    // Loose nodes are excluded here for the same reason `entriesFromList`
    // excludes them — carried, never asserted. `withLoose` in
    // `planFavoritesPublish` restores the ones this device did publish.
    if (node.t !== 'group') continue;
    const feed = showId(node.group.feedGuid);
    if (!feeds.includes(feed)) feeds.push(feed);
    for (const guid of node.group.itemGuids) {
      const id = itemClaim(itemId(guid), node.group.feedGuid);
      if (!items.includes(id)) items.push(id);
    }
  }
  return { feeds, items };
}

/**
 * The loose identifiers THIS DEVICE put on the wire.
 *
 * The intersection is the whole point. `merged` holds every loose node that
 * survived, ours and carried alike; `local` holds only ours. An id in both is
 * one we published and still assert, which is exactly what a baseline records —
 * and leaving it out is not a small loss: `mergeFavoritesList`'s loose-removal
 * test is gated on the baseline, so an unclaimed loose entry is re-emitted on
 * every republish and re-adopted on every hydrate. The heart empties locally and
 * the tag never leaves the relay, on any device, with no error.
 */
export function looseIdsWePublished(merged: ParsedList | null | undefined, local: LocalList): string[] {
  if (!merged) return [];
  const ours = new Set(local.loose.map((l) => l.tag[1]).filter((id): id is string => !!id));
  const out: string[] = [];
  for (const node of merged.nodes) {
    if (node.t !== 'loose') continue;
    const id = node.loose.tag[1];
    if (id && ours.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

export function baselineForHalves(publicLocal: LocalList, privateLocal: LocalList): FavoritesBaseline {
  const pub = baselineFrom(publicLocal);
  const priv = baselineFrom(privateLocal);
  return { feeds: pub.feeds, items: pub.items, privateFeeds: priv.feeds, privateItems: priv.items };
}

/**
 * May this baseline be believed?
 *
 * The baseline is a PROMISE that local state will keep asserting these ids, and
 * it is the only thing that tells a foreign entry from one this device removed.
 * It lives in one localStorage key; the favourites it speaks for live in
 * others. Nothing makes those writes atomic, and they are wildly different
 * sizes — bare ids against hundreds of KB of titles, authors and artwork URLs.
 *
 * So the small one can reach disk while the large one does not. `safeSet` falls
 * back to an in-memory mirror when a write cannot land, and that mirror does not
 * survive a reload. The next load then reads a baseline naming every favourite
 * and a local cache holding none, which satisfies `mergeFavoritesList`'s
 * removal test — *ours, and we no longer hold it* — for all of them at once.
 *
 * A baseline that claims ids while this device holds NOTHING is therefore not
 * evidence of a removal; it is evidence that the pair fell out of step. Refuse
 * it and every entry on the relay reads as another writer's, which is the safe
 * direction: the worst case is that one genuine unfavourite waits for the next
 * cycle, against a device that by definition has no favourites to unfavourite.
 *
 * Deliberately NOT a size comparison. "The baseline names more than we hold" is
 * the ordinary state mid-removal and must stay publishable, so this asks only
 * the one question that has no innocent answer.
 */
export function baselineIsTrustworthy(
  baseline: FavoritesBaseline,
  localHasEntries: boolean,
  deliberatelyEmpty = false,
): boolean {
  // "I unfavorited everything" produces the SAME bytes as an unhydrated store —
  // an empty local set beside a baseline that claims ids — and refusing both is
  // what made deleting a whole list impossible: the removal never published,
  // the cycle then recorded an empty baseline over the real one, and the next
  // reload re-adopted every entry off the relay. Reported from a real account.
  //
  // The two are only separable at the moment of the action, which is why this
  // takes an argument instead of trying to infer it. `storage.favCleared` is
  // written by the store's removers and by nothing else; an unhydrated store
  // never calls one, so a set flag is proof rather than a guess.
  if (deliberatelyEmpty) return true;
  const claimsSomething =
    baseline.feeds.length > 0 ||
    baseline.items.length > 0 ||
    (baseline.privateFeeds?.length ?? 0) > 0 ||
    (baseline.privateItems?.length ?? 0) > 0;
  return !claimsSomething || localHasEntries;
}

/**
 * May a REFUSED read still be painted?
 *
 * `wholesale-delete` answers "do not publish this". It does not, on its own,
 * answer "do not render this", and conflating the two is why the same account
 * on a NEW ORIGIN sees an empty library over a full list. The two deploys are
 * separate origins, so `localStorage` starts empty on the second one; `local`
 * is therefore empty, `localFed` is 0 on both halves, and the planner correctly
 * refuses to publish — but the merge it refused is NOT empty. It carries every
 * relay node. The refusal was withholding a list from the user to protect a
 * device that holds nothing.
 *
 * THE GUARD NEEDS SOMETHING TO PROTECT. All three conditions, and each is a
 * different way to get this wrong:
 *
 * - `cacheHasEntries` false — nothing on disk to destroy. This is the whole
 *   reason painting is safe here: `setFavorites` writes THROUGH to
 *   `localStorage`, and the destructive case the guard exists for is painting
 *   OVER `cached[feed.feedGuid]`, the only record separating a real album
 *   favorite from a group opened to place a track. An empty cache has no such
 *   record to lose.
 * - `baselineClaimsEntries` false — this device has never agreed anything with
 *   the relay. A baseline naming ids beside a cache holding none is the exact
 *   input of the 2026-08-21 wipe, and it must keep refusing. Pass the RAW
 *   stored baseline, not `trustedBaseline`, which has already dropped that
 *   claim and would report the dangerous shape as clean.
 * - `carriedNodes > 0` — there is something to adopt. Painting nothing is the
 *   destructive case itself, so "adopt" over an empty read is the one answer
 *   that must never be yes.
 *
 * Publishing and the baseline are NOT unblocked by this. The caller still
 * publishes nothing and records nothing, so the adoption is one-way: the next
 * cycle sees a populated store, `localFed` is non-zero, and the ordinary path
 * takes over. That is the same adoption `planFavoritesPublish` already
 * describes when it derives the active half from the merge — this only lets a
 * device with no history reach it.
 */
export function mayAdoptRefusedRead(input: {
  cacheHasEntries: boolean;
  baselineClaimsEntries: boolean;
  carriedNodes: number;
}): boolean {
  if (input.cacheHasEntries) return false;
  if (input.baselineClaimsEntries) return false;
  return input.carriedNodes > 0;
}

// ---------------------------------------------------------------------------
// The private half's plaintext
// ---------------------------------------------------------------------------

/**
 * The private entries, as the bytes we hand a signer to encrypt.
 *
 * A stringified tag array, per the spec — the SAME shape as `event.tags`, so
 * the grouping rules apply inside it unchanged and `parseFavoritesList` reads
 * it without knowing which half it came from.
 *
 * The one deviation is the escaping, and it is not cosmetic: `?` is written as
 * its JSON escape `\u003f`.
 *
 * Amber (NIP-55) URL-decodes the WHOLE `nostrsigner:` URI and only then splits
 * it on `?`, so a plaintext carrying one is silently truncated there and the
 * request comes back "Invalid request. Amber received a malformed nostrsigner
 * request." Percent-encoding does not help — the `%3F` we write is what Amber
 * decodes back into the character it splits on. And this payload is FULL of
 * candidates: an RSS `<guid>` is an arbitrary publisher-chosen string and item
 * guids are routinely permalink URLs, which is exactly why `parseItemGuid` is
 * not UUID-gated. One favorited track with a query string in its guid would
 * otherwise make every private publish on Android fail, forever, with a message
 * that reads as "Amber isn't installed".
 *
 * `encodeAmberSafe` (`lib/nostr/amber-safe-text.ts`) is the usual answer and is
 * WRONG here: it would put `bmb1.…` inside the ciphertext, and the other app
 * decrypting this list would find something it has never been told about. This
 * has to stay interoperable, so the escape has to be one every JSON reader
 * already understands — which `\u003f` is. `JSON.parse` gives back the same
 * string, byte for byte, in any implementation.
 *
 * `?` can only ever appear inside a string literal here (every element of every
 * tag is a string, and the structural characters are `[`, `]`, `,` and `"`), so
 * a global replace over the stringified output cannot corrupt the syntax. A `?`
 * preceded by a backslash is preceded by an ESCAPED backslash — `\\` — so the
 * replacement lands after it correctly.
 */
export function encodePrivateFavorites(tags: string[][]): string {
  return JSON.stringify(tags).replace(/\?/g, '\\u003f');
}

/**
 * Read a decrypted private half back into a tag array.
 *
 * Returns null when the plaintext is not an array of tag arrays. Null means
 * "this is not a private favorites list", and the caller MUST treat it the same
 * as a decrypt that failed: park the ciphertext and publish nothing derived
 * from it. `lib/nostr/mutes.ts` has the hole this closes — a `JSON.parse` that
 * succeeds on a non-array leaves the blob marked readable and empty, and the
 * next republish rewrites `content` from those empty lists and destroys it.
 */
export function decodePrivateFavorites(plaintext: string): string[][] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const tags: string[][] = [];
  for (const tag of parsed) {
    if (!Array.isArray(tag)) return null;
    if (!tag.every((v) => typeof v === 'string')) return null;
    tags.push(tag as string[]);
  }
  return tags;
}

/** UTF-8 byte length, which is what the NIP-44 limit counts. */
export function plaintextBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Parse an event's tags into the ordered node list.
 *
 * `k` is ignored entirely and the kind is taken from the identifier at position
 * 1. That is not an optimization — it is what makes the two published layouts
 * the same event. An earlier revision of the spec paired a `k` with every `i`;
 * the current one emits one per distinct kind at the end. A reader that walks
 * `i`/`k` in pairs reads a current-form list as an EMPTY LIBRARY rather than as
 * an error, which is the worst available failure for a format whose writers
 * republish wholesale.
 *
 * `alt` is discarded and re-emitted canonically. It is a NIP-31 rendering hint
 * for clients that have no definition for this kind, not user data.
 */
export function parseFavoritesList(tags: string[][]): ParsedList {
  const nodes: ListNode[] = [];
  const foreignTags: string[][] = [];
  const foreignKinds: string[] = [];
  let visibility: ListVisibility | null = null;
  let medium: string | undefined;
  let current: FeedGroup | null = null;

  for (const tag of tags) {
    const type = tag[0];

    if (type === 'alt') continue;

    // Read, never carried. A `visibility` tag found INSIDE the private half is
    // dropped rather than round-tripped: the mode is a property of the list,
    // not of a half, so a claim made there is one no reader may act on.
    if (type === VISIBILITY_TAG) {
      if (tag[1] === 'public' || tag[1] === 'private') visibility = tag[1];
      continue;
    }

    if (type === 'k') {
      const value = tag[1];
      if (value && !KNOWN_IDENTIFIER_KINDS.includes(value) && !foreignKinds.includes(value)) {
        foreignKinds.push(value);
      }
      continue;
    }

    if (type === 'medium') {
      // An empty value is "not told", not the empty-string medium.
      medium = tag[1] || undefined;
      continue;
    }

    if (type !== 'i' || !tag[1]) {
      if (!MANAGED_TAGS.has(type)) foreignTags.push(tag.slice());
      continue;
    }

    const id = tag[1];

    // POSITION 2 PRESENT — an item entry that names its own feed, or something
    // we cannot read. Tested BEFORE the feed branch, because position 1 is the
    // same string on both and length is the only thing that tells them apart.
    if (tag[2] !== undefined) {
      const feed = parseShowGuid(id);
      const item = parseItemGuid(tag[2]);
      if (feed !== null && item !== null) {
        // Carried whole, and it does NOT open or close a legacy run: it is not a
        // feed entry, and an item below it still belongs to whatever group is
        // open. Vector 4.
        nodes.push({ t: 'item', item: { feedGuid: feed, itemGuid: item, medium, tag: tag.slice() } });
        continue;
      }
      // A POSITION 2 WE CANNOT READ IS NOT A FEED FAVORITE. Nothing but
      // `podcast:item:guid:` is defined there today, so an entry carrying
      // something else belongs to a writer newer than us — and reading it as a
      // two-element feed entry would turn their entry into a followed show.
      // Carry the whole tag and say nothing about it. Vector 4.
      nodes.push({ t: 'loose', loose: { tag: tag.slice(), medium } });
      continue;
    }

    const feedGuid = parseShowGuid(id);
    if (feedGuid !== null) {
      current = { feedGuid, medium, itemGuids: [], feedTag: tag.slice() };
      nodes.push({ t: 'group', group: current });
      continue;
    }

    // THE LEGACY FORM, and it is mandatory. Every list in production is full of
    // these, and its feed is the group most recently opened above it.
    const itemGuid = parseItemGuid(id);
    if (itemGuid !== null && current) {
      if (!current.itemGuids.includes(itemGuid)) {
        current.itemGuids.push(itemGuid);
        (current.itemTags ??= {})[itemGuid] = tag.slice();
      }
      continue;
    }

    // Either an item with no group open yet (an orphan, which the spec permits
    // and which our own emitter produces for a parentless favorite), or an
    // identifier kind we have no placement for.
    //
    // A loose entry deliberately does NOT close `current`. An unrecognized `i`
    // sitting between two items must not silently re-parent every item after
    // it — the entries around it belong to a writer that knew what it meant,
    // and our not understanding one of them is not licence to move the others.
    nodes.push({ t: 'loose', loose: { tag: tag.slice(), medium } });
  }

  return { nodes, visibility, foreignTags, foreignKinds };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const mediumOfNode = (n: ListNode): string | undefined => {
  if (n.t === 'group') return n.group.medium;
  if (n.t === 'item') return n.item.medium;
  return n.loose.medium;
};

/**
 * Group this device's flat favorites for the wire.
 *
 * A feed group is opened for EVERY parent of a favorited item, whether or not
 * the feed itself is favorited — it is the only way to name an item's parent.
 * That is why a group with items under it cannot be read back as a feed
 * favorite; see `partitionList`.
 */
export function groupLocalFavorites(entries: FavoriteEntry[]): LocalList {
  const groups: FeedGroup[] = [];
  const byGuid = new Map<string, FeedGroup>();
  const loose: LooseEntry[] = [];

  const ensure = (feedGuid: string, medium?: string): FeedGroup => {
    const existing = byGuid.get(feedGuid);
    if (existing) {
      // Fill a gap, never overwrite. Two entries under one feed may disagree
      // only because one of them was never told.
      if (!existing.medium && medium) existing.medium = medium;
      return existing;
    }
    const group: FeedGroup = { feedGuid, medium, itemGuids: [], favorited: false };
    byGuid.set(feedGuid, group);
    groups.push(group);
    return group;
  };

  for (const entry of entries) {
    const feedGuid = parseShowGuid(entry.id);
    if (feedGuid !== null) {
      // The one place the answer is known: a `podcast:guid:` entry in local
      // state IS the user favoriting the feed. Every other group here was
      // opened by an item to name its parent.
      ensure(feedGuid, entry.medium).favorited = true;
      continue;
    }

    const itemGuid = parseItemGuid(entry.id);
    if (itemGuid === null) {
      // An identifier kind we don't place. Carried, not dropped.
      loose.push({ tag: ['i', entry.id], medium: entry.medium });
      continue;
    }

    const parent = bareFeedGuid(entry.feedRef);
    if (!parent) {
      // A favorited item whose parent we don't know, or know only as a
      // malformed guid. It rides as an orphan rather than being dropped: the
      // spec permits items ahead of any group, and losing a track because we
      // can't name its album is a worse trade than an unplaceable entry.
      loose.push({ tag: ['i', entry.id], medium: entry.medium });
      continue;
    }

    const group = ensure(parent, entry.medium);
    if (!group.itemGuids.includes(itemGuid)) group.itemGuids.push(itemGuid);
  }

  return { groups, loose };
}

/**
 * Emit the tag array.
 *
 * Layout, and every line of it is a rule from the spec:
 *
 *   ['alt', …]                one, ours, first
 *   foreign tag types         verbatim, in read order
 *   unknown-medium nodes      BEFORE any ['medium', …] tag
 *   ['medium', v] + its nodes one block per distinct medium, contiguous
 *   ['k', kind]               trailing, one per distinct kind
 *
 * Unknown-medium nodes go first rather than last because appending them would
 * make them inherit whatever medium was declared last, and minting a
 * `['medium','unknown']` tag would write a value no reader has been told about.
 * Placing them ahead of the first `medium` tag is the one position that says
 * "not told" without inventing anything.
 *
 * Where preserving read order and keeping same-medium groups contiguous
 * conflict — because the writer before us interleaved them — CONTIGUITY WINS.
 * Reordering groups within a medium block reattaches nothing, since an item
 * always travels directly beneath its own feed entry, whereas a broken block
 * silently re-labels every entry after the boundary.
 */
/**
 * Which of the four bands an `i` tag belongs to, or null when we cannot say.
 *
 *   0  an item that names NO feed
 *   1  artists
 *   2  albums and podcasts
 *   3  items, grouped by the feed they name
 *
 * BAND 0 IS NOT COSMETIC. A legacy `['i','podcast:item:guid:X']` takes its feed
 * from the most recent feed entry above it. Put every feed entry above every
 * item and such an entry resolves to the LAST album in band 2 — a wrong feed,
 * which is worse than the nothing it had, and the emitted tag is byte-identical
 * either way so nothing else catches it. Ahead of band 2 there is no feed entry
 * to mistake for its parent, and an artist is never a feed, so band 1 beside it
 * is harmless.
 *
 * A resolvable legacy item never reaches band 0: the same publish rewrites it,
 * so it arrives in band 3 already naming its feed.
 */
function bandOf(tag: string[]): number | null {
  if (tag[0] !== 'i' || !tag[1]) return null;
  const kind = entryKind(tag);
  if (kind === PUBLISHER_KIND) return 1;
  if (kind === ITEM_KIND) return tag[2] !== undefined ? 3 : 0;
  if (kind === SHOW_KIND) return 2;
  return null;
}

/**
 * Put each `medium` run in band order.
 *
 * Applied ONCE, over the whole emitted body, rather than threaded through the
 * two merge passes — that is what makes an entry land in the same place whether
 * it came off the wire or out of local state.
 *
 * **Prescribing the order is what makes it converge; preserving it never did.**
 * The rule used to be "keep what you read, append yours", and its failure needs
 * two apps imposing DIFFERENT orders: they rewrote the event at each other in
 * production for three weeks. One order in the document ends that, because a
 * writer that does not sort still keeps what it read.
 *
 * This is available at all only because an entry names its own feed. Under the
 * previous revision, moving a track away from the album above it destroyed the
 * association outright.
 *
 * WITHIN a band the read order stands and a new entry lands at the end, so no
 * existing list is reshuffled. Band 3 groups by feed, groups in order of first
 * appearance, so an album's tracks stay together.
 *
 * A RUN HOLDING A TAG WE CANNOT CLASSIFY IS EMITTED AS READ. Rule 4 carries an
 * unparseable `i` or an unknown tag type untouched, and a tag with no kind has
 * no band. Inventing a place for a carried tag is how it ends up somewhere that
 * changes what it means, so the whole run keeps wire order instead.
 */
function orderRuns(body: string[][]): string[][] {
  const runs: { header: string[] | null; tags: string[][] }[] = [];
  let current: { header: string[] | null; tags: string[][] } = { header: null, tags: [] };
  for (const tag of body) {
    if (tag[0] === 'medium') {
      runs.push(current);
      current = { header: tag, tags: [] };
      continue;
    }
    current.tags.push(tag);
  }
  runs.push(current);

  const out: string[][] = [];
  for (const run of runs) {
    if (run.header) out.push(run.header);
    if (run.tags.length === 0) continue;

    const bands = run.tags.map(bandOf);
    if (bands.some((b) => b === null)) {
      for (const tag of run.tags) out.push(tag);
      continue;
    }

    const banded: string[][][] = [[], [], [], []];
    run.tags.forEach((tag, i) => banded[bands[i] as number].push(tag));

    // Band 3 groups by the feed each item NAMES — position 1 of its own tag,
    // never the entry above it — groups in order of first appearance.
    const byFeed = new Map<string, string[][]>();
    for (const tag of banded[3]) {
      const feed = tag[1];
      if (!byFeed.has(feed)) byFeed.set(feed, []);
      (byFeed.get(feed) as string[][]).push(tag);
    }
    banded[3] = [...byFeed.values()].flat();

    for (const band of banded) for (const tag of band) out.push(tag);
  }
  return out;
}

export function tagsFromList(list: ParsedList): string[][] {
  // The BODY only: entries and their `medium` headers. `alt` goes on the front
  // and the `k` tags on the back once this is banded, because neither takes part
  // in a run.
  const body: string[][] = [];

  for (const tag of list.foreignTags) body.push(tag.slice());

  // THE TAG WE READ, NEVER ONE REBUILT FROM THE MODEL. A rebuild type-checks,
  // renders correctly, and drops every element past the one this version knows
  // about — which for an item entry is the guid of its feed, and for the next
  // revision is whatever it puts at position 3. Only a node this device
  // ORIGINATED has nothing to carry, and it is the only one built from the model.
  const emit = (node: ListNode) => {
    if (node.t === 'loose') {
      body.push(node.loose.tag.slice());
      return;
    }
    if (node.t === 'item') {
      body.push(node.item.tag.slice());
      return;
    }
    body.push(node.group.feedTag ? node.group.feedTag.slice() : ['i', showId(node.group.feedGuid)]);
    for (const guid of node.group.itemGuids) {
      const read = node.group.itemTags?.[guid];
      // THE MIGRATION, and it happens once per list. A LEGACY tag — two
      // elements, the item at position 1 — is replaced WHOLE: the identifier
      // moves to position 2 and position 1 becomes the feed's, taken from the
      // group this item was read under. It is not an appended third element.
      //
      // Anything longer than two elements already names its feed and is carried
      // untouched, which is what keeps a position we have no meaning for alive.
      // Reading our own output back turns these into `item` nodes, so the second
      // pass emits the same bytes and the upgrade does not repeat forever.
      body.push(read && read.length > 2
        ? read.slice()
        : ['i', showId(node.group.feedGuid), itemId(guid)]);
    }
  };

  for (const node of list.nodes) if (!mediumOfNode(node)) emit(node);

  const mediums: string[] = [];
  for (const node of list.nodes) {
    const m = mediumOfNode(node);
    if (m && !mediums.includes(m)) mediums.push(m);
  }
  for (const medium of mediums) {
    body.push(['medium', medium]);
    for (const node of list.nodes) if (mediumOfNode(node) === medium) emit(node);
  }

  const ordered = orderRuns(body);
  const out: string[][] = [['alt', LIST_ALT], ...ordered];

  // Derived from what we actually emitted, in emission order — never from the
  // model, so a `k` can't name a kind that isn't on the list.
  const kinds: string[] = [];
  for (const tag of out) {
    if (tag[0] !== 'i' || !tag[1]) continue;
    // `entryKind`, never `identifierKind(tag[1])`: an item entry's kind lives at
    // position 2 and reading position 1 alone keeps `podcast:item:guid` off the
    // event entirely.
    const kind = entryKind(tag);
    if (kind && !kinds.includes(kind)) kinds.push(kind);
  }
  for (const kind of kinds) out.push(['k', kind]);
  for (const kind of list.foreignKinds) {
    if (!kinds.includes(kind)) out.push(['k', kind]);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

export interface MergeInput {
  /** What the relay holds. Never call this on an untrustworthy read. */
  read: ParsedList;
  /** What this device holds. */
  local: LocalList;
  /** What this device last agreed with the relay on. */
  baseline: FavoritesBaseline;
  /**
   * Pass 2 off: keep everything the removal tests keep, ADD nothing.
   *
   * This is for the whole-list move only, on the half it is EMPTYING. That
   * merge still has to run the removal tests — an entry we claim there and no
   * longer hold is an unfavorite the user made, and carrying it across the move
   * is permanent, because the baseline written beside the move cannot claim
   * what this device does not hold, so no later cycle can drop it. Spec vector
   * 29.
   *
   * What it must NOT do is append. The entries this device holds are appended
   * once, by the merge that owns the half they are moving INTO; appending them
   * here too opens a second `medium` run for them and the list never reaches a
   * fixed point.
   *
   * **Handing this merge `EMPTY_LOCAL` looks like the same thing and is not.**
   * That turns pass 2 off by taking the `local` state away, and the removal
   * tests need it: without it every entry reads as unheld, so the whole half is
   * dropped and re-appended by the receiving merge in LOCAL order, losing the
   * wire order that is the data. Spec vector 30.
   *
   * `append` decides what is ADDED, never what is kept.
   */
  append?: boolean;
}

/**
 * Whether a switch to Private takes the WHOLE list, including entries this
 * device did not write.
 *
 * **ON since 2026-09-02, and the prerequisite was on this app rather than the
 * format.** The spec's sequencing is explicit: an app must be able to READ and
 * RENDER the other half before anything moves entries into it on that app's
 * behalf, or the move is indistinguishable from a deletion on that app's
 * screen. The order was: ship the rendering, confirm on a real account that a
 * moved entry appears, THEN turn this on. All three are done — the carried half
 * renders (#288–#290, `carried` in lib/types.ts) and was confirmed on a live
 * 287-entry list — and the other writer, Project StableKraft, has had its own
 * move on for longer.
 *
 * Leaving it off is not the safe side once the rendering ships. It is what
 * produces "97% private": a choice the format honours for most of a list, with
 * the rest sitting in plaintext `i` tags relays index, and nothing on screen
 * naming which.
 *
 * **The asymmetry does NOT depend on this flag and must survive its removal.**
 * public → private may move another app's entries unconditionally.
 * private → public may not, EXCEPT on a stated `visibility` — see
 * `effectiveListMode`. Without that tag there is no way to know the user's
 * intent for the whole list, so the move stays limited to what our baseline
 * claims; with it, the intent is on the wire and was written by an app that
 * could read both halves.
 */
export const WHOLE_LIST_PRIVACY_MOVE = true;

/**
 * Fold one half's nodes into another's, for the whole-list move into private.
 *
 * **A concatenation is the obvious version and it is wrong.** An entry can be a
 * group in BOTH halves at once — nothing in the format forbids it, and a switch
 * that publishes into one half while its removal from the other stays
 * baseline-gated lands there by itself. Measured on a real account: 284
 * favorites public, 287 encrypted, all 284 in both. Concatenating then emits
 * one feed as TWO groups, which double-counts it for every reader and gives its
 * items two parents to sit under. The same defect shipped in the format's
 * reference implementation and in the other writer of this list, in opposite
 * directions; it is spec test vector 15.
 *
 * Folding rather than dropping the duplicate, because the incoming group may
 * carry items the one already here does not — this is a MOVE, and an item under
 * a duplicate group is as much the user's as the group itself.
 *
 * **Order is the receiving half's.** Tag order is the data, so the side already
 * in place keeps its positions and incoming items append. Loose nodes fold on
 * their identifier: a duplicate there is one entry named twice, not two.
 */
export function foldHalves(here: ParsedList, moving: ParsedList): ParsedList {
  const nodes: ListNode[] = here.nodes.map((n) => (n.t === 'group'
    ? { t: 'group', group: { ...n.group, itemGuids: [...n.group.itemGuids] } }
    : n));
  const groupAt = new Map<string, number>();
  const looseIds = new Set<string>();
  // Keyed on the PAIR. An item guid is unique only inside its feed, so folding
  // on the item guid alone collapses two different favorites into one.
  const itemKeys = new Set<string>();
  nodes.forEach((n, i) => {
    if (n.t === 'group') groupAt.set(n.group.feedGuid, i);
    else if (n.t === 'item') itemKeys.add(`${n.item.feedGuid}|${n.item.itemGuid}`);
    else if (n.loose.tag[1]) looseIds.add(n.loose.tag[1]);
  });

  for (const node of moving.nodes) {
    if (node.t === 'loose') {
      const id = node.loose.tag[1];
      if (id && looseIds.has(id)) continue;
      if (id) looseIds.add(id);
      nodes.push(node);
      continue;
    }
    if (node.t === 'item') {
      const key = `${node.item.feedGuid}|${node.item.itemGuid}`;
      if (itemKeys.has(key)) continue;
      itemKeys.add(key);
      nodes.push({ t: 'item', item: { ...node.item, tag: node.item.tag.slice() } });
      continue;
    }
    const at = groupAt.get(node.group.feedGuid);
    if (at === undefined) {
      groupAt.set(node.group.feedGuid, nodes.length);
      nodes.push({ t: 'group', group: { ...node.group, itemGuids: [...node.group.itemGuids] } });
      continue;
    }
    const existing = nodes[at];
    if (existing.t !== 'group') continue;
    for (const guid of node.group.itemGuids) {
      if (!existing.group.itemGuids.includes(guid)) existing.group.itemGuids.push(guid);
    }
    // The medium hint only ever FILLS a gap. Overwriting one the feed declared
    // with one it did not is how a hint becomes wrong.
    if (!existing.group.medium && node.group.medium) existing.group.medium = node.group.medium;
  }

  const foreignTags = [...here.foreignTags];
  for (const tag of moving.foreignTags) {
    if (!foreignTags.some((t) => JSON.stringify(t) === JSON.stringify(tag))) foreignTags.push(tag);
  }
  const foreignKinds = [...here.foreignKinds];
  for (const kind of moving.foreignKinds) {
    if (!foreignKinds.includes(kind)) foreignKinds.push(kind);
  }
  // The mode belongs to the LIST, so a fold of two halves cannot decide it and
  // does not try. `effectiveListMode` is the only thing that answers it.
  return { nodes, visibility: here.visibility, foreignTags, foreignKinds };
}

/**
 * Combine the relay's list with this device's, using the baseline to tell a
 * foreign entry from one we removed.
 *
 * The output is closed over the input type: merging is an edit of the ordered
 * node list, never a rebuild from local state. A writer built from local state
 * alone is the natural way to write one and it deletes every entry the other
 * app added — that is the spec's own test vector 1.
 *
 * Five points where this deliberately diverges from the reference
 * implementation in StableKraft, each because that one has no baseline and so
 * cannot answer the question:
 *
 *  1. Item removals are reconciled under EVERY group, not only groups we still
 *     hold. Otherwise unfavoriting a track whose album we've since dropped
 *     never propagates.
 *  2. A group we published keeps its place while any item under it survives.
 *     Deleting the group would take the other app's items with it — the group
 *     is the only thing naming their parent.
 *  3. Items read off the wire keep their wire position; local-only items
 *     append. Imposing our own order on every republish means two apps reorder
 *     the event at each other forever, each publish locally reasonable, the
 *     only symptom being that it never stops.
 *  4. The append pass honours the baseline, so an entry another app REMOVED is
 *     not resurrected by this device on the next cycle.
 *  5. Loose entries exist at all, so an identifier kind or tag position we
 *     don't understand survives us.
 */
export function mergeFavoritesList({ read, local, baseline, append = true }: MergeInput): ParsedList {
  const localByGuid = new Map(local.groups.map((g) => [g.feedGuid, g]));
  const publishedFeeds = new Set(baseline.feeds);
  const publishedItems = new Set(baseline.items);
  // KEYED ON THE PAIR, every one of them. Two feeds may hold one item guid, and
  // they are two different favorites — a set keyed on the item guid alone folds
  // them into one, so taking back one removes the other.
  const localItems = new Set(
    local.groups.flatMap((g) => g.itemGuids.map((i) => itemClaim(itemId(i), g.feedGuid))),
  );

  /** Ours, and we no longer hold it ⇒ the user removed it here. */
  const weRemovedItem = (guid: string, feedGuid: string) =>
    claimedItem(publishedItems, itemId(guid), feedGuid)
    && !localItems.has(itemClaim(itemId(guid), feedGuid));

  const localLooseIds = new Set(local.loose.map((l) => l.tag[1]).filter(Boolean));

  /**
   * Item guids the wire states in THREE-ELEMENT form and that survive this
   * cycle.
   *
   * Computed ahead of the walk because an `item` node may sit after the group
   * that also holds it locally, and both passes below have to agree. An item
   * already on the wire naming its own feed must be emitted exactly once, in the
   * form it arrived in — re-emitting our own two-element copy beneath a group
   * would duplicate the favorite AND downgrade it, stripping the one value that
   * makes it resolvable.
   */
  const carriedItems = new Set<string>();
  for (const node of read.nodes) {
    if (node.t !== 'item') continue;
    if (weRemovedItem(node.item.itemGuid, node.item.feedGuid)) continue;
    carriedItems.add(itemClaim(itemId(node.item.itemGuid), node.item.feedGuid));
  }

  const nodes: ListNode[] = [];
  // Items THIS DEVICE adds this cycle. They are appended as their own nodes
  // rather than folded into a group, because under the current format an item is
  // an independent entry that names its own feed — nothing above it places it.
  // Folding them in also put them AHEAD of the items already on the wire, since
  // a group sits above the entries that follow it, and the rule is that a new
  // entry goes at the END of its band.
  const newItems: ItemEntry[] = [];
  const addNewItem = (feedGuid: string, guid: string, medium?: string) => {
    newItems.push({
      feedGuid,
      itemGuid: guid,
      medium,
      tag: ['i', showId(feedGuid), itemId(guid)],
    });
  };
  const taken = new Set<string>();
  // Where each feed's group sits in `nodes`, and how many of its items came
  // off the wire, so a second group for the same feed can fold into it AFTER
  // the wire items already there and BEFORE anything local appended. See the
  // duplicate branch below.
  const groupAt = new Map<string, { at: number; wireItems: number }>();
  // Incremented ONLY where a node is emitted because local state holds it —
  // never where one is carried for another writer. See `ParsedList.localFed`.
  let localFed = 0;

  for (const node of read.nodes) {
    if (node.t === 'loose') {
      const id = node.loose.tag[1];
      // Not ours to interpret is not ours to drop — UNLESS the baseline says we
      // put it there and we no longer hold it, which is a removal like any
      // other. The baseline only ever names identifiers this device emitted, so
      // this can never reach another writer's entry. Without it a favorite that
      // rides loose (an item whose parent guid we never learned) would be
      // carried forever and could never be unfavorited on any device.
      // Both halves are consulted, not just `items`: a loose entry may be a
      // malformed `podcast:guid:` that an older baseline recorded on the feeds
      // side. Which half it landed in is an accident of history; whether we
      // published it is the question.
      if (id && (publishedItems.has(id) || publishedFeeds.has(id)) && !localLooseIds.has(id)) continue;
      if (id && localLooseIds.has(id)) localFed++;
      nodes.push({ t: 'loose', loose: { tag: node.loose.tag.slice(), medium: node.loose.medium } });
      continue;
    }

    if (node.t === 'item') {
      // An entry that names its own feed. Ours to remove if the baseline says we
      // asserted it and local state no longer holds it — this app adopts what it
      // renders, so a carried entry the user unfavorites here has to go — and
      // otherwise carried, tag and all.
      if (weRemovedItem(node.item.itemGuid, node.item.feedGuid)) continue;
      if (localItems.has(itemClaim(itemId(node.item.itemGuid), node.item.feedGuid))) localFed++;
      nodes.push({ t: 'item', item: { ...node.item, tag: node.item.tag.slice() } });
      continue;
    }

    const group = node.group;
    const kept = group.itemGuids.filter((guid) => !weRemovedItem(guid, group.feedGuid));

    // THE SAME FEED TWICE ON THE WIRE. Well-formed — a reader attaches each
    // item to the group most recently opened above it, and both name this
    // feed — and this loop meets the second one already taken. It used to
    // `continue` here, which dropped the items beneath it: real favorites,
    // named nowhere else on the event, gone on the next publish with nothing
    // on screen. Fold them into the first group instead, in wire order, the
    // same way `foldHalves` folds a duplicate across halves. Spec vector 19.
    const first = groupAt.get(group.feedGuid);
    if (first !== undefined) {
      const into = nodes[first.at];
      if (into.t === 'group') {
        for (const guid of kept) {
          if (into.group.itemGuids.includes(guid)) continue;
          // Wire order: after the first group's own wire items, ahead of ours.
          into.group.itemGuids.splice(first.wireItems, 0, guid);
          first.wireItems += 1;
        }
        if (!into.group.medium && group.medium) into.group.medium = group.medium;
      }
      continue;
    }
    taken.add(group.feedGuid);

    const mine = localByGuid.get(group.feedGuid);

    if (!mine) {
      // We opened this group once and no longer hold the feed. Drop it only
      // when there is nothing left to place; while any item survives, the group
      // must stay to name their parent. (The spec is explicit that unfavoriting
      // a feed whose track is still favorited is inexpressible — expressing it
      // anyway deletes another app's tracks.)
      if (publishedFeeds.has(showId(group.feedGuid)) && kept.length === 0) continue;
      groupAt.set(group.feedGuid, { at: nodes.length, wireItems: kept.length });
      // `...group` carries `feedTag` and `itemTags` with it. Both are the tags
      // as read, and this branch is pure carrying.
      nodes.push({ t: 'group', group: { ...group, itemGuids: kept } });
      continue;
    }

    localFed++;
    // `append` gates the ADD, not the `localFed++` above it: that one counts a
    // node kept because we hold it, which is what the wholesale-delete guard
    // reads. Gate it and every whole-list move reports `localFed === 0` on both
    // halves and is refused as a wipe.
    for (const g of append ? mine.itemGuids : []) {
      if (kept.includes(g)) continue;
      // Local items the read didn't carry are either NEW here, or ones we
      // published that another writer has since removed. Only the first may go
      // up: re-adding the second is the resurrection loop.
      if (claimedItem(publishedItems, itemId(g), group.feedGuid)) continue;
      // Already on the wire naming its own feed. Carried there, once.
      if (carriedItems.has(itemClaim(itemId(g), group.feedGuid))) continue;
      addNewItem(group.feedGuid, g, group.medium ?? mine.medium);
    }
    groupAt.set(group.feedGuid, { at: nodes.length, wireItems: kept.length });
    nodes.push({
      t: 'group',
      group: {
        feedGuid: group.feedGuid,
        // THE TAGS AS READ, THREADED ACROSS EXPLICITLY. This literal names its
        // fields one at a time, so anything added to `FeedGroup` is dropped here
        // by construction rather than by oversight — and dropping these rebuilds
        // every carried `i` tag from our own model. `mine` is local state and
        // has neither, so they can only come from `group`.
        feedTag: group.feedTag,
        itemTags: group.itemTags,
        favorited: group.favorited,
        // Fill a gap, never overwrite a value another writer set.
        medium: group.medium ?? mine.medium,
        // Local items the read didn't carry are either NEW here, or ones we
        // published that another writer has since removed. Only the first may
        // go up: re-adding the second is the resurrection loop, the same one
        // `fresh` guards against below for a group absent from the read.
        //
        // **This is the branch that shipped without the filter**, and the
        // asymmetry is why it hid: whether an unfavorite stuck depended on
        // whether its album happened to still have a second track on the list,
        // which is invisible from the device doing the removing. The baseline
        // is the discriminator — absence from the read alone would suppress a
        // favorite the user just made.
        // WIRE ITEMS ONLY. These are legacy two-element tags that depend on
        // this group to name their feed; `tagsFromList` rewrites them so they
        // stop depending on it. Anything this device adds goes below, as its
        // own node.
        itemGuids: kept,
      },
    });
  }

  for (const group of append ? local.groups : []) {
    if (taken.has(group.feedGuid)) continue;

    // Absent from the read entirely. Anything we already published and the relay
    // no longer has was removed by another writer, and re-adding it is the
    // resurrection loop — so only genuinely NEW entries go up.
    const fresh = group.itemGuids.filter(
      (guid) => !claimedItem(publishedItems, itemId(guid), group.feedGuid)
        && !carriedItems.has(itemClaim(itemId(guid), group.feedGuid)),
    );

    // The items go up on their own, whether or not the feed does. They name
    // their own feed, so they no longer need a group reopened above them to say
    // which album they came from — which is what used to force a feed the user
    // had never favorited onto the list.
    for (const guid of fresh) addNewItem(group.feedGuid, guid, group.medium);

    // THE FEED ENTRY IS NOW A SEPARATE QUESTION, and both halves of it matter.
    //
    // `favorited === false` means the user never favorited this feed — the group
    // exists only because an item named it as a parent. A bare feed entry says
    // the user favorited the feed, so writing one here invents a favorite. That
    // used to be unavoidable and is the case this revision of the format exists
    // to fix: on the first real list, 114 of 196 feed entries were placement.
    //
    // `publishedFeeds` is the resurrection guard, unchanged: we published this
    // feed, the read no longer holds it, so another writer removed it.
    taken.add(group.feedGuid);
    localFed += fresh.length;
    if (group.favorited === false) continue;
    if (publishedFeeds.has(showId(group.feedGuid))) continue;
    localFed++;
    nodes.push({ t: 'group', group: { ...group, itemGuids: [] } });
  }

  for (const loose of append ? local.loose : []) {
    const id = loose.tag[1];
    if (!id) continue;
    if (read.nodes.some((n) => n.t === 'loose' && n.loose.tag[1] === id)) continue;
    if (publishedItems.has(id) || publishedFeeds.has(id)) continue;
    localFed++;
    nodes.push({ t: 'loose', loose: { tag: loose.tag.slice(), medium: loose.medium } });
  }

  // A NEW ENTRY GOES AT THE END. Band order sorts these into their run and
  // groups them under the feed they name, so this position decides only where
  // they land WITHIN their band — after everything read off the wire, which is
  // the rule.
  for (const item of newItems) nodes.push({ t: 'item', item });

  // Carried from the read. `mergeFavoritesList` folds ONE half; the mode is a
  // property of the whole list and is not this function's to decide.
  return {
    nodes,
    visibility: read.visibility,
    foreignTags: read.foreignTags,
    foreignKinds: read.foreignKinds,
    localFed,
  };
}

/**
 * What this device is asserting, recorded ONLY once a publish has landed.
 *
 * A baseline written for an event that never reached a relay permanently stops
 * that entry from being retried: `local − baseline` is empty for it from then
 * on, so it is never published again while the UI reports success. That is why
 * every caller gates this on `assertPublished`.
 */
export function baselineFrom(local: LocalList): FavoritesBaseline {
  return {
    feeds: local.groups.map((g) => showId(g.feedGuid)),
    items: [
      // THE PAIR. See `itemClaim`: an item guid is unique only inside its feed.
      ...local.groups.flatMap((g) => g.itemGuids.map((i) => itemClaim(itemId(i), g.feedGuid))),
      // Loose entries this device asserted (a favorite whose parent we never
      // learned) are recorded too — an identifier we published and cannot later
      // retract is a favorite the user can never remove.
      ...local.loose.map((l) => l.tag[1]).filter((id): id is string => !!id),
    ],
  };
}

// ---------------------------------------------------------------------------
// Planning a publish
// ---------------------------------------------------------------------------

export type PublishReason =
  | 'degraded'
  | 'unchanged'
  | 'nothing-to-create'
  | 'wholesale-delete'
  | 'private-unreadable'
  | 'private-too-large'
  // Not a plan outcome — the hydrator's, for a wire `seedModeFromWire` refuses
  // to read (entries in BOTH halves, so which one this device owns is
  // unknowable). It withholds the private half rather than guess, and this is
  // what stops that being silent.
  | 'mode-ambiguous'
  | 'publish';

export interface FavoritesPlanInput {
  /** The merged PUBLIC half. */
  merged: ParsedList;
  /** The raw tags of the event we read, or [] when there is none. */
  readTags: string[][];
  exists: boolean;
  trustworthy: boolean;
  /**
   * This device's favorites destined for the public half.
   *
   * VESTIGIAL: the baseline moved off `local` and onto the merge, so nothing in
   * here reads it any more. Kept because every call site and check vector
   * passes it, and because it documents which half `merged` was built from.
   */
  local: LocalList;

  // -- the private half -----------------------------------------------------
  //
  // All optional. Omitted, this plans exactly as it did before a private half
  // existed, except that `content` is CARRIED rather than blanked — which is
  // the carry rule, and it ships whether or not anything below is populated.

  /** Where this device puts the favorites it owns. Defaults to 'public'. */
  mode?: FavoritesPrivacy;
  /** The merged PRIVATE half, or null when we could not read it. */
  privateMerged?: ParsedList | null;
  /** The decrypted tag array of the read, or [] when there is none. */
  readPrivateTags?: string[][];
  /** `event.content` verbatim. Carried untouched unless we re-encrypt. */
  readContent?: string;
  /** True when `content` is non-empty and we could not turn it into tags. */
  privateUnreadable?: boolean;
  /** This device's favorites destined for the private half. Vestigial, as `local`. */
  privateLocal?: LocalList;
  /**
   * EVERYTHING THIS DEVICE HOLDS, both halves' worth, before the mode split.
   *
   * `local` and `privateLocal` are one list split by the mode, so on any given
   * cycle one of them is empty — which makes neither of them the answer to
   * "do we still hold this?" about the half we are not writing into. That
   * question decides whether a carried claim retires, and getting it wrong
   * deletes another app's entry: see `carriedClaims`.
   *
   * Defaults to `EMPTY_LOCAL`, which retires a claim on absence alone — the
   * behaviour before this existed, and the conservative direction for a caller
   * that has not been taught to pass it.
   */
  held?: LocalList;
  /**
   * What this device last agreed with the relay on, so the claims about a half
   * we could not read this cycle survive it. Without it an unreadable private
   * half disowns every entry in it on the next publish.
   */
  previousBaseline?: FavoritesBaseline;
  /**
   * This emptiness is something a person did, not something that happened.
   *
   * The ONLY thing that may bypass the wholesale-delete refusal — that guard
   * exists to catch an empty merge nobody asked for. Two provenances, both
   * genuine:
   *
   *   - the withdrawal dialog ("also remove my entries from Nostr")
   *   - the user unfavoriting their whole list, recorded by the store's
   *     removers in `storage.favCleared` at the moment it happens
   *
   * Never inferred from state. An empty merge over a full read is the shape of
   * the 2026-08-21 wipe, and the only thing separating that from a deliberate
   * clear is whether somebody asked for it.
   */
  emptyIsIntentional?: boolean;
  /**
   * This cycle is a WITHDRAWAL: both halves get an empty local list, so neither
   * is fed by this device.
   *
   * Distinct from {@link emptyIsIntentional}, which it implies but is not
   * implied by — unfavoriting the whole list also empties the active half, and
   * that half's baseline must still be recomputed from the (now empty) merge.
   * Here the device removes everything it claimed, so afterwards it claims
   * nothing and BOTH halves record an empty baseline.
   */
  withdraw?: boolean;
  /**
   * The `visibility` tag this publish states.
   *
   * Decided by {@link effectiveListMode}, not here — the caller has already
   * used the same answer to choose which half `merged` was built from, and two
   * places deciding it is how a writer publishes into one half while the tag
   * names the other.
   *
   * **OMITTED MEANS CARRY WHAT THE READ SAID, and that default is load-bearing
   * rather than a convenience.** `tagsFromList` rebuilds the whole tag array
   * from the model, and `visibility` is a managed tag, so a caller that says
   * nothing would emit an event WITHOUT it — silently retracting a mode
   * another app stated. `<FavoritesHydrator>` plans a cycle of its own and is
   * exactly such a caller: it found this by turning every hydrate on a stated
   * list into a `wholesale-delete` refusal, because the rebuilt tags no longer
   * matched the read.
   *
   * An explicit `null` states nothing, and only a caller that has decided that
   * should pass it.
   *
   * Applied to the EVENT's tags only. Never to `privateTags`, which becomes
   * `content`: a mode stated inside a half is a claim no reader may act on.
   */
  stating?: ListVisibility | null;
}

export interface FavoritesPlan {
  publish: boolean;
  reason: PublishReason;
  tags: string[][];
  /** Record only once the publish lands. Meaningful even when `publish` is false. */
  baseline: FavoritesBaseline;
  /**
   * The private tag array to encrypt. Only meaningful when
   * {@link encryptPrivate} is true.
   */
  privateTags: string[][] | null;
  /**
   * What `content` must be when we are NOT re-encrypting: the ciphertext we
   * read, verbatim, or '' when the private half is genuinely empty.
   */
  content: string;
  /**
   * Encrypt {@link privateTags} and use that as `content`.
   *
   * False is the common case and that is the point: NIP-44 draws a fresh nonce
   * per encryption, so re-encrypting identical entries produces different bytes
   * every time. Encrypt unconditionally and the byte comparison below can never
   * report 'unchanged' — every page load republishes, and two apps rewrite the
   * event at each other forever. Self-inflicted, and the spec names it as the
   * first thing a private half breaks.
   */
  encryptPrivate: boolean;
}

/**
 * Decide whether to publish, and what.
 *
 * `changed` is a BYTE comparison against what the relay actually holds, not a
 * membership comparison — order and grouping are semantic here, so two lists
 * with identical membership can mean different things. Comparing against the
 * read rather than against a digest of our own last publish is also what lets
 * us notice that another app has since edited the event.
 *
 * Byte-equality with the read IS the spec's idempotence vector, executed on
 * every cycle in production rather than only in the check script. With a
 * private half that comparison has to be made on the DECRYPTED array, and the
 * ciphertext compared only where we could not decrypt it — see
 * {@link FavoritesPlan.encryptPrivate}.
 */
export function planFavoritesPublish(input: FavoritesPlanInput): FavoritesPlan {
  const mode: FavoritesPrivacy = input.mode ?? 'public';
  const readContent = input.readContent ?? '';
  const readPrivateTags = input.readPrivateTags ?? [];
  const privateUnreadable = !!input.privateUnreadable;

  const tags = withVisibility(
    tagsFromList(input.merged),
    input.stating === undefined ? statedVisibility(input.readTags) : input.stating,
  );

  // THE BASELINE DESCRIBES BOTH HALVES AS THEY NOW STAND: the ACTIVE half
  // derived from the MERGED result rather than from `local`, the inactive one
  // carried from what this device last asserted about it.
  //
  // It used to be `baselineForHalves(local, privateLocal)` — one local list
  // split by mode — which blanked the claims on the half this device was not
  // currently using. Every ordinary publish in public mode therefore threw away
  // whatever this device had asserted privately, and those entries became
  // unremovable: absent from the baseline, the merge reads them as another
  // writer's and carries them forever, while the app still renders them and
  // offers a heart that does nothing. Reported as "I unfavorited 2 and they
  // came back", off an event holding 9 public entries and an encrypted copy.
  //
  // Deriving the ACTIVE half from the merge is what makes an ADOPTED list
  // removable at all: this app paints that half into one library and lets the
  // user unfavorite any of it, so it has to claim what it renders. Entries it
  // cannot represent are excluded by `entriesFromList`, which is the line
  // between adopting a list and claiming a stranger's bytes.
  //
  // THE INACTIVE HALF IS CARRIED, NEVER RECOMPUTED, AND THE DIFFERENCE IS A
  // DELETION. Under one whole-list choice `syncFavorites` hands that half
  // `EMPTY_LOCAL` on every cycle, so a claim made off ITS merge has nothing
  // backing it next time round — `mergeFavoritesList`'s removal test (ours, and
  // we no longer hold it) then fires on every entry in it at once. Cycle 1
  // claims another writer's entries and cycle 2 deletes them, and cycle 1 need
  // not even publish, because the hydrator records a baseline on 'unchanged'
  // too. Measured both ways round against this module: a public-mode device
  // published `content: ''` over a foreign private half, and a private-mode
  // device published `[]` over a foreign public one — the same cross-app
  // deletion the carry rule exists to prevent, arriving through the baseline
  // instead of through `content`.
  //
  // Carrying `previousBaseline` keeps the claims from when that half WAS active,
  // so a mode switch still removes what it moved, and invents none over a writer
  // we are merely carrying for.
  const carried = (half: ListHalf): FavoritesBaseline => (half === 'public'
    ? { feeds: input.previousBaseline?.feeds ?? [], items: input.previousBaseline?.items ?? [] }
    : { feeds: input.previousBaseline?.privateFeeds ?? [], items: input.previousBaseline?.privateItems ?? [] });

  // A withdrawal feeds NEITHER half and removes everything this device claimed,
  // so afterwards it claims nothing. Not `carried`: a claim naming an entry that
  // is now gone would make `mergeFavoritesList`'s `fresh` filter suppress it if
  // the user ever favorites it again.
  //
  // **A CLAIM THAT HAS STOPPED BEING TRUE IS WORSE THAN NO CLAIM**, and a mode
  // switch is the ordinary way one does. Switching private→public moves entries
  // out of `content`, but `carried('private')` copies the pre-switch claims
  // forward unchanged and every later public-mode cycle copies them again. When
  // another app (or the user's second device) later favorites one of those same
  // ids privately, this device matches the stale claim, reads it as
  // ours-and-removed, and drops it — a cross-app deletion with no undo, driven
  // by an assertion that expired at the moment of the switch.
  //
  // So an inactive half keeps only the claims that still have work to do, and
  // there are TWO conditions, not one. This is never applied to an UNREADABLE
  // half: absence from a half we could not open is not evidence of anything,
  // and filtering on it would disown every private entry at once.
  const keysOfList = (list: ParsedList): Set<string> => {
    const present = new Set<string>();
    for (const node of list.nodes) {
      if (node.t === 'loose') {
        const id = node.loose.tag[1];
        if (id) present.add(id);
        continue;
      }
      // BOTH FORMS, because the baseline being filtered may hold either: a
      // paired claim this version wrote, or a bare one written before the pair
      // existed. Adding only the pair would disown every legacy claim at once.
      if (node.t === 'item') {
        present.add(itemClaim(itemId(node.item.itemGuid), node.item.feedGuid));
        present.add(itemId(node.item.itemGuid));
        continue;
      }
      present.add(showId(node.group.feedGuid));
      for (const g of node.group.itemGuids) {
        present.add(itemClaim(itemId(g), node.group.feedGuid));
        present.add(itemId(g));
      }
    }
    return present;
  };

  /**
   * What this device HOLDS, in the two claim forms a baseline may carry.
   *
   * Not `baselineFrom`, which emits the pair form alone: a baseline written
   * before the pair existed carries bare item ids, and matching those against
   * pairs only would retire every legacy claim on an entry we still hold —
   * the same defect this exists to fix, narrowed to legacy claims.
   *
   * A group with `favorited === false` is a placement, not a held feed. It is
   * on the list to name its items' parent and nothing else, so it may not keep
   * a feed claim alive.
   */
  const keysOfLocal = (l: LocalList): Set<string> => {
    const out = new Set<string>();
    for (const g of l.groups) {
      if (g.favorited !== false) out.add(showId(g.feedGuid));
      for (const i of g.itemGuids) {
        out.add(itemClaim(itemId(i), g.feedGuid));
        out.add(itemId(i));
      }
    }
    for (const e of l.loose) {
      const id = e.tag[1];
      if (id) out.add(id);
    }
    return out;
  };

  /**
   * The claims we carry about the half we did NOT publish into.
   *
   * CARRYING A CLAIM IS NOT KEEPING IT ALIVE PAST ITS ENTRY. This writer edits
   * the inactive half too — a whole-list move empties it outright — and a claim
   * left behind by that can never be satisfied again. The one thing it can
   * still do is fire `mergeFavoritesList`'s removal test, so the moment a
   * second app writes that entry back into that half, we delete it: silently,
   * on someone else's device, with no undo. Spec vector 31.
   *
   * TWO CONDITIONS, AND EACH IS LOAD-BEARING IN A DIFFERENT DIRECTION.
   *
   *  - **Not claimed in the ACTIVE half.** An entry the move carried across is
   *    claimed where it now lives; a second copy of that claim on the half it
   *    left is the stale claim above, and leaving it there is how emptying a
   *    half deletes the next writer's entry.
   *  - **Still in that half, OR still held here.** Presence alone is not the
   *    test. An entry we still HOLD keeps its claim wherever it sits, because
   *    there the claim is the resurrection guard: `mergeFavoritesList` re-adds
   *    what we hold, and the baseline is the only thing that stops it. Retire
   *    it and an entry another app removed comes back on the next cycle, for
   *    good.
   *
   * Neither true means we removed the entry and already published the removal,
   * so the claim is spent. Retiring only ever REMOVES claims, so it can never
   * claim another writer's entry — which is the whole thing the carry rule
   * protects.
   */
  const carriedClaims = (
    b: FavoritesBaseline,
    inactive: ParsedList | null | undefined,
    active: FavoritesBaseline,
    heldList: LocalList,
  ): FavoritesBaseline => {
    // A half we could not read is a half we did not edit. Verbatim, filter and
    // all — and the active-claims half is skipped too, deliberately further
    // from the spec's reference than the rest of this. `baselineOfList` claims
    // what this app RENDERS, another writer's entries included, so applying it
    // blind to bytes we cannot open would retire a private claim because a
    // stranger's public entry happens to share the identifier. That removal
    // cannot be redone.
    if (!inactive) return b;
    const still = keysOfList(inactive);
    const claimed = new Set([...active.feeds, ...active.items]);
    const held = keysOfLocal(heldList);
    const keep = (id: string) => !claimed.has(id) && (still.has(id) || held.has(id));
    return { feeds: b.feeds.filter(keep), items: b.items.filter(keep) };
  };

  // `withLoose` restores what `baselineOfList` deliberately cannot see. It reads
  // GROUPS off the merged wire (which is what was actually published) and takes
  // the loose ids from the LOCAL list (which is what tells ours from another
  // writer's). Dropping the loose half is silent and permanent: an orphan
  // favorite this device published would never enter a baseline, so
  // `mergeFavoritesList`'s loose-removal test could never fire for it and the
  // unfavorite would revert on every cycle, forever.
  const withLoose = (b: FavoritesBaseline, list: ParsedList | null | undefined, l: LocalList) => {
    const loose = looseIdsWePublished(list, l);
    if (loose.length === 0) return b;
    const items = new Set(b.items);
    for (const id of loose) items.add(id);
    return { ...b, items: [...items] };
  };
  // ACTIVE FIRST, THEN INACTIVE, because the inactive half now READS the active
  // one: a claim that moved across is claimed where it landed, and carrying a
  // second copy on the half it left is what deletes the next writer's entry.
  const activeIsPrivate = mode === 'private';
  const held = input.held ?? EMPTY_LOCAL;

  // A half we could not read goes back verbatim: what we asserted about it is
  // still the best answer we have, and recomputing it from nothing would
  // silently disown every private entry.
  const active: FavoritesBaseline = input.withdraw
    ? { feeds: [], items: [] }
    : activeIsPrivate
      ? (privateUnreadable
        ? carried('private')
        : withLoose(baselineOfList(input.privateMerged), input.privateMerged, input.privateLocal ?? EMPTY_LOCAL))
      : withLoose(baselineOfList(input.merged), input.merged, input.local);

  const inactive: FavoritesBaseline = input.withdraw
    ? { feeds: [], items: [] }
    : activeIsPrivate
      // Inactive public half. Same rule as the private one below.
      ? carriedClaims(carried('public'), input.merged, active, held)
      : (privateUnreadable
        ? carried('private')
        // Inactive but readable — the post-switch case. Carry, minus what the
        // switch just moved out and minus what we no longer hold.
        : carriedClaims(carried('private'), input.privateMerged, active, held));

  const pub = activeIsPrivate ? inactive : active;
  const priv = activeIsPrivate ? active : inactive;
  const baseline: FavoritesBaseline = {
    feeds: pub.feeds, items: pub.items, privateFeeds: priv.feeds, privateItems: priv.items,
  };

  // A private half with nothing in it is an EMPTY `content`, never an encrypted
  // empty array — otherwise every list that has never used one carries a couple
  // of hundred bytes of ciphertext for the rest of its life, and the comparison
  // below has to spend a signer round trip to learn nothing.
  //
  // EMPTINESS IS A COUNT OF NODES, NOT OF TAGS, and the difference is not
  // pedantic: `tagsFromList` always emits `['alt', LIST_ALT]`, so an empty list
  // serialises to ONE tag, never zero. Testing the tag array made every
  // ordinary public-mode publish encrypt an alt-only array into `content` —
  // caught end to end, where a public list came back carrying 132 bytes of
  // ciphertext holding no entries. It cost a signer round trip per publish and
  // put a private half on the wire for users who had never asked for one.
  const privateNodes = input.privateMerged ? input.privateMerged.nodes.length : 0;
  const privateTags = input.privateMerged && privateNodes > 0 ? tagsFromList(input.privateMerged) : null;
  const privateEmpty = privateTags === null;
  // Rule 5, on the private half: BOTH SIDES THROUGH OUR OWN FRAMING. It is a tag
  // array with the same free slots as the public one, so a half another app
  // wrote with a `k` beside every `i` would otherwise differ from itself on
  // every cycle — and each of those costs a signer round trip to re-encrypt a
  // list nothing changed. No `visibility` on either side: the mode is a property
  // of the list, and a claim made inside a half is one no reader may act on.
  const privateSame = privateUnreadable
    ? true // carried verbatim, so by definition nothing about it changes
    : JSON.stringify(frameForCompare(privateTags ?? [], null))
      === JSON.stringify(frameForCompare(readPrivateTags, null));

  const encryptPrivate = !privateUnreadable && !privateSame && !privateEmpty;
  // Unchanged ⇒ carry the ciphertext we read, byte for byte. Changed ⇒ either
  // we encrypt (and the caller fills this in) or the half is now empty, and an
  // empty private half is an empty `content`.
  const content = privateSame ? readContent : '';

  const plan = (publish: boolean, reason: PublishReason): FavoritesPlan => ({
    publish,
    reason,
    tags,
    baseline,
    privateTags,
    content,
    encryptPrivate: publish && encryptPrivate,
  });

  // Never write on top of a read that may have failed silently. Wholesale
  // replacement makes this the most expensive mistake the format allows: one
  // bad read, republished, is the entire list gone.
  if (!input.trustworthy) return plan(false, 'degraded');

  // A CIPHERTEXT WE COULD NOT READ IS NOT A CIPHERTEXT WE MAY WRITE OVER.
  //
  // Carrying it verbatim is always safe, so a publish that only touches the
  // public half proceeds. A publish that has to CHANGE `content` cannot: it
  // would replace entries we never decoded, which is the same wholesale
  // deletion the guard below refuses, arriving through a door that guard does
  // not watch.
  //
  // In 'private' mode that is every publish — including the half-finished state
  // during a switch, where this device still has public baseline entries to
  // drop. Publishing only the drop would take them off the public half without
  // ever putting them in the private one. A WITHDRAWAL is the other one: it
  // empties both halves by definition, so it cannot carry `content` verbatim.
  //
  // **The question is whether this plan must CHANGE `content`, never whether an
  // emptiness was intentional.** `emptyIsIntentional` is `withdraw ||
  // localCleared`, and the second is a public-mode delete-all — which carries
  // the ciphertext untouched (`privateSame` is hard-coded true for an unreadable
  // half, so `content = readContent`). Folding it in refused a publish that
  // changes nothing about `content`, and the refusal is permanent: `favCleared`
  // is only retired by `recordFavoritesBaseline`, which never runs because the
  // plan never publishes. The user reads "Your signer couldn't open the private
  // half" forever and their delete-all never leaves the device.
  //
  // Not every signer implements NIP-44, and Amber is deliberately not asked to
  // decrypt unattended, so this is an ordinary state rather than an error —
  // which is exactly why it has to reach the screen. "Hidden here by choice"
  // and "this app cannot read it" both render as a shorter list.
  const wantsPrivateWrite = mode === 'private' || !!input.withdraw;
  if (privateUnreadable && wantsPrivateWrite) return plan(false, 'private-unreadable');

  // ONLY NOW may we say "nothing changed", and the order is the whole point.
  //
  // `privateSame` is TRUE when the private half is unreadable — it has to be,
  // because a ciphertext we carry verbatim cannot differ from itself. Ask this
  // question first and a private-mode cycle that failed to decrypt reports
  // 'unchanged' rather than refusing: `syncFavorites` then calls `onSynced`,
  // and the baseline it records claims the favorite the user just made was
  // published. `local − baseline` is empty for that id from then on, so it is
  // NEVER PUBLISHED AGAIN, while the UI reports success — the same permanent
  // loss `assertPublished` exists to prevent, arriving through a door it does
  // not watch.
  //
  // Found by writing the sequence out as a check vector: the first private
  // publish works, and the second one silently swallows the entry.
  //
  // AND THE COMPARISON IS AGAINST THE READ REFRAMED, NEVER THE READ AS IT
  // ARRIVED (rule 5). `tags` is already our framing; the read gets the same
  // treatment, carrying the visibility IT stated rather than the one we are
  // about to write — see `frameForCompare`. Comparing raw made a list written in
  // either of the two legal `k` layouts differ from itself on every load, so two
  // conforming apps rewrite the event at each other indefinitely.
  //
  // GATED ON THE EVENT EXISTING, which reframing made load-bearing. "Unchanged"
  // is a claim that the relay already holds these bytes, and an absent event
  // holds none. Framing an empty read yields our `alt` tag, so without this an
  // account with no favorites and no event matches its own empty merge and
  // reports 'unchanged' — which is `nothing-to-create`'s answer, given a name
  // that tells `syncFavorites` to record a baseline for an event nobody wrote.
  if (input.exists
    && privateSame
    && JSON.stringify(tags)
      === JSON.stringify(frameForCompare(input.readTags, statedVisibility(input.readTags)))) {
    return plan(false, 'unchanged');
  }

  const publicNodes = input.merged.nodes.length;

  // Don't mint an empty event for a user who has no favorites — otherwise every
  // signed-in visitor gets a kind:10333 they never asked for.
  if (!input.exists && publicNodes === 0 && privateNodes === 0) {
    return plan(false, 'nothing-to-create');
  }

  // A MERGE THAT COMES OUT EMPTY OVER A LIST THAT IS NOT IS NEVER A USER ACTION.
  //
  // This is the hole the guard above only half covered: it declines to CREATE
  // an empty event and says nothing about replacing a full one with an empty
  // one. On 2026-08-21 that cost a live account 213 groups and 232 items in a
  // single publish, and the read was perfectly healthy, so `trustworthy` was
  // true and the degraded branch never fired.
  //
  // The mechanism is `mergeFavoritesList`'s removal test, which is correct in
  // isolation:
  //
  //     ours, and we no longer hold it  ⇒  the user removed it here
  //
  // `local` empty with a populated baseline satisfies that for EVERY entry at
  // once, so the merge dutifully removes all of them. But "this device holds
  // nothing" is not the same claim as "the user cleared their favorites" — it
  // is also what an unhydrated store looks like, and the store is rebuilt from
  // scratch on every page load while the baseline is read from disk.
  //
  // WITH A PRIVATE HALF THIS IS ASKED OF THE UNION, NEVER OF EITHER HALF ALONE.
  // Switching to private legitimately empties the public merge over a non-empty
  // read — the exact shape below — so a per-half test would refuse the feature
  // it exists to protect. A mode switch moves entries across and the union never
  // drops, while an unhydrated store empties both at once.
  //
  // **BUT THE UNION MUST BE OVER LOCALLY-FED NODES, NEVER OVER `nodes.length`.**
  // The tempting version reads the merged totals, and its justification — "both
  // halves are fed from ONE local list" — is false for the half of the merge
  // that matters here. `mergeFavoritesList` also CARRIES another writer's
  // entries through untouched, and those are fed by no local state at all. So a
  // single foreign entry in the private half makes `privateMerged.nodes.length`
  // 1 while the public merge is legitimately 0, the guard never fires, and the
  // public half publishes as an alt-only tag array: the 2026-08-21 wipe, from a
  // guard written to prevent exactly it. `localFed` is the provenance count that
  // answers the question actually being asked.
  //
  // Refusing costs a user who genuinely emptied their list one extra action.
  // Publishing costs every favorite they have, on every device, with no undo,
  // and a replaceable event keeps no history to recover from. That trade is not
  // close. Deliberately keyed on what the RELAY holds rather than on the
  // baseline: it is the thing about to be overwritten, and it is true even if
  // the baseline is itself corrupt.
  const readHadEntries =
    input.readTags.some((t) => t[0] === 'i') || readPrivateTags.some((t) => t[0] === 'i');
  // `?? nodes.length` is the conservative fallback for a list that did not come
  // from a merge: over-counting can only make this guard fire LESS, so it must
  // never be the silent default for a merged list — which is why
  // `mergeFavoritesList` always sets the field.
  const publicLocalFed = input.merged.localFed ?? input.merged.nodes.length;
  const privateLocalFed = input.privateMerged
    ? input.privateMerged.localFed ?? input.privateMerged.nodes.length
    : 0;
  if (publicLocalFed === 0 && privateLocalFed === 0 && readHadEntries && !input.emptyIsIntentional) {
    return plan(false, 'wholesale-delete');
  }

  // A private list too big for the oldest NIP-44 in the wild reads back as
  // EMPTY on whatever app hits the cliff, not as an error. Refusing here costs
  // one favorite; publishing costs the whole list on that device.
  if (
    encryptPrivate &&
    privateTags &&
    plaintextBytes(encodePrivateFavorites(privateTags)) > PRIVATE_PLAINTEXT_MAX
  ) {
    return plan(false, 'private-too-large');
  }

  return plan(true, 'publish');
}

// ---------------------------------------------------------------------------
// Projecting back out, for rendering
// ---------------------------------------------------------------------------

export interface ListFeed {
  feedGuid: string;
  medium?: string;
  /**
   * No items under this group.
   *
   * TRUE is the only unambiguous statement the format makes about a feed
   * favorite. A group is opened for every parent of a favorited item, so a
   * group WITH items may exist solely to name that parent — reading it as a
   * favorite manufactures albums the user never chose. Measured on the live
   * list this was built against: 197 groups carrying 38 unambiguous favorites.
   */
  itemless: boolean;
}

export interface ListItem {
  itemGuid: string;
  /** undefined for an orphan — an item that named no parent. */
  feedGuid?: string;
  medium?: string;
}

export interface PartitionedList {
  feeds: ListFeed[];
  items: ListItem[];
  /** Loose entries we could not place, for diagnostics and the cleanup hook. */
  loose: LooseEntry[];
  /** `podcast:guid:` identifiers whose guid is not a UUID. */
  malformed: string[];
}

/** Flatten the node list into the rows the app renders. */
export function partitionList(list: ParsedList): PartitionedList {
  const feeds: ListFeed[] = [];
  const items: ListItem[] = [];
  const loose: LooseEntry[] = [];
  const malformed: string[] = [];

  for (const node of list.nodes) {
    if (node.t === 'group') {
      const { feedGuid, medium, itemGuids } = node.group;
      feeds.push({ feedGuid, medium, itemless: itemGuids.length === 0 });
      // PC 2.0 has no per-item medium; an item takes its group's.
      for (const itemGuid of itemGuids) items.push({ itemGuid, feedGuid, medium });
      continue;
    }

    if (node.t === 'item') {
      // An item that names its own feed. It yields NO `ListFeed`: under the
      // current format a feed entry is the only statement that the user
      // favorited a feed, so manufacturing one here would invent an album
      // favorite out of another app's saved track.
      items.push({ itemGuid: node.item.itemGuid, feedGuid: node.item.feedGuid, medium: node.item.medium });
      continue;
    }

    loose.push(node.loose);
    const id = node.loose.tag[1];
    if (!id) continue;
    if (id.startsWith(SHOW_PREFIX)) {
      malformed.push(id);
      continue;
    }
    const itemGuid = parseItemGuid(id);
    if (itemGuid !== null) items.push({ itemGuid, medium: node.loose.medium });
  }

  return { feeds, items, loose, malformed };
}

/**
 * The rows of an INACTIVE half this device may adopt into its own store.
 *
 * The app renders the union of both halves as one library, but it publishes
 * into ONE of them — so anything it adopts out of the half it is not using is
 * republished into the half it IS using on the next cycle. For this device's
 * own entries that is the point: a mode switch moves them. For another writer's
 * it is a migration nobody asked for, and in the public direction it is a
 * disclosure — a private entry re-emitted as a plaintext `i` tag, which relays
 * index, which makes it reverse-searchable by feed. That is the property the
 * private half exists to provide.
 *
 * The baseline is the only thing that can tell the two apart, because it names
 * exactly what this device put there. So the active half is adopted whole and
 * the inactive half is filtered through this.
 *
 * `loose` and `malformed` come back EMPTY on purpose. A loose entry is by
 * definition one we have no meaning for, so it is carried on the wire and never
 * adopted; `malformed` drives a cleanup hook that only ever edits the public
 * half, and offering to remove an entry from the other one would print a count
 * and take nothing away.
 *
 * An item survives without its feed row: `ListItem` carries its own `feedGuid`,
 * and a group the baseline does not claim is one we opened only to place a
 * track — not a favorite of the feed.
 */
export function claimedByBaseline(
  part: PartitionedList,
  baseline: FavoritesBaseline,
  half: ListHalf,
): PartitionedList {
  const claimed = baselineHalf(baseline, half);
  const feedSet = new Set(claimed.feeds);
  const itemSet = new Set(claimed.items);
  return {
    feeds: part.feeds.filter((f) => feedSet.has(showId(f.feedGuid))),
    items: part.items.filter((i) => claimedItem(itemSet, itemId(i.itemGuid), i.feedGuid)),
    loose: [],
    malformed: [],
  };
}

/**
 * The inverse of {@link groupLocalFavorites}: the flat entries that regroup
 * into this list.
 *
 * Used to pin that the store rebuild is a fixed point — what we render is what
 * we would republish, so a rendering pass can never quietly change the wire.
 * Loose entries are excluded: they are carried from the read, never asserted by
 * this device.
 */
export function entriesFromList(list: ParsedList): FavoriteEntry[] {
  const entries: FavoriteEntry[] = [];
  for (const node of list.nodes) {
    if (node.t === 'item') {
      // CLAIMED, because this app adopts it. The store paints an item entry into
      // the library and offers a heart on it, so it has to enter the baseline —
      // otherwise the removal test can never fire for it and unfavoriting it is
      // a control that does nothing, on every device, forever.
      entries.push({ id: itemId(node.item.itemGuid), feedRef: node.item.feedGuid, medium: node.item.medium });
      continue;
    }
    if (node.t !== 'group') continue;
    const { feedGuid, medium, itemGuids } = node.group;
    if (itemGuids.length === 0) {
      entries.push({ id: showId(feedGuid), medium });
      continue;
    }
    for (const itemGuid of itemGuids) {
      entries.push({ id: itemId(itemGuid), feedRef: feedGuid, medium });
    }
  }
  return entries;
}
