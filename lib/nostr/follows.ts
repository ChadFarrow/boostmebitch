'use client';
import { nip19, type Event } from 'nostr-tools';
import type { NostrIdentity } from './auth';
import { DEFAULT_RELAYS, PROFILE_RELAYS, resolvePublishRelays, sanitizeRelays } from './relays';
import { collectEventsByAuthors } from './event-queries';
import { withPool, FEED_QUERY_MAX_WAIT_MS, FEED_QUIET_MS } from './pool';
import { signAndPublish } from './publish';

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
    return {
      event,
      following: event ? followingFromTags(event.tags) : new Set(),
      ok: gotAnyEvent || allEosed,
    };
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
