'use client';
import { nip19, type Event } from 'nostr-tools';
import type { NostrIdentity } from './auth';
import { DEFAULT_RELAYS, PROFILE_RELAYS, resolvePublishRelays, sanitizeRelays } from './relays';
import { collectEventsByAuthors } from './event-queries';
import { withPool, FEED_QUERY_MAX_WAIT_MS, FEED_QUIET_MS } from './pool';
import { signAndPublish } from './publish';
import { storage } from '../storage';

// NIP-02 kind:3 contact-list ("follow list") read/write. The rest of the app
// deliberately doesn't touch kind:3 — this is the only module that does, so the
// canonical follow list stays behind one careful surface.

export interface FollowListState {
  /** The latest kind:3 we found, or null when the user genuinely has none.
   *  Passed back into publishFollow so a republish preserves its content/tags. */
  event: Event | null;
  /** Hex pubkeys the user follows. */
  following: Set<string>;
  /** True ONLY when the fetch is trustworthy: an event arrived, or every relay
   *  EOSE'd confirming there isn't one. A degraded fetch (no EOSE, no event) is
   *  NOT ok — publishing from it could overwrite a real list with a partial one,
   *  so callers must refuse to publish until this is true. */
  ok: boolean;
}

function followingFromTags(tags: string[][]): Set<string> {
  const out = new Set<string>();
  for (const t of tags) if (t[0] === 'p' && t[1]) out.add(t[1]);
  return out;
}

/** Fetch the user's kind:3 from a broad relay union (their write relays ∪
 *  defaults ∪ profile relays), so a list living only on an outbox relay isn't
 *  missed — the same union rationale as the Spark backup restore. */
export async function fetchFollowList(identity: NostrIdentity): Promise<FollowListState> {
  const relays = sanitizeRelays([
    ...resolvePublishRelays(identity),
    ...DEFAULT_RELAYS,
    ...PROFILE_RELAYS,
  ]).slice(0, 20);
  const filter = { kinds: [3], authors: [identity.pubkey], limit: 1 };
  try {
    const { events, allEosed, gotAnyEvent } = await withPool(relays, (pool) =>
      collectEventsByAuthors(pool, relays, filter, [identity.pubkey], FEED_QUERY_MAX_WAIT_MS, FEED_QUIET_MS),
    );
    // kind:3 is replaceable — newest wins.
    const event = events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
    const following = event ? followingFromTags(event.tags) : new Set<string>();
    // Cache ONLY a real kind:3 (never a possibly-false-empty result) as the
    // last-known-good nuke-guard signal read by toggleFollow.
    if (event) storage.follows.set(identity.npub, [...following]);
    return { event, following, ok: gotAnyEvent || allEosed };
  } catch {
    return { event: null, following: new Set(), ok: false };
  }
}

/**
 * Publish an updated kind:3 that PRESERVES the user's existing `content` (legacy
 * relay list) and every existing tag, adding or removing exactly one `p` tag.
 * `current` MUST be the freshly-fetched event (or null only when the fetch
 * reliably confirmed the user has none) — never call this without a trustworthy
 * fetch, or the republish wipes the real list. Returns the new signed event (so
 * a follow-up toggle builds on the latest tags, not stale ones) + the resulting
 * following set.
 */
export async function publishFollow(
  identity: NostrIdentity,
  current: Event | null,
  targetHex: string,
  follow: boolean,
): Promise<{ event: Event; following: Set<string> }> {
  const tags = (current?.tags ?? []).filter((t) => !(t[0] === 'p' && t[1] === targetHex));
  if (follow) tags.push(['p', targetHex]);
  const template = {
    kind: 3,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: current?.content ?? '',
  };
  const published = await signAndPublish(template, resolvePublishRelays(identity));
  return { event: published.event, following: followingFromTags(published.event.tags) };
}

/** Decode an npub/nprofile (optionally `nostr:`-prefixed) to a hex pubkey. */
export function refToHex(ref: string): string | null {
  try {
    const d = nip19.decode(ref.replace(/^nostr:/i, ''));
    if (d.type === 'npub') return d.data as string;
    if (d.type === 'nprofile') return (d.data as { pubkey: string }).pubkey;
    return null;
  } catch {
    return null;
  }
}

// ── Shared follow-state singleton ──────────────────────────────────────────
// One kind:3 fetch for the whole app, so every follow button (note cards, show
// notes) reads/writes the same set instead of each fetching its own list.
// Deliberately store-free (no React/zustand imports) to avoid a cycle with
// lib/store; components subscribe via the useFollows() hook in follow-button.tsx.

