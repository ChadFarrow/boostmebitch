// Measures whether nostr-tools' per-message `MessageChannel` yield leaks in a
// real browser, and how much. Issue #313.
//
// Usage:
//   npm run dev                                   # in another terminal
//   CHROME_PATH=/usr/bin/google-chrome npm run e2e:yield
//   ... npm run e2e:yield -- --headed             # watch it
//   ... npm run e2e:yield -- --live               # the session-rate half
//
// WHAT IS BEING MEASURED
// ----------------------
// `AbstractRelay` pumps every incoming relay message through `handleNext()` and
// then `await yieldThread()`. In the pinned 2.19.4 that yield is a fresh
// `MessageChannel` per message, with `port1.start()` called and neither port
// closed (`node_modules/nostr-tools/lib/esm/index.js:593-613`, awaited from
// `runQueue` at `:820`, driven from `_onmessage` at `:1006`).
//
// The Node half of this is already fixed and pinned — #312,
// `services/nostr-index/src/node-yield.ts`, measured at 2,375 B/message by
// `services/nostr-index/verify/check-yield.mjs`. This is the browser half, and
// it is a DIFFERENT QUESTION with a different answer per engine:
//
//   Chrome  Blink's `MessagePort::HasPendingActivity()` is
//           `started_ && IsEntangled()`, beside the comment "entangled message
//           ports should always be treated as if they have a strong reference".
//           nostr-tools starts port1 and closes nothing, so both conditions
//           hold forever. The `removeEventListener` inside the handler does not
//           help: Blink never consults listeners. Retention is structural.
//
//   Safari  WebKit's `virtualHasPendingActivity()` returns false once the port
//           has no message listener, and nostr-tools' handler removes its own.
//           The pair becomes collectable. iOS does not pay this.
//
// So the remaining question is not WHETHER Chrome retains them — it is HOW MUCH
// that costs at this app's message volume, which is what decides whether a fix
// is worth applying to a frozen dependency. That is the number this produces.
//
// WHY THIS IS AN `e2e:*` AND NOT A `check:*`
// ------------------------------------------
// Every `check:*` loads a shipping module under `node --experimental-strip-types`
// and pins a pure function; `scripts/import-free.mjs` enforces the arrangement
// that makes that possible. This drives a real browser, so it cannot be one —
// same reasoning `scripts/e2e-resolve-hook.mjs` records for itself.
//
// It is a MEASUREMENT WITH A CONTROL, not a pin, and it inherits that doctrine
// wholesale from `check-yield.mjs`: a single run showing "the heap went up"
// proves nothing, because draining tens of thousands of messages legitimately
// allocates. Everything is held identical between the two arms — same app, same
// pump, same drive window, same forced GC — and exactly one thing differs.
//
// THE CONTROL IS A CLOSING SHIM, NOT A DELETED GLOBAL
// ---------------------------------------------------
// `check-yield.mjs` controls by `delete globalThis.MessageChannel`, which in
// Node selects the `setImmediate` branch the library already ships. That is not
// available here, for two reasons that are NOT the one this repo used to give
// (it said the yield becomes a no-op; 2.19.4's ladder has three rungs, so a page
// lands on `setTimeout(resolve, 0)` instead):
//
//   The clamp. `setTimeout(0)` is held to 4 ms past nesting depth 5, capping the
//   drain at roughly 250 messages/second — worse under the exact burst the yield
//   exists for.
//
//   The neighbour. React's scheduler reads `globalThis.MessageChannel` at module
//   load (`scheduler/cjs/scheduler.production.js`), so deleting it degrades
//   React's own scheduling and the measurement stops being about nostr-tools.
//
// So the control keeps a real `MessageChannel` and a real task per message, and
// changes ONE thing: it closes both ports after delivery. Closing disentangles
// the pair, `IsEntangled()` goes false, and Blink can collect. That isolates the
// close, which is the variable under test. It is deliberately NOT the shape a
// real fix would take — a fix would pool one channel for the module's life, the
// way React's scheduler does — because a control's job is to isolate a variable,
// not to prototype a fix.
//
// THE SHIM COUNTS `start()`, NOT CONSTRUCTIONS, AND THAT IS LOAD-BEARING
// ---------------------------------------------------------------------
// React's scheduler builds ONE `MessageChannel` at module load and drives it
// with `port1.onmessage` — it never calls `start()`. nostr-tools always does.
// Counting constructions would fold React's channel into the numbers, and, far
// worse, the control arm would close React's scheduler channel after its first
// task and break the page. Arming on `start()` excludes it from both arms, and
// makes `created` mean exactly "yields taken" rather than "channels built".
//
// THE PUMP IS PURPOSE-BUILT, AND `local-relay.mjs` WOULD BE WRONG HERE
// -------------------------------------------------------------------
// CLAUDE.md says an e2e must import `createRelay` from `local-relay.mjs` rather
// than carry its own — because those tests put replaceable-event SEMANTICS under
// test, and a second copy drifts from the tool a human runs by hand. Nothing
// about relay semantics is under test here; the DRAIN RATE is. `createRelay`
// stores every event in a Map and never echoes to the publishing socket, so at
// this volume it would measure the harness. This pump is `check-yield.mjs`'s:
// one pre-serialized frame, batched behind `setImmediate`, nothing stored.
//
// Repeating one event id is also deliberate. `SimplePool`'s `_knownIds`
// short-circuits every copy after the first, so `handleNext` returns before
// `JSON.parse` and before `verifyEvent` (`lib/esm/index.js:842`, `:1209-1216`)
// — and still pays a yield. That is the duplicate path, which is what a real
// session mostly receives, and it is the same choice `check-yield.mjs:72-75`
// makes for the same reason.
//
// IT MUST DRIVE THE REAL BUNDLE, AND `bmb:relays` CANNOT GET IT THERE
// -------------------------------------------------------------------
// The obvious way to point the app at a local relay is `bmb:relays`, which
// CLAUDE.md's local-testing table describes as replacing the default set. IT
// DOES NOT REPLACE THE READ SET. `storage.relays` has exactly one reader,
// `resolvePublishRelays` (`lib/nostr/relays.ts:161`), so it governs publishes
// and the reads that go with them — favorites, mutes, backups — and nothing
// else. The global feed, the live-stream strip and the profile ladder use
// `DEFAULT_RELAYS` / `LIVE_STREAM_RELAYS` / `PROFILE_RELAYS` directly.
//
// This was measured, not reasoned: the first version of this script set
// `bmb:relays`, and the pump received ZERO REQ frames while the page happily
// drained about 35 messages/second from damus, primal, nos.lol and fountain.
// A run that looks hermetic and is not would have reported whatever the public
// network happened to be doing that afternoon, in both arms, as our number.
//
// So the redirection happens one layer down, at name resolution:
// `--host-resolver-rules` maps every relay host the app knows to the local
// pump, and the pump speaks TLS because the app asks for `wss://`. Nothing
// leaves the machine, the app's own relay lists are used unmodified, and the
// traffic reaches the bundled `AbstractRelay` through `newPool()` →
// `SimplePool.ensureRelay`. That last part matters for the same reason
// `scripts/check-relay-socket.mjs` records: `lib/esm/index.js` carries its OWN
// copy of `AbstractRelay`, separate from the `nostr-tools/abstract-relay`
// subpath, so anything measured against a subpath import would run, report a
// number, and prove nothing.
//
// READING THE OUTPUT
// ------------------
// `retainedPorts / ports` is the PRIMARY signal — the fraction of MessagePorts
// Chrome would not collect after a forced GC. It is reported per YIELD too, as
// a pair count, because a yield builds two ports and one channel. `usedSize`
// from `Runtime.getHeapUsage` is secondary and WILL UNDERSTATE: a Blink
// `MessagePort` is an Oilpan object holding a Mojo pipe, only partly on the V8
// heap. Do not quote the byte figure as the whole cost.
//
// If the stock arm ever retains nothing, Chrome changed. Read
// `third_party/blink/renderer/core/messaging/message_port.cc` again before
// believing it, and do not delete this script — a passing control arm with a
// clean stock arm is upstream news, not a reason to stop measuring.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { WebSocketServer } from 'ws';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';

