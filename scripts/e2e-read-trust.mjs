// End-to-end for the relay ACCOUNTING behind every "may I believe this empty
// read" guard (lib/nostr/event-queries.ts, `perRelayRead`), against scripted
// relays on this machine.
//
// Usage:
//   npm run e2e:readtrust
//
// Needs no dev server. Runs in about 15 s.
//
// WHY THIS EXISTS. check:readtrust pins the predicate (`readIsTrustworthy`) and
// says in its own header what it cannot pin: the wiring — that `reached` and
// `answered` count what really happened on each socket. That needs a relay that
// hangs, one that refuses and one that is not there, and no real relay does any
// of those on request. These do.
//
// THE BUG IT WAS WRITTEN AGAINST (2026-11-26). `finish()` closed every
// subscription before it resolved, and nostr-tools' `sub.close()` calls the
// sub's own `onclose` synchronously — the branch meant for a relay that closes
// ON US before answering, which drops it from `reached`. So every relay still
// silent when the window ended was dropped by our own close: a relay that
// accepted the socket, received the REQ and never answered read as one that was
// never there, and the read beside it as trustworthy. The comments and
// docs/nostr.md said the opposite ("a relay that connects and hangs stays
// counted and unanswered, which correctly degrades the read").
//
// What that cost: `fetchEncryptedMnemonicDetailed` reads the Spark seed backup
// with this flag, and `backupOverwriteVerdict` lets a derived seed be published
// over the coordinate only on a trustworthy absence. A write relay that holds
// the user's backup and hangs, beside one that answers "none", was exactly that
// — a funded pasted seed's backup overwritten. The same flag guards a kind:0
// edit, the favorites create, the follow list and the kind:33369 sum.
//
// NOTHING LEAVES THIS MACHINE: the first import replaces the global WebSocket
// with one that opens to 127.0.0.1 only and ends the run on any other URL.

import { relayGuard } from './no-public-relays.mjs';
import { register } from 'node:module';
register('./e2e-resolve-hook.mjs', import.meta.url);

import { WebSocketServer } from 'ws';
import { createRelay } from './local-relay.mjs';
import { checker } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';

const t = checker();
const WAIT = 1500;

/** A relay that takes the socket and the REQ, and never says a word. */
async function hangingRelay() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const state = { reqs: 0 };
  wss.on('connection', (ws) => ws.on('message', (m) => {
    if (String(m).startsWith('["REQ"')) state.reqs++;
  }));
  return { url: `ws://127.0.0.1:${wss.address().port}`, state, close: () => wss.close() };
}

/** A relay that refuses the subscription with a NIP-01 CLOSED, before any EOSE. */
async function refusingRelay() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', (ws) => ws.on('message', (m) => {
    const msg = JSON.parse(String(m));
    if (msg[0] === 'REQ') ws.send(JSON.stringify(['CLOSED', msg[1], 'restricted: not here']));
  }));
  return { url: `ws://127.0.0.1:${wss.address().port}`, close: () => wss.close() };
}

/** A port nothing listens on: the connection is refused. */
async function absentRelay() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const url = `ws://127.0.0.1:${wss.address().port}`;
  await new Promise((r) => wss.close(r));
  return { url };
}

const answering = createRelay({ port: 0, log: null });
const A = `ws://127.0.0.1:${await answering.ready}`;
const answering2 = createRelay({ port: 0, log: null });
const A2 = `ws://127.0.0.1:${await answering2.ready}`;
const H = await hangingRelay();
const R = await refusingRelay();
const X = await absentRelay();

const { collectEventsDetailed, fetchLatestEventDetailed } = await import('../lib/nostr/event-queries.ts');

// The query: an author nobody has written as, so every answering relay's
// honest answer is "none".
const nobody = getPublicKey(generateSecretKey());
const absent = { kinds: [30078], authors: [nobody], '#d': ['e2e-read-trust'], limit: 1 };
const pick = (r) => ({ reached: r.reached, answered: r.answered, verdict: r.complete ?? r.trustworthy });

// ---------------------------------------------------------------------------
console.log('\n1. A relay that connects and never answers DEGRADES the read');
// ---------------------------------------------------------------------------
{
  const reqsBefore = H.state.reqs;
  const c = await collectEventsDetailed([A, H.url], absent, WAIT);
  t.equal('the silent relay really received the REQ', H.state.reqs > reqsBefore, true);
  t.equal('collect: it stays counted and unanswered, so the set is not whole', pick(c), { reached: 2, answered: 1, verdict: false });
  const l = await fetchLatestEventDetailed([A, H.url], absent, WAIT);
  t.equal('latest: an absence beside a silent relay is not trustworthy', pick(l), { reached: 2, answered: 1, verdict: false });
  const only = await collectEventsDetailed([H.url], absent, WAIT);
  t.equal('a silent relay alone: reached, never answered', pick(only), { reached: 1, answered: 0, verdict: false });
}

// ---------------------------------------------------------------------------
console.log('\n2. Must still work: what is NOT a degraded read');
// ---------------------------------------------------------------------------
{
  t.equal('every relay answered "none": trustworthy',
    pick(await fetchLatestEventDetailed([A, A2], absent, WAIT)), { reached: 2, answered: 2, verdict: true });
  t.equal('a relay that is not there leaves the denominator (a dead default never degrades a read)',
    pick(await fetchLatestEventDetailed([A, X.url], absent, WAIT)), { reached: 1, answered: 1, verdict: true });
  t.equal('a relay that REFUSES with CLOSED before EOSE leaves the denominator: we learned nothing',
    pick(await fetchLatestEventDetailed([A, R.url], absent, WAIT)), { reached: 1, answered: 1, verdict: true });
  t.equal('collect, same rule for a refusal',
    pick(await collectEventsDetailed([A, R.url], absent, WAIT)), { reached: 1, answered: 1, verdict: true });
  t.equal('nothing reachable at all is never proof of absence',
    pick(await fetchLatestEventDetailed([X.url], absent, WAIT)), { reached: 0, answered: 0, verdict: false });
}

// ---------------------------------------------------------------------------
console.log('\n3. An event in hand is proof the query worked, a silent relay or not');
// ---------------------------------------------------------------------------
{
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const ev = finalizeEvent({ kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'e2e-read-trust']], content: 'x' }, sk);
  answering.events.set(ev.id, ev);
  const filter = { kinds: [30078], authors: [pk], '#d': ['e2e-read-trust'], limit: 1 };
  const l = await fetchLatestEventDetailed([A, H.url], filter, WAIT);
  t.equal('latest: the event is found and the read is trustworthy', [l.event?.id === ev.id, l.trustworthy], [true, true]);
  t.equal('...and the silent relay still counts as reached, unanswered', [l.reached, l.answered], [2, 1]);
  // For a SUM an event in hand is not enough (DetailedCollect.complete).
  const c = await collectEventsDetailed([A, H.url], filter, WAIT);
  t.equal('collect: one event in hand beside a silent relay is still not the whole set', [c.events.length, c.complete], [1, false]);
}

t.equal('every socket this run opened went to this machine',
  relayGuard.opened.length > 0 && relayGuard.opened.every((u) => u.startsWith('ws://127.0.0.1:')), true);

answering.close(); answering2.close(); H.close(); R.close();
if (t.fails) {
  console.error(`\nREAD TRUST E2E FAILED (${t.fails})`);
  process.exit(1);
}
console.log('\nREAD TRUST E2E OK');
process.exit(0);
