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
 *
 * **An entry cap is not a memory bound, and reading it as one is what this
 * module shipped with.** Both callers hold whole RSS bodies read at
 * `MAX_BODY_BYTES` (8 MB), so 200 entries is 1.6 GB of ceiling in a function
 * with about one. It is reachable in a single request rather than by drift:
 * `/api/publisher` walks up to `MAX_PUBLISHER_ALBUMS` (100) children of a
 * FEED-SUPPLIED publisher document, one `fetchFeedXml` each, so one call
 * against a URL an attacker chose can retain 800 MB for the ten-minute
 * horizon. Measured against the real collection for contrast: all ten of
 * ChadF's playlist source feeds together are 9.5 MB, and the largest single one
 * is 2.5 MB — so the working set is nowhere near the cap, and the cap was never
 * what bounded it.
 *
 * `maxBytes` + `sizeOf` add the missing half. Eviction runs count first, then
 * bytes, both oldest-first.
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
  /**
   * Total size currently held, per `sizeOf`. Always 0 when no budget is
   * configured, because nothing is measured in that case.
   */
  readonly bytes: number;
}

export function createBoundedCache<T>(opts: {
  /** Hard horizon. Past this an entry is unservable and gets swept. */
  maxAgeMs: number;
  /** Hard entry cap, evicted oldest-first. */
  maxEntries: number;
  /**
   * Optional total-size budget, evicted oldest-first after the entry cap.
   * Requires `sizeOf`. Without it the cache is bounded in COUNT only, which is
   * not a memory bound when the values are whole response bodies.
   */
  maxBytes?: number;
  /**
   * Size of one value, in whatever unit `maxBytes` is expressed in.
   *
   * For a string body `(v) => v.length` is the intended cost: O(1), and within
   * about 2x of the real heap either way — UTF-16 storage doubles it, a
   * latin1-backed string does not, and multi-byte UTF-8 sources under-count.
   * The budget is sized with that slack rather than paying `Buffer.byteLength`
   * on every write, which is O(n) over megabytes.
   */
  sizeOf?: (value: T) => number;
}): BoundedCache<T> {
  const { maxAgeMs, maxEntries, maxBytes, sizeOf } = opts;
  if (maxBytes !== undefined && !sizeOf) {
    // A configuration error, and it throws at construction — module load — so
    // it cannot present later as a cache that silently stopped bounding.
    throw new Error('createBoundedCache: maxBytes requires sizeOf');
  }
  const map = new Map<string, { value: T; storedAt: number; bytes: number }>();
  let bytes = 0;

  const drop = (key: string) => {
    const hit = map.get(key);
    if (!hit) return;
    bytes -= hit.bytes;
    map.delete(key);
  };

  return {
    get(key, now) {
      const hit = map.get(key);
      if (!hit) return undefined;
      const ageMs = now - hit.storedAt;
      // Past the horizon: unservable to anyone, so drop it here rather than
      // waiting for the next write to sweep. A read-heavy, write-idle period
      // would otherwise hold it indefinitely.
      if (ageMs >= maxAgeMs) { drop(key); return undefined; }
      return { value: hit.value, ageMs };
    },

    set(key, value, now) {
      // Drop entries nobody can serve any more before evicting ones that are
      // still useful — expiry first, capacity second.
      for (const [k, v] of map) {
        if (now - v.storedAt >= maxAgeMs) drop(k);
      }
      const size = sizeOf ? sizeOf(value) : 0;
      // **A value bigger than the whole budget is not cached at all**, and the
      // stale entry under that key goes with it. Storing it would evict every
      // other entry to make room for one body, turning a cache into a
      // single-slot buffer for whichever feed happens to be largest; and
      // evicting it right back out would be a write that can never be read.
      // The caller still gets its value — this decides what is RETAINED.
      if (maxBytes !== undefined && size > maxBytes) { drop(key); return; }
      // Delete-then-set so a refreshed entry moves to the BACK of the eviction
      // queue; a plain `set` on an existing key keeps its original position.
      drop(key);
      map.set(key, { value, storedAt: now, bytes: size });
      bytes += size;
      while (map.size > maxEntries) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        drop(oldest.value);
      }
      // Bytes AFTER count, and never evicting the entry just written: it is the
      // newest, so oldest-first reaches it only once everything else is gone,
      // and the oversize guard above has already ruled out that case.
      while (maxBytes !== undefined && bytes > maxBytes && map.size > 1) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        drop(oldest.value);
      }
    },

    get size() { return map.size; },
    get bytes() { return bytes; },
  };
}
