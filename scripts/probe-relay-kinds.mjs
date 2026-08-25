// Ask the real relays whether they will take the Value Playback Event kinds.
//
// Usage:
//   npm run probe:kinds                        # write + read back, all 3 kinds
//   npm run probe:kinds -- --relay wss://…     # repeatable, replaces the list
//   npm run probe:kinds -- --read <npub|hex>   # read existing 3369s instead
//
// Why this exists: `3369`, `23369` and `33369` are unassigned kinds, and
// "will relays accept them" is not answerable from the NIPs. NIP-01 says the
// ranges are valid (`1000 <= n < 10000` regular, `20000 <= n < 30000`
// ephemeral, `30000 <= n < 40000` addressable) and most general-purpose relays
// store any regular kind — but several relays in this app's default list are
// not general-purpose (an index, an app's own relay, a cache), and a rate limit
// or a kind allowlist is invisible until you write to one.
//
// TWO ANSWERS PER RELAY, AND THE SECOND IS THE ONE THAT MATTERS. A relay can
// answer `OK true` and store nothing: the write is accepted, the read comes
// back empty, and a publisher trusting the OK believes it has a durable record
// it does not have. So every kind is written AND read back.
//
// FOR 23369 AN EMPTY READ IS THE CORRECT ANSWER, NOT A FAILURE. Ephemeral
// events are forwarded to live subscribers and never stored, so
// `stored: false` there means the relay implements NIP-01 properly, while
// `stored: true` means it ignores the range. Reporting those two as one
// outcome would mark every correctly-behaving relay as broken — which is the
// mistake this file exists to avoid making in a table someone later trusts.
//
// Raw WebSocket rather than SimplePool, deliberately: the whole payload here is
// the relay's own `OK` message and its `reason` string ("blocked: kind not
// allowed", "rate-limited: …"). A pool collapses that into resolve/reject and
// throws away the sentence that tells you what to change.
//
// It signs with a KEY IT GENERATES and never touches the user's. It writes a
// few tiny events to public relays and pays nothing. Descriptive only: it does
// not import lib/nostr/value-playback.ts (that module is 'use client' and
// reaches browser globals through ./relays), and it does not need to — what is
// under test here is the RELAY, not our template builder. The repo rule about
// importing the shipping module governs `check:*` scripts pinning our own
// behaviour; this measures somebody else's.
//
// The relay list is restated rather than imported from lib/nostr/relays.ts for
// the same reason probe-favorites.mjs restates it: that module pulls in
// ./pool and ../storage, and with them browser globals this script has none of.
// Override with --relay (repeatable) if it drifts.

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';

const RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.fountain.fm',
];

const KINDS = [
  { kind: 3369, label: 'receipt   ', range: 'regular',     expectStored: true },
  { kind: 23369, label: 'ticker    ', range: 'ephemeral',  expectStored: false },
  { kind: 33369, label: 'summary   ', range: 'addressable', expectStored: true },
];

const CONNECT_TIMEOUT_MS = 8000;
const OK_TIMEOUT_MS = 10000;
const READ_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flags = { relay: [], read: [] };
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (!a.startsWith('--')) {
    console.error(`unexpected argument ${a}`);
    process.exit(1);
  }
  const name = a.slice(2);
  if (!(name in flags)) {
    console.error(`unknown flag ${a}\nusage: probe:kinds [--relay wss://…] [--read <npub>]`);
    process.exit(1);
  }
  const value = argv[++i];
  if (!value) {
    console.error(`${a} needs a value`);
    process.exit(1);
  }
  flags[name].push(value);
}

const relays = flags.relay.length ? flags.relay : RELAYS;

