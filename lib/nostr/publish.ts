import { nip19, type Event, type EventTemplate } from 'nostr-tools';
import { withPool } from './pool';

export interface PublishedNote {
  id: string;
  nevent: string;        // bech32 nevent for shareable link
  acceptedRelays: string[];
  failedRelays: string[];
  event: Event;          // the signed source event — lets callers build an optimistic note without a refetch
}

/** Thrown by {@link assertPublished}. Distinct from a signing rejection, which
 *  is the user saying no and must not be reported as a relay problem. */
export class NoRelayAcceptedError extends Error {
  constructor(what: string) {
    super(`${what}: no relay accepted the event`);
    this.name = 'NoRelayAcceptedError';
  }
}

/**
 * Throw unless the event reached at least one relay.
 *
 * `publishSignedEvent` resolves with per-relay results and NEVER rejects, so an
 * unchecked `await` cannot tell "stored on five relays" from "refused by every
 * one of them". That gap is invisible at the call site and expensive wherever a
 * successful publish is recorded as durable state.
 *
 * The favorites baseline is exactly such a place, and it shipped broken: the
 * baseline was written on the strength of this promise merely resolving, so a
 * publish that reached nobody still entered it. From then on
 * `adds = local − baseline` is empty for that id and **the favorite is never
 * published again, on any subsequent toggle, forever** — while the UI reported
 * a successful sync. Losing a publish is recoverable only if the next one
 * retries it, and recording the baseline is precisely what stops it retrying.
 */
export function assertPublished(note: PublishedNote, what: string): PublishedNote {
  if (note.acceptedRelays.length === 0) throw new NoRelayAcceptedError(what);
  return note;
}

// Sign + publish a single event template across the given relays. Used by
// both publishBoostNote (kind:1) and the shared favorites list (kind:30078).
export async function signAndPublish(
  template: EventTemplate,
  relays: string[],
): Promise<PublishedNote> {
  if (typeof window === 'undefined' || !window.nostr) {
    throw new Error('No Nostr signer available');
  }
  const signed = await window.nostr.signEvent(template);
  return publishSignedEvent(signed, relays);
}

// Publish an already-signed event across the given relays. Split out of
// signAndPublish so callers that obtain a signature elsewhere — e.g. the
// site-key path, which signs server-side (app/api/nostr/site-sign) — can reuse
// the identical relay-fan-out + PublishedNote assembly.
export async function publishSignedEvent(
  signed: Event,
  relays: string[],
): Promise<PublishedNote> {
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
