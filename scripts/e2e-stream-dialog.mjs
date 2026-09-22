// Drives ≋ STREAM in a real browser and asserts its settings open ON SCREEN,
// from every surface that has the control.
//
// THE REPORT. From an iPhone, in the fullscreen player: *"The 'stream' button
// at the top opens the streaming settings just fine but it's confusing since I
// have to scroll down to know that it opened it."* The button is in the top
// bar's `⋯` menu; the panel it toggled rendered under BOOST, below the bottom
// of a phone. Nothing was wrong except where the answer appeared — which no
// unit check can see, so this measures the answer's BOX against the viewport.
//
// `useStreamPanel` (components/streaming-settings.tsx) now returns a dialog
// through <ModalShell>, for all three surfaces at once. This checks two of
// them — the show page and the player's `⋯` menu — because those are the two
// ends of the problem: one where the panel happened to be visible, one where
// it was not.
//
// IT NEVER TOUCHES THE SWITCH. Streaming spends money unattended; this only
// opens and closes the dialog, and asserts that doing so wrote no streaming
// key at all.
//
//   npm run build && npm start          # in another terminal
//   npm run e2e:streamdialog            # add --headed to watch it
//
// It needs the network: Tinderbox (a `music` album with a value block, so
// STREAM renders) comes from Podcast Index through the app's routes.
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const ALBUM_GUID = '537df90e-0cc4-535b-84d0-dcb3ca87f1f8';

await requireApp(`${APP}/privacy`,
  `Nothing is serving ${APP}. Start it with \`npm start\` (after \`npm run build\`) in another terminal.`);

const t = checker();
const section = (s) => console.log(`\n${s}`);
const { page } = await launchChrome({ name: 'streamdialog', autoplay: true });
const { send, js, on } = page;
const exceptions = [];
on((m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push(m.params.exceptionDetails?.exception?.description ?? 'exception');
  }
});
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

const until = async (fn, ms) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await wait(250); }
};
/** A real pointer press at the centre of an element, found by an expression. */
const tap = async (find) => {
  const at = await js(`(() => { const el = ${find}; if (!el) return null;
    const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (!at) return false;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  }
  return true;
};
/** What a person would see of the dialog: is there one, is it all on screen,
 *  is it the thing on top, what does it name, and does it hold focus. */
const dialog = () => js(`(() => {
  const ds = [...document.querySelectorAll('[role=dialog]')];
  const d = ds[0];
  if (!d) return { count: 0 };
  const card = d.querySelector('[tabindex="-1"]') || d;
  const r = card.getBoundingClientRect();
  const top = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + Math.min(r.height / 2, 60)));
  return {
    count: ds.length,
    onScreen: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
    box: [Math.round(r.top), Math.round(r.bottom), innerHeight],
    onTop: !!top && d.contains(top),
    text: d.innerText.replace(/\\s+/g, ' ').slice(0, 120),
    focused: d.contains(document.activeElement),
  };
})()`);
/** Every streaming key, so the suite can prove it spent nothing. */
const streamKeys = () => js(`JSON.stringify(Object.keys(localStorage).filter((k) => k.startsWith('bmb:stream')).sort().map((k) => [k, localStorage.getItem(k)]))`);

await send('Page.navigate', { url: `${APP}/?podcast=${ALBUM_GUID}` });
const STREAM_TILE = `[...document.querySelectorAll('button[aria-haspopup="dialog"]')].find((b) => /STREAM/.test(b.textContent))`;
await until(() => js(`!!(${STREAM_TILE})`), 30000);
const keysBefore = await streamKeys();

// ---------------------------------------------------------------------------
section('1. On the show page, STREAM opens a dialog, on screen, naming the show');
// ---------------------------------------------------------------------------
{
  t.ok('the show page offers STREAM, as a control that opens a dialog', await tap(STREAM_TILE), 'no STREAM button with aria-haspopup="dialog"');
  await wait(800);
  const d = await dialog();
  console.log(`  dialog: ${JSON.stringify(d)}`);
  t.equal('one dialog opens', d.count, 1);
  t.ok('...wholly inside the viewport', d.onScreen, JSON.stringify(d.box));
  t.ok('...on top of everything else', d.onTop, JSON.stringify(d));
  t.ok('...naming the show it will spend on', /Tinderbox/.test(d.text || ''), d.text);
  t.ok('...with the settings in it', /Stream this show/i.test(d.text || ''), d.text);
  t.ok('...and focus inside it', d.focused, JSON.stringify(d));
  await tap(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim().toUpperCase() === 'DONE')`);
  await wait(600);
  t.equal('DONE closes it', (await dialog()).count, 0);
}

// ---------------------------------------------------------------------------
section('2. In the player, STREAM in the ⋯ menu opens the SAME dialog, on screen');
// ---------------------------------------------------------------------------
{
  await tap(`document.querySelector('button[aria-label="Play album"]')`);
  const bar = await until(() => js(`!!document.querySelector('[aria-label="Open fullscreen player"]')`), 15000);
  t.ok('a track is playing, so the player exists', bar, 'no now-playing bar');
  await wait(1500);
  // The bar's inner controls stop propagation, so a synthetic click on the
  // wrapper opens nothing; a pointer press left of centre lands on the title.
  const box = await js(`(() => { const d = document.querySelector('[aria-label="Open fullscreen player"]'); const r = d.getBoundingClientRect();
    return { x: Math.round(r.x + r.width * 0.45), y: Math.round(r.y + 22) }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  await wait(1500);
  t.ok('the ⋯ menu opens', await tap(`document.querySelector('button[aria-label="More actions for this episode"]')`), 'no ⋯ trigger');
  await wait(600);
  t.ok('...and holds STREAM', await tap(`[...document.querySelectorAll('[role=menu] button')].find((b) => /STREAM/.test(b.textContent))`),
    'no STREAM tile in the menu');
  await wait(800);
  const d = await dialog();
  console.log(`  dialog: ${JSON.stringify(d)}`);
  t.equal('one dialog opens', d.count, 1);
  t.ok('...wholly inside the viewport — the report was that it opened below it', d.onScreen, JSON.stringify(d.box));
  t.ok('...on top of the player AND its menu', d.onTop, JSON.stringify(d));
  t.ok('...naming the show', /Tinderbox/.test(d.text || ''), d.text);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait(600);
  t.equal('Escape closes it', (await dialog()).count, 0);
}

t.equal('opening and closing it wrote no streaming setting', await streamKeys(), keysBefore);
t.equal('no uncaught exceptions', exceptions, []);
console.log(t.fails ? `\n${t.fails} of ${t.count} stream-dialog checks FAILED.` : `\nAll ${t.count} stream-dialog checks passed.`);
await exit(t.fails ? 1 : 0);
