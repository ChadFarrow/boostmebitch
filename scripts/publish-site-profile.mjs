// Publishes the SITE Nostr identity's kind:0 profile (name / avatar / about /
// nip05 / lud16) AND its kind:10002 NIP-65 relay list, so its boost notes
// render with a name + picture and are discoverable via the outbox model.
// One-off maintenance script — edit PROFILE / RELAYS below and re-run to update.
//
// Usage (loads SITE_NOSTR_SK and NEXT_PUBLIC_BRAND from .env.local):
//   npm run publish:site-profile
//
// SITE_NOSTR_SK is the same server-only key the app signs boost notes with
// (nsec or 32-byte hex). The key never leaves your machine here.
//
// THE PROFILE IS PER-BRAND, and this script is the only tool that writes it.
// It is the kind:0 every client resolves when it renders a SITE-SIGNED boost
// note — which is exactly the signed-out path and the Anonymous path, the two
// cases where the site's own identity is the only one on the note. So a bmb
// profile published under the buddy deploy's key labels every family-friendly
// note with the other brand's name, avatar and nip05.
//
// The brand and the key are read from the SAME env file on purpose: run it once
// per deploy, with that deploy's .env.local. It prints both before publishing.

import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { SimplePool, nip19 } from 'nostr-tools';
import { BRAND } from '../lib/brand.ts';

const PROFILE = {
  name: BRAND.displayName,
  display_name: BRAND.displayName,
  about:
    `⚡ Boost notes from listeners on ${BRAND.domain} — search. listen. boost. Podcasting 2.0 + Value4Value.`,
  // `www` on the two URLs, apex on the nip05. The apex 307-redirects to www,
  // and `picture` is FETCHED by every client rendering this profile — a client
  // that doesn't follow the redirect shows no avatar. The nip05 identifier is
  // not a URL: it's the identity clients display as the bare domain, and
  // app/.well-known/nostr.json serves it on both hosts.
  picture: `${BRAND.origin}/icons/icon-512.png`,
  website: BRAND.origin,
  nip05: `_@${BRAND.domain}`,
  // Not per-brand: one operator, one Lightning address, both sites.
  lud16: 'chadf@getalby.com',
};

// Must match DEFAULT_RELAYS in lib/nostr/relays.ts — where publishBoostNoteViaSite
// actually writes the site's boost notes. The kind:10002 below declares these as
// the site's read+write relays so outbox-model clients find its notes.
const RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.fountain.fm',
];

function secretKey() {
  const raw = process.env.SITE_NOSTR_SK?.trim();
  if (!raw) throw new Error('SITE_NOSTR_SK is not set (use --env-file=.env.local)');
  if (raw.startsWith('nsec1')) {
    const d = nip19.decode(raw);
    if (d.type !== 'nsec') throw new Error('SITE_NOSTR_SK is not a valid nsec');
    return d.data;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error('SITE_NOSTR_SK must be nsec or 32-byte hex');
  return Uint8Array.from(raw.match(/.{2}/g).map((b) => parseInt(b, 16)));
}

const sk = secretKey();
const pk = getPublicKey(sk);
const now = Math.floor(Date.now() / 1000);
// Print the brand FIRST. The wrong pairing of key and brand is the one mistake
// here that cannot be taken back, and it is invisible in the output otherwise.
console.log(`Brand:      ${BRAND.id} (${BRAND.displayName}, ${BRAND.domain})`);
console.log(`Publishing for ${nip19.npubEncode(pk)}`);

// kind:0 metadata profile.
const profileEvent = finalizeEvent(
  { kind: 0, created_at: now, tags: [], content: JSON.stringify(PROFILE) },
  sk,
);

// kind:10002 NIP-65 relay list — each relay as a read+write `r` tag (a bare
// `r` with no marker means both, per NIP-65).
const relayListEvent = finalizeEvent(
  { kind: 10002, created_at: now, tags: RELAYS.map((url) => ['r', url]), content: '' },
  sk,
);

const pool = new SimplePool();
for (const [label, event] of [['profile (kind:0)', profileEvent], ['relay list (kind:10002)', relayListEvent]]) {
  console.log(`\n${label} — ${event.id}`);
  const results = await Promise.allSettled(pool.publish(RELAYS, event));
  results.forEach((r, i) => {
    console.log(`  ${r.status === 'fulfilled' ? '✓' : '✗'} ${RELAYS[i]}${r.status === 'rejected' ? ` — ${r.reason}` : ''}`);
  });
}
pool.close(RELAYS);
console.log('\nDone.');
process.exit(0); // SimplePool leaves sockets open; exit so the script doesn't hang
