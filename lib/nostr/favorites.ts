import type { Event, EventTemplate } from 'nostr-tools';
import {
  assertPublished,
  NoRelayAcceptedError,
  signAndPublish,
  type PublishedNote,
} from './publish';
import { fetchLatestEventDetailed } from './event-queries';
import { QUERY_MAX_WAIT_MS } from './pool';
import {
  EMPTY_LOCAL,
  EMPTY_PARSED,
  FAVORITES_KIND,
  baselineHalf,
  decodePrivateFavorites,
  encodePrivateFavorites,
  WHOLE_LIST_PRIVACY_MOVE,
  foldHalves,
  mergeFavoritesList,
  parseFavoritesList,
  planFavoritesPublish,
  type FavoritesBaseline,
  type FavoritesPrivacy,
  type LocalList,
  type ParsedList,
  type PublishReason,
} from './favorites-list';
import { decryptWithTimeout, getNip44, requireNip44, type DecryptPurpose } from './signer';
import { payloadSurvivesAmber } from './amber-callback-url';
// ---------------------------------------------------------------------------
// Cross-app favorites — the I/O half. The wire format and the merge live in
// `favorites-list.ts`, which is import-free so scripts/check-favsync.mjs can
// load the real thing; everything there is re-exported below so callers only
// import this module.
//
// This event is SHARED with other podcast apps, at a single well-known address
// per pubkey, and it is REPLACEABLE — so every writer can destroy every other
// writer's data with one blind publish, and there is no partial update to fall
// back on. That is why there is no exported "publish my favorites": only
// `syncFavorites`, which reads first, and `publishFavoritesTags`, which takes
// an already-merged tag array and is not exported beyond this module's own
// callers.
// ---------------------------------------------------------------------------

export * from './favorites-list';

export interface FavoritesRead {
  /**
   * The signed event exactly as the relay sent it, or null when none exists.
   *
   * Every other field here is DERIVED from it, and this one is kept because a
   * derivation cannot be verified or republished: `id` and `sig` are what let
   * anything outside this app prove the list is the user's own, and they are
   * not reconstructible from `tags` (the id is a hash over the whole event,
   * and re-signing needs the secret key). It is what `<DownloadFavorites>`
   * writes to disk — a backup that cannot be re-published by another Nostr
   * tool is not a backup of a replaceable event, it is a transcript of one.
   *
   * Read-only. Nothing in the sync path may take tags from here instead of
   * from `tags`: those two are the same array today and a future intake filter
   * would have to change one of them.
   */
  event: Event | null;
  /** The parsed node list, in wire order. */
  list: ParsedList;
  /**
   * The raw tags exactly as they arrived, or [] when no event exists.
   *
   * Kept alongside the parsed form because "did anything change" is a BYTE
   * comparison against what the relay holds, not a membership one — order and
   * grouping are semantic here, so two lists with identical membership can mean
   * different things.
   */
  tags: string[][];
  /** unix seconds, from event.created_at. 0 when no event exists. */
  updatedAt: number;
  exists: boolean;
  /**
   * The read can be trusted. False means "nothing answered", NOT "the list is
   * empty" — never merge or publish on top of a false here. Under wholesale
   * replacement this is the most expensive mistake the format allows: one bad
   * read, republished, is the entire list gone.
   */
  trustworthy: boolean;

  // -- the private half -----------------------------------------------------

  /**
   * `event.content` EXACTLY as it arrived, always.
   *
   * This is the carry rule and it is not optional, whatever this app does with
   * a private half of its own. The spec's rule 4 ("carry what you can't read")
   * covers tags and says nothing about `content`, so a writer following the
   * document to the letter republishes the empty string the format has
   * specified from the start — and erases every private entry another app
   * wrote, silently, on someone else's device, with no undo. There is nothing
   * to decrypt and nothing to understand: keep the bytes.
   */
  content: string;
  /** The decrypted private half, parsed. Null when absent or unreadable. */
  privateList: ParsedList | null;
  /** The decrypted private half's raw tags. [] when absent or unreadable. */
  privateTags: string[][];
  /**
   * `content` is non-empty and we did not turn it into tags.
   *
   * ONE state for four different causes, deliberately: the caller declined to
   * spend a signer prompt, the signer exposes no NIP-44, the decrypt threw or
   * timed out, or the plaintext was not a tag array. Downstream they mean the
   * same thing — carry the ciphertext, derive nothing from it — and collapsing
   * them here is what stops a fifth cause being handled differently by
   * accident. `lib/nostr/mutes.ts` treats the fourth as readable-and-empty,
   * which is how a blob gets rewritten out of existence.
   */
  privateUnreadable: boolean;
}

