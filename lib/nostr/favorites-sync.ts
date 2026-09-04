'use client';

// The glue between the store's two favorite maps and the one shared kind:10333
// list on Nostr. Kept apart from `favorites.ts` so that module stays pure wire
// format + merge (and stays pinnable by scripts/check-favsync.mjs), and apart
// from `favorites-hydrator.ts` so <FavHeart> doesn't have to import the
// hydration path just to schedule a publish.

import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { resolvePublishRelays } from './relays';
import { createScheduledPublish } from './debounced-publish';
import {
  groupLocalFavorites,
  itemId,
  showId,
  syncFavorites,
  withdrawFavorites,
  type FavoriteEntry,
  type FavoritesRead,
  type LocalList,
  type SyncOptions,
} from './favorites';
// Straight from the import-free leaf rather than through './favorites': the
// predicate is pure and pinned by check:favsync, and routing it through the
// module that owns the network calls would only widen what this file depends on.
import {
  baselineIsTrustworthy,
  correctedModeFromWire,
  seedModeFromWire,
  EMPTY_BASELINE,
  PRIVATE_FAVORITES_ENABLED,
  type FavoritesBaseline,
  type FavoritesPrivacy,
} from './favorites-list';
import type { DecryptPurpose } from './signer';
import type { NostrIdentity } from './auth';

// ---------------------------------------------------------------------------
// Where this account's favorites go
// ---------------------------------------------------------------------------

/**
 * May this device offer the private half at all?
 *
 * `PRIVATE_FAVORITES_ENABLED` is false until every writer of kind:10333 carries
 * `content` through a republish — see the constant's own note for why shipping
 * ahead of that erases data on someone else's device. The localStorage half is
 * a per-machine escape hatch so the feature can be exercised end to end before
 * then; it is deliberately not per-npub, because it is a build switch a human
 * flips on their own machine rather than a preference.
 */
export function privateFavoritesEnabled(): boolean {
  return PRIVATE_FAVORITES_ENABLED || storage.favPrivateOptIn.get();
}

/**
 * This account's recorded choice, or null when it has never made one.
 *
 * Null is a real third state and must not be flattened to 'public'. It is what
 * `seedFavoritesMode` fills in from the wire for an account that already has a
 * list, and what makes the first-favorite prompt fire for an account that does
 * not. Defaulting it would publish a list before the user was ever offered the
 * choice — the one ordering this feature exists to get right.
 *
 * THE GATE DOES NOT REACH THIS FUNCTION, AND MUST NOT.
 *
 * It shipped downgrading a recorded 'private' to 'public' when
 * `privateFavoritesEnabled()` was false, on the reasoning that the flag should
 * be a real off switch. That is a plaintext leak: a device that already keeps
 * its favorites in `content` — one that used the hatch, or a second device the
 * choice synced to — would read 'public', put `localFavoriteList()` in the
 * PUBLIC half, and republish the user's whole library as indexed `i` tags,
 * beside the encrypted half it was quietly ignoring. The user chose private and
 * a build that cannot offer private must not silently do the opposite.
 *
 * What the gate actually governs is whether you can CHOOSE private — the
 * control offers it, and `<FavoritesPrivacyModal>` accepts it — which is the
 * whole safety property: no new private half is created until every writer
 * carries `content`. One that already exists keeps working, because abandoning
 * it is worse than maintaining it.
 */
export function favoritesMode(npub: string): FavoritesPrivacy | null {
  return storage.favPrivacy.get(npub);
}

/** Record the choice. Returns whether it reached disk. */
export function setFavoritesMode(npub: string, mode: FavoritesPrivacy): boolean {
  return storage.favPrivacy.set(npub, mode);
}

/**
 * Give an account that already has a list the mode its list already implies.
 *
 * Existing users are seeded, never interrogated: a first-favorite prompt aimed
 * at someone with 200 favorites is a question about a decision they made long
 * ago, and answering it wrong is a publish. The wire says which half they are
 * in, so ask the wire.
 *
 * Runs only on a TRUSTWORTHY read, and only when nothing is recorded yet. The
 * rule itself is `seedModeFromWire` in the import-free leaf, so `check:favsync`
 * can hold it — this half only supplies the two booleans and persists the
 * answer. Null means the wire could not say, and a null mode publishes nothing
 * at all, so the safe state is also the default one.
 */