const APP = process.env.APP_URL ?? 'http://localhost:3000';
const HEADED = process.argv.includes('--headed');
const KEEP = process.argv.includes('--keep');
const LIVE = process.argv.includes('--live');

// The same N as the Node measurement (`check-yield.mjs:29`), so the two halves
// of #313 are quoted against the same denominator. It is the PUMP that is
// capped at this, not the poll loop — see `startPump`.
const TARGET_YIELDS = 60_000;
// Wall-clock ceiling on the drive. A run that hits this reports what it drained
// rather than failing, because the ratio is what matters, not the count.
const DRIVE_MS = 90_000;
// The `--live` half runs against the real default relays for this long. Five
// minutes rather than one, because a single minute measures the COLD LOAD — the
// feed scan, the reply-tree rounds and the profile ladder all fire at once — and
// extrapolating that burst to an hour would overstate the cost several times
// over. The report separates the first minute from the trailing one.
const LIVE_MS = 300_000;
// The control must retain this many times less per yield than stock. Far below
// what a working control produces and far above noise, for the reason
// `check-yield.mjs` states: it must not pass by accident or fail on a slow box.
const MIN_RATIO = 10;

const appUp = await fetch(APP).then((r) => r.ok).catch(() => false);
if (!appUp) {
  console.error(`Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);
  console.error('(and `rm -rf .next` first if you have just run a production build)');
  process.exit(1);
}

// macOS default, because that is where this is usually run. `CHROME_PATH`
// overrides it, which is what lets this run on Linux and in CI at all.
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Every relay host the app can dial, from `lib/nostr/relays.ts` (DEFAULT_RELAYS,
// PROFILE_RELAYS) and `lib/nostr/live-streams.ts` (LIVE_STREAM_RELAYS). Keep in
// sync with those: a host missing here is a host this run is NOT hermetic
// against, and the symptom is a number quietly sourced from the public network.
// The NIP-46 pair from `bunker.ts` is deliberately absent — nothing signs in.
const RELAY_HOSTS = [
  'relay.damus.io',
  'relay.primal.net',
  'nos.lol',
  'relay.fountain.fm',
  'purplepag.es',
  'relay.zap.stream',
  'nostr.wine',
];

// Renderer RSS, which is the number that actually answers "how much".
// `Runtime.getHeapUsage` sees the V8 heap only, and a Blink `MessagePort` is an
// Oilpan object holding a Mojo message pipe — mostly NOT on that heap. The two
// numbers disagree by roughly an order of magnitude and the V8 one is the
// optimistic half, so quoting it alone would understate the leak.
//
// Linux-only and best-effort: the renderer is found by its `--user-data-dir`,
// which is unique per arm, so this cannot pick up another Chrome on the box.
// Returns null anywhere it cannot look, and the report drops the column.
function rendererRssKb(profileDir) {
  try {
    let total = 0;
    let found = false;
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      let cmd;
      try { cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8'); } catch { continue; }
      if (!cmd.includes(profileDir) || !cmd.includes('--type=renderer')) continue;
      const status = readFileSync(`/proc/${entry}/status`, 'utf8');
      const m = /VmRSS:\s+(\d+) kB/.exec(status);
      if (m) { total += Number(m[1]); found = true; }
    }
    return found ? total : null;
  } catch {
    return null;
  }
}

// A throwaway self-signed cert, cached between runs. Chrome is launched with
// `--ignore-certificate-errors`, so nothing about this cert has to be valid —
// it exists only because the app asks for `wss://` and TLS needs bytes.
function selfSignedCert() {
  const key = `${tmpdir()}/bmb-e2e-yield-key.pem`;
  const cert = `${tmpdir()}/bmb-e2e-yield-cert.pem`;
  if (!existsSync(key) || !existsSync(cert)) {
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', key, '-out', cert, '-days', '30', '-subj', '/CN=localhost',
      ], { stdio: 'ignore' });
    } catch {
      console.error('This needs `openssl` on PATH to mint a throwaway TLS cert.');
      console.error('The app dials wss://, so the local pump has to speak TLS.');
      process.exit(1);
    }
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

// ---- the pump --------------------------------------------------------------
// One canned frame, batched behind `setImmediate`, nothing stored. It answers
// every REQ, because a homepage opens several subscriptions (warm, feed, reply
// rounds, profiles) and any of them is a fine source of drain.
//
// THE CAP IS ON THE PUMP, NOT ON THE POLL LOOP, and that is the second thing
// this script got wrong. Stopping when the page reports enough yields does not
// bound anything: the poller sees the count 250 ms late, and everything already
// in flight keeps draining after it stops. A 20,000-yield target overshot to
// 440,500. Capping the SENDER bounds it by construction and, more usefully,
// hands both arms exactly the same number of frames — so the denominator is
// equal by design rather than by luck.
function startPump(port, cap) {
  const ev = finalizeEvent(
    {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', 'boostagram']],
      content: 'x'.repeat(300),
    },
    generateSecretKey(),
  );
  let sentTotal = 0;
  let reqs = 0;
  let stopped = false;
  let pumping = false;
  const server = createServer(selfSignedCert());
  server.listen(port, '127.0.0.1');
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m[0] === 'EVENT') { ws.send(JSON.stringify(['OK', m[1]?.id ?? '', true, ''])); return; }
      if (m[0] !== 'REQ') return;
      reqs += 1;
      if (pumping) return;
      // CLOSE is deliberately ignored, and that is the whole reason this drives
      // at all. The app closes its subscriptions on a quiet timer, so a pump
      // that honoured CLOSE stopped after one short burst — measured at 37
      // messages/second, which is a measurement of the app's subscription
      // lifecycle rather than of the yield.
      //
      // A message for a subscription the client has closed STILL PAYS A YIELD:
      // `handleNext` returns `undefined` at the `if (!so) return;` branch
      // (`lib/esm/index.js:836-839`), not `false`, so `runQueue` does not break
      // and awaits `yieldThread()` anyway (`:820-828`). That is the cheapest
      // message that still exercises the path under test, and both arms get
      // exactly the same mix of it.
      pumping = true;
      const sub = m[1];
      const frame = JSON.stringify(['EVENT', sub, ev]);
      const pump = () => {
        if (stopped || sentTotal >= cap || ws.readyState !== ws.OPEN) return;
        // Backpressure. Without it `ws.send` buffers in THIS process faster
        // than the browser drains, and the harness runs out of heap before the
        // page does — which would be a measurement of the wrong runtime.
        if (ws.bufferedAmount > 1 << 20) { setTimeout(pump, 5); return; }
        for (let i = 0; i < 500 && sentTotal < cap; i += 1) { ws.send(frame); sentTotal += 1; }
        setImmediate(pump);
      };
      pump();
    });
    ws.on('close', () => { pumping = false; });
  });
  return {
    get sent() { return sentTotal; },
    get reqs() { return reqs; },
    stop() { stopped = true; },
    close() { stopped = true; wss.close(); server.close(); },
  };
}

