'use client';
import { useEffect, useState } from 'react';
import type { Event } from 'nostr-tools';
import type { NostrIdentity } from './auth';
import type { DiscoveredNote } from './discover';
import { withPool, QUERY_MAX_WAIT_MS } from './pool';
import { DEFAULT_RELAYS } from './relays';

/**
 * Query relays for the viewer's kind:6 reposts targeting any of `noteIds`.
 * Returns the set of note ids the viewer has reposted. One batched query —
 * does not scale with `noteIds.length`.
 */
export async function fetchViewerReposts(opts: {
  noteIds: string[];
  viewerPubkey: string;
  relays?: string[];
}): Promise<Set<string>> {
  const out = new Set<string>();
  const ids = Array.from(new Set(opts.noteIds.filter((id) => id && id.length === 64)));
  if (ids.length === 0) return out;
  const relays = opts.relays ?? DEFAULT_RELAYS;
  return withPool(relays, async (pool) => {
    let events: Event[] = [];
    try {
      events = await pool.querySync(relays, {
        kinds: [6],
        authors: [opts.viewerPubkey],
        '#e': ids,
      }, { maxWait: QUERY_MAX_WAIT_MS });
    } catch {
      return out;
    }
    const idSet = new Set(ids);
    for (const e of events) {
      for (const t of e.tags) {
        if (t[0] === 'e' && typeof t[1] === 'string' && idSet.has(t[1])) {
          out.add(t[1]);
          break;
        }
      }
    }
    return out;
  });
}

// Walk the reply tree and collect every visible note id so the repost query
// also covers nested replies, not just the top-level cards.
function flattenIds(notes: DiscoveredNote[]): string[] {
  const out: string[] = [];
  function walk(n: DiscoveredNote) {
    out.push(n.id);
    for (const r of n.replies) walk(r);
  }
  for (const n of notes) walk(n);
  return out;
}

/**
 * Returns the set of note ids the signed-in viewer has reposted (kind:6).
 * Re-fetches when notes or identity change. Empty set when not signed in.
 */
export function useViewerReposts(
  notes: DiscoveredNote[] | null,
  identity: NostrIdentity | null,
): Set<string> {
  const [reposted, setReposted] = useState<Set<string>>(() => new Set());

  const pubkey = identity?.pubkey ?? null;
  const idsKey = notes ? flattenIds(notes).sort().join(',') : '';

  useEffect(() => {
    if (!pubkey || !notes || notes.length === 0) {
      setReposted(new Set());
      return;
    }
    let cancelled = false;
    (async () => {
      const result = await fetchViewerReposts({
        noteIds: flattenIds(notes),
        viewerPubkey: pubkey,
      });
      if (!cancelled) setReposted(result);
    })();
    return () => {
      cancelled = true;
    };
    // idsKey makes the effect re-run when the visible note set changes; pubkey
    // re-runs on login/logout/account-switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkey, idsKey]);

  return reposted;
}
