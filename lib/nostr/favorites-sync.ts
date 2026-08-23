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
 * A recorded 'private' on a build where the gate is off reads back as 'public',
 * so turning the gate off is a real off switch rather than a UI change with a
 * live publish path behind it.
 */
export function favoritesMode(npub: string): FavoritesPrivacy | null {
  const stored = storage.favPrivacy.get(npub);
  if (stored === 'private' && !privateFavoritesEnabled()) return 'public';
  return stored;
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
 * Runs only on a TRUSTWORTHY read, and only when nothing is recorded yet. Both
 * halves empty leaves it null on purpose — that account genuinely has not
 * chosen, and the prompt is the right place for it.
 */
export function seedFavoritesMode(npub: string, read: FavoritesRead): FavoritesPrivacy | null {
  const existing = favoritesMode(npub);
  if (existing) return existing;
  const hasPublic = read.tags.some((t) => t[0] === 'i');
  // An opaque `content` counts: we cannot read it, but its presence is still
  // evidence that this account keeps a private half, and seeding 'public' over
  // it would move the whole list into plaintext on the next toggle.
  const hasPrivate = read.privateUnreadable || read.privateTags.some((t) => t[0] === 'i');
  if (hasPublic) { setFavoritesMode(npub, 'public'); return 'public'; }
  if (hasPrivate && privateFavoritesEnabled()) { setFavoritesMode(npub, 'private'); return 'private'; }
  return null;
}

/**
 * Whether to spend a signer call decrypting the private half on a cycle nobody
 * asked for.
 *
 * Amber renders its approval sheet over whatever app is in front and, for a
 * decrypt, shows the PLAINTEXT — so an unattended one on a cold start is a
 * prompt the user did not ask for, over content they did not ask to see.
 * `mutes-hydrator.ts` measured the worse half of this on a Pixel 6: approving
 * returned the user to the launcher, so the request never resolved and the
 * prompt came straight back.
 *
 * `decryptWithTimeout` refuses an unattended Amber decrypt on its own, but that
 * refusal arrives as a rejection inside a `.catch(() => {})` — invisible. Not
 * asking is both cheaper and honest, and the library check stays the backstop
 * for the next caller.
 */
export function unattendedDecryptOk(): boolean {
  return storage.signer.get() !== 'amber';
}

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
  for (const fav of Object.values(state.favorites)) {
    entries.push({ id: showId(fav.podcastGuid), medium: fav.medium });
  }
  for (const ep of Object.values(state.favoriteEpisodes)) {
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
  const localHasEntries =
    Object.keys(storage.favorites.get(npub)).length > 0
    || Object.keys(storage.favoriteEpisodes.get(npub)).length > 0;
  if (baselineIsTrustworthy(baseline, localHasEntries)) return baseline;
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
    onSynced: (baseline) => {
      storage.favBaseline.set(identity.npub, baseline);
      useApp.getState().setFavoritesSync('ok');
    },
    onDegraded: (reason) => useApp.getState().setFavoritesSync('degraded', reason),
  };
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
): SyncOptions {
  const mode = favoritesMode(identity.npub);
  return {
    ...syncOptionsFor(identity),
    // A null mode never reaches a publish — `requestFavoritesSync` returns
    // before that — so treating it as 'public' here only affects the paths that
    // have already established one.
    mode: mode ?? 'public',
    purpose,
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
export function syncFavoritesNow(identity: NostrIdentity, purpose?: DecryptPurpose) {
  return serializeFavoritesCycle(() => syncFavorites(cycleOptionsFor(identity, purpose)));
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