// ---- the page-side probe ---------------------------------------------------
// Installed with `Page.addScriptToEvaluateOnNewDocument`, so it is in place
// before any app script — the repo's standard "fake the SOURCE, keep everything
// downstream shipping code" technique.
//
// The registry holds its targets weakly, so the probe cannot itself be the leak
// it is looking for. `closing` is the ONLY difference between the two arms.
const probeSource = (closing) => `
(() => {
  const Real = window.MessageChannel;
  const CLOSING = ${closing ? 'true' : 'false'};
  // created counts yields (one channel each); ports/finalized count individual
  // MessagePorts, two per yield. Mixing the two units is how the first run of
  // this script reported a retention of -100%. No backticks in here: this whole
  // block is a template literal.
  let created = 0, ports = 0, finalized = 0, frames = 0;
  const reg = new FinalizationRegistry(() => { finalized += 1; });
  class Instrumented {
    constructor() {
      const ch = new Real();
      const p1 = ch.port1, p2 = ch.port2;
      let armed = false;
      const realStart = p1.start.bind(p1);
      // Arming on start() rather than on construction is what keeps React's
      // scheduler channel — driven by onmessage, never started — out of both
      // the counts and, in the control arm, out of being closed underneath it.
      p1.start = () => {
        if (!armed) {
          armed = true;
          created += 1;
          ports += 2;
          reg.register(p1, 0);
          reg.register(p2, 0);
          if (CLOSING) {
            // Deferred to a microtask so nostr-tools' own handler resolves
            // first: our listener was attached before theirs and so runs first.
            p1.addEventListener('message', () => {
              queueMicrotask(() => { try { p1.close(); p2.close(); } catch {} });
            });
          }
        }
        realStart();
      };
      this.port1 = p1;
      this.port2 = p2;
    }
  }
  window.MessageChannel = Instrumented;
  const tick = () => { frames += 1; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.__yieldProbe = () => ({ created, ports, finalized, frames, retainedPorts: ports - finalized });
})();
`;

