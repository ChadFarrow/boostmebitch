/**
 * A Map-backed cache with a hard age horizon AND a hard entry cap.
 *
 * Both bounds are mandatory, and that is the entire point of this module.
 * `lib/pi.ts` and `lib/musicl-resolver.ts` each cache whole RSS bodies keyed by
 * a FEED-SUPPLIED URL, and each shipped as a plain `Map` with an expiry check on
 * read and no eviction anywhere: entries past their TTL stopped being *served*
 * but were never *deleted*, so every distinct URL an attacker (or a large
 * podroll) could name pinned one whole response body in memory, forever. The
 * same bug, written twice, because the mechanism was copied. Once it is written
 * once, it can only be fixed once.
 *
 * What is deliberately NOT shared is policy. The two callers keep their own TTLs,
 * their own caps, their own fetch timeouts, and — in pi.ts's case — a two-tier
 * freshness model where a caller may ask for a shorter window than the shared
 * one and a failed fetch may still serve a stale-but-not-expired body. So `get`
 * reports the entry's AGE and refuses to judge it; deciding what counts as fresh
 * belongs to the caller. `maxAgeMs` here is only the hard horizon past which an
 * entry is unservable by anyone and may be swept.
 *
 * Eviction order is insertion order, which is why `set` deletes before it sets:
 * re-setting an existing key keeps its ORIGINAL position in a Map, so without
 * the delete a constantly-refreshed entry would drift to the front of the queue
 * and be evicted while hot.
 */

export interface BoundedCache<T> {
  /**
   * The entry for `key` with its age in ms, or undefined if absent or past the
   * hard horizon. The caller decides whether `ageMs` is fresh enough.
   */
  get(key: string, now: number): { value: T; ageMs: number } | undefined;
  /** Store, sweeping expired entries first and capacity-evicting after. */
  set(key: string, value: T, now: number): void;
  /** Current entry count — for assertions and tests. */
  readonly size: number;
}

export function createBoundedCache<T>(opts: {
  /** Hard horizon. Past this an entry is unservable and gets swept. */
  maxAgeMs: number;
  /** Hard entry cap, evicted oldest-first. */
  maxEntries: number;
}): BoundedCache<T> {
  const { maxAgeMs, maxEntries } = opts;
  const map = new Map<string, { value: T; storedAt: number }>();

  return {
    get(key, now) {
      const hit = map.get(key);
      if (!hit) return undefined;
      const ageMs = now - hit.storedAt;
      // Past the horizon: unservable to anyone, so drop it here rather than
      // waiting for the next write to sweep. A read-heavy, write-idle period
      // would otherwise hold it indefinitely.
      if (ageMs >= maxAgeMs) { map.delete(key); return undefined; }
      return { value: hit.value, ageMs };
    },

    set(key, value, now) {
      // Drop entries nobody can serve any more before evicting ones that are
      // still useful — expiry first, capacity second.
      for (const [k, v] of map) {
        if (now - v.storedAt >= maxAgeMs) map.delete(k);
      }
      // Delete-then-set so a refreshed entry moves to the BACK of the eviction
      // queue; a plain `set` on an existing key keeps its original position.
      map.delete(key);
      map.set(key, { value, storedAt: now });
      while (map.size > maxEntries) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }
    },

    get size() { return map.size; },
  };
}
