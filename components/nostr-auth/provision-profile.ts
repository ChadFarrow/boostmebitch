'use client';

import { publishProfile } from '@/lib/nostr/profile';
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

  // No merge-with-existing here, and that's safe by construction rather than
  // by luck: this only ever runs on the new-account branch, and a freshly
  // generated random key cannot already have a kind:0 to preserve. The editor
  // (components/profile-editor.tsx) is the path that must merge, because it
  // runs against a profile other clients may have written. publishProfile
  // re-seeds the cache after signing, which is what beats loadProfile's
  // racing fetchProfile writing a negative-cache entry over the seed above.
  await publishProfile(identity, profile);
}
