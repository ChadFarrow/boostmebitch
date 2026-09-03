'use client';

// Candidates for the @-mention picker, in tiers.
//
// The shape is the point. Tier one is LOCAL and synchronous — the feed's own
// npubs, the people you follow, and every kind:0 this device has cached — so
// the list under the cursor is never waiting on anything. Tier two asks the
// read index, debounced, and merges BELOW tier one.
//
// There is deliberately no relay tier. Relays have no name-search primitive, so
// the only way to build one is a broad scan per keystroke, and relays cap
// concurrent subscriptions per connection and drop the overflow in silence —
// the failure would be a name that sometimes resolves and sometimes does not,
// with nothing on screen to say which happened. When the index cannot answer,
// the picker says so and the paste-an-npub path is the fallback.

import { nip19 } from 'nostr-tools';
import { storage } from '../storage';
import { indexSearchProfiles } from './index-client';
import { followsSnapshot } from './follows';
import { fetchProfilesFor } from './discover';
import type { ProfileMetadata } from './profile-metadata';
import type { MentionNpub } from './mention-tags';

/** Someone the picker can offer. `npub` is what a `p` tag and the body need. */
export interface MentionCandidate extends MentionNpub {
  name: string;
  picture?: string;
  /** Where this came from, for the row's supporting line and the sort. */
  source: 'feed' | 'follow' | 'cached' | 'index';
}

/** Shortest useful prefix. Below this the picker does not search at all. */
export const MIN_MENTION_QUERY = 2;
/** How many rows the list shows. A picker is not a directory. */
export const MAX_MENTION_ROWS = 8;

/** Rank by source: who the note is about, then who you know, then everyone. */
const SOURCE_RANK: Record<MentionCandidate['source'], number> = {
  feed: 0,
  follow: 1,
  cached: 2,
  index: 3,
};

function displayName(p: ProfileMetadata | null | undefined): string {
  return p?.display_name?.trim() || p?.name?.trim() || '';
}

/** Does this profile answer to `q`? Prefix on either name, as the index does. */
function matches(p: ProfileMetadata | null | undefined, q: string): boolean {
  const lower = q.toLowerCase();
  for (const field of [p?.display_name, p?.name]) {
    if (field?.trim().toLowerCase().startsWith(lower)) return true;
  }
  return false;
}

function npubOf(pubkey: string): string | null {
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return null;
  }
}

function candidate(
  pubkey: string,
  meta: ProfileMetadata | null | undefined,
  source: MentionCandidate['source'],
): MentionCandidate | null {
  const npub = npubOf(pubkey);
  if (!npub) return null;
  const name = displayName(meta);
  if (!name) return null;
  return { pubkey, npub, name, picture: meta?.picture?.trim() || undefined, source };
}

/**
 * The local tiers — no network, safe to call on every keystroke.
 *
 * `feedNpubs` are the people the feed being boosted declares for itself. They
 * rank first because they are who the note is already about: on a music feed,
 * @-ing the artist you are listening to is the common case.
 */
export function localMentionCandidates(
  q: string,
  feedNpubs: readonly MentionNpub[] = [],
): MentionCandidate[] {
  if (q.length < MIN_MENTION_QUERY) return [];
  const out: MentionCandidate[] = [];
  const seen = new Set<string>();

  const add = (pubkey: string, source: MentionCandidate['source']) => {
    if (seen.has(pubkey)) return;
    const meta = storage.profile.get(pubkey);
    if (!matches(meta, q)) return;
    const c = candidate(pubkey, meta, source);
    if (!c) return;
    seen.add(pubkey);
    out.push(c);
  };

  for (const n of feedNpubs) add(n.pubkey, 'feed');
  // followsSnapshot never blocks: it returns whatever is loaded, and `ok` says
  // whether that was a reliable read. The picker does not care which — an
  // unloaded follow list means fewer suggestions, never a wrong one.
  for (const pubkey of followsSnapshot().following) add(pubkey, 'follow');
  for (const [pubkey] of storage.profile.all()) add(pubkey, 'cached');

  return sortCandidates(out, q).slice(0, MAX_MENTION_ROWS);
}

/**
 * Warm the local tier's names.
 *
 * The follow list is pubkeys only, so a follow whose kind:0 this device has
 * never cached has no name to match against and cannot be offered. ONE batched
 * call fixes that for the whole list — never a fetchProfile per pubkey, which
 * is the fan-out relays answer by silently dropping the overflow.
 *
 * Call it when the picker opens, not per keystroke. It resolves into the shared
 * cache, so the caller's next `localMentionCandidates` reads the result.
 */
export async function warmMentionCandidates(feedNpubs: readonly MentionNpub[] = []): Promise<void> {
  const wanted = new Set<string>();
  for (const n of feedNpubs) wanted.add(n.pubkey);
  for (const pubkey of followsSnapshot().following) wanted.add(pubkey);
  // Anyone already cached — hit or miss — is not worth asking about again;
  // fetchProfilesFor reads the same cache first, but not building the list is
  // cheaper than having it filtered.
  const missing = [...wanted].filter((pk) => storage.profile.get(pk) === undefined);
  if (!missing.length) return;
  try {
    await fetchProfilesFor(missing);
  } catch {
    // A name that does not resolve costs a suggestion, never correctness.
  }
}

/**
 * The index tier. Returns null when the index did not answer — which is NOT
 * the same as it answering that nobody matches, and the caller must show the
 * two differently.
 */
export async function indexMentionCandidates(q: string): Promise<MentionCandidate[] | null> {
  if (q.length < MIN_MENTION_QUERY) return null;
  const res = await indexSearchProfiles(q);
  if (!res) return null;
  // A response for a prefix the user has since typed past is not an answer
  // about what is on screen now. Cheaper than threading an AbortSignal, and it
  // is why the service echoes the query back.
  if (res.query.toLowerCase() !== q.toLowerCase()) return null;
  const out: MentionCandidate[] = [];
  for (const e of res.matches) {
    const c = candidate(e.pubkey, storage.profile.get(e.pubkey), 'index');
    if (c) out.push(c);
  }
  return out;
}

/**
 * Merge the index tier UNDER the local one.
 *
 * Local wins on a duplicate, so somebody you follow is never relabelled as a
 * stranger by a slower answer, and the row you were about to click does not
 * move out from under the cursor.
 */
export function mergeMentionCandidates(
  local: MentionCandidate[],
  index: MentionCandidate[] | null,
  q: string,
): MentionCandidate[] {
  if (!index?.length) return local.slice(0, MAX_MENTION_ROWS);
  const seen = new Set(local.map((c) => c.pubkey));
  const merged = [...local];
  for (const c of index) {
    if (seen.has(c.pubkey)) continue;
    seen.add(c.pubkey);
    merged.push(c);
  }
  return sortCandidates(merged, q).slice(0, MAX_MENTION_ROWS);
}

/**
 * Source first, then an exact name match, then the shortest name — typing
 * "ali" should surface "Ali" above "Alistair Longname" — then the pubkey, so
 * the order is stable across keystrokes and the list does not reshuffle under
 * the cursor.
 */
function sortCandidates(list: MentionCandidate[], q: string): MentionCandidate[] {
  const lower = q.toLowerCase();
  return [...list].sort((a, b) =>
    SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
    Number(b.name.toLowerCase() === lower) - Number(a.name.toLowerCase() === lower) ||
    a.name.length - b.name.length ||
    (a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0));
}
