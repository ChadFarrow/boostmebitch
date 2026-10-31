// Watches — or, on an emulator, reproduces — a listen-queue advance on an
// Android device with the screen LOCKED, over adb and the browser's DevTools
// socket.
//
// Usage:
//   npm run android:advance                      # watch: any device, changes nothing
//   npm run android:advance -- watch --seconds 900
//   npm run android:advance -- repro [--twa] [--doze deep|light] [--seek-left 12]
//                                    [--watch 60] [--next-at 4] [--origin URL]
//
// Not an `e2e:*` script, on purpose: those launch a desktop Chrome through
// `scripts/cdp.mjs` (docs/testing.md). This one launches nothing — it attaches
// to the browser already running on the device, through `adb forward`.
//
// WHY THIS EXISTS. "The next item in the queue doesn't play with the screen
// locked" was reported from the Zapstore app (the buddy TWA, in Brave, on a
// Pixel 6) on 2026-10-30. Nine runs of `repro` on the Android 16 emulator did
// NOT reproduce it: a Chrome tab, the Chrome TWA and the Brave 1.98 TWA;
// streamed and downloaded episodes; the screen locked 12 s and 7 minutes
// before the end; forced deep Doze; a lock-screen ⏭; delete-after-play. Every
// run advanced within 0.4 s, and the browser's media service stayed a
// FOREGROUND service throughout. So the cause is something only the real phone
// has, and `watch` is the instrument for it: the listener does the steps, this
// prints what the page and the OS did.
//
// **`repro` CLEARS THE ORIGIN'S localStorage**, which on a real phone is the
// listener's queue, settings, signer state and wallet connection. It therefore
// refuses any device whose serial does not start with `emulator-`. `watch`
// writes one key (`__advlog`, its own event log) and removes nothing.
//
// Traps, each of which cost a run:
// - `adb` is at ~/Library/Android/sdk/platform-tools/adb, not on PATH (or set ADB).
// - Unlocking can leave the LAUNCHER in front, and the DevTools socket then
//   lists nothing: `repro` relaunches the browser (or the TWA with --twa).
// - Chrome on a fresh emulator stops at its first-run screen, Brave at its
//   onboarding; tap through them once by hand (or uiautomator) first.
// - A TWA uses the DEFAULT browser. To test Brave as the provider on an image
//   that ships Chrome: install Brave, `cmd role add-role-holder
//   android.app.role.BROWSER com.brave.browser`, and `pm disable-user --user 0
//   com.android.chrome` (re-enable it afterwards).
// - Doze never starts on a charging emulator: `--doze` unplugs the virtual
//   battery and forces idle, and restores both at the end.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const MODE = args[0] && !args[0].startsWith('--') ? args[0] : 'watch';
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const ORIGIN = flag('origin', 'https://www.boostmebuddy.com');
const PC20 = '917393e3-1b1e-5cef-ace4-edaa54e1f810';
const TWA_PACKAGE = flag('twa-package', 'com.boostmebuddy');
const LOCAL_ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const ADB = process.env.ADB ?? (existsSync(LOCAL_ADB) ? LOCAL_ADB : 'adb');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...a) => execFileSync(ADB, a, { encoding: 'utf8' });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);

const serial = adb('get-serialno').trim();
if (MODE === 'repro' && !serial.startsWith('emulator-')) {
  console.error(`Refusing: "repro" clears localStorage on ${ORIGIN}, and ${serial} is not an emulator.\nUse "watch" on a real phone.`);
  process.exit(2);
}
// Port 0, read back: a fixed port answers for whatever a previous run left
// forwarded (docs/testing.md, "Port 0, never a fixed port").
const PORT = Number(adb('forward', 'tcp:0', 'localabstract:chrome_devtools_remote').trim());
process.on('exit', () => { try { adb('forward', '--remove', `tcp:${PORT}`); } catch { /* gone */ } });
const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const BROWSER = version['Android-Package'] ?? 'com.android.chrome';
log(`device ${serial}, browser ${BROWSER} (${version.Browser}), mode ${MODE}`);

