// Pins the fix in src/node-yield.ts: nostr-tools' MessageChannel yield path
// leaks a native handle per message received, and the setImmediate path does
// not.
//
// This is NOT a pure-function pin like the other verify scripts, because the
// property under test is memory retention. It is a MEASUREMENT WITH A CONTROL:
// the same shipping `Relay`, the same local relay, the same 60,000 messages,
// forced GC before sampling, one child process per mode, and exactly one thing
// different between them.
//
// The control is the whole point. A single run showing "heap went up" proves
// nothing, because draining 60,000 messages legitimately allocates. The stock
// path measured 2,375 B/message against the fallback's 15 — a ratio of ~158 —
// so asserting a factor of 10 is far from the observed value in both
// directions: it cannot pass by noise, and it will not fail on a slow machine.
//
// If this starts FAILING after a nostr-tools bump, read `yieldThread` in
// lib/esm/abstract-relay.js before changing anything here. Two outcomes are
// both fine and mean opposite things: upstream closed the ports (the gap
// disappears, and node-yield.ts can go), or upstream restructured the branch
// (the fix needs rewriting). Deleting this check is not one of the outcomes.
//
//   node --experimental-strip-types verify/check-yield.mjs
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const MESSAGES = 60_000;
// Ratio the fallback must beat the stock path by, in heap bytes per message.
const MIN_RATIO = 10;

// ---- child: one mode, one number -------------------------------------------
if (process.env.YIELD_PROBE_MODE) {
  const mode = process.env.YIELD_PROBE_MODE;
  const port = Number(process.env.YIELD_PROBE_PORT);
  if (mode === 'fallback') delete globalThis.MessageChannel;

  const { WebSocketServer } = await import('ws');
  const { finalizeEvent, generateSecretKey } = await import('nostr-tools');
  const { Relay } = await import('nostr-tools/relay');

  const ev = finalizeEvent(
    { kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [['t', 'boostagram']], content: 'x'.repeat(300) },
    generateSecretKey(),
  );
  const wss = new WebSocketServer({ port });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m[0] !== 'REQ') return;
      const frame = JSON.stringify(['EVENT', m[1], ev]);
      let sent = 0;
      const pump = () => {
        for (let i = 0; i < 500 && sent < MESSAGES; i += 1, sent += 1) ws.send(frame);
        if (sent < MESSAGES) setImmediate(pump);
        else ws.send(JSON.stringify(['EOSE', m[1]]));
      };
      pump();
    });
  });

  global.gc();
  await new Promise((r) => setTimeout(r, 200));
  const before = process.memoryUsage().heapUsed;

  const relay = new Relay(`ws://127.0.0.1:${port}`, { enablePing: false, enableReconnect: false });
  await relay.connect();
  let drained = 0;
  await new Promise((resolve) => {
    relay.subscribe([{ kinds: [1], limit: 0 }], {
      // Counting from here rather than from `onevent` is deliberate: this is
      // the DUPLICATE path, which is what production mostly receives, and it
      // still pays a yield per message.
      alreadyHaveEvent: () => { drained += 1; if (drained >= MESSAGES) resolve(); return true; },
      onevent: () => {}, oneose: () => {},
    });
  });
  await new Promise((r) => setTimeout(r, 500));
  global.gc();
  await new Promise((r) => setTimeout(r, 400));
  global.gc();

  process.send({ mode, drained, bytesPerMsg: (process.memoryUsage().heapUsed - before) / drained });
  relay.close(); wss.close();
  process.exit(0);
}

// ---- parent: run both modes and compare ------------------------------------
function measure(mode, port) {
  return new Promise((resolve, reject) => {
    const child = fork(SELF, [], {
      execArgv: ['--expose-gc', '--experimental-strip-types', '--no-warnings'],
      env: { ...process.env, YIELD_PROBE_MODE: mode, YIELD_PROBE_PORT: String(port) },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    let got = null;
    child.on('message', (m) => { got = m; });
    child.on('exit', (code) => (got ? resolve(got) : reject(new Error(`${mode} probe exited ${code} with no result`))));
  });
}

let failures = 0;
let checks = 0;
function ok(cond, what) {
  checks += 1;
  if (!cond) { failures += 1; console.error(`FAIL ${what}`); }
}

const stock = await measure('stock', 55581);
const fallback = await measure('fallback', 55582);
const ratio = stock.bytesPerMsg / fallback.bytesPerMsg;

console.log(`  stock         ${stock.bytesPerMsg.toFixed(0).padStart(6)} B/msg heap over ${stock.drained} messages`);
console.log(`  setImmediate  ${fallback.bytesPerMsg.toFixed(0).padStart(6)} B/msg heap over ${fallback.drained} messages`);
console.log(`  ratio         ${ratio.toFixed(1)}x`);

ok(stock.drained === MESSAGES, `stock drained every message (got ${stock.drained})`);
ok(fallback.drained === MESSAGES, `fallback drained every message (got ${fallback.drained})`);
// The must-still-work half: the fallback has to actually yield, or this
// "fix" is a starved event loop rather than a saved allocation.
ok(fallback.bytesPerMsg < 500, `setImmediate path retains almost nothing per message (got ${fallback.bytesPerMsg.toFixed(0)} B)`);
ok(stock.bytesPerMsg > 500, `the MessageChannel path still leaks, so this check still discriminates (got ${stock.bytesPerMsg.toFixed(0)} B)`);
ok(ratio > MIN_RATIO, `setImmediate retains at least ${MIN_RATIO}x less per message (got ${ratio.toFixed(1)}x)`);

console.log(`\n${checks} checks`);
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
console.log('ok');