// ---- one arm ---------------------------------------------------------------
async function measure({ mode, cdpPort, pumpPort, hermetic }) {
  const profile = `${tmpdir()}/bmb-e2e-yield-${mode}`;
  rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    ...(HEADED ? [] : ['--headless=new']),
    ...(asRoot ? ['--no-sandbox'] : []),
    // The page calls this directly; `HeapProfiler.collectGarbage` alone does not
    // reliably run FinalizationRegistry callbacks.
    '--js-flags=--expose-gc',
    // Redirect every relay the app knows to the local pump. This is what makes
    // the run hermetic AND controllable; see the header on why `bmb:relays`
    // cannot do it. `--ignore-certificate-errors` is what lets the throwaway
    // cert answer for those hostnames.
    ...(hermetic ? [
      `--host-resolver-rules=${RELAY_HOSTS.map((h) => `MAP ${h} 127.0.0.1:${pumpPort}`).join(',')}`,
      '--ignore-certificate-errors',
    ] : []),
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' });
  const stopChrome = () => { if (!KEEP) chrome.kill(); };
  process.on('exit', stopChrome);

  // Wait for the debug port rather than sleeping a guessed amount.
  let ready = false;
  for (let i = 0; i < 80 && !ready; i += 1) {
    ready = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then((r) => r.ok).catch(() => false);
    if (!ready) await wait(250);
  }
  if (!ready) { console.error(`Chrome never opened its debug port on ${cdpPort}.`); process.exit(1); }

  const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const handlers = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) handlers.forEach((h) => h(m));
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params }));
  });
  const js = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed');
    }
    return r.result?.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('HeapProfiler.enable');
  const exceptions = [];
  handlers.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 200));
    }
  });

  await send('Page.addScriptToEvaluateOnNewDocument', { source: probeSource(mode === 'closing') });

  const pump = hermetic ? startPump(pumpPort, TARGET_YIELDS) : null;

  await send('Page.navigate', { url: APP });
  await wait(2500);

  const gc = async () => {
    await js('window.gc && window.gc()');
    await send('HeapProfiler.collectGarbage');
  };
  await gc();
  await wait(300);
  const heapBefore = (await send('Runtime.getHeapUsage')).result?.usedSize ?? 0;
  const rssBefore = rendererRssKb(profile);
  const framesBefore = (await js('window.__yieldProbe().frames')) ?? 0;

  const deadline = Date.now() + (hermetic ? DRIVE_MS : LIVE_MS);
  const startedAt = Date.now();
  let probe = { created: 0, ports: 0, finalized: 0, frames: 0, retainedPorts: 0 };
  const timeline = [];
  while (Date.now() < deadline) {
    probe = await js('window.__yieldProbe()');
    timeline.push({ t: Date.now() - startedAt, created: probe.created });
    if (hermetic && probe.created >= TARGET_YIELDS) break;
    // A slower poll on the live half: five minutes of 250 ms CDP round trips is
    // enough work to perturb the thing being counted.
    await wait(hermetic ? 250 : 1000);
  }
  const driveMs = Date.now() - startedAt;
  const drivenYields = probe.created;
  pump?.stop();

  // Wait for the BACKLOG, not a guessed interval. Stopping the pump does not
  // stop the page: the frames already in Chrome's receive buffer keep draining
  // and keep taking yields. Sampling straight after the drive counted those,
  // and the first hermetic run overshot a 20,000-yield target to 81,938 —
  // a denominator four times the one the drive actually produced, and a tail of
  // very fresh ports that no amount of GC could have collected yet.
  let last = -1;
  for (let i = 0; i < 40; i += 1) {
    const now = (await js('window.__yieldProbe().created')) ?? 0;
    if (now === last) break;
    last = now;
    await wait(500);
  }

  // Then collect repeatedly with a wait between. One collection does not finish
  // weak-callback reclamation, and a FinalizationRegistry's callbacks need task
  // turns of their own — V8 runs them in batches. Same shape as
  // check-yield.mjs:79-82, with more rounds because there are far more objects.
  for (let i = 0; i < 4; i += 1) { await gc(); await wait(900); }

  const after = await js('window.__yieldProbe()');
  const heapAfter = (await send('Runtime.getHeapUsage')).result?.usedSize ?? 0;
  const rssAfter = rendererRssKb(profile);

  const pumpSent = pump?.sent ?? 0;
  const pumpReqs = pump?.reqs ?? 0;
  ws.close();
  pump?.close();
  stopChrome();
  await wait(300);

  return {
    mode,
    created: after.created,
    drivenYields,
    ports: after.ports,
    retainedPorts: after.ports - after.finalized,
    retainedPairs: (after.ports - after.finalized) / 2,
    frames: after.frames - framesBefore,
    driveMs,
    msgPerSec: drivenYields / (driveMs / 1000),
    pumpSent,
    pumpReqs,
    timeline,
    heapDelta: heapAfter - heapBefore,
    rssDelta: rssBefore != null && rssAfter != null ? (rssAfter - rssBefore) * 1024 : null,
    bytesPerYieldRss: rssBefore != null && rssAfter != null && after.created
      ? ((rssAfter - rssBefore) * 1024) / after.created
      : null,
    bytesPerYield: after.created ? (heapAfter - heapBefore) / after.created : 0,
    exceptions,
  };
}