export interface FavoritesReadOptions {
  /**
   * Spend a signer call on the private half. Default false.
   *
   * Off is the honest default: this read runs on every page load, and a signer
   * prompt on a cold start is not something the user asked for. See
   * `hydrateFavorites`, which additionally refuses on Amber for the reason
   * `mutes-hydrator.ts` spells out.
   */
  decryptPrivate?: boolean;
  /**
   * Whether the user asked for this. REQUIRED when decrypting, and PASSED
   * THROUGH from the call — never hardcoded here. Hardcoding it one level up is
   * how `fetchEncryptedMnemonic` silently overrode every caller and broke the
   * wallet modal's own restore button for a release.
   */
  purpose?: DecryptPurpose;
}

const EMPTY_READ: FavoritesRead = {
  event: null,
  list: { nodes: [], foreignTags: [], foreignKinds: [] },
  tags: [],
  updatedAt: 0,
  exists: false,
  trustworthy: true,
  content: '',
  privateList: null,
  privateTags: [],
  privateUnreadable: false,
};


/**
 * Turn `event.content` into tags, or decide we cannot.
 *
 * Every failure lands on the same answer — park the ciphertext, report
 * `privateUnreadable`, derive nothing from it — which is what lets every caller
 * downstream have one branch instead of four. The shape is lifted from
 * `lib/nostr/mutes.ts`, with the hole that file has closed: a `JSON.parse` that
 * succeeds on something that is not a tag array leaves the blob marked readable
 * and empty there, and the next republish rewrites `content` from those empty
 * lists and destroys it. `decodePrivateFavorites` returns null for that case.
 */
async function readPrivateHalf(
  pubkey: string,
  content: string,
  opts: FavoritesReadOptions,
): Promise<Pick<FavoritesRead, 'privateList' | 'privateTags' | 'privateUnreadable'>> {
  // A function, not a shared constant: each caller gets its own array, so
  // nothing downstream can mutate the "no private half" answer for everyone.
  const unreadable = () => ({ privateList: null, privateTags: [], privateUnreadable: true });
  if (!content) return { privateList: null, privateTags: [], privateUnreadable: false };

  if (!opts.decryptPrivate || !opts.purpose) {
    // eslint-disable-next-line no-console
    console.info(
      '[favorites] kind:10333 carries an encrypted half and we are not spending a signer '
      + 'call to read it here — carried verbatim, and the local cache still renders',
    );
    return unreadable();
  }
  if (!getNip44()) {
    // eslint-disable-next-line no-console
    console.info(
      '[favorites] kind:10333 carries an encrypted half but this signer has no NIP-44 — '
      + 'private favorites will round-trip opaquely',
    );
    return unreadable();
  }

  try {
    const plaintext = await decryptWithTimeout(pubkey, content, opts.purpose);
    const tags = decodePrivateFavorites(plaintext);
    if (!tags) {
      // eslint-disable-next-line no-console
      console.warn('[favorites] private half decrypted to something that is not a tag array — preserving as an opaque blob');
      return unreadable();
    }
    return { privateList: parseFavoritesList(tags), privateTags: tags, privateUnreadable: false };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      '[favorites] private half decrypt failed — preserving as an opaque blob:',
      (e as Error)?.message ?? e,
    );
    return unreadable();
  }
}

