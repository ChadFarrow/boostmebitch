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
// exactly one per pubkey and republishing replaces it wholesale. The single
// most important property, and the one with no analogue in the two-address
// design this replaced:
//
//   TAG ORDER IS THE DATA.
//
// An `i` tag is bare — `['i', '<identifier>']`, two elements. An item's parent
// feed and its medium are carried by POSITION IN THE ARRAY and by nothing on
// the entry itself: `['medium', v]` is a running value applying to every entry
// after it, and an item belongs to the most recently opened feed group. So a
// client that parses entries into structs and rebuilds the array from them —
// sorting, deduping, or emitting groups in a different order — silently
// reattaches every item to the wrong feed, and nothing else in the format
// recovers the association.
//
// That is why the parsed model here is an ORDERED NODE LIST rather than the
// maps this app renders from, and why `tagsFromList` walks `nodes` in place
// instead of iterating a Map. The predecessor of this rule cost this repo every
// tag position past the third on every publish for the entire life of the
// feature; this is the same mistake one level up, with a bigger blast radius.
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
const MANAGED_TAGS = new Set(['alt', 'medium', 'i', 'k']);

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

/** A feed group and the items beneath it, in wire order. */
export interface FeedGroup {
  feedGuid: string;
  /** undefined means "not told". NEVER defaulted — see `tagsFromList`. */
  medium?: string;
  itemGuids: string[];
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
  | { t: 'loose'; loose: LooseEntry };

export interface ParsedList {
  /** Groups and loose entries, IN READ ORDER. The order is the data. */
  nodes: ListNode[];
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
export const EMPTY_PARSED: ParsedList = { nodes: [], foreignTags: [], foreignKinds: [] };

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
  return baselineFrom(groupLocalFavorites(entriesFromList(list)));
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
  let medium: string | undefined;
  let current: FeedGroup | null = null;

