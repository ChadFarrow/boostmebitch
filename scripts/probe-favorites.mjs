// Show what is actually on the relays for one account's favorites — the new
// kind:10333 single list, and the three addresses it replaces.
//
// Usage:
//   npm run probe:favorites -- <npub|hex> [--relay wss://…] [--dump <file>]
//
// Why this exists: this repo moved favorites from kind:30078 (two `d`-tagged
// addresses, data carried by position INSIDE each `i` tag) to kind:10333 (one
// plain replaceable event, data carried by position IN THE TAG ARRAY). Both
// apps now publish 10333 — StableKraft since 2026-08-13, this app since later
// the same evening — and the old 30078 addresses survive on relays as the
// rollback path only. Two writers on one replaceable event is exactly the
// situation where you want the real bytes in front of you rather than the
// shape your own struct implies.
//
// DESCRIPTIVE ONLY, and deliberately so. It reports the raw tag array — counts,
// order, and the specific things the spec says are load-bearing — and does NOT
// parse into this app's model. A probe that reimplemented the parser would be a
// second implementation to keep in sync, and the one place it disagreed with
// the real one is exactly the place it would tell you everything was fine.
// `--dump` writes the raw tags to a file, which is where check:favsync's
// fixtures should come from: the repo rule is that a vector is built from a
// literal WIRE tag array and never from the struct you parse it into.
//
// Read-only. It opens sockets, reads, and prints. It imports no publish path,
// signs nothing, and pays nothing.
//
// The relay list is restated here rather than imported from lib/nostr/relays.ts,
// which pulls in `./pool` and `../storage` and with them the browser globals
// this script has none of. Override with --relay (repeatable) if it drifts.

import { writeFileSync } from 'node:fs';
import { SimplePool } from 'nostr-tools/pool';
import { nip19 } from 'nostr-tools';

const RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.fountain.fm',
];

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
  console.error('Usage: npm run probe:favorites -- <npub|hex> [--relay wss://…] [--dump <file>]');
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
// the four addresses
// ---------------------------------------------------------------------------

const ADDRESSES = [
  { label: 'kind:10333  (NEW — the single list)', filter: { kinds: [10333], authors: [pubkey], limit: 1 }, dTag: null },
  { label: 'kind:30078  d:podcast:favorites        (old shared, feeds)', filter: { kinds: [30078], authors: [pubkey], '#d': ['podcast:favorites'], limit: 1 }, dTag: 'podcast:favorites' },
  { label: 'kind:30078  d:podcast:favorites:items  (old shared, items)', filter: { kinds: [30078], authors: [pubkey], '#d': ['podcast:favorites:items'], limit: 1 }, dTag: 'podcast:favorites:items' },
  { label: 'kind:30003  d:boostmebitch:favorites   (old legacy, this app)', filter: { kinds: [30003], authors: [pubkey], '#d': ['boostmebitch:favorites'], limit: 1 }, dTag: 'boostmebitch:favorites' },
];

// Collect rather than take the first: a replaceable event can differ between
// relays, and "which relay had which version" is the whole question when a
// republish has raced. Also counts reached/answered, because an empty result
// from a relay that never answered is not evidence of an empty list — the same
// distinction lib/nostr/read-trust.ts exists to make.
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
// describing a tag array — raw shape only, no model
// ---------------------------------------------------------------------------

const SHOW_PREFIX = 'podcast:guid:';
const ITEM_PREFIX = 'podcast:item:guid:';