// ---- report ----------------------------------------------------------------
let failures = 0;
let checks = 0;
function ok(cond, what) {
  checks += 1;
  console.log(`  ${cond ? 'ok   ' : 'FAIL '} ${what}`);
  if (!cond) failures += 1;
}
const row = (r) => `  ${r.mode.padEnd(8)} yields=${String(r.created).padStart(6)}`
  + `  retained=${String(r.retainedPorts).padStart(6)} ports`
  + `  ${(r.retainedPorts / Math.max(r.ports, 1) * 100).toFixed(1).padStart(5)}% kept`
  + `  ${r.msgPerSec.toFixed(0).padStart(6)} msg/s`
  + `  heap ${(r.heapDelta / 1048576).toFixed(1).padStart(6)} MB`
  + (r.rssDelta == null ? '' : `  rss ${(r.rssDelta / 1048576).toFixed(1).padStart(6)} MB`
      + `  (${r.bytesPerYieldRss.toFixed(0).padStart(5)} B/yield)`)
  + `  frames=${r.frames}`
  + `  sent=${r.pumpSent}`;

if (LIVE) {
  // The session-rate half: what a real homepage actually drains, against the
  // real default relays. SIGNED OUT, and it publishes nothing — the "testing
  // locally is not testing against local data" hazard is about writes, and
  // there are none here. Multiply this rate by the retention below to decide
  // whether a fix is worth applying to a frozen dependency.
  console.log(`\nlive session rate — ${APP}, signed out, ${LIVE_MS / 1000}s, real relays\n`);
  const live = await measure({ mode: 'live', cdpPort: 9245, pumpPort: 0, hermetic: false });
  console.log(row(live));
  // Cold load versus steady state. These answer different questions and the
  // gap between them is large: the first is what one page load costs, the
  // second is what LEAVING THE TAB OPEN costs, and only the second multiplies
  // by session length.
  const at = (ms) => {
    let best = 0;
    for (const p of live.timeline) { if (p.t <= ms) best = p.created; }
    return best;
  };
  const firstMin = at(60_000);
  const lastMin = live.drivenYields - at(live.driveMs - 60_000);
  console.log(`\n  cold load    ${firstMin} yields in the first minute`);
  console.log(`  steady state ${lastMin} yields in the last minute`);
  console.log(`  session      ${live.drivenYields} yields over ${(live.driveMs / 60000).toFixed(1)} minutes`);
  console.log(`\n  Multiply the steady-state rate by the per-message cost a normal run reports.`);
  // The memory columns above are NOISE on this half and must not be quoted.
  // Five mostly-idle minutes followed by four forced collections routinely
  // leave RSS BELOW where it started, which says nothing about retention. Only
  // the yield counts and the retained fraction mean anything here.
  console.log('  The memory columns are not meaningful on this half — only the counts are.');
  console.log('  This is a SIGNED-OUT HOMEPAGE. Live chat holds a subscription open and');
  console.log('  polls every 12s (lib/nostr/live-chat.ts), and is not covered by this run.');
  process.exit(0);
}

