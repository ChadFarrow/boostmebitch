// Drives the playback diagnostic log (lib/playback-log.ts) in a real browser:
// what it records through a queue advance, that it outlives a reload, and that
// "Report a bug" shows it and sends it only under "Include app info".
//
// Usage:
//   npm run dev                  # in another terminal
//   npm run e2e:playbacklog [-- --headed --keep]
//
// WHY THIS EXISTS. The log is the evidence for a fault that did not reproduce
// anywhere but a listener's phone ("the next item in the queue doesn't play
// with the screen locked", Android, 2026-10-30). A log that silently stopped
// recording — an effect that ran before the <audio> mounted, a format drift
// that `isPlaybackLogLine` then dropped on read — would turn the next report
// into an empty section, and nobody would know until the bug came back. Every
// assertion here reads the lines off disk, which is where the report reads
// them.
//
// WHAT IT DOES NOT DRIVE. A locked screen, a lock-screen ⏭ and a page the OS
// froze: those need a phone or an emulator. `npm run android:advance`
// (`scripts/android-advance.mjs`) drives them over adb.
//
// Signed out, nothing reaches a relay. Without `GITHUB_BUG_TOKEN` the route
// answers 503 AFTER `parseBugReport` accepts the report, which is what the
// report check reads; it never files an issue.

import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:3000';
const PC20 = '917393e3-1b1e-5cef-ace4-edaa54e1f810';  // Podcasting 2.0 (talk)
const LOG_KEY = 'bmb:plog:device';

await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);

const { page } = await launchChrome({ name: 'playbacklog', autoplay: true, args: ['--disable-gpu', '--window-size=1200,900'] });
const { send } = page;
const js = page.jsOrThrow;
const t = checker();
const section = (n) => console.log(`\n${n}`);
const lines = () => js(`JSON.parse(localStorage.getItem(${JSON.stringify(LOG_KEY)}) || '[]')`);
const codes = (ls) => ls.map((l) => l.split(' ').slice(1).join(' '));
// <ModalShell> labels its dialog with aria-labelledby, so find it by its heading.
const DIALOG = `[...document.querySelectorAll('[role="dialog"]')].find((d) => /Report a bug/.test(d.querySelector('h2')?.textContent ?? ''))`;

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: APP }); await wait(3000);
await js(`(() => { localStorage.clear(); return 1; })()`);

// ---------------------------------------------------------------------------
section('1. A queue advance is recorded end to end, with no URL in any line');
// ---------------------------------------------------------------------------
await send('Page.navigate', { url: `${APP}/?podcast=${PC20}` }); await wait(14000);
const queued = await js(`(async () => {
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
})()`);
t.equal('two episodes queued', queued, 2);