async function connect() {
  const host = new URL(ORIGIN).host;
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = list.find((x) => x.type === 'page' && new URL(x.url).host === host);
  if (!target) throw new Error(`No ${host} page is open in ${BROWSER}. Open the app first.`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  const send = (method, params = {}, ms = 15000) => new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ timeout: true }); } }, ms);
  });
  // A frozen renderer answers nothing; say so rather than hang.
  const js = async (expression, opts = {}) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...opts }, opts.ms ?? 15000);
    if (r.timeout) return '__TIMEOUT__';
    if (r.result?.exceptionDetails) return `__EXC__ ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`;
    return r.result?.result?.value;
  };
  return { send, js };
}

// Independent of the app's own log, so it works against any deployed build.
// Writes to localStorage so a renderer the OS froze still leaves its lines.
const INSTRUMENT = `(() => {
  if (window.__instr) return 'already';
  window.__instr = true;
  const push = (o) => {
    const L = JSON.parse(localStorage.getItem('__advlog') || '[]');
    L.push({ t: Math.round(performance.now()), vis: document.visibilityState, ...o });
    localStorage.setItem('__advlog', JSON.stringify(L.slice(-300)));
  };
  for (const ev of ['loadstart','loadedmetadata','canplay','play','playing','pause','ended','waiting','stalled','emptied','abort','error']) {
    document.addEventListener(ev, (e) => {
      if (!(e.target instanceof HTMLMediaElement)) return;
      const a = e.target;
      push({ ev, tag: a.tagName, src: (a.currentSrc || a.src || '').slice(-48), ct: Math.round(a.currentTime), rs: a.readyState, paused: a.paused, err: a.error && a.error.code });
    }, true);
  }
  const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  Object.defineProperty(HTMLMediaElement.prototype, 'src', { configurable: true, get: d.get, set(v) { push({ ev: 'SET_SRC', tag: this.tagName, src: String(v).slice(-48) }); d.set.call(this, v); } });
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    const tag = this.tagName; push({ ev: 'PLAY_CALL', tag });
    const p = play.call(this);
    p.then(() => push({ ev: 'PLAY_RESOLVED', tag }), (e) => push({ ev: 'PLAY_REJECTED', tag, name: e && e.name }));
    return p;
  };
  document.addEventListener('visibilitychange', () => push({ ev: 'VIS' }));
  window.addEventListener('pagehide', () => push({ ev: 'PAGEHIDE' }));
  document.addEventListener('freeze', () => push({ ev: 'FREEZE' }));
  document.addEventListener('resume', () => push({ ev: 'RESUME' }));
  return 'ok';
})()`;

function osState() {
  const ms = adb('shell', 'dumpsys', 'media_session');
  const at = ms.indexOf(BROWSER);
  const session = at >= 0 ? (/state=PlaybackState \{state=(\w+)/.exec(ms.slice(at)) ?? [])[1] ?? '?' : 'none';
  const players = adb('shell', 'dumpsys', 'audio').split('\n')
    .filter((l) => /AudioPlaybackConfiguration/.test(l) && /state:started/.test(l)).length;
  const services = adb('shell', 'dumpsys', 'activity', 'services', BROWSER).split('* ServiceRecord').slice(1)
    .map((r) => ({ name: ((/\{[0-9a-f]+ u0 ([^}]+)\}/.exec(r) ?? [])[1] ?? '?').split('$').pop(), fg: /isForeground=true/.test(r) }))
    .filter((r) => /Playback|Media/i.test(r.name))
    .map((r) => `${r.name.split('/').pop().split(' ')[0]}:${r.fg ? 'FG' : 'bg'}`).join(',') || 'none';
  const power = (/mWakefulness=(\w+)/.exec(adb('shell', 'dumpsys', 'power')) ?? [])[1];
  const idle = adb('shell', 'dumpsys', 'deviceidle');
  const doze = `${(/mState=(\w+)/.exec(idle) ?? [])[1]}/${(/mLightState=(\w+)/.exec(idle) ?? [])[1]}`;
  return `screen=${power} doze=${doze} session=${session} players=${players} service=${services}`;
}

const { send, js } = await connect();
await send('Page.enable');
await send('Runtime.enable');

async function printLog(since = 0) {
  const raw = await js(`localStorage.getItem('__advlog')`);
  if (typeof raw !== 'string') { log('page did not answer:', raw ?? 'no log'); return since; }
  const L = JSON.parse(raw || '[]');
  for (const e of L.slice(since)) {
    const { t, vis, ev, ...rest } = e;
    console.log(`         ${String(t).padStart(8)}ms ${vis.padEnd(7)} ${ev.padEnd(14)} ${JSON.stringify(rest)}`);
  }
  return L.length;
}