export function seedFavoritesMode(npub: string, read: FavoritesRead): FavoritesPrivacy | null {
  const existing = favoritesMode(npub);
  const hasPublicNow = read.tags.some((t) => t[0] === 'i');
  const hasPrivateNow = read.privateUnreadable || read.privateTags.some((t) => t[0] === 'i');
  if (existing) {
    // A RECORDED MODE IS NOT THE LAST WORD, because it does not come only from
    // this device. `favPrivacy` rides in the kind:30078 settings backup, whose
    // d-tag is unbranded on purpose, so a stale `'public'` is restored on every
    // sign-in on every device and both deploys — and this function used to
    // return here without ever asking the wire. In public mode the private half
    // is then filtered by `claimedByBaseline`, which on a device with no
    // baseline drops all of it: measured at 218 feeds and 230 items rendering
    // as an empty library, with no error anywhere. See `correctedModeFromWire`
    // for why the correction only ever runs public → private.
    // THE STATED MODE FIRST, and in BOTH directions. `correctedModeFromWire`
    // only ever corrects public → private, because emptiness cannot tell the
    // user's intent from another app's entries and the safe direction was the
    // only one available. `visibility` IS that intent, written by an app that
    // could read both halves, so following it is not a guess.
    const stated = read.list.visibility;
    const corrected = stated && stated !== existing
      ? stated
      : correctedModeFromWire(existing, hasPublicNow, hasPrivateNow);
    if (corrected) {
      setFavoritesMode(npub, corrected);
      return corrected;
    }
    return existing;
  }
  const hasPublic = read.tags.some((t) => t[0] === 'i');
  // An opaque `content` counts: we cannot read it, but its presence is still
  // evidence that this account keeps a private half, and seeding 'public' over
  // it would move the whole list into plaintext on the next toggle.
  //
  // Ungated, for the reason on `favoritesMode`: seeding follows the data, never
  // the build flag.
  const hasPrivate = read.privateUnreadable || read.privateTags.some((t) => t[0] === 'i');
  // Again the tag first: emptiness answers for a list that HOLDS entries and
  // cannot answer for one that holds none, which is where every user starts.
  const seeded = read.list.visibility ?? seedModeFromWire(hasPublic, hasPrivate);
  if (seeded) setFavoritesMode(npub, seeded);
  return seeded;
}

// `unattendedDecryptOk` used to live here, and now lives in ./signer beside
// `canSignUnattended`, which is the question it is a sibling of and where
// somebody looking for it would look. Re-exported so every consumer of this
// module is unaffected — see there for what it decides and why a bunker counts.
export { unattendedDecryptOk, listDecryptOnLoadOk } from './signer';

/**
 * This device's favorites as flat wire entries — both maps in one list, because
 * they share one Nostr event.
 *
 * An episode carries its parent feed guid, without which it cannot be grouped
 * (and cannot be resolved through PI, which needs a `podcastguid`). One with no
 * parent is not dropped: `groupLocalFavorites` keeps it as an orphan ahead of
 * the groups, because losing a track because we can't name its album is a worse
 * trade than an unplaceable entry.
 *
 * Neither carries a feed URL. `FavoritePodcast.url` and `FavoriteEpisode.feedUrl`
 * are still populated and still used for rendering — kind:10333 simply has no
 * slot for one, an `i` tag there being bare.
 */
export function localFavoriteEntries(): FavoriteEntry[] {
  const state = useApp.getState();
  const entries: FavoriteEntry[] = [];
  // `carried` entries are skipped, and this is the ONE place that decides it.
  // They live in the half this device does not write into and our baseline does
  // not claim them, so they are the user's to see and not ours to assert. An
  // entry that got past here would be republished into the ACTIVE half on the
  // next cycle — in public mode that is a private entry turned into a plaintext
  // `i` tag, which relays index and which cannot be taken back. See `carried`
  // in lib/types.ts.
  for (const fav of Object.values(state.favorites)) {
    if (fav.carried) continue;
    entries.push({ id: showId(fav.podcastGuid), medium: fav.medium });
  }
  for (const ep of Object.values(state.favoriteEpisodes)) {
    if (ep.carried) continue;
    entries.push({ id: itemId(ep.itemGuid), feedRef: ep.feedGuid, medium: ep.medium });
  }
  return entries;
}

/** The same, grouped for the wire. */
export function localFavoriteList(): LocalList {
  return groupLocalFavorites(localFavoriteEntries());
}

/**
 * The stored baseline, or an empty one when it cannot be believed.
 *
 * Both reads are per-npub localStorage. See `baselineIsTrustworthy` for why the
 * pair can fall out of step and why the empty answer is the safe one.
 */
export function trustedBaseline(npub: string): FavoritesBaseline {
  const baseline = storage.favBaseline.get(npub);
  const deliberatelyEmpty = storage.favCleared.get(npub);
  const localHasEntries =
    Object.keys(storage.favorites.get(npub)).length > 0
    || Object.keys(storage.favoriteEpisodes.get(npub)).length > 0;
  if (baselineIsTrustworthy(baseline, localHasEntries, deliberatelyEmpty)) return baseline;
  // eslint-disable-next-line no-console
  console.warn(
    '[favorites] ignoring the baseline this cycle — it names '
    + `${baseline.feeds.length + baseline.items.length} id(s) while this device caches none. `
    + 'Treating every entry on the relay as another writer\'s rather than as our removal.',
  );
  return EMPTY_BASELINE;
}

