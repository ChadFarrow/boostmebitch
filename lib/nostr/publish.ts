import { nip19, type Event, type EventTemplate } from 'nostr-tools';
import { withPool } from './pool';

export interface PublishedNote {
  id: string;
  nevent: string;        // bech32 nevent for shareable link
  acceptedRelays: string[];
  failedRelays: string[];
  event: Event;          // the signed source event — lets callers build an optimistic note without a refetch
}

// Sign + publish a single event template across the given relays. Used by
// both publishBoostNote (kind:1) and publishFavorites (kind:30003).
export async function signAndPublish(
  template: EventTemplate,
  relays: string[],
): Promise<PublishedNote> {
  if (typeof window === 'undefined' || !window.nostr) {
    throw new Error('No Nostr signer available');
  }
  const signed = await window.nostr.signEvent(template);

  return withPool(relays, async (pool) => {
    const accepted: string[] = [];
    const failed: string[] = [];
    const publishes = pool.publish(relays, signed);
    await Promise.allSettled(
      publishes.map((p, i) =>
        p
          .then(() => accepted.push(relays[i]))
          .catch(() => failed.push(relays[i])),
      ),
    );
    return {
      id: signed.id,
      nevent: nip19.neventEncode({ id: signed.id, relays: accepted.slice(0, 3) }),
      acceptedRelays: accepted,
      failedRelays: failed,
      event: signed,
    };
  });
}
