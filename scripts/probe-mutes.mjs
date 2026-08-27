// Show what is actually on the relays for one account's NIP-51 mute list, and
// — the reason this exists — WHICH CIPHER its private half is written in.
//
// Usage:
//   npm run probe:mutes -- <npub|hex> [--relay wss://…] [--dump <file>]
//
// Why this exists: a kind:10000 carries an encrypted JSON tag array in
// `event.content`, and there has never been exactly one encoding for it. NIP-51
// originally specified NIP-04 and later moved private list items to NIP-44, so
// the relays hold a mixture; some clients leave the tags there unencrypted.
// This app read every one of them as NIP-04, which is how a Clave sign-in on
// iOS came back with `nip04_decrypt failed: Invalid base64`.
//
// So the question this answers is not "what does my mute list contain" — it is
// "what shape are these bytes, and does the app agree with me about it". It
// prints the RAW EVIDENCE (length, leading characters, whether `?iv=` occurs
// and where) beside `classifyMuteContent`'s verdict, so a human can check the
// verdict rather than take it.
//
// It IMPORTS the real classifier rather than restating it, which is the
// opposite of what probe-favorites.mjs does with the favorites parser, and
// deliberately so. That probe describes a tag array a human then judges; this
// one exists to confirm the app's own routing decision, so a second copy of the
// test would be able to disagree with the shipping one in exactly the case that
// matters. `lib/nostr/mute-state.ts` is import-free, so it loads under
// `--experimental-strip-types` — the same arrangement check:mutes relies on.
//
// READ-ONLY, and it holds no key. It opens sockets, reads, and prints. It never
// decrypts and can never print a plaintext: everything below works on the
// ciphertext's SHAPE. It imports no publish path, signs nothing, pays nothing.
//
// The relay list is restated here rather than imported from lib/nostr/relays.ts,
// which pulls in `./pool` and `../storage` and with them the browser globals
// this script has none of. Override with --relay (repeatable) if it drifts.

import { writeFileSync } from 'node:fs';
import { SimplePool } from 'nostr-tools/pool';
import { nip19 } from 'nostr-tools';
import { classifyMuteContent } from '../lib/nostr/mute-state.ts';

const RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.fountain.fm',
];

const MUTES_KIND = 10000;
const MAX_WAIT_MS = 6000;

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flags = { relay: [], dump: [] };
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const name = a.slice(2);
    if (!(name in flags)) {
      console.error(`unknown flag ${a}`);
      process.exit(1);
    }
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
      console.error(`${a} needs a value`);
      process.exit(1);
    }
    flags[name].push(argv[i + 1]);
    i += 1; // consume the value, so it can't be read as the npub
    continue;
  }
  positional.push(a);
}
const who = positional[0];

if (!who) {
  console.error('Usage: npm run probe:mutes -- <npub|hex> [--relay wss://…] [--dump <file>]');
  process.exit(1);
}

let pubkey;
if (who.startsWith('npub')) {
  try {
    const d = nip19.decode(who);
    if (d.type !== 'npub') throw new Error(`not an npub (${d.type})`);
    pubkey = d.data;
  } catch (e) {
    console.error(`could not decode ${who}: ${e.message}`);
    process.exit(1);
  }
} else if (/^[0-9a-f]{64}$/i.test(who)) {
  pubkey = who.toLowerCase();
} else {
  console.error(`not an npub or 64-char hex pubkey: ${who}`);
  process.exit(1);
}

const relays = flags.relay.length ? flags.relay : RELAYS;
const dumpTo = flags.dump[0];

// ---------------------------------------------------------------------------
// read
//
// Collect rather than take the first: a replaceable event can differ between
// relays, and "which relay had which version" is the whole question when a
// republish has raced. Also counts reached/answered, because an empty result
// from a relay that never answered is not evidence of an empty list — the same
// distinction lib/nostr/read-trust.ts exists to make.
// ---------------------------------------------------------------------------