/**
 * Read this account's favorites list.
 *
 * `queryRelays` is REQUIRED, and the missing default is the point. It used to
 * fall back to `DEFAULT_RELAYS` while every publish went to
 * `resolvePublishRelays` (the user's NIP-65 write set ∪ the defaults), so a
 * newer event living only on the user's own write relay was invisible to the
 * read and got published over on the next merge — a narrower read than write is
 * exactly how you overwrite data you never saw. Pass the publish set.
 */
export async function fetchFavoritesList(
  pubkey: string,
  queryRelays: string[],
  opts: FavoritesReadOptions = {},
): Promise<FavoritesRead> {
  const { event, trustworthy } = await fetchLatestEventDetailed(
    queryRelays,
    { kinds: [FAVORITES_KIND], authors: [pubkey], limit: 1 },
    QUERY_MAX_WAIT_MS,
    // Belt and braces on the one read where a wrong event is worst: whatever
    // lands here is merged over and republished under the user's key, so an
    // event for another pubkey or kind would be laundered into their favorites.
    //
    // `dTag: ''` matches an event with NO `d` tag (see `acceptsEvent`), which is
    // what kind 10333 is — a plain replaceable event, one per pubkey. Without
    // it an addressable event that happened to share the kind would be
    // accepted, and its `d` tag would then be dropped on republish.
    { pubkey, kinds: [FAVORITES_KIND], dTag: '' },
  );
  if (!event) return { ...EMPTY_READ, trustworthy };

  const priv = await readPrivateHalf(pubkey, event.content, opts);

  return {
    ...priv,
    event,
    content: event.content,
    list: parseFavoritesList(event.tags),
    tags: event.tags,
    updatedAt: event.created_at,
    exists: true,
    trustworthy: true, // an event in hand is its own proof the query worked
  };
}

/**
 * Publish an already-merged tag array.
 *
 * Takes tags rather than a model on purpose: the array IS the data, and a
 * function that rebuilt it here would be a second emitter to keep in step with
 * `tagsFromList`. Everything that reaches this point has been through the
 * merge.
 *
 * `content` is REQUIRED and has no default, for the same reason `queryRelays`
 * above has none. It used to be hardcoded to `''`, which is correct only while
 * no app in the world puts anything there — and one now does. Whatever reaches
 * this function must have come from the read, verbatim, or from an encryption
 * the plan asked for. A `''` written by habit is another app's private
 * favorites deleted.
 *
 * Throws {@link NoRelayAcceptedError} when the event reached nobody. The assert
 * lives HERE rather than at each call site because every writer records a
 * baseline immediately afterwards, and a baseline written for an event that
 * never landed permanently stops those entries from being retried — `local −
 * baseline` is empty for them from then on, so they are never published again
 * while the UI reports success.
 */
export async function publishFavoritesTags(
  tags: string[][],
  content: string,
  relays: string[],
): Promise<PublishedNote> {
  const template: EventTemplate = {
    kind: FAVORITES_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
  };
  return assertPublished(await signAndPublish(template, relays), 'favorites');
}

export interface SyncOptions {
  pubkey: string;
  relays: string[];
  /** This device's current favorites, grouped for the wire. */
  local: () => LocalList;
  /** What this device last agreed with the relay on. */
  baseline: () => FavoritesBaseline;
  /** Called with the new baseline once the event lands. */
  onSynced: (baseline: FavoritesBaseline) => void;
  /**
   * Called instead of publishing when the read came back untrustworthy. The
   * skip is correct but invisible, and a heart-tap that never propagates looks
   * exactly like one that did — so the caller gets told. Injected like
   * `onSynced` rather than reaching for the store here, which keeps this module
   * free of React and browser globals.
   */
  onDegraded?: (reason: PublishReason) => void;

  // -- the private half -----------------------------------------------------