const EMPTY: ReadonlySet<string> = new Set();
let state: FollowListState = { event: null, following: new Set(), ok: false };
let loadedFor: string | null = null;   // pubkey the current state belongs to
let pendingFor: string | null = null;  // pubkey of an in-flight fetch
let loading = false;
const subs = new Set<() => void>();
const notify = () => subs.forEach((fn) => fn());

export function subscribeFollows(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

export interface FollowsSnapshot {
  following: ReadonlySet<string>;
  ok: boolean;      // list loaded reliably — toggles allowed
  loading: boolean;
}
export function followsSnapshot(): FollowsSnapshot {
  return { following: state.following, ok: state.ok, loading };
}

/** Load the user's follow list once per identity. No-op if already loaded /
 *  in flight for the same pubkey. Switching identity resets first. */
export async function ensureFollowsLoaded(identity: NostrIdentity): Promise<void> {
  if (loadedFor === identity.pubkey) return;
  if (loading && pendingFor === identity.pubkey) return;
  loadedFor = null;
  loading = true;
  pendingFor = identity.pubkey;
  state = { event: null, following: new Set(), ok: false };
  notify();
  const fetched = await fetchFollowList(identity);
  if (pendingFor !== identity.pubkey) return; // superseded by an identity switch
  state = fetched;
  loading = false;
  // Only mark loaded when the fetch was TRUSTWORTHY (an event arrived or every
  // relay EOSE'd). Pinning loadedFor on a degraded fetch (ok:false) made the
  // entry guard a permanent no-op, so a transient relay outage left every
  // follow button disabled ("Loading your follows…") until reload. Leaving it
  // null lets a re-invocation (button retry) fetch again. Never wipes — the
  // list-safety invariant holds either way.
  if (fetched.ok) loadedFor = identity.pubkey;
  notify();
}

// Serialize toggles: each publish must build on the latest kind:3, so two
// buttons clicked in quick succession can't each republish from the same stale
// event and drop each other's change. Failures don't block the chain.
let chain: Promise<void> = Promise.resolve();

/** Toggle following a pubkey. Requires a reliably-loaded list (throws otherwise
 *  — the caller keeps the button in an error/retry state). Serialized app-wide. */
export function toggleFollow(identity: NostrIdentity, hex: string): Promise<void> {
  const run = chain.then(async () => {
    if (!state.ok) throw new Error('follow list not loaded');
    // Nuke-guard. The ONLY way a toggle wipes the real list is publishing onto
    // an empty base (state.event === null) that was actually a transient
    // false-empty: the initial load EOSE'd against relays that didn't hold the
    // list (classic case: right after login, before NIP-65 hydrated, when we
    // fell back to default relays). allEosed only means "every *reachable*
    // relay confirmed none" — a relay that failed to connect doesn't hold the
    // aggregate EOSE open — so an empty+ok result isn't proof the list is gone.
    //
    // A genuine brand-new user also has a null base, so we can't just refuse.
    // Instead re-confirm at the last moment, when relays are more likely warm:
    //   - the confirm now finds a list  → rebase on it (never wipe)
    //   - the confirm can't be trusted  → refuse (button shows retry)
    //   - the confirm reliably finds none → safe to create the first list
    // Only runs on the empty-base path, so normal toggles pay no extra fetch.
    if (state.event === null) {
      const confirm = await fetchFollowList(identity);
      if (confirm.event) {
        state = { ...confirm, ok: true };
      } else if (!confirm.ok) {
        throw new Error('could not confirm your (empty) follow list — not publishing');
      } else {
        // Reliably empty across reachable relays, but we hold a non-empty
        // last-known-good set from a previous real load → almost certainly a
        // transient false-empty (your kind:3 exists, no relay we reached served
        // it). Refuse rather than publish a fresh list that overwrites it. A
        // genuinely new user has no cached set here, so they can still create
        // their first list; a user who really emptied their list elsewhere has a
        // non-null (empty) kind:3, so this branch (event === null) isn't reached.
        const cached = storage.follows.get(identity.npub);
        if (cached && cached.length > 0) {
          throw new Error('your follow list looks temporarily unavailable — reload and try again');
        }
      }
    }
    const { event, following } = await publishFollow(identity, state.event, hex, !state.following.has(hex));
    state = { event, following, ok: true };
    storage.follows.set(identity.npub, [...following]); // update last-known-good
    notify();
  });
  chain = run.catch(() => {}); // keep the chain alive after a failed toggle
  return run;
}

/** Clear on sign-out / account switch so a new account never sees the old set. */
export function resetFollows(): void {
  state = { event: null, following: EMPTY as Set<string>, ok: false };
  loadedFor = null;
  pendingFor = null;
  loading = false;
  notify();
}