function toHexPubkey(input) {
  if (/^[0-9a-f]{64}$/i.test(input)) return input.toLowerCase();
  try {
    const { type, data } = nip19.decode(input);
    if (type === 'npub') return data;
    if (type === 'nprofile') return data.pubkey;
  } catch {
    /* fall through */
  }
  console.error(`not an npub or hex pubkey: ${input}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// one socket, request/response helpers
// ---------------------------------------------------------------------------

function connect(url) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* already gone */ }
      reject(new Error('connect timed out'));
    }, CONNECT_TIMEOUT_MS);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('connect failed'));
    }, { once: true });
  });
}

/** Send one EVENT and wait for the relay's own OK line, reason included. */
function publish(ws, event) {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => { ws.removeEventListener('message', onMessage); resolve({ ok: null, reason: 'no OK within timeout' }); },
      OK_TIMEOUT_MS,
    );
    function onMessage(ev) {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg[0] === 'OK' && msg[1] === event.id) {
        clearTimeout(timer);
        ws.removeEventListener('message', onMessage);
        resolve({ ok: msg[2] === true, reason: msg[3] || '' });
      }
      if (msg[0] === 'NOTICE') noticed.push(String(msg[1]).slice(0, 120));
    }
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify(['EVENT', event]));
  });
}

/** REQ one filter and collect events until EOSE or the deadline. */
function query(ws, filter) {
  return new Promise((resolve) => {
    const subId = `probe${Math.floor(performance.now())}${Math.floor(process.hrtime()[1] % 9973)}`;
    const events = [];
    const finish = () => {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      try { ws.send(JSON.stringify(['CLOSE', subId])); } catch { /* socket gone */ }
      resolve(events);
    };
    const timer = setTimeout(finish, READ_TIMEOUT_MS);
    function onMessage(ev) {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg[1] !== subId) return;
      if (msg[0] === 'EVENT') events.push(msg[2]);
      if (msg[0] === 'EOSE' || msg[0] === 'CLOSED') finish();
    }
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify(['REQ', subId, filter]));
  });
}

const noticed = [];

// ---------------------------------------------------------------------------
// the events under test
// ---------------------------------------------------------------------------

// A real-shaped receipt, not a stub: a relay that filters on tag count, tag
// names or content size must see what it would really be asked to store.
function templateFor(kind, nowSec) {
  const tags = [
    ['i', 'podcast:guid:c90e609a-df1e-596a-bd5e-57bcc8aad6cc'],
    ['k', 'podcast:guid'],
    ['i', 'podcast:item:guid:d98d189b-dc7b-45b1-8720-d4b98690f31f'],
    ['k', 'podcast:item:guid'],
    ['amount', '30000'],
    ['action', 'auto'],
    ['start', String(nowSec - 600)],
    ['end', String(nowSec)],
    ['position', '412'],
    ['session', 'probe000'],
    ['app', 'BoostMeBitch'],
    ['alt', '30 sats streamed (value playback receipt)'],
  ];
  if (kind === 33369) {
    tags.unshift(['d', 'podcast:item:guid:d98d189b-dc7b-45b1-8720-d4b98690f31f']);
  }
  return { kind, created_at: nowSec, tags, content: '' };
}

// ---------------------------------------------------------------------------
// read mode
// ---------------------------------------------------------------------------

async function readMode(pubkey) {
  console.log(`reading kind:3369 for ${pubkey.slice(0, 12)}… across ${relays.length} relays\n`);
  let total = 0;
  for (const url of relays) {
    let ws;
    try {
      ws = await connect(url);
    } catch (e) {
      console.log(`  ${url.padEnd(28)} — ${e.message}`);
      continue;
    }
    const events = await query(ws, { kinds: [3369], authors: [pubkey], limit: 20 });
    ws.close();
    total += events.length;
    console.log(`  ${url.padEnd(28)} — ${events.length} event(s)`);
    for (const ev of events) {
      const tag = (n) => ev.tags.find((t) => t[0] === n)?.[1] ?? '';
      const ids = ev.tags.filter((t) => t[0] === 'i').map((t) => t[1]);
      console.log(
        `      ${new Date(ev.created_at * 1000).toISOString()}  ${tag('amount').padStart(8)} msat  ${tag('action')}  session=${tag('session')}`,
      );
      for (const i of ids) console.log(`          i  ${i}`);
    }
  }
  console.log(`\n${total} event(s) total.`);
  if (!total) {
    console.log(
      'Nothing found. Either none were published, or the read relays differ from\n' +
      'the write relays — this app publishes to the NIP-65 write set unioned with\n' +
      'the defaults, so pass --relay if the account writes somewhere else.',
    );
  }
}

// ---------------------------------------------------------------------------
// write + read-back mode
// ---------------------------------------------------------------------------

async function writeMode() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const nowSec = Math.floor(Date.now() / 1000);
  const signed = KINDS.map((k) => ({ ...k, event: finalizeEvent(templateFor(k.kind, nowSec), sk) }));

  console.log('Value Playback Event kinds — relay acceptance probe');
  console.log(`throwaway pubkey ${pk.slice(0, 16)}…  (generated here; your keys are untouched)\n`);

  const rows = [];
  for (const url of relays) {
    let ws;
    try {
      ws = await connect(url);
    } catch (e) {
      console.log(`${url}\n  connect: ${e.message}\n`);
      for (const k of signed) rows.push({ url, kind: k.kind, verdict: 'unreachable' });
      continue;
    }
    console.log(url);
    for (const k of signed) {
      const res = await publish(ws, k.event);
      let stored = null;
      if (res.ok) {
        const back = await query(ws, { ids: [k.event.id] });
        stored = back.length > 0;
      }
      const verdict = verdictFor(k, res, stored);
      rows.push({ url, kind: k.kind, verdict });
      const reason = res.reason ? `  “${res.reason}”` : '';
      console.log(
        `  ${k.kind} ${k.label} write ${res.ok === null ? 'TIMEOUT' : res.ok ? 'OK ' : 'REJECTED'}` +
        `   read-back ${stored === null ? '—' : stored ? 'stored' : 'absent'}   → ${verdict}${reason}`,
      );
    }
    ws.close();
    console.log('');
  }

  summarize(rows);
  if (noticed.length) {
    console.log('\nrelay NOTICEs seen:');
    for (const n of new Set(noticed)) console.log(`  ${n}`);
  }
}

/**
 * Turn a write result plus a read-back into one word.
 *
 * `usable` for a regular/addressable kind means written AND readable. For the
 * ephemeral 23369 it means written and correctly NOT stored — see the header.
 * `stored-not-ephemeral` is not a failure either; it means the relay ignores
 * the ephemeral range, which costs storage but still delivers.
 */
function verdictFor(k, res, stored) {
  if (res.ok === null) return 'no-answer';
  if (!res.ok) return 'refused';
  if (k.expectStored) return stored ? 'usable' : 'accepted-not-stored';
  return stored ? 'usable (stored-not-ephemeral)' : 'usable (ephemeral)';
}

function summarize(rows) {
  console.log('summary');
  for (const k of KINDS) {
    const mine = rows.filter((r) => r.kind === k.kind);
    const good = mine.filter((r) => r.verdict.startsWith('usable'));
    console.log(
      `  ${k.kind} (${k.range}): ${good.length}/${mine.length} relays usable` +
      (good.length ? ` — ${good.map((r) => host(r.url)).join(', ')}` : ''),
    );
    for (const r of mine.filter((x) => !x.verdict.startsWith('usable'))) {
      console.log(`      ${host(r.url)}: ${r.verdict}`);
    }
  }
  console.log(
    '\n`accepted-not-stored` on a regular kind is the dangerous one: the relay\n' +
    'answered OK and kept nothing, so a publisher trusting the OK has no record.',
  );
}

const host = (url) => url.replace(/^wss?:\/\//, '');

// ---------------------------------------------------------------------------

if (typeof WebSocket === 'undefined') {
  console.error('no global WebSocket — needs Node 22+');
  process.exit(1);
}

if (flags.read.length) {
  await readMode(toHexPubkey(flags.read[0]));
} else {
  await writeMode();
}
process.exit(0);
