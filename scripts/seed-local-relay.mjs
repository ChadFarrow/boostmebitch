// Copy an account's REAL kind:10333 off the public relays into the local one,
// so a local test starts from real data instead of a blank list.
//
// Usage:
//   npm run relay                                  # in another terminal
//   npm run seed:relay -- <npub|hex>
//   npm run seed:relay -- <npub> --from f.json     # from a probe:favorites dump
//
// STRICTLY READ-ONLY against the public relays. It fetches, prints what it
// found, and writes only to ws://127.0.0.1. Nothing it does can touch the
// shared event.
//
// Why bother: an empty relay is a real state and worth testing, but it is the
// EASY one. The states that have cost this repo data all need a list with
// history in it — another app's entries, a group that exists only to place a
// track, a non-UUID item guid, a malformed identifier. Those are on the wire
// and nowhere else, so a local test that starts blank never reaches them.

import { SimplePool } from 'nostr-tools/pool';
import { nip19 } from 'nostr-tools';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, f) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : f; };
const target = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--from'
  && argv[argv.indexOf(a) - 1] !== '--port');
const PORT = Number(arg('port', 7447));
const FROM = arg('from', null);

if (!target) {
  console.error('Usage: npm run seed:relay -- <npub|hex> [--from dump.json] [--port 7447]');
  process.exit(1);
}

let pubkey = target;
if (target.startsWith('npub')) {
  try { pubkey = nip19.decode(target).data; } catch { console.error('bad npub'); process.exit(1); }
}

const READ_RELAYS = [
  'wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nos.lol',
  'wss://relay.nostr.band', 'wss://relay.fountain.fm',
];

let event = null;

if (FROM) {
  const dump = JSON.parse(readFileSync(FROM, 'utf8'));
  const d = dump.kind10333;
  if (!d) { console.error(`${FROM} holds no kind10333 entry`); process.exit(1); }
  event = { id: d.id, pubkey, kind: 10333, created_at: d.created_at, tags: d.tags, content: d.content ?? '', sig: '0'.repeat(128) };
  console.log(`loaded from ${FROM}`);
} else {
  console.log(`reading kind:10333 for ${pubkey.slice(0, 12)}… from ${READ_RELAYS.length} public relays (read-only)`);
  const pool = new SimplePool();
  event = await pool.get(READ_RELAYS, { kinds: [10333], authors: [pubkey], limit: 1 });
  pool.close(READ_RELAYS);
}

if (!event) {
  console.log('\nNo kind:10333 found for that account. Nothing to seed — the local relay');
  console.log('starts empty, which is itself a valid thing to test.');
  process.exit(0);
}

const iTags = event.tags.filter((t) => t[0] === 'i').length;
console.log('');
console.log(`  created_at   ${event.created_at}  (${new Date(event.created_at * 1000).toISOString()})`);
console.log(`  tags         ${event.tags.length}  (${iTags} entries)`);
console.log(`  content      ${event.content === '' ? 'empty — no private half' : `${event.content.length} chars — A PRIVATE HALF`}`);
console.log('');

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
ws.onerror = () => {
  console.error(`Could not reach ws://127.0.0.1:${PORT} — is \`npm run relay\` running?`);
  process.exit(1);
};
ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]));
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d[0] !== 'OK') return;
  console.log(d[2] ? 'seeded into the local relay.' : `relay refused it: ${d[3]}`);
  console.log('\nNow, in the browser console on http://localhost:3000 :');
  console.log(`  localStorage.setItem('bmb:relays', JSON.stringify(['ws://127.0.0.1:${PORT}']))`);
  console.log('  bmbEnablePrivateFavorites()');
  console.log('  location.reload()');
  console.log("\nWhen you're done:  localStorage.removeItem('bmb:relays')");
  process.exit(d[2] ? 0 : 1);
};