if (MODE === 'watch') {
  const seconds = Number(flag('seconds', 600));
  log('instrument', await js(INSTRUMENT));
  log('Do the steps on the phone now. Ctrl-C stops; the app\'s own playback log is printed at the end.');
  let seen = await printLog(0);
  const stop = async () => {
    const own = await js(`localStorage.getItem('bmb:plog:device')`);
    if (typeof own === 'string') {
      console.log('\n  the app\'s own playback log (bmb:plog:device):');
      for (const l of JSON.parse(own)) console.log(`         ${l}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => { void stop(); });
  for (let s = 0; s < seconds; s += 5) {
    await wait(5000);
    log(osState());
    seen = await printLog(seen);
  }
  await stop();
}

if (MODE === 'repro') {
  const pressQueue = `(async () => {
    const tick = () => new Promise((r) => setTimeout(r, 400));
    let pressed = 0;
    for (const b of document.querySelectorAll('button[aria-label^="More actions for "]')) {
      if (pressed >= 2) break;
      b.click(); await tick();
      const add = document.querySelector('[aria-label^="Actions for "] button[aria-label^="Add "]');
      if (add) { add.click(); pressed++; } else b.click();
      await tick();
    }
    return pressed;
  })()`;
  await send('Page.navigate', { url: ORIGIN }); await wait(4000);
  await js(`(() => { localStorage.clear(); return 1; })()`);
  await send('Page.navigate', { url: `${ORIGIN}/?podcast=${PC20}` }); await wait(15000);
  log('queued', await js(pressQueue));
  await send('Page.navigate', { url: `${ORIGIN}/listen` }); await wait(8000);
  log('instrument', await js(INSTRUMENT));
  await js(`document.querySelector('button[aria-label="Play"]').click(), 1`, { userGesture: true });
  for (let i = 0; i < 30; i++) {
    const s = await js(`(() => { const a = document.querySelector('audio'); return a && !a.paused && a.currentTime > 0; })()`);
    if (s === true) break;
    await wait(1000);
  }
  const seekLeft = Number(flag('seek-left', 12));
  const nextAt = flag('next-at', null);
  if (!nextAt) await js(`(() => { const a = document.querySelector('audio'); a.currentTime = a.duration - ${seekLeft}; return 1; })()`);
  log(`playing; ${nextAt ? `lock-screen next in ${nextAt}s` : `ends in ${seekLeft}s`}. ${osState()}`);
  adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP');
  log('screen locked');
  const doze = flag('doze', null);
  if (doze) {
    adb('shell', 'dumpsys', 'battery', 'unplug');
    log(adb('shell', 'dumpsys', 'deviceidle', 'force-idle', ...(doze === 'light' ? ['light'] : [])).trim());
  }
  if (nextAt) {
    await wait(Number(nextAt) * 1000);
    adb('shell', 'cmd', 'media_session', 'dispatch', 'next');
    log('sent media "next"');
  }
  const watchFor = Number(flag('watch', 60));
  for (let s = 0; s < watchFor; s += 5) { await wait(5000); log(osState()); }
  if (doze) { adb('shell', 'dumpsys', 'deviceidle', 'unforce'); adb('shell', 'dumpsys', 'battery', 'reset'); }
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'); await wait(800);
  adb('shell', 'wm', 'dismiss-keyguard'); await wait(1500);
  if (flag('twa', false)) adb('shell', 'monkey', '-p', TWA_PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1');
  else adb('shell', 'monkey', '-p', BROWSER, '-c', 'android.intent.category.LAUNCHER', '1');
  await wait(2500);
  log('screen unlocked');
  const after = await js(`(() => { const a = document.querySelector('audio'); return { paused: a.paused, ct: Math.round(a.currentTime), queue: JSON.parse(localStorage.getItem('bmb:listen_queue:guest') || '[]').length }; })()`);
  log('player after:', JSON.stringify(after));
  await printLog(0);
  const advanced = after && after.paused === false && after.queue === 1;
  console.log(advanced ? '\nADVANCED: the next item is playing' : '\nDID NOT ADVANCE');
  process.exit(advanced ? 0 : 1);
}
