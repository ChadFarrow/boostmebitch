// Publishes the SITE Nostr identity's kind:0 profile (name / avatar / about /
// nip05 / lud16) AND its kind:10002 NIP-65 relay list, so its boost notes
// render with a name + picture and are discoverable via the outbox model.
// One-off maintenance script — edit PROFILE / RELAYS below and re-run to update.
//
// Usage — ONE COMMAND PER DEPLOY, each bound to its own env file:
//   npm run publish:site-profile         (.env.local       -> bmb)
//   npm run publish:site-profile:buddy   (.env.buddy.local -> buddy)
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
// The brand and the key are read from the SAME env file on purpose, and the
// pairing is then CHECKED against `Brand.siteNpub` rather than merely printed —
// see the refusal below. Each deploy has its own file and its own npm script, so
// publishing the buddy profile never means editing .env.local and putting it
// back afterwards.

import { readFileSync } from 'node:fs';

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

// BOTH RELAY LISTS ARE READ OUT OF `lib/nostr/relays.ts`, NOT COPIED FROM IT.
//
// kind:10002 is a CLAIM about where this identity writes, and the thing it has
// to be true about is `DEFAULT_RELAYS` — `publishBoostNoteViaSite` hands exactly
// that array to `publishSignedEvent`. A copy here said "must match" and then did
// not: `wss://relay.nostr.band` was measured out of `DEFAULT_RELAYS` on
// 2026-08-25 for connecting and never sending EOSE, and this file kept it, so
// the published NIP-65 list sent every outbox client to a fifth relay that holds
// none of the site's notes and pins each query to its full ceiling.
//
// The obvious fix — `import { DEFAULT_RELAYS } from '../lib/nostr/relays.ts'` —
// is not available: that module imports `./pool` and `../storage`, which touch
// `window` and cannot load under plain Node. So the array is parsed out of the
// source text instead, and a parse that finds nothing THROWS rather than falling
// back to a default. A wrong relay list is a quiet, permanent claim; a crashed
// maintenance script is neither.
function relayConst(name) {
  const src = readFileSync(
    new URL('../lib/nostr/relays.ts', import.meta.url), 'utf8',
  );
  const block = src.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\]`));
  if (!block) {
    throw new Error(
      `could not find ${name} in lib/nostr/relays.ts — the declaration moved or `
      + 'changed shape. Fix this parse; do NOT hard-code the list here.',
    );
  }
  const urls = [...block[1].matchAll(/'(wss:\/\/[^']+)'/g)].map((m) => m[1]);
  if (!urls.length) throw new Error(`${name} parsed as empty — refusing to publish against an empty relay list`);
  return urls;
}

// WHAT THE kind:10002 SAYS. A NIP-65 list is a claim about where this identity
// WRITES, and the only true answer is `DEFAULT_RELAYS`.
const RELAYS = relayConst('DEFAULT_RELAYS');

// WHERE THESE TWO EVENTS GO, which is a DIFFERENT question and must not be
// collapsed into the one above.
//
// `PROFILE_RELAYS` (purplepag.es) is the de facto profile outbox: Damus and
// Amethyst resolve kind:0 and kind:10002 there, and this app unions it into
// every one of those lookups too. kind:0 and kind:10002 are precisely the two
// kinds this script publishes — so writing them everywhere EXCEPT the relay that
// exists to serve them is the one gap that makes a correct publish invisible.
//
// Measured 2026-08-29: after a publish to DEFAULT_RELAYS only, purplepag.es
// still served the bmb relay list from 2026-08-07, naming the `relay.nostr.band`
// that had been measured out. purplepag.es does crawl, so it had picked up a
// kind:0 on its own — but a crawl is not a delivery, and the stale list sat
// there while every direct relay held the new one.
//
// This union stays OUT of the kind:10002 tags on purpose. The site does not
// write its boost notes to purplepag.es, so naming it there would be false.
const PUBLISH_TO = [...new Set([...RELAYS, ...relayConst('PROFILE_RELAYS')])];

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
// Print the brand FIRST, so the output reads in the order a person checks it.
// The printing is no longer the safeguard, though — the refusal below is.
const npub = nip19.npubEncode(pk);
console.log(`Brand:      ${BRAND.id} (${BRAND.displayName}, ${BRAND.domain})`);
console.log(`Publishing for ${npub}`);

// THE PAIRING IS REFUSED, NOT PRINTED. There are two deploys, two keys and one
// script, and the brand comes from a line in the same env file as the key — so
// the pairing is set by hand, which makes it the part that goes wrong. Printing
// it only helps somebody who reads the output before it publishes, and this
// script publishes on the next line.
//
// `Brand.siteNpub` is the public half of each deploy's SITE_NOSTR_SK, so this
// compares what was loaded against what the brand says it should be. Both
// directions are real damage: the wrong way round overwrites the ORIGINAL
// site's kind:0 with the other brand's name, about, avatar and nip05.
if (npub !== BRAND.siteNpub) {
  console.error(`
✗ REFUSING TO PUBLISH — this key is not this brand's key.

  NEXT_PUBLIC_BRAND says   ${BRAND.id} (${BRAND.displayName})
  which expects            ${BRAND.siteNpub}
  but SITE_NOSTR_SK is     ${npub}

  Publishing would put the ${BRAND.displayName} name, about, avatar and nip05
  on that second identity, where anyone resolving it sees them.

  One env file carries BOTH values, so exactly one line in it is wrong:
    .env.local        NEXT_PUBLIC_BRAND unset or 'bmb'
    .env.buddy.local  NEXT_PUBLIC_BRAND=buddy

  If you rotated a key deliberately, update siteNpub in lib/brand.ts AND in
  scripts/check-brand.mjs (check:brand pins the literal in both), then re-run.
`);
  process.exit(1);
}

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
  const results = await Promise.allSettled(pool.publish(PUBLISH_TO, event));
  results.forEach((r, i) => {
    console.log(`  ${r.status === 'fulfilled' ? '✓' : '✗'} ${PUBLISH_TO[i]}${r.status === 'rejected' ? ` — ${r.reason}` : ''}`);
  });
}
pool.close(PUBLISH_TO);
console.log('\nDone.');
process.exit(0); // SimplePool leaves sockets open; exit so the script doesn't hang