console.log(`\nnostr-tools yield retention in Chrome — ${APP}, local pump, target ${TARGET_YIELDS} yields\n`);
const stock = await measure({ mode: 'stock', cdpPort: 9243, pumpPort: 7461, hermetic: true });
const closing = await measure({ mode: 'closing', cdpPort: 9244, pumpPort: 7462, hermetic: true });
console.log(row(stock));
console.log(row(closing));

const stockFrac = stock.retainedPorts / Math.max(stock.ports, 1);
const closingFrac = closing.retainedPorts / Math.max(closing.ports, 1);
const ratio = closingFrac > 0 ? stockFrac / closingFrac : Infinity;
console.log(`\n  ratio        ${Number.isFinite(ratio) ? `${ratio.toFixed(1)}x` : 'infinite (control retained none)'}`);

// THE COST IS THE DIFFERENCE BETWEEN THE ARMS, NEVER ONE ARM'S RSS.
// Neither allocator returns pages eagerly, so each arm's RSS is a high-water
// mark that includes the message churn both arms pay for equally. Subtracting
// leaves what the retention itself costs, which is the whole reason there is a
// control. Quoting the stock arm's RSS alone would overstate it by about 2x.
if (stock.rssDelta != null && closing.rssDelta != null) {
  const perYield = (stock.rssDelta - closing.rssDelta) / Math.max(stock.created, 1);
  console.log(`  cost         ${perYield.toFixed(0)} B of renderer memory retained per relay message`);
  console.log(`               (stock ${(stock.rssDelta / 1048576).toFixed(0)} MB - control `
    + `${(closing.rssDelta / 1048576).toFixed(0)} MB over ${stock.created} yields)`);
  console.log(`               run \`--live\` for yields/minute; multiply for the hourly cost.`);
}
console.log('');

