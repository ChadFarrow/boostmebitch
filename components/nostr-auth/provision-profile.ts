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

  // Seed the cache BEFORE publishing. loadProfile's relay fetch races this
  // publish and will usually lose, so without this the header shows "Anon"
  // until some later refresh happens to catch the event.
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
}