  /**
   * Where this device puts the favorites it owns. Defaults to 'public'.
   *
   * ONE choice for the whole list: `local()` goes wholly into one half, and the
   * other half is still read, merged and carried so another app's entries
   * survive.
   *
   * **'off' DOES reach here, and the early return below is why it is safe.**
   * `requestFavoritesSync` tests the mode at SCHEDULE time and then hands the
   * work to a debounce; `cycleOptionsFor` re-reads it at fire time, so a user
   * who taps a heart and immediately chooses "Not on Nostr" arrives here with
   * mode 'off'. Without a check, anything that is not 'private' is treated as
   * public and the whole library is published seconds after the dialog said
   * "Kept on this device only. Nothing is sent to Nostr." A withdrawal is the
   * one exception: it is how entries are taken OFF the relays, and it is always
   * user-initiated.
   */
  mode?: FavoritesPrivacy;
  /**
   * Whether the user asked for this, for the private half's decrypt. Passed
   * through to `fetchFavoritesList`; omitted, the private half is not decrypted
   * at all and is carried opaquely.
   */
  purpose?: DecryptPurpose;
  /**
   * Take this device's entries OFF the relays and publish nothing further.
   *
   * Both halves get an empty local list, so the merge drops exactly what this
   * device's baseline claims and carries everything else — another app's
   * entries are untouched, including a group of ours that is the only thing
   * naming a surviving foreign item's parent. It is also the one caller allowed
   * past the wholesale-delete refusal, because here the empty merge IS the
   * request.
   */
  withdraw?: boolean;
  /**
   * This device is holding nothing ON PURPOSE — the user unfavorited their
   * whole list, recorded by the store's removers at the moment it happened.
   *
   * It is not the same claim as `withdraw`, which also empties the halves
   * itself. Here the locals are already empty and this only says the emptiness
   * is meant, so the two guards that refuse an empty merge can tell it from an
   * unhydrated store. Passed in rather than read here, so this module stays
   * free of storage.
   */
  localCleared?: boolean;
}

/**
 * Encrypt the private half to the author's own key.
 *
 * The `payloadSurvivesAmber` check is a backstop for a bug, not a user-facing
 * state, which is why it throws rather than becoming a plan reason.
 * `encodePrivateFavorites` writes `?` as `\u003f` precisely so this can never
 * fire; if it ever does, the escaping has regressed and the alternative is
 * handing Amber a URI it will silently truncate at the first `?`, encrypting
 * the truncated text, and storing a private favorites list that is missing
 * everything after one item guid. A throw reaches the debounce's warn. A
 * truncated publish reaches the relays.
 */
async function encryptPrivateHalf(pubkey: string, tags: string[][]): Promise<string> {
  const plaintext = encodePrivateFavorites(tags);
  if (!payloadSurvivesAmber(plaintext)) {
    throw new Error(
      'favorites: private plaintext contains "?" after encoding — refusing to hand an '
      + 'external signer a payload it will truncate. encodePrivateFavorites has regressed.',
    );
  }
  return requireNip44().encrypt(pubkey, plaintext);
}

/**
 * Take this device's favorites off the relays, and leave every other writer's
 * alone.
 *
 * Deliberately a separate export rather than a flag on the sync options the UI
 * can reach: it is the one path allowed past the wholesale-delete refusal, and
 * a caller that could set that flag by accident is a caller that can empty a
 * shared list. It still reads first, and it still refuses on an untrustworthy
 * read — "remove my entries" is not a licence to publish over a list we could
 * not see.
 */
export async function withdrawFavorites(
  opts: Omit<SyncOptions, 'withdraw'>,
): Promise<PublishedNote | null> {
  return syncFavorites({ ...opts, withdraw: true });
}

/**
 * Read → merge → publish, in one step. The read is what makes the write safe,
 * so they are never separated: a caller that could publish without reading is a
 * caller that can wipe another app's favorites.
 *
 * Returns null without recording anything in three cases: the read was
 * degraded, nothing changed, or the publish reached no relay. Losing a
 * republish is recoverable — the next toggle or page load retries it — whereas
 * publishing over a list we couldn't read is not.
 */
