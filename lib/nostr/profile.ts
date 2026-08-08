import { DEFAULT_RELAYS, PROFILE_RELAYS, resolvePublishRelays, sanitizeRelays } from './relays';
import { storage } from '../storage';
import {
  coerceProfileMetadata,
  parseProfileContent,
  type NostrIdentity,
  type ProfileMetadata,
} from './auth';
import { fetchLatestEventDetailed } from './event-queries';
import { signAndPublish, type PublishedNote } from './publish';

// Fetch the user's kind:0 metadata event from the given relays (defaults to
// our standard set unioned with the profile-outbox relays). Returns null if
// no event is found or parsing fails. The result (hit or miss) is mirrored
// into `storage.profile` so the next page load can paint name + avatar from
// cache before any relay round-trip.
export async function fetchProfile(
  pubkey: string,
  relays?: string[],
): Promise<ProfileMetadata | null> {
  const base = relays ?? DEFAULT_RELAYS;
  const useRelays = Array.from(new Set([...base, ...PROFILE_RELAYS]));
  const { event: newest, trustworthy } = await fetchLatestEventDetailed(useRelays, {
    kinds: [0],
    authors: [pubkey],
    limit: 1,
  });
  if (!newest) {
    // Only record a MISS when the absence is believable. An unreachable relay
    // set is not evidence the profile doesn't exist, and caching it as one
    // pinned a bare npub for the full 15-minute miss TTL — seen in production
    // when a sign-in coincided with damus 503-ing and two other relays
    // refusing connections, for a kind:0 that was live on five relays.
    // A degraded query now simply doesn't cache, so the next call retries.
    if (trustworthy) storage.profile.setMiss(pubkey);
    return null;
  }
  const profile = parseProfileContent(newest.content);
  if (!profile) {
    // We DID get an event; it's just unparseable. That's a real, cacheable
    // miss regardless of relay health.
    storage.profile.setMiss(pubkey);
    return null;
  }
  storage.profile.set(pubkey, profile);
  return profile;
}

/** The newest kind:0's content exactly as its author wrote it, plus whether the
 *  query was healthy enough to believe a null. */
export interface RawProfile {
  /** Every field of the parsed kind:0 content, including ones this app doesn't
   *  model. `null` means no event, or content that wasn't a JSON object. */
  content: Record<string, unknown> | null;
  /** False when the relay set was too degraded for `content: null` to mean
   *  "this profile doesn't exist". Never edit-and-publish on a false. */
  trustworthy: boolean;
}

/**
 * Read a kind:0 for **editing**, not for rendering — `fetchProfile` is the one
 * you want for display.
 *
 * The difference is the whole point of this function. `fetchProfile` returns a
 * `ProfileMetadata`, which `coerceProfileMetadata` has narrowed to seven known
 * string fields; `banner`, `website`, `bot` and anything else a different
 * client set are simply not in the object. That is correct for rendering and
 * catastrophic for editing: an edit built from it, published back, **deletes
 * every field outside that whitelist** with nothing to signal it. This returns
 * the raw parsed object so an editor can spread its changes over the author's
 * own content and preserve what it doesn't understand.
 *
 * Same reasoning as the standing kind:3 rule — never republish a list you
 * didn't reliably fetch — which is why `trustworthy` comes back too. A profile
 * assembled after "no relay answered" wipes exactly as thoroughly as one
 * assembled from a truncated parse; the trigger is a timeout instead of a
 * whitelist. "No event" and "no answer" are the same `null` without this flag.
 */
export async function fetchRawProfile(pubkey: string, relays?: string[]): Promise<RawProfile> {
  const base = relays ?? DEFAULT_RELAYS;
  const useRelays = Array.from(new Set([...base, ...PROFILE_RELAYS]));
  const { event, trustworthy } = await fetchLatestEventDetailed(useRelays, {
    kinds: [0],
    authors: [pubkey],
    limit: 1,
  });
  if (!event) return { content: null, trustworthy };
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // An event that exists but isn't a JSON object. Treat as "nothing to
      // preserve" rather than refusing forever — but the fetch itself was
      // sound, so an editor may safely publish over it.
      return { content: null, trustworthy };
    }
    return { content: parsed as Record<string, unknown>, trustworthy };
  } catch {
    return { content: null, trustworthy };
  }
}

/**
 * The single kind:0 write path for a user's own profile — onboarding and the
 * editor both come through here, so the relay set and the cache handling can't
 * drift between them.
 *
 * `content` is published verbatim, so callers are responsible for having merged
 * it over `fetchRawProfile().content` (see the warning there). This function
 * deliberately does not merge on the caller's behalf: doing so would need its
 * own fetch, and a second fetch is a second chance to get an untrustworthy null
 * and quietly wipe the profile.
 */
export async function publishProfile(
  identity: NostrIdentity,
  content: Record<string, unknown>,
): Promise<PublishedNote> {
  // PROFILE_RELAYS is load-bearing, not belt-and-braces: purplepag.es is the
  // de facto profile outbox that Damus and Amethyst read. Publishing only to
  // the user's write relays means most clients never find this profile.
  const relays = sanitizeRelays([...resolvePublishRelays(identity), ...PROFILE_RELAYS]).slice(0, 20);

  const result = await signAndPublish(
    {
      kind: 0,
      content: JSON.stringify(content),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    },
    relays,
  );

  // Reseed AFTER the event is signed and sent, for two different callers.
  // Onboarding: loadProfile's fetchProfile races this publish — it fires its
  // kind:0 REQ while this call is still suspended on the signEvent round-trip,
  // so if EOSE lands first, fetchProfile writes a negative-cache entry that
  // pins a bare npub for the full miss TTL. Editor: nothing races, but the
  // cache should reflect the edit immediately rather than after a refetch.
  //
  // Only when a relay actually took it. The cache is a claim about what the
  // network holds, so writing it after a publish every relay refused caches a
  // profile that exists nowhere — the user sees their new name, believes it
  // saved, and it survives reloads until the miss TTL expires and a refetch
  // contradicts it. Failing loudly and leaving the cache alone is what lets the
  // editor's `acceptedRelays.length === 0` error mean something.
  if (result.acceptedRelays.length > 0) {
    const parsed = coerceProfileMetadata(content);
    if (parsed) storage.profile.set(identity.pubkey, parsed);
  }

  return result;
}
