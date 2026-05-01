import type { EventTemplate } from 'nostr-tools';
import { withPool } from './pool';
import { DEFAULT_RELAYS } from './relays';
import { signAndPublish, type PublishedNote } from './publish';

// NIP-51 public mute list — kind:10000. We only manage `p` tags (muted
// pubkeys); other tag families (`e` muted threads, `t` hashtags, `word`
// keywords) are preserved verbatim on republish so we don't clobber mutes
// the user set in a different Nostr client.
//
// Private mutes (NIP-04 encrypted in `.content`) are out of scope — this app
// only writes the public list.

export const MUTES_KIND = 10000;

export interface MuteListEvent {
  pubkeys: string[];
  /** Non-`p` tags from the relay event, kept so we don't drop them when we
   *  publish a new revision. */
  otherTags: string[][];
  /** unix seconds, from event.created_at */
  updatedAt: number;
}

export async function fetchMutedPubkeys(
  pubkey: string,
  queryRelays?: string[],
): Promise<MuteListEvent | null> {
  const useRelays = queryRelays ?? DEFAULT_RELAYS;
  return withPool(useRelays, async (pool) => {
    try {
      const events = await pool.querySync(useRelays, {
        kinds: [MUTES_KIND],
        authors: [pubkey],
        limit: 1,
      });
      if (!events.length) return null;
      const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
      const pubkeys: string[] = [];
      const otherTags: string[][] = [];
      const seen = new Set<string>();
      for (const tag of newest.tags) {
        if (tag[0] === 'p' && typeof tag[1] === 'string' && tag[1]) {
          if (!seen.has(tag[1])) {
            seen.add(tag[1]);
            pubkeys.push(tag[1]);
          }
        } else {
          otherTags.push(tag);
        }
      }
      return { pubkeys, otherTags, updatedAt: newest.created_at };
    } catch {
      return null;
    }
  });
}

export async function publishMuteList(
  pubkeys: string[],
  otherTags: string[][],
  relays: string[],
): Promise<PublishedNote> {
  const tags: string[][] = [];
  // Preserve any non-`p` tags we read from the user's existing event first
  // so they remain visible to other clients reading the list.
  for (const t of otherTags) tags.push(t);
  for (const pubkey of pubkeys) tags.push(['p', pubkey]);
  const template: EventTemplate = {
    kind: MUTES_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
  return signAndPublish(template, relays);
}

// Debounced wrapper — collapses rapid mute/unmute toggles into a single
// signing prompt. Mirrors schedulePublishFavorites.
let publishMutesTimer: ReturnType<typeof setTimeout> | null = null;
export function schedulePublishMuteList(
  getPubkeys: () => string[],
  getOtherTags: () => string[][],
  relays: string[],
  delayMs = 1500,
) {
  if (publishMutesTimer) clearTimeout(publishMutesTimer);
  publishMutesTimer = setTimeout(() => {
    publishMutesTimer = null;
    publishMuteList(getPubkeys(), getOtherTags(), relays).catch((e) => {
      // eslint-disable-next-line no-console
      console.warn('[mutes] publish failed:', e?.message ?? e);
    });
  }, delayMs);
}