function describe10333(tags) {
  const lines = [];
  const byType = new Map();
  for (const t of tags) byType.set(t[0], (byType.get(t[0]) ?? 0) + 1);

  // Walk exactly as the spec says a reader must: `medium` is a running value,
  // a podcast:guid entry opens a group, item entries attach to the most
  // recently opened group.
  let medium;
  let current = null;
  const groups = [];
  const orphans = [];
  const unknownIds = [];
  const mediumRuns = [];
  let sawMediumTag = false;

  for (const t of tags) {
    if (t[0] === 'medium') {
      medium = t[1] || undefined;
      sawMediumTag = true;
      mediumRuns.push(medium ?? '(empty)');
      continue;
    }
    if (t[0] !== 'i' || !t[1]) continue;
    const id = t[1];
    if (id.startsWith(SHOW_PREFIX)) {
      current = { feedGuid: id.slice(SHOW_PREFIX.length), medium, items: [], extraPositions: t.length - 2 };
      groups.push(current);
      continue;
    }
    if (id.startsWith(ITEM_PREFIX)) {
      const entry = { itemGuid: id.slice(ITEM_PREFIX.length), extraPositions: t.length - 2 };
      if (current) current.items.push(entry);
      else orphans.push(entry);
      continue;
    }
    unknownIds.push(id);
  }

  const itemless = groups.filter((g) => g.items.length === 0);
  const withItems = groups.filter((g) => g.items.length > 0);
  const unknownMedium = groups.filter((g) => g.medium === undefined);
  const totalItems = groups.reduce((n, g) => n + g.items.length, 0) + orphans.length;

  lines.push(`  tag types            ${[...byType].map(([k, n]) => `${k}×${n}`).join('  ')}`);
  lines.push(`  first tag            ${JSON.stringify(tags[0])}`);
  lines.push('');
  lines.push(`  feed groups          ${groups.length}`);
  lines.push(`    itemless           ${itemless.length}   ← the only unambiguous FEED favorites`);
  lines.push(`    with items         ${withItems.length}   ← unknowable: may exist only to place a track`);
  lines.push(`    unknown medium     ${unknownMedium.length}   ← entries before the first ["medium",…] tag`);
  lines.push(`  item entries         ${totalItems}`);
  lines.push(`    orphaned           ${orphans.length}   ← items before any group opened`);
  lines.push(`  unrecognized i kinds ${unknownIds.length}${unknownIds.length ? `   ← ${unknownIds.slice(0, 5).join(', ')}` : ''}`);

  // k layout — the spec requires readers to accept both, and getting it wrong
  // reads as an empty library rather than as an error.
  const ks = tags.filter((t) => t[0] === 'k');
  const iCount = tags.filter((t) => t[0] === 'i').length;
  const kValues = [...new Set(ks.map((t) => t[1]))];
  const trailing = tags.length > 0 && ks.length > 0
    && tags.slice(tags.length - ks.length).every((t) => t[0] === 'k');
  lines.push('');
  lines.push(`  k tags               ${ks.length} (${kValues.length} distinct: ${kValues.join(', ') || '—'})`);
  lines.push(`  k layout             ${ks.length === 0 ? 'none' : ks.length === kValues.length ? 'one per distinct kind' : ks.length === iCount ? 'PAIRED with every i (older revision)' : 'mixed'}${ks.length ? `, ${trailing ? 'trailing' : 'NOT trailing'}` : ''}`);

  // Contiguity: same-medium groups must not be interleaved, or the block
  // boundaries stop meaning anything.
  const seen = [];
  let broken = 0;
  for (const g of groups) {
    const key = g.medium ?? '(unknown)';
    if (seen[seen.length - 1] !== key) {
      if (seen.includes(key)) broken += 1;
      seen.push(key);
    }
  }
  lines.push(`  medium blocks        ${sawMediumTag ? mediumRuns.join(' → ') : '(no medium tag at all)'}`);
  lines.push(`  contiguity           ${broken === 0 ? 'ok — no medium block reopens' : `BROKEN — ${broken} medium block(s) reopen after another`}`);

  // Position 2+ on an i tag: the new format has none. Anything here is either a
  // NIP-73 hint or an old-format event that landed at the wrong kind.
  const withExtras = tags.filter((t) => t[0] === 'i' && t.length > 2);
  lines.push(`  i tags with pos 2+   ${withExtras.length}${withExtras.length ? `   ← ${JSON.stringify(withExtras[0])}` : '   (correct — entries are bare 2-element tags)'}`);

  return lines.join('\n');
}