export function syncOptionsFor(identity: NostrIdentity): SyncOptions {
  return {
    pubkey: identity.pubkey,
    relays: resolvePublishRelays(identity),
    // Getters, not values: the debounce re-reads at fire time, so a burst of
    // heart-taps publishes once with the final set.
    local: localFavoriteList,
    baseline: () => trustedBaseline(identity.npub),
    // Both callbacks also move `favoritesSync`, so the whole feature reports its
    // relay health from one place: hydration routes its own success through this
    // same `onSynced` (see favorites-hydrator.ts), and a publish that lands is
    // proof the relays are answering again — it clears a notice an earlier
    // degraded read put up.
    //
    // ONE flag, where there used to be two. That is not a simplification of the
    // old rule but its replacement: two flags existed because two events could
    // fail independently, and a single flag across them let a good read on one
    // clear a notice the other's failure had raised. There is one event now, so
    // a partial failure is not expressible and a single flag cannot lie.
    onSynced: (baseline) => recordFavoritesBaseline(identity, baseline),
    onDegraded: (reason) => useApp.getState().setFavoritesSync('degraded', reason),
    // Distinct from both of the above, and not a third failure channel: the
    // publish SUCCEEDED. This says how widely, which `assertPublished`'s
    // one-relay floor cannot. `<FavoritesSyncNotice>` shows it only when the
    // set is incomplete, so a clean publish stays silent.
    onReach: (reach) => useApp.getState().setFavoritesReach(reach),
  };
}

/**
 * Agree with the relay: record what this device is now asserting, retire the
 * deliberate-clear marker, and clear the notice.
 *
 * Named rather than inlined in `onSynced` because the hydrator needs the same
 * three steps on a cycle that did not publish, and reached them by building a
 * whole `SyncOptions` — relays, both getters, mode, purpose — to call one
 * callback off it. That reads as though the options mattered, and it put the
 * definition of "we agree with the relay" one indirection away from both
 * callers.
 *
 * The marker retires HERE, with the publish, and not on a timer or a reload:
 * left set, a later empty merge — an unhydrated store on the next load — would
 * ride through the wholesale-delete guard on a permission granted for a
 * different act.
 */
export function recordFavoritesBaseline(identity: NostrIdentity, baseline: FavoritesBaseline): void {
  storage.favBaseline.set(identity.npub, baseline);
  storage.favCleared.set(identity.npub, false);
  useApp.getState().setFavoritesSync('ok');
}

/**
 * The sync options for one cycle, with the private half wired in.
 *
 * `purpose` is what decides whether the private half is decrypted at all, and
 * it is threaded from the CALLER rather than chosen here. A background cycle
 * passes nothing and the ciphertext rides through opaquely; a cycle the user
 * pressed a button for passes 'user-initiated' and spends the one prompt they
 * asked for. Hardcoding either here is the `fetchEncryptedMnemonic` mistake —
 * one level up, silently overriding every caller.
 */
function cycleOptionsFor(
  identity: NostrIdentity,
  purpose?: DecryptPurpose,
  userChose = false,
): SyncOptions {
  const mode = favoritesMode(identity.npub);
  return {
    ...syncOptionsFor(identity),
    // A null mode never reaches a publish — `requestFavoritesSync` returns
    // before that — so treating it as 'public' here only affects the paths that
    // have already established one.
    mode: mode ?? 'public',
    // Only a real answer may state or change the list's `visibility`. Every
    // background cycle and every heart toggle leaves this false, which is what
    // stops one app's standing setting overruling the app the user last
    // answered in — and stops a legacy list being stamped with a mode nobody
    // picked. See `effectiveListMode`.
    userChose,
    localCleared: storage.favCleared.get(identity.npub),
    // IN PRIVATE MODE THE DECRYPT IS NOT OPTIONAL, AND THE DEFAULT MUST NOT BE
    // "don't spend a prompt".
    //
    // This shipped as a bare `purpose`, which is undefined on every background
    // cycle — so `syncFavorites` read with `decryptPrivate: false`, got
    // `privateUnreadable`, and the planner correctly refused to write over a
    // blob it could not read. The FIRST private publish worked (an empty
    // `content` needs no decrypt) and every one after it silently refused. The
    // symptom is the worst kind: hearts fill, nothing propagates, and the only
    // sign is a console warn.
    //
    // A public-mode cycle still does not decrypt, and that is not laziness —
    // it carries `content` verbatim, so it has nothing to learn from opening
    // it, and the cheapest correct read is the one that asks for nothing.
    //
    // 'unattended' rather than 'user-initiated' because a heart toggle is not a
    // request to decrypt: on Amber this refuses, parks the ciphertext, and
    // surfaces the notice with its "unlock" button. That is the intended
    // degradation, not a failure to work around here.
    purpose: purpose ?? (mode === 'private' ? 'unattended' : undefined),
  };
}

