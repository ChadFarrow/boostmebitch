// The Chrome DevTools Protocol harness every `e2e:*` script drives a browser
// with. One copy, because eleven hand-rolled copies had drifted in exactly the
// places that cost something:
//
// - FIXED DEBUG PORTS. Two scripts shared 9224, and a leftover Chrome still
//   holding a fixed port answers `/json/list` for the NEXT run: once, five tabs
//   of an earlier run played a live stream out of the machine's speakers while
//   each later run killed a process that owned nothing. `launchChrome` passes
//   `--remote-debugging-port=0` and reads the port Chrome actually bound from
//   `<profile>/DevToolsActivePort` (what chrome-launcher does), so no two runs
//   can meet on a port and no run can be answered by another's browser.
// - NO `--mute-audio`. `e2e-playlist` turned on autoplay without it and played
//   `public/boost.mp3` aloud. Every browser here is muted, unconditionally.
// - NO CLEANUP ON A THROW. A script that died mid-run left Chrome up and its
//   profile on disk. Every browser is closed on `exit`, SIGINT and SIGTERM, and
//   `close()` then sweeps `ps` for anything still holding the profile.
// - NO EXIT ON SUCCESS. A script holding a relay or a CDP socket open never
//   returns on its own, and only a GREEN run hangs, because the failure path
//   already exited. End every script with `exit(code)`.
//
// Deliberately dependency-free — Node 22's global `fetch` and `WebSocket` —
// for the reason scripts/playwright-global.mjs gives: a browser-automation
// package would put a browser download in every `npm install`.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** `CHROME_PATH`, else the first of the usual install paths that exists. */
export function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

/** Exit 1 with `message` unless `url` answers 2xx. */
export async function requireApp(url, message) {
  const up = await fetch(url).then((r) => r.ok).catch(() => false);
  if (!up) {
    console.error(message);
    process.exit(1);
  }
}

/** Every browser this process launched and has not closed. */
const live = new Set();
let hooksInstalled = false;

/**
 * Start a muted Chrome on a free debug port and attach to its first tab.
 *
 * `args` carries the script's own flags (window size, `--disable-gpu`, host
 * resolver rules …) and is appended as given. `autoplay` adds
 * `--autoplay-policy=no-user-gesture-required`; the tab is muted either way.
 * `--headed` and `--keep` are read from argv by default, as every script
 * already did. `--no-sandbox` only when actually running as root: an
 * unconditional one is the kind of flag that gets copied.
 *
 * Returns `{ page, openTab(url), port, profile, close() }`.
 */
