// Pins src/relay-rejections.ts — which unhandled rejections the process
// survives, and that it still dies on everything else.
//
// Two halves, and neither stands in for the other:
//
//  1. The CLASSIFIER, replayed as vectors against the shipping module and
//     against naive(). Every reason is produced by the real library or the real
//     driver rather than typed out, because the question is what those
//     libraries actually reject WITH — a hand-written "connection timed out"
//     proves nothing about the next release.
//
//  2. The HANDLER, in child processes, reproducing the two production crashes
//     through nostr-tools itself: `send()` while a connect is pending that then
//     times out, and `send()` on a relay whose connection promise is gone. Each
//     is run WITHOUT the guard first and must crash, so the scenario is known
//     to be the real one; then WITH it, and must survive. A database error is
//     run with the guard and must still end the process.

import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Relay } from 'nostr-tools/relay';
import pg from 'pg';
import { isRelayLibraryRejection } from '../src/relay-rejections.ts';

let failures = 0;
let checks = 0;
const ok = (cond, what) => { checks++; if (!cond) { failures++; console.error(`FAIL ${what}`); } };

// A TCP server that accepts and never answers: a WebSocket handshake or a
// Postgres startup against it hangs until the client's own timeout fires.
const silent = net.createServer(() => {});
await new Promise((r) => silent.listen(0, '127.0.0.1', r));
const SILENT = silent.address().port;

// --- reasons, from the real libraries ----------------------------------------

const timedOut = await (() => {
  const relay = new Relay(`ws://127.0.0.1:${SILENT}`);
  relay.connectionTimeout = 200;
  return relay.connect().then(() => 'connected?', (e) => e);
})();
const refused = await new Relay('ws://127.0.0.1:1').connect().then(() => 'connected?', (e) => e);
const closedSend = await new Relay('ws://127.0.0.1:1').send('["CLOSE","forced-ping:1"]').then(() => 'sent?', (e) => e);
const pgTimeout = await (async () => {
  const pool = new pg.Pool({ connectionString: `postgres://u:p@127.0.0.1:${SILENT}/x`, connectionTimeoutMillis: 200 });
  const e = await pool.connect().then(() => 'connected?', (err) => err);
  await pool.end().catch(() => {});
  return e;
})();

ok(timedOut === 'connection timed out', `fixture: a relay connect timeout rejects with the bare string (got ${JSON.stringify(String(timedOut))})`);
ok(typeof refused === 'string', `fixture: a refused relay connect rejects with a bare string (got ${typeof refused})`);
ok(closedSend instanceof Error && closedSend.name === 'SendingOnClosedConnection', 'fixture: send() with no connection rejects with SendingOnClosedConnection');
ok(pgTimeout instanceof Error && /timeout/i.test(pgTimeout.message), `fixture: pg's connect timeout is an Error naming a timeout (got ${pgTimeout?.message})`);

const VECTORS = [
  { args: [timedOut], expect: true, why: '"connection timed out" - two of the seven production crashes' },
  { args: [refused], expect: true, why: 'a refused/errored connect, the string form of the third' },
  { args: [closedSend], expect: true, alsoNaive: true,
    why: 'SendingOnClosedConnection - four crashes; its message happens to match the naive regex' },
  { args: [pgTimeout], expect: false,
    why: "pg's timeout names a timeout too, and a database rejection that escapes is OUR bug - it must stay fatal" },
  { args: [new Error('boom')], expect: false, alsoNaive: true, why: 'an ordinary Error is fatal' },
  { args: [undefined], expect: false, alsoNaive: true, why: 'a rejection with no reason is fatal' },
];

// The tempting version: recognise the library by what its errors SAY.
const naive = (reason) => reason instanceof Error && /timed? ?out|closed connection|network error/i.test(reason.message);

for (const v of VECTORS) {
  ok(isRelayLibraryRejection(...v.args) === v.expect, `isRelayLibraryRejection: ${v.why}`);
}
let exempted = 0;
for (const v of VECTORS) {
  if (v.alsoNaive) { exempted++; continue; }
  ok(naive(...v.args) !== v.expect, `naive() agrees with "${v.why}" - the vector discriminates nothing`);
}

// --- the handler, in child processes -----------------------------------------

const GUARD = new URL('../src/relay-rejections.ts', import.meta.url).href;
const CWD = fileURLToPath(new URL('..', import.meta.url));

const SCENARIOS = {
  // What `Subscription.fire()` does while a reconnect is pending: `send()` hangs
  // `connectionPromise.then(...)` off it with no catch. The connect's own caller
  // handles ITS promise; the timeout still rejects the one nobody holds.
  pendingSendTimesOut: `
    const relay = new Relay('ws://127.0.0.1:${SILENT}');
    relay.connectionTimeout = 200;
    relay.connect().catch(() => {});
    relay.send('["REQ","x",{}]');`,
  // What the ping's \`oneose\` does on a relay whose connection promise is gone:
  // \`close()\` wraps \`send()\` in a try/catch, but \`send()\` is async.
  sendOnClosedConnection: `
    const relay = new Relay('ws://127.0.0.1:1');
    relay.send('["CLOSE","forced-ping:1"]');`,
  databaseBugEscapes: `
    Promise.reject(new Error('timeout exceeded when trying to connect'));`,
};

function run(name, guarded) {
  const code = `
    import { Relay } from 'nostr-tools/relay';
    ${guarded ? `import { guardRelayRejections } from '${GUARD}'; guardRelayRejections();` : ''}
    ${SCENARIOS[name]}
    await new Promise((r) => setTimeout(r, 700));
    console.log('ALIVE');
    process.exit(0);`;
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], {
    cwd: CWD, encoding: 'utf8', timeout: 15_000,
  });
  return { status: r.status, alive: r.stdout.includes('ALIVE'), stderr: r.stderr };
}

for (const name of ['pendingSendTimesOut', 'sendOnClosedConnection']) {
  const bare = run(name, false);
  ok(bare.status !== 0 && !bare.alive, `${name}: WITHOUT the guard the process dies, as it did in production (status ${bare.status})`);
  const guarded = run(name, true);
  ok(guarded.status === 0 && guarded.alive, `${name}: WITH the guard it survives (status ${guarded.status}) ${guarded.stderr.trim().split('\n').slice(-2).join(' | ')}`);
  ok(/not fatal/.test(guarded.stderr), `${name}: and says so in the log`);
}
const bug = run('databaseBugEscapes', true);
ok(bug.status === 1 && !bug.alive, `databaseBugEscapes: WITH the guard an escaped database error still ends the process, exit 1 (status ${bug.status})`);

silent.close();
console.log(`\n${checks} checks, ${VECTORS.length - exempted} discriminating vectors, ${exempted} exempted`);
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
console.log('ok');
process.exit(0);
