// Pins `trustworthy` — the flag that decides whether a null read is "nobody has
// it" or "nothing answered".
//
// Usage:
//   npm run check:relaytrust
//
// Run it after ANY edit to fetchLatestEventDetailed in lib/nostr/event-queries.ts.
//
// Why this earns a check script: three callers write on the strength of this
// flag, and each one destroys something when it lies.
//
//   - fetchProfile negative-caches a kind:0 miss. A false positive pins a bare
//     npub for the full miss TTL — this actually happened in production when a
//     sign-in coincided with damus 503-ing.
//   - fetchRawProfile's result decides whether an editor may safely publish
//     over the user's existing kind:0. A false positive drops profile fields.
//   - the favorites hydrator refuses to reconcile or publish on a degraded
//     read. A false positive republishes the shared cross-app list with every
//     other app's entries stripped out of it — silently, on someone else's
//     device, with no undo.
//
// The bug this pins was invisible to every test that used real relays, because
// it needs relays that MISBEHAVE: one that accepts the socket and then says
// nothing, and a set that refuses to connect at all. A correct relay will not
// do either on request, so we run our own.
//
//   - nostr-tools SYNTHESIZES an eose on a timer (baseEoseTimeout, 4400ms) when
//     a relay never sends one. QUERY_MAX_WAIT_MS is 4000, which sits under that
//     by 400ms — so this app escaped the hung-relay half by accident, not by
//     design. That margin is exactly what the SYNTHETIC_EOSE case below guards:
//     raise the default past 4400 and it comes back.
//   - a failed connection also counted toward the aggregate eose, so with
//     nothing reachable it fired immediately and vacuously. Offline read as
//     proof of absence.
//
// See github.com/ChadFarrow/PC20-Nostr/specs/pc20-favorites.md
// ("An aggregate EOSE is not automatically an answer").

import { WebSocketServer } from 'ws';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import { fetchLatestEventDetailed } from '../lib/nostr/event-queries.ts';

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const filter = { kinds: [30078], authors: [pubkey], '#d': ['podcast:favorites'], limit: 1 };

let failures = 0;
const servers = [];

function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function signed(createdAt) {
  return finalizeEvent(
    {
      kind: 30078,
      created_at: createdAt,
      content: '',
      tags: [['d', 'podcast:favorites'], ['i', 'podcast:guid:9b024349-ccf0-5f69-a609-6b82873eab3c']],
    },
    sk,
  );
}

// mode: 'serve' (send events then eose) | 'eose' (answer, nothing to give) |
// 'silent' (accept the socket and never speak again)
async function startRelay(mode, events = []) {
  const wss = new WebSocketServer({ port: 0 });
  servers.push(wss);
  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg[0] !== 'REQ') return;
      if (mode === 'silent') return;
      if (mode === 'serve') for (const e of events) socket.send(JSON.stringify(['EVENT', msg[1], e]));
      socket.send(JSON.stringify(['EOSE', msg[1]]));
    });
  });
  await new Promise((r) => wss.on('listening', r));
  return `ws://127.0.0.1:${wss.address().port}`;
}

console.log('relay trust — scripted relays on localhost\n');

// 1. The ordinary case.
{
  const url = await startRelay('serve', [signed(1000)]);
  const r = await fetchLatestEventDetailed([url], filter, 3000);
  check('an event in hand is trusted', r.trustworthy && r.event?.created_at === 1000);
}

// 2. A genuinely empty list. Must be TRUSTED, or a first publish never happens
//    and a real clear-all can never propagate.
{
  const url = await startRelay('eose');
  const r = await fetchLatestEventDetailed([url], filter, 3000);
  check('a relay that answers with nothing is a trusted EMPTY list', r.trustworthy && r.event === null);
}

// 3. Same observable shape as 2, opposite meaning.
{
  const url = await startRelay('silent');
  const r = await fetchLatestEventDetailed([url], filter, 1500);
  check('a relay that says NOTHING is degraded, not empty', !r.trustworthy && r.event === null);
}

// 4. THE REGRESSION. With maxWait above nostr-tools' 4400ms synthetic-eose
//    timer, the old code counted the fake eose as an answer. The shipping
//    default (4000) sits under it by luck; this proves the fix, not the luck.
{
  const url = await startRelay('silent');
  const started = Date.now();
  const r = await fetchLatestEventDetailed([url], filter, 6000);
  check(
    'a hung relay is degraded even past the 4400ms synthetic eose',
    !r.trustworthy,
    `trustworthy=${r.trustworthy} after ${Date.now() - started}ms`,
  );
}

// 5. THE OTHER REGRESSION, and the likelier one: no network at all.
{
  const started = Date.now();
  const r = await fetchLatestEventDetailed(
    ['ws://127.0.0.1:9', 'ws://127.0.0.1:10', 'ws://127.0.0.1:11'],
    filter,
    3000,
  );
  check(
    'being offline is degraded, not a trusted empty list',
    !r.trustworthy,
    `trustworthy=${r.trustworthy} after ${Date.now() - started}ms`,
  );
}

// 6. The other side of that fix: an unreachable relay must not poison a read
//    the reachable ones answered, or one dead default degrades everything
//    forever.
{
  const live = await startRelay('eose');
  const r = await fetchLatestEventDetailed(['ws://127.0.0.1:9', live], filter, 3000);
  check('a dead relay does not block a good read from the others', r.trustworthy && r.event === null);
}

// 7. Newest wins across relays — a relay serving a stale revision looks exactly
//    as reachable as a current one.
{
  const stale = await startRelay('serve', [signed(1000)]);
  const fresh = await startRelay('serve', [signed(2000)]);
  const r = await fetchLatestEventDetailed([stale, fresh], filter, 3000);
  check('the newest revision wins, not the first to answer', r.event?.created_at === 2000);
}

for (const s of servers) {
  // close() stops the listener but leaves established sockets open, and an open
  // socket keeps the event loop alive long after the last assertion.
  for (const c of s.clients) { try { c.terminate(); } catch { /* gone */ } }
  try { s.close(); } catch { /* already down */ }
}

console.log(failures === 0 ? '\nall relay-trust checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