function describeOld(tags) {
  const lines = [];
  const is = tags.filter((t) => t[0] === 'i');
  const widths = new Map();
  for (const t of is) widths.set(t.length, (widths.get(t.length) ?? 0) + 1);
  const shows = is.filter((t) => t[1]?.startsWith(SHOW_PREFIX)).length;
  const items = is.filter((t) => t[1]?.startsWith(ITEM_PREFIX)).length;
  const other = is.length - shows - items;
  const withMedium = is.filter((t) => t[4]).length;
  const withFeedRef = is.filter((t) => t[3]).length;
  const withUrl = is.filter((t) => t[2]).length;
  const prefixedRefs = is.filter((t) => t[3]?.startsWith(SHOW_PREFIX)).length;
  const beyond4 = is.filter((t) => t.length > 5).length;

  lines.push(`  i entries            ${is.length}  (shows ${shows}, items ${items}, other ${other})`);
  lines.push(`  tag widths           ${[...widths].sort((a, b) => a[0] - b[0]).map(([w, n]) => `${w}-element ×${n}`).join('  ')}`);
  lines.push(`  pos 2 (feed URL)     ${withUrl}   ← NO SLOT in kind:10333; this is what migration drops`);
  lines.push(`  pos 3 (parent guid)  ${withFeedRef}   (${prefixedRefs} still carry the podcast:guid: prefix)`);
  lines.push(`  pos 4 (medium)       ${withMedium}`);
  lines.push(`  pos 5+ (foreign)     ${beyond4}`);
  const dTag = tags.find((t) => t[0] === 'd')?.[1];
  const title = tags.find((t) => t[0] === 'title')?.[1];
  lines.push(`  d / title            ${dTag ?? '—'} / ${title ?? '—'}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

console.log(`pubkey  ${pubkey}`);
console.log(`npub    ${nip19.npubEncode(pubkey)}`);
console.log(`relays  ${relays.join('  ')}\n`);

const pool = new SimplePool();
const dump = {};

for (const addr of ADDRESSES) {
  console.log('═'.repeat(78));
  console.log(addr.label);
  console.log('═'.repeat(78));

  const { best, byRelay, reached, answered } = await read(pool, addr.filter);
  const trustworthy = best !== null || (reached > 0 && answered >= reached);

  console.log(`  read                 ${reached} reached, ${answered} answered → ${trustworthy ? 'TRUSTWORTHY' : 'DEGRADED (an empty result here means nothing)'}`);

  if (!best) {
    console.log(`  event                none\n`);
    continue;
  }

  const bytes = Buffer.byteLength(JSON.stringify(best));
  const versions = new Set([...byRelay.values()].map((e) => e.created_at));
  console.log(`  created_at           ${best.created_at}  (${new Date(best.created_at * 1000).toISOString()})`);
  console.log(`  size                 ${(bytes / 1024).toFixed(1)} KB of ~128 KB relay cap  (${(bytes / 1024 / 128 * 100).toFixed(0)}% used)`);
  console.log(`  tags                 ${best.tags.length}`);
  console.log(`  content              ${best.content === '' ? 'empty (correct)' : `${best.content.length} chars — NOT empty`}`);
  if (versions.size > 1) {
    console.log(`  ⚠ VERSION SKEW       ${versions.size} different created_at across relays:`);
    for (const [url, e] of byRelay) console.log(`      ${e.created_at}  ${url}`);
  }
  console.log('');
  console.log(addr.dTag === null ? describe10333(best.tags) : describeOld(best.tags));
  console.log('');

  dump[addr.dTag === null ? 'kind10333' : `kind${best.kind}:${addr.dTag}`] = {
    created_at: best.created_at, id: best.id, tags: best.tags,
  };
}

pool.close(relays);

if (dumpTo) {
  writeFileSync(dumpTo, `${JSON.stringify(dump, null, 2)}\n`);
  console.log(`raw tags written to ${dumpTo}`);
}
