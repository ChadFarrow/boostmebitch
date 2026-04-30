import { withPool } from './pool';
import { DEFAULT_RELAYS, PROFILE_RELAYS } from './relays';
import type { ProfileMetadata } from './auth';

// Fetch the user's kind:0 metadata event from the given relays (defaults to
// our standard set unioned with the profile-outbox relays). Returns null if
// no event is found or parsing fails.
export async function fetchProfile(
  pubkey: string,
  relays?: string[],
): Promise<ProfileMetadata | null> {
  const base = relays ?? DEFAULT_RELAYS;
  const useRelays = Array.from(new Set([...base, ...PROFILE_RELAYS]));
  return withPool(useRelays, async (pool) => {
    try {
      const events = await pool.querySync(useRelays, {
        kinds: [0],
        authors: [pubkey],
        limit: 1,
      });
      if (!events.length) return null;
      const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
      return JSON.parse(newest.content) as ProfileMetadata;
    } catch {
      return null;
    }
  });
}