export async function syncFavorites(opts: SyncOptions): Promise<PublishedNote | null> {
  const mode: FavoritesPrivacy = opts.mode ?? 'public';
  // See `mode` in SyncOptions. A queued cycle can land after the user has turned
  // syncing off, and publishing then is the one thing the setting promises will
  // not happen. Returning null is the same "nothing recorded" answer every other
  // refusal gives, so nothing downstream writes a baseline off it.
  if (mode === 'off' && !opts.withdraw) return null;
  const read = await fetchFavoritesList(opts.pubkey, opts.relays, {
    decryptPrivate: !!opts.purpose,
    purpose: opts.purpose,
  });

  // ONE local list, split by the mode. Withdrawal empties both, which is what
  // makes it a removal of exactly this device's baseline rather than of the
  // event: `mergeFavoritesList` only drops what the baseline claims.
  const all = opts.local();
  const publicLocal = opts.withdraw || mode === 'private' ? EMPTY_LOCAL : all;
  const privateLocal = opts.withdraw || mode !== 'private' ? EMPTY_LOCAL : all;

  const baseline = opts.baseline();
  const merged = mergeFavoritesList({
    read: read.list,
    local: publicLocal,
    baseline: baselineHalf(baseline, 'public'),
  });
  // Null, not an empty merge, when we could not read it — the difference is
  // "carry these bytes" versus "there is nothing there", and only one of those
  // is safe to act on.
  const privateMerged = read.privateUnreadable
    ? null
    : mergeFavoritesList({
      read: read.privateList ?? EMPTY_PARSED,
      local: privateLocal,
      baseline: baselineHalf(baseline, 'private'),
    });

  // GOING PRIVATE TAKES THE WHOLE LIST — spec vector 13.
  //
  // Everything left in the public half after the merge above is another
  // writer's: ours was just removed from it, because the baseline claims it and
  // `publicLocal` is empty. The spec requires it to move too, and the asymmetry
  // is what makes that safe — public → private only ever REDUCES exposure and
  // is reversible by anything that can decrypt, while private → public is a
  // disclosure and stays limited to what our baseline claims.
  //
  // Without this the user gets "97% private": a choice the format honoured for
  // most of their list, with nothing on screen naming the part it did not.
  //
  // `foldHalves`, never a concatenation — see its own note, and vector 15.
  //
  // The moved entries are deliberately NOT claimed in the baseline. Nothing
  // local backs them, so a claim would read as our own removal on the next
  // cycle and delete them.
  const movingWholeList = WHOLE_LIST_PRIVACY_MOVE && mode === 'private'
    && !opts.withdraw && privateMerged !== null;
  const activeMerged = movingWholeList ? foldHalves(privateMerged!, merged) : privateMerged;
  const publicMerged = movingWholeList ? EMPTY_PARSED : merged;

  const plan = planFavoritesPublish({
    merged: publicMerged,
    readTags: read.tags,
    exists: read.exists,
    trustworthy: read.trustworthy,
    local: publicLocal,
    mode,
    privateMerged: activeMerged,
    readPrivateTags: read.privateTags,
    readContent: read.content,
    privateUnreadable: read.privateUnreadable,
    privateLocal,
    // Both provenances of an emptiness a person asked for: the withdrawal
    // dialog, and unfavoriting the whole list. See `emptyIsIntentional`.
    emptyIsIntentional: opts.withdraw || opts.localCleared,
    // Narrower than `emptyIsIntentional`, and the baseline needs the narrower
    // claim: a withdrawal feeds NEITHER half, so neither may be recomputed from
    // its merge, while an ordinary delete-all still feeds (and empties) the
    // active one.
    withdraw: opts.withdraw,
    previousBaseline: baseline,
  });

  if (plan.reason === 'degraded') {
    opts.onDegraded?.(plan.reason);
    // eslint-disable-next-line no-console
    console.warn('[favorites] skipping publish — could not read the current list');
    return null;
  }

  // Withheld, and it MUST be reported like a degraded read rather than falling
  // through to the `!plan.publish` branch below. That branch records the
  // baseline, and recording an empty baseline here is what would make the
  // refusal useless: the next cycle would diff against "we published nothing",
  // conclude there is nothing to remove, and quietly agree with the empty list
  // it just declined to write. `onDegraded` also surfaces <FavoritesSyncNotice>,
  // because a guard that silently withholds is indistinguishable from a broken
  // one — that is the same rule the degraded branch above exists for.
  if (plan.reason === 'wholesale-delete') {
    opts.onDegraded?.(plan.reason);
    // eslint-disable-next-line no-console
    console.warn(
      '[favorites] REFUSING to publish — the merge came out empty over a list that is not. '
      + 'This device is holding no favorites while the relay holds some, which is what an '
      + 'unhydrated store looks like as much as a real "remove everything".',
    );
    return null;
  }

  // The private half is a blob we never decoded, and this publish would have to
  // write over it. Same shape as a degraded read — keep local state, publish
  // nothing, record NO baseline — and the same reason for reporting it: the
  // user cannot otherwise tell "hidden here by choice" from "this app has not
  // been able to open it", and both render as a shorter list.
  if (plan.reason === 'private-unreadable') {
    opts.onDegraded?.(plan.reason);
    // eslint-disable-next-line no-console
    console.warn(
      '[favorites] REFUSING to publish — this list has an encrypted half we could not read, '
      + 'and this change would replace it. Carried verbatim instead.',
    );
    return null;
  }

  if (plan.reason === 'private-too-large') {
    opts.onDegraded?.(plan.reason);
    // eslint-disable-next-line no-console
    console.warn(
      '[favorites] REFUSING to publish — the private half is over the NIP-44 plaintext '
      + 'ceiling, and a payload past it reads back as EMPTY on an older signer rather than '
      + 'as an error.',
    );
    return null;
  }

  if (!plan.publish) {
    // Nothing to say: the relay already holds exactly these bytes. Still record
    // the baseline — without it the first unfavorite on this device has nothing
    // to diff against and silently fails to propagate.
    opts.onSynced(plan.baseline);
    return null;
  }

  // **Ask whether we can encrypt BEFORE trying to, or the failure is silent.**
  // `readPrivateHalf` only reaches its own `getNip44()` guard when `content` is
  // non-empty, so a FIRST private publish (`content === ''`) never establishes
  // that the signer can encrypt at all. `requireNip44()` inside
  // `encryptPrivateHalf` then throws, and the throw is not a
  // `NoRelayAcceptedError`, so it leaves this function entirely: no
  // `onDegraded`, no `PublishReason`, no notice — on the background path just
  // one line in `createScheduledPublish`'s console warn, while the user's
  // favorites quietly stop propagating. It is the same state as
  // 'private-unreadable', which does get a reason and a notice, so it gets the
  // same treatment.
  if (plan.encryptPrivate && plan.privateTags && !getNip44()) {
    opts.onDegraded?.('private-unreadable');
    // eslint-disable-next-line no-console
    console.warn(
      '[favorites] this signer cannot NIP-44 encrypt, so the private half cannot be written — '
      + 'keeping local favorites as-is and publishing nothing',
    );
    return null;
  }

  try {
    const content = plan.encryptPrivate && plan.privateTags
      ? await encryptPrivateHalf(opts.pubkey, plan.privateTags)
      : plan.content;
    const published = await publishFavoritesTags(plan.tags, content, opts.relays);
    // This line is why `assertPublished` exists: the baseline is a promise that
    // `local` will keep asserting these ids, and it may only be made about an
    // event that actually landed.
    opts.onSynced(plan.baseline);
    return published;
  } catch (e) {
    // Only the reached-nobody case is a relay problem. A signing rejection is
    // the user saying no, and reporting that as "couldn't reach the relays"
    // would be a lie — it rethrows to the debounce's own warn instead.
    if (!(e instanceof NoRelayAcceptedError)) throw e;
    opts.onDegraded?.('degraded');
    // eslint-disable-next-line no-console
    console.warn('[favorites] publish reached no relay — baseline unchanged, next toggle retries');
    return null;
  }
}

// The debounce that used to live here now sits in `favorites-sync.ts`, next to
// the serializer it has to compose with: every cycle must be both debounced AND
// queued behind any other in-flight cycle, and a scheduler exported from here
// would be a second, unserialized way in. This module can't import
// favorites-sync (that's the cycle it exists to avoid), so the pair lives
// there. See `serializeFavoritesCycle`.