ok(stock.created > 1000, `stock took enough yields to measure (got ${stock.created})`);
ok(closing.created > 1000, `control took enough yields to measure (got ${closing.created})`);
// The discriminator. If this fails, Chrome or the library changed — read
// message_port.cc and lib/esm/index.js:593 before touching anything here.
ok(stockFrac > 0.5, `stock keeps most of the ports it builds (got ${(stockFrac * 100).toFixed(1)}%)`);
// The thing being proved.
ok(closingFrac < 0.1, `closing the ports lets Chrome collect them (got ${(closingFrac * 100).toFixed(1)}%)`);
ok(stock.retainedPairs > 0, `stock retained ${stock.retainedPairs} port pairs — the leak is real in this build`);
ok(ratio > MIN_RATIO, `the control retains at least ${MIN_RATIO}x less per yield (got ${ratio.toFixed(1)}x)`);
// THE MUST-STILL-WORK HALF, and getting it right took two attempts. The first
// version asserted the control drains at a rate comparable to stock. That is
// the wrong property: closing two ports per message is real work, and the
// control measured about 5x slower — while PAINTING MORE FRAMES than stock.
// Throughput is a COST here, not a starve, and a test that cannot tell those
// apart would have rejected a working control and accepted a yield that had
// been quietly removed.
//
// What actually has to hold is that the page keeps yielding to the event loop,
// and frames are the only thing that sees that directly. Headless does not
// always drive the compositor, so an absent frame signal is reported rather
// than asserted against — a flaky must-still-work half is worse than none.
if (stock.frames > 0) {
  ok(closing.frames >= stock.frames * 0.5,
    `the page keeps painting under the control (${closing.frames} vs ${stock.frames} frames)`);
} else {
  console.log('  note  the frame probe gave no signal here; the throughput floor below covers it');
}
// A throughput FLOOR rather than a ratio, and the number comes from the other
// half of this script: `--live` measures what a real homepage actually drains
// from the public relays. The floor is far above that, so it fails only on a
// control that has stopped yielding, never on one that is merely paying for the
// close. Re-measure with `--live` before moving it.
ok(closing.msgPerSec > 500,
  `the control drains far faster than any real relay feeds it (${closing.msgPerSec.toFixed(0)} msg/s, floor 500)`);
console.log(`\n  the close costs throughput: ${(stock.msgPerSec / Math.max(closing.msgPerSec, 1)).toFixed(1)}x slower than stock.`);
console.log('  That is an argument for a POOLED channel over a per-message close, not against a fix.');
for (const r of [stock, closing]) {
  ok(r.exceptions.length === 0, `${r.mode} raised no page exceptions${r.exceptions.length ? `: ${r.exceptions[0]}` : ''}`);
}

console.log(`\n${checks} checks`);
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
console.log('ok');
