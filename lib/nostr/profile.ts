import { DEFAULT_RELAYS, PROFILE_RELAYS } from './relays';
import { storage } from '../storage';
import { parseProfileContent, type ProfileMetadata } from './auth';
import { fetchLatestEvent } from './event-queries';

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
  const newest = await fetchLatestEvent(useRelays, {
    kinds: [0],
    authors: [pubkey],
    limit: 1,
  });
  if (!newest) {
    storage.profile.setMiss(pubkey);
    return null;
  }
  const profile = parseProfileContent(newest.content);
  if (!profile) {
    storage.profile.setMiss(pubkey);
    return null;
  }
  storage.profile.set(pubkey, profile);
  return profile;
}
