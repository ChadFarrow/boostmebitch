'use client';

import { signAndPublish } from '@/lib/nostr/publish';
import { PROFILE_RELAYS, resolvePublishRelays, sanitizeRelays } from '@/lib/nostr/relays';
import { buildGeneratedProfile } from '@/lib/nostr/generated-profile';
import { storage } from '@/lib/storage';
import type { NostrIdentity } from '@/lib/nostr';

/**
 * Give a brand-new account a kind:0 so it isn't a nameless npub everywhere
 * outside this app — including on its own boost notes, which is the whole
 * point of the onboarding flow.
 *
 * Only ever called on the **new-account** branch. kind:0 is replaceable, so
 * running this on restore would silently overwrite a profile the user set in
 * another client. A freshly generated random key cannot already have a kind:0,
 * which makes the restriction safe by construction rather than by luck — the
 * same argument that governs provision-spark.ts.
 *
 * Best-effort: a missing profile is cosmetic, a blocked sign-in is not. The
 * caller swallows failures.
 */
export async function provisionProfileFromKey(identity: NostrIdentity): Promise<void> {
  const profile = buildGeneratedProfile(identity.pubkey);

  // Seed the cache before publishing even starts. This does NOT reach the
  // header this session — <AccountMenu> renders from identity.profile (set by
  // the caller directly on the identity object), and this cache is only read
  // by the next page load's mount fast-path (components/nostr-auth/index.tsx).
  // It's here so that fast-path has something to paint if the publish below
  // is still slow when the tab closes.
  storage.profile.set(identity.pubkey, profile);

  // PROFILE_RELAYS is load-bearing, not belt-and-braces: purplepag.es is the
  // de facto profile outbox that Damus and Amethyst read. Publishing only to
  // the user's write relays means most clients never find this profile.
  const relays = sanitizeRelays([
    ...resolvePublishRelays(identity),
    ...PROFILE_RELAYS,
  ]).slice(0, 20);

  await signAndPublish(
    {
      kind: 0,
      content: JSON.stringify(profile),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    },
    relays,
  );

  // loadProfile's fetchProfile(pubkey) races this publish — it fires its
  // kind:0 REQ synchronously while this call is still suspended on the
  // signEvent round-trip, so the relay usually sees REQ before EVENT. If
  // EOSE arrives first, fetchProfile calls storage.profile.setMiss(pubkey),
  // clobbering the seed above with a negative-cache entry for the miss TTL.
  // Re-seed now that the event has actually been signed and sent, so a miss
  // written mid-race gets overwritten instead of poisoning the next reload.
  storage.profile.set(identity.pubkey, profile);
}
