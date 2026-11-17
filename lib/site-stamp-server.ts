// SERVER-ONLY. The note stamp's server half: the key its tokens are MACed
// under, the phase switch, and the event id a stamp is bound to. The rules
// themselves are in lib/site-stamp.ts (import-free, pinned by check:sitestamp).
import { createHmac } from 'node:crypto';
import { getEventHash, type EventTemplate } from 'nostr-tools/pure';
import { siteSecretKey } from '@/lib/nostr/site-key';
import type { Mac } from '@/lib/site-stamp';

// Derived from SITE_NOSTR_SK, so the stamp needs no second secret, and each
// deploy's tokens verify only on that deploy (each brand has its own key).
// The label keeps this MAC key distinct from any other use of the site key.
const STAMP_KEY_LABEL = 'boostmebitch:site-stamp:v1';

/** The deploy's token MAC, or null when the site key is unset (feature off). */
export function stampMac(): Mac | null {
  const sk = siteSecretKey();
  if (!sk) return null;
  const key = createHmac('sha256', Buffer.from(sk)).update(STAMP_KEY_LABEL).digest();
  return (data: string) => createHmac('sha256', key).update(data).digest('base64url');
}

/**
 * Phase 2: refuse a bare template. Off until production on both brands AND
 * beta carry the stamping client — a page from before it sends bare templates,
 * and beta's hosted-playlist notes sign on the OTHER deploy. docs/ops.md.
 */
export function requireStamp(): boolean {
  return process.env.SITE_SIGN_REQUIRE_STAMP === 'on';
}

/** The NIP-01 id the site key will give this template. */
export function siteEventId(template: EventTemplate, sitePubkey: string): string {
  return getEventHash({ ...template, pubkey: sitePubkey });
}
