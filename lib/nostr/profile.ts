import { DEFAULT_RELAYS, PROFILE_RELAYS } from './relays';
import { storage } from '../storage';
import { parseProfileContent, type ProfileMetadata } from './auth';
import { fetchLatestEventDetailed } from './event-queries';

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