/**
 * One favorites read-merge-publish cycle at a time.
 *
 * Hydration and a heart-toggle publish are the SAME cycle as far as the relays
 * are concerned: both read the list, merge a delta over what came back, and
 * replace the whole event. Run two concurrently and they merge against the same
 * `latest`, so whichever publishes second silently overwrites the first's
 * changes with a `next` computed before they existed — the multi-writer clobber
 * this feature exists to prevent, committed against ourselves.
 *
 * It became reachable when `<FavoritesSyncNotice>` grew a retry button: that
 * fires a hydrate while a debounced publish is already pending. The hydrator's
 * own npub-keyed guard doesn't cover it, because that guard dedupes *identical*
 * work and these are two different jobs.
 *
 * So: serialized, not deduped — a publish queues behind a hydrate rather than
 * joining it. `chain` swallows failures so one rejected cycle can't wedge every
 * later one, the same shape as the settle chain in lib/v4v/streaming.ts.
 */
let chain: Promise<unknown> = Promise.resolve();

export function serializeFavoritesCycle<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

// Collapses rapid heart-toggles into one cycle, and so one signing prompt. The
// getters in SyncOptions are re-read at fire time, so a burst publishes once
// with the final set.
const scheduleFavoritesPublish = createScheduledPublish('favorites');

/**
 * Debounced read-merge-publish. Signed out, favorites stay local — no-op.
 *
 * THIS IS THE ONE FUNNEL every heart goes through, which is why the two gates
 * below live here rather than in `components/fav-heart.tsx`. There are five
 * hearts across thirteen render sites; a check placed at the toggle is five
 * places to forget, and forgetting one means a favorite published into a half
 * the user was never asked about.
 *
 *   'off'  — this device only. Nothing is read, nothing is published, and the
 *            entries already on the relay are left exactly where they are. We
 *            do not delete on someone's behalf; `withdrawThisDevice` is the
 *            explicit way to take them down.
 *   null   — never chosen. The favorite has ALREADY been applied to the store
 *            by the time we get here, so the heart is filled and the question
 *            comes after: ask, and publish nothing until it is answered.
 *            Publishing publicly and then asking "public or private?" is
 *            backwards, and it is not undoable once a relay has the bytes.
 *
 * `onPromptNeeded` is injected rather than reached for, so this module keeps
 * knowing nothing about React.
 */
let promptForMode: (() => void) | null = null;

/** Register the surface that asks the never-chosen question. */
export function onFavoritesModeNeeded(fn: (() => void) | null) {
  promptForMode = fn;
}

export function requestFavoritesSync(identity: NostrIdentity | null | undefined) {
  if (!identity) return;
  const mode = favoritesMode(identity.npub);
  if (mode === 'off') return;
  if (!mode) {
    // Suppressed while a read is still in flight: `seedFavoritesMode` runs off
    // that read and settles this for every account that already has a list, so
    // asking first would put the question to people who never needed it. The
    // hydrator re-arms this cycle on its way out.
    const status = useApp.getState().favoritesSync;
    if (status === 'loading' || status === 'idle') return;
    promptForMode?.();
    return;
  }
  scheduleFavoritesPublish(() =>
    serializeFavoritesCycle(() => syncFavorites(cycleOptionsFor(identity))),
  );
}

/**
 * Immediate read-merge-publish, for callers that must await the result.
 *
 * `purpose` is how a user-initiated retry differs from a background cycle: pass
 * 'user-initiated' and the private half is decrypted, spending exactly one
 * signer prompt, which is the route in for an Amber user whose cold start
 * deliberately never asks.
 */
export function syncFavoritesNow(
  identity: NostrIdentity,
  purpose?: DecryptPurpose,
  userChose = false,
) {
  return serializeFavoritesCycle(() =>
    syncFavorites(cycleOptionsFor(identity, purpose, userChose)),
  );
}

/**
 * Take this device's entries off the relays, then stop syncing.
 *
 * Always user-initiated — it is reached from a confirmation the user read — so
 * it decrypts the private half and can therefore remove entries from both. It
 * refuses on an untrustworthy read like every other cycle: "remove my entries"
 * is not a licence to publish over a list we could not see.
 */
export function withdrawThisDevice(identity: NostrIdentity) {
  return serializeFavoritesCycle(() =>
    withdrawFavorites(cycleOptionsFor(identity, 'user-initiated')),
  );
}