  for (const tag of tags) {
    const type = tag[0];

    if (type === 'alt') continue;

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

    const feedGuid = parseShowGuid(id);
    if (feedGuid !== null) {
      current = { feedGuid, medium, itemGuids: [] };
      nodes.push({ t: 'group', group: current });
      continue;
    }

    const itemGuid = parseItemGuid(id);
    if (itemGuid !== null && current) {
      if (!current.itemGuids.includes(itemGuid)) current.itemGuids.push(itemGuid);
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

  return { nodes, foreignTags, foreignKinds };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const mediumOfNode = (n: ListNode): string | undefined =>
  (n.t === 'group' ? n.group.medium : n.loose.medium);

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
    const group: FeedGroup = { feedGuid, medium, itemGuids: [] };
    byGuid.set(feedGuid, group);
    groups.push(group);
    return group;
  };

  for (const entry of entries) {
    const feedGuid = parseShowGuid(entry.id);
    if (feedGuid !== null) {
      ensure(feedGuid, entry.medium);
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
export function tagsFromList(list: ParsedList): string[][] {
  const tags: string[][] = [['alt', LIST_ALT]];

  for (const tag of list.foreignTags) tags.push(tag.slice());

  const emit = (node: ListNode) => {
    if (node.t === 'loose') {
      // The tag WHOLE, never rebuilt from its identifier.
      tags.push(node.loose.tag.slice());
      return;
    }
    tags.push(['i', showId(node.group.feedGuid)]);
    for (const guid of node.group.itemGuids) tags.push(['i', itemId(guid)]);
  };

  for (const node of list.nodes) if (!mediumOfNode(node)) emit(node);

  const mediums: string[] = [];
  for (const node of list.nodes) {
    const m = mediumOfNode(node);
    if (m && !mediums.includes(m)) mediums.push(m);
  }
  for (const medium of mediums) {
    tags.push(['medium', medium]);
    for (const node of list.nodes) if (mediumOfNode(node) === medium) emit(node);
  }

  // Derived from what we actually emitted, in emission order — never from the
  // model, so a `k` can't name a kind that isn't on the list.
  const kinds: string[] = [];
  for (const tag of tags) {
    if (tag[0] !== 'i' || !tag[1]) continue;
    const kind = identifierKind(tag[1]);
    if (kind && !kinds.includes(kind)) kinds.push(kind);
  }
  for (const kind of kinds) tags.push(['k', kind]);
  for (const kind of list.foreignKinds) {
    if (!kinds.includes(kind)) tags.push(['k', kind]);
  }

  return tags;
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
export function mergeFavoritesList({ read, local, baseline }: MergeInput): ParsedList {
  const localByGuid = new Map(local.groups.map((g) => [g.feedGuid, g]));
  const publishedFeeds = new Set(baseline.feeds);
  const publishedItems = new Set(baseline.items);
  const localItems = new Set(local.groups.flatMap((g) => g.itemGuids));

  /** Ours, and we no longer hold it ⇒ the user removed it here. */
  const weRemovedItem = (guid: string) =>
    publishedItems.has(itemId(guid)) && !localItems.has(guid);

  const localLooseIds = new Set(local.loose.map((l) => l.tag[1]).filter(Boolean));

  const nodes: ListNode[] = [];
  const taken = new Set<string>();
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

    const group = node.group;
    if (taken.has(group.feedGuid)) continue; // a duplicate group on the wire
    taken.add(group.feedGuid);

    const kept = group.itemGuids.filter((guid) => !weRemovedItem(guid));
    const mine = localByGuid.get(group.feedGuid);

    if (!mine) {
      // We opened this group once and no longer hold the feed. Drop it only
      // when there is nothing left to place; while any item survives, the group
      // must stay to name their parent. (The spec is explicit that unfavoriting
      // a feed whose track is still favorited is inexpressible — expressing it
      // anyway deletes another app's tracks.)
      if (publishedFeeds.has(showId(group.feedGuid)) && kept.length === 0) continue;
      nodes.push({ t: 'group', group: { ...group, itemGuids: kept } });
      continue;
    }

    localFed++;
    nodes.push({
      t: 'group',
      group: {
        feedGuid: group.feedGuid,
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
        itemGuids: [
          ...kept,
          ...mine.itemGuids.filter(
            (g) => !kept.includes(g) && !publishedItems.has(itemId(g)),
          ),
        ],
      },
    });
  }

  for (const group of local.groups) {
    if (taken.has(group.feedGuid)) continue;

    // Absent from the read entirely. Anything we already published and the relay
    // no longer has was removed by another writer, and re-adding it is the
    // resurrection loop — so only genuinely NEW entries go up.
    const fresh = group.itemGuids.filter((guid) => !publishedItems.has(itemId(guid)));

    // The group itself is ours-and-removed only if we published it. Skipping on
    // that alone would be wrong: a track the user has just favorited under an
    // album another app removed still has to be published, and it needs its
    // parent group reopened to say which album it came from. Skip only when
    // there is nothing new to carry.
    if (publishedFeeds.has(showId(group.feedGuid)) && fresh.length === 0) continue;

    taken.add(group.feedGuid);
    localFed++;
    nodes.push({ t: 'group', group: { ...group, itemGuids: fresh } });
  }

  for (const loose of local.loose) {
    const id = loose.tag[1];
    if (!id) continue;
    if (read.nodes.some((n) => n.t === 'loose' && n.loose.tag[1] === id)) continue;
    if (publishedItems.has(id) || publishedFeeds.has(id)) continue;
    localFed++;
    nodes.push({ t: 'loose', loose: { tag: loose.tag.slice(), medium: loose.medium } });
  }

  return { nodes, foreignTags: read.foreignTags, foreignKinds: read.foreignKinds, localFed };
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
      ...local.groups.flatMap((g) => g.itemGuids.map((i) => itemId(i))),
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

  const tags = tagsFromList(input.merged);

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
  // So an inactive half keeps only the claims whose entries are STILL THERE.
  // This is never applied to an UNREADABLE half: absence from a half we could
  // not open is not evidence of anything, and filtering on it would disown
  // every private entry at once.
  const stillPresent = (b: FavoritesBaseline, list: ParsedList | null | undefined): FavoritesBaseline => {
    if (!list) return b;
    const present = new Set<string>();
    for (const node of list.nodes) {
      if (node.t === 'loose') {
        const id = node.loose.tag[1];
        if (id) present.add(id);
        continue;
      }
      present.add(showId(node.group.feedGuid));
      for (const g of node.group.itemGuids) present.add(itemId(g));
    }
    return { feeds: b.feeds.filter((id) => present.has(id)), items: b.items.filter((id) => present.has(id)) };
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
  const pub = input.withdraw
    ? { feeds: [], items: [] }
    // Inactive public half (private mode), same rule as the private one below.
    : mode === 'private'
      ? stillPresent(carried('public'), input.merged)
      : withLoose(baselineOfList(input.merged), input.merged, input.local);
  // A half we could not read is carried for the same reason and one of its own:
  // it goes back verbatim, so what we asserted about it is still true, and
  // recomputing it from nothing would silently disown every private entry.
  const priv = input.withdraw
    ? { feeds: [], items: [] }
    // Unreadable: verbatim, always. We cannot see what is in there, so what we
    // asserted about it is still the best answer we have, and recomputing it
    // from nothing would silently disown every private entry.
    : privateUnreadable
      ? carried('private')
      // Inactive but readable — the post-switch case. Carry, minus what the
      // switch just moved out.
      : mode !== 'private'
        ? stillPresent(carried('private'), input.privateMerged)
        : withLoose(baselineOfList(input.privateMerged), input.privateMerged, input.privateLocal ?? EMPTY_LOCAL);
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
  const privateSame = privateUnreadable
    ? true // carried verbatim, so by definition nothing about it changes
    : JSON.stringify(privateTags ?? []) === JSON.stringify(readPrivateTags);

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
  if (privateSame && JSON.stringify(tags) === JSON.stringify(input.readTags)) {
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
    items: part.items.filter((i) => itemSet.has(itemId(i.itemGuid))),
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