async function read(pool, filter) {
  return new Promise((resolve) => {
    const byRelay = new Map();
    let best = null;
    let reached = 0;
    let answered = 0;
    let outstanding = relays.length;
    let settled = false;
    const subs = [];

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const s of subs) { try { s.close(); } catch { /* already closed */ } }
      resolve({ best, byRelay, reached, answered });
    };
    const timer = setTimeout(finish, MAX_WAIT_MS);

    for (const url of relays) {
      let done = false;
      const terminal = (fn) => {
        if (done) return;
        done = true;
        fn();
        outstanding -= 1;
        if (outstanding <= 0) finish();
      };
      pool.ensureRelay(url).then((relay) => {
        if (settled) return;
        reached += 1;
        try {
          subs.push(relay.subscribe([filter], {
            eoseTimeout: MAX_WAIT_MS + 750,
            onevent(e) {
              if (e.pubkey !== pubkey) return;
              const prev = byRelay.get(url);
              if (!prev || e.created_at > prev.created_at) byRelay.set(url, e);
              if (!best || e.created_at > best.created_at) best = e;
            },
            oneose() { terminal(() => { answered += 1; }); },
            onclose() { terminal(() => { reached -= 1; }); },
          }));
        } catch {
          terminal(() => { reached -= 1; });
        }
      }).catch(() => terminal(() => {}));
    }
  });
}

// ---------------------------------------------------------------------------
// describe — raw shape only
// ---------------------------------------------------------------------------

function describeTags(tags) {
  const byType = new Map();
  for (const t of tags) byType.set(t[0], (byType.get(t[0]) ?? 0) + 1);
  const lines = [`  ${tags.length} tags`];
  for (const [type, n] of [...byType].sort((a, b) => b[1] - a[1])) {
    lines.push(`    ${type.padEnd(6)} ${n}`);
  }
  return lines;
}

/**
 * The evidence, then the verdict — in that order, so the verdict can be
 * checked rather than believed.
 */
function describeContent(content) {
  const lines = [];
  if (!content) {
    lines.push('  content: EMPTY — this account has no private half');
    return lines;
  }

  const ivAt = content.indexOf('?iv=');
  const head = content.slice(0, 24);
  const base64ish = /^[A-Za-z0-9+/]+={0,2}$/.test(content);

  lines.push(`  content: ${content.length} chars`);
  lines.push(`    first 24        ${JSON.stringify(head)}`);
  lines.push(`    leading char    ${JSON.stringify(content[0])}`
    + (content[0] === 'A' ? '   (NIP-44 v2 version byte 0x02 always encodes to "A")' : ''));
  lines.push(`    "?iv=" at       ${ivAt === -1 ? 'not present' : ivAt}`);
  lines.push(`    base64 alphabet ${base64ish ? 'yes' : 'no'}`);
  lines.push(`    length % 4      ${content.length % 4}`);

  // The shipping classifier, not a copy of it.
  const verdict = classifyMuteContent(content);
  lines.push('');
  lines.push(`  classifyMuteContent() → ${verdict}`);
  if (verdict === 'unknown') {
    lines.push('    The app will PARK this verbatim and ask no signer. If the evidence');
    lines.push('    above looks like a real NIP-44 payload, loosen looksNip44() in');
    lines.push('    lib/nostr/mute-state.ts — and add this payload to check:mutes first.');
  }
  return lines;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const pool = new SimplePool();

console.log(`\npubkey  ${pubkey}`);
console.log(`relays  ${relays.join(', ')}\n`);

const { best, byRelay, reached, answered } = await read(pool, {
  kinds: [MUTES_KIND],
  authors: [pubkey],
  limit: 1,
});

console.log(`kind:${MUTES_KIND}  (NIP-51 mute list)`);
console.log(`  reached ${reached}/${relays.length} relays, ${answered} answered`
  + (reached > 0 && answered === reached ? '  (trustworthy read)' : '  (DEGRADED — an empty result here is not evidence)'));

if (!best) {
  console.log('  no event found\n');
} else {
  console.log(`  id ${best.id}`);
  console.log(`  created_at ${best.created_at}  (${new Date(best.created_at * 1000).toISOString()})`);
  for (const line of describeTags(best.tags)) console.log(line);
  console.log('');
  for (const line of describeContent(best.content)) console.log(line);
  console.log('');

  // Version skew across relays is the thing a single "best" hides.
  const versions = new Set([...byRelay.values()].map((e) => e.created_at));
  if (versions.size > 1) {
    console.log('  VERSION SKEW — relays disagree about the newest event:');
    for (const [url, e] of byRelay) console.log(`    ${e.created_at}  ${url}`);
    console.log('');
  }
}

if (dumpTo) {
  // The raw wire, for building check:mutes fixtures. The repo rule is that a
  // vector is a literal the relay could have sent, never a struct you parsed
  // it into — this is where those come from.
  writeFileSync(dumpTo, JSON.stringify(best
    ? { id: best.id, created_at: best.created_at, tags: best.tags, content: best.content }
    : null, null, 2));
  console.log(`dumped raw event to ${dumpTo}\n`);
}

pool.close(relays);