await send('Page.navigate', { url: `${APP}/listen` });
await page.until(`!!document.querySelector('button[aria-label="Play"]')`, 30000);
// An offset, not a clear: the reveal has already logged the head's `src`.
const base = (await lines()).length;
await js(`document.querySelector('button[aria-label="Play"]').click(), 1`);
const started = await page.until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && a.currentTime > 0; })()`, 30000);
t.equal('the head plays', started, true);
await js(`(() => { const a = document.querySelector('audio'); a.currentTime = Math.max(0, a.duration - 3); return 1; })()`);
const advanced = await page.until(`JSON.parse(localStorage.getItem(${JSON.stringify(LOG_KEY)}) || '[]').some((l) => / advance via=queue playing=1$/.test(l))`, 30000);
t.equal('the advance is logged as a queue advance that kept playing', advanced, true);
await page.until(`(() => { const L = JSON.parse(localStorage.getItem(${JSON.stringify(LOG_KEY)}) || '[]'); const i = L.findIndex((l) => / advance /.test(l)); return i >= 0 && L.slice(i).some((l) => / play\\.ok el=a$/.test(l)); })()`, 30000);

const L1 = await lines();
const after = codes(L1.slice(L1.findIndex((l) => / m\.ended /.test(l))));
const order = ['m.ended', 'advance via=queue playing=1', 'src el=a kind=stream', 'play.call el=a', 'play.ok el=a'];
let at = 0;
for (const want of order) {
  const i = after.findIndex((c, k) => k >= at && c.startsWith(want));
  t.equal(`after ended: "${want}" follows`, i >= 0, true);
  if (i >= 0) at = i + 1;
  else console.log(after.map((c) => `         | ${c}`).join('\n'));
}
const items = [...new Set(L1.filter((l) => / src el=a /.test(l)).map((l) => / item=(\w+)/.exec(l)?.[1]))];
t.equal('the two src lines name two different items', items.length, 2);
t.equal('the press is logged as intent, then a play() call', codes(L1.slice(base, base + 2)), ['want playing=1', 'play.call el=a rs=4 vis=visible']);
t.equal('the reveal logged the head\'s own src', L1.slice(0, base).some((l) => / src el=a kind=stream item=/.test(l)), true);
t.equal('no line holds a URL, a title or a guid', L1.some((l) => /http|op3|mp3|PC20|Episode|917393e3/i.test(l)), false);

// ---------------------------------------------------------------------------
section('1b. The first play into an EMPTY player is watched');
// ---------------------------------------------------------------------------
// Both elements mount in the same commit as the source effect's first play, so
// this is the one case where the watcher's position above the source effect
// decides whether the play() is seen. Declare it after, and `play.call` is
// missing here while every other section still passes.
await js(`(() => { localStorage.clear(); return 1; })()`);
await send('Page.navigate', { url: `${APP}/?podcast=${PC20}` });
await page.until(`!!document.querySelector('li button[aria-label="Play"]') && !document.querySelector('audio')`, 30000);
// Give the download library time to hydrate. A tap before it lands takes the
// source effect's async branch, and that branch can resolve within microtasks
// — before the element has settled the srcless play() the play/pause effect
// just issued — so the new load aborts it and the AbortError parks the store.
// Measured here 2026-10-31; a player bug of its own, not this log's, and not
// this section's subject.
await wait(4000);
await js(`document.querySelector('li button[aria-label="Play"]').click(), 1`);
await page.until(`JSON.parse(localStorage.getItem(${JSON.stringify(LOG_KEY)}) || '[]').some((l) => / play\.ok el=a$/.test(l))`, 30000);
const firstPlay = codes(await lines()).filter((c) => /^(src|play\.call)/.test(c)).map((c) => c.split(' ').slice(0, 2).join(' '));
t.equal('src, then the play() it started', firstPlay.slice(0, 2), ['src el=a', 'play.call el=a']);

// ---------------------------------------------------------------------------
section('2. The log outlives a reload, and the reload says so');
// ---------------------------------------------------------------------------
const before = (await lines()).length;
await send('Page.reload'); await wait(6000);
const L2 = await lines();
t.equal('the lines from before the reload are still there', L2.length > before, true);
t.equal('a load line records the reload', L2.some((l) => / load date=\d{4}-\d{2}-\d{2} nav=reload discarded=0 vis=visible$/.test(l)), true);

await send('Page.setWebLifecycleState', { state: 'frozen' }); await wait(500);
await send('Page.setWebLifecycleState', { state: 'active' }); await wait(500);
const L3 = await lines();
t.equal('a freeze and its resume are recorded', L3.some((l) => / freeze$/.test(l)) && L3.some((l) => / resume$/.test(l)), true);

// ---------------------------------------------------------------------------
section('3. "Report a bug" shows the log and sends it only with app info');
// ---------------------------------------------------------------------------
await js(`(() => {
  window.__reports = [];
  const f = window.fetch;
  window.fetch = async (input, init) => {
    if (String(input).includes('/api/bug-report')) {
      const res = await f(input, init);
      window.__reports.push({ body: JSON.parse(init.body), status: res.status });
      return res;
    }
    return f(input, init);
  };
  return 1;
})()`);
const opened = await js(`(async () => {
  const tick = () => new Promise((r) => setTimeout(r, 400));
  const trigger = [...document.querySelectorAll('button[aria-haspopup="menu"]')].find((b) => /Sign in/.test(b.textContent));
  if (!trigger) return 'no trigger';
  trigger.click(); await tick();
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((b) => /Report a bug/.test(b.textContent));
  if (!item) return 'no item';
  item.click(); await tick();
  return !!(${DIALOG});
})()`);
t.equal('the report modal opens', opened, true);
const shown = await js(`(() => {
  const d = (${DIALOG}).querySelector('details');
  d.open = true;
  const p = [...d.querySelectorAll('p')].find((x) => /Playback log/.test(x.textContent));
  const pre = d.querySelector('pre');
  return { label: p?.textContent ?? null, lines: pre ? pre.textContent.split('\\n').length : 0 };
})()`);
const onDisk = (await lines()).length;
t.equal('the modal names the log and its size', shown.label, `Playback log, ${onDisk} events (UTC)`);
t.equal('...and shows every line it will send', shown.lines, onDisk);

const sendReport = () => js(`(async () => {
  const dlg = ${DIALOG};
  const ta = dlg.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, 'e2e: playback log check'); ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  [...dlg.querySelectorAll('button')].find((b) => /Send report/.test(b.textContent)).click();
  for (let i = 0; i < 40 && window.__reports.length < (window.__want || 1); i++) await new Promise((r) => setTimeout(r, 250));
  return window.__reports.at(-1) ?? null;
})()`);
const r1 = await sendReport();
t.equal('with app info: the log is sent, every line', r1?.body?.log?.length, onDisk);
// 503 = parseBugReport accepted it and the route stopped at the missing token.
// A 400 would mean the route refused a log the app wrote.
t.equal('...and the route accepts it (503: no token here, parsed fine)', r1?.status, 503);

await js(`(() => {
  window.__want = 2;
  const box = (${DIALOG}).querySelector('input[type="checkbox"]');
  box.click();
  return box.checked;
})()`);
const r2 = await sendReport();
t.equal('without app info: no log is sent', r2?.body?.log, []);

// ---------------------------------------------------------------------------
section('4. At phone width the log box scrolls inside itself, not the page');
// ---------------------------------------------------------------------------
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await wait(800);
const fit = await js(`(() => {
  const card = ${DIALOG};
  const pre = card.querySelector('pre');
  return {
    page: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    card: card.scrollWidth <= card.clientWidth,
    preScrolls: !!pre && pre.scrollWidth >= pre.clientWidth,
  };
})()`);
t.equal('no horizontal page overflow at 390px', fit, { page: true, card: true, preScrolls: true });

if (t.fails) {
  console.error(`\nPLAYBACK LOG E2E FAILED (${t.fails})`);
  await exit(1);
}
console.log('\nPLAYBACK LOG E2E OK');
await exit(0);