export async function launchChrome({
  name,
  args = [],
  autoplay = false,
  headed = process.argv.includes('--headed'),
  keep = process.argv.includes('--keep'),
} = {}) {
  installHooks();
  const profile = mkdtempSync(join(tmpdir(), `bmb-e2e-${name}-`));
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const bin = chromePath();
  const child = spawn(bin, [
    ...(headed ? [] : ['--headless=new']),
    ...(asRoot ? ['--no-sandbox'] : []),
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    ...(autoplay ? ['--autoplay-policy=no-user-gesture-required'] : []),
    ...args,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const b = { name, child, profile, keep, port: 0, tabs: new Set(), closed: false };
  live.add(b);

  // Chrome writes to stderr for its whole life, so the pipe has to be drained
  // or it fills and Chrome blocks. The tail is kept for the error message.
  let stderrTail = '';
  child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
  let startError = null;
  child.on('error', (e) => { startError = e; });

  for (let i = 0; i < 200 && !b.port; i++) {
    if (startError) break;
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      const port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      if (port > 0) b.port = port;
    } catch { /* not written yet */ }
    if (!b.port) {
      const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(stderrTail);
      if (m) b.port = Number(m[1]);
    }
    if (!b.port) await wait(100);
  }
  if (!b.port) {
    await closeBrowser(b, { force: true });
    const why = startError?.code === 'ENOENT'
      ? `Chrome was not found at ${bin}. Set CHROME_PATH.`
      : `Chrome never opened a debug port (${bin}).${stderrTail ? `\n${stderrTail.trim()}` : ''}`;
    throw new Error(why);
  }

  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${b.port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* still coming up */ }
    if (!target) await wait(100);
  }
  if (!target) {
    await closeBrowser(b, { force: true });
    throw new Error(`Chrome on port ${b.port} never offered a page target.`);
  }

  b.page = await attach(b, target);
  b.openTab = async (url = 'about:blank') => {
    const t = await (await fetch(`http://127.0.0.1:${b.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
    return attach(b, t);
  };
  b.close = () => closeBrowser(b);
  return b;
}

/**
 * One tab: `send` resolves the raw CDP reply (`{ id, result?, error? }`) and
 * REJECTS once the socket closes, so a dead browser fails the run instead of
 * hanging it. `js` returns `undefined` when the page throws — right for a
 * poll whose expression throws until the element exists; `jsOrThrow` throws
 * the page's own error. `on(fn)` sees every CDP event and returns its remover.
 */
async function attach(b, target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('the CDP socket did not open')), { once: true });
  });
  let id = 0;
  const pending = new Map();
  const handlers = new Set();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id).resolve(m);
      pending.delete(m.id);
    } else if (m.method) {
      for (const h of handlers) h(m);
    }
  });
  ws.addEventListener('close', () => {
    for (const p of pending.values()) p.reject(new Error('the CDP socket closed'));
    pending.clear();
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) {
      reject(new Error(`the CDP socket is closed (${method})`));
      return;
    }
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = (expression) =>
    send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  const js = async (expression) => (await evaluate(expression)).result?.result?.value;
  const jsOrThrow = async (expression) => {
    const r = await evaluate(expression);
    const d = r.result?.exceptionDetails;
    if (d) throw new Error(d.exception?.description ?? d.text ?? 'eval failed');
    return r.result?.result?.value;
  };
  const until = async (expression, ms = 20000, step = 250) => {
    for (let t = 0; t < ms; t += step) {
      if (await js(expression)) return true;
      await wait(step);
    }
    return false;
  };
  const tab = {
    targetId: target.id,
    ws,
    send,
    on: (fn) => { handlers.add(fn); return () => handlers.delete(fn); },
    js,
    jsOrThrow,
    until,
    close: async () => {
      b.tabs.delete(tab);
      await fetch(`http://127.0.0.1:${b.port}/json/close/${target.id}`).catch(() => {});
      try { ws.close(); } catch { /* already closed */ }
    },
  };
  b.tabs.add(tab);
  return tab;
}

/** PIDs whose command line names this profile — Chrome and its helpers. */
function holders(profile) {
  try {
    return execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.includes(`--user-data-dir=${profile}`))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter((pid) => pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sweep(profile) {
  const left = holders(profile);
  for (const pid of left) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  if (left.length) console.error(`cdp: killed ${left.length} process(es) still holding ${profile}`);
}

function removeProfile(profile) {
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
}

async function closeBrowser(b, { force = false } = {}) {
  if (b.closed) return;
  b.closed = true;
  live.delete(b);
  if (b.keep && !force) {
    console.log(`--keep: Chrome left running on port ${b.port}, profile ${b.profile}`);
    return;
  }
  for (const t of [...b.tabs]) await t.close();
  const exited = () => b.child.exitCode !== null || b.child.signalCode !== null;
  if (!exited()) {
    const gone = new Promise((r) => b.child.once('exit', r));
    b.child.kill('SIGTERM');
    await Promise.race([gone, wait(5000)]);
    if (!exited()) b.child.kill('SIGKILL');
  }
  sweep(b.profile);
  removeProfile(b.profile);
}

/** The `exit` hook runs synchronously, so it cannot await: signal, poll with a
 *  blocking sleep, then sweep. */
function closeSync(b) {
  if (b.closed) return;
  b.closed = true;
  if (b.keep) return;
  const pid = b.child.pid;
  if (pid && alive(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    const nap = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 30 && alive(pid); i++) Atomics.wait(nap, 0, 0, 100);
  }
  sweep(b.profile);
  removeProfile(b.profile);
}

function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on('exit', () => { for (const b of [...live]) closeSync(b); });
  // Without these a Ctrl-C skips the `exit` hook entirely.
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
}

/** Close every browser this process started, then exit with `code`. */
export async function exit(code) {
  for (const b of [...live]) await closeBrowser(b);
  process.exit(code);
}

/**
 * The assertion helpers, in both shapes the scripts already used, so a
 * migrated assertion keeps its exact meaning:
 * - `equal(label, actual, expected)` — JSON equality, prints both on failure;
 * - `ok(label, cond, detail)` — a boolean, with `detail` printed on failure;
 * - `pass(label)` / `fail(label, detail)` — for a script that decides itself.
 * Every line starts `ok` or `FAIL`, which is what a before/after diff reads.
 */
export function checker() {
  let fails = 0;
  let count = 0;
  const report = (passed, label, detail) => {
    count++;
    console.log(`  ${passed ? 'ok  ' : 'FAIL'} ${label}`);
    if (!passed) {
      fails++;
      if (detail) console.log(`         ${detail}`);
    }
    return passed;
  };
  return {
    equal: (label, actual, expected) => {
      const passed = JSON.stringify(actual) === JSON.stringify(expected);
      return report(passed, label,
        `expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`);
    },
    ok: (label, cond, detail = '') => report(!!cond, label, detail),
    pass: (label) => report(true, label),
    fail: (label, detail = '') => report(false, label, detail),
    get fails() { return fails; },
    get count() { return count; },
  };
}
