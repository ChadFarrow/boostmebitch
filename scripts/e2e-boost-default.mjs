// Drives the SET AS DEFAULT control on every surface that has one, in a real
// browser, and asserts what each surface opens with afterwards.
//
// THE REQUEST. Chad, with a screenshot of the single boost modal: *"leave this
// blank but maybe add a 'set as default' button below it and add a set default
// boost in the other sections that have to do with sat amounts"* — and, asked
// whether one number should serve them all, *"one for each section"*. So there
// are three keys, and the assertion that matters most is that they stay apart:
// boost-all MULTIPLIES its number by the track count, so a single-boost default
// read there is an album spend N times larger than the one the listener chose.
//
// WHAT IT PINS:
//
//   1. Single boost: opens blank with no default; the control saves, shows
//      ✓ default, clears; a cleared field never leaves the old amount on the
//      Send button; garbage or a sub-minimum stored value opens blank.
//
// NOTHING IS PAID OR PUBLISHED. No wallet is connected, so Send stays disabled,
// and this script never presses it. The control writes one localStorage key.
//
//   npm run build && npm start          # in another terminal
//   npm run e2e:boostdefault            # add --headed to watch it
//
// It needs the network: the episode comes from Podcast Index through the app's
// routes.
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const SHOW = 'fafd2bfc-98ac-5010-9fcb-7403abfd420a'; // Two For Tunestr — value block AND track splits
const ITEM = 'f7cb78c5-c90b-4ace-a6a3-4b6ef01f9d9b'; // Open Range
const EPISODE_URL = `${APP}/?podcast=${SHOW}&episode=${encodeURIComponent(ITEM)}`;

await requireApp(`${APP}/privacy`,
  `Nothing is serving ${APP}. Start it with \`npm start\` (after \`npm run build\`) in another terminal.`);

const t = checker();
const section = (s) => console.log(`\n${s}`);
const { page } = await launchChrome({ name: 'boostdefault', args: ['--disable-gpu'] });
const { send, js, until } = page;
const exceptions = [];
page.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push((m.params.exceptionDetails?.exception?.description ?? 'exception').slice(0, 300));
  }
});
await send('Page.enable');
await send('Runtime.enable');

// ---- helpers ----------------------------------------------------------------
const DIALOG = `document.querySelector('[role="dialog"]')`;
const FIELD = `${DIALOG}?.querySelector('input[inputmode="numeric"], input[type="number"]')`;
const buttonIn = (re) =>
  `[...(${DIALOG}?.querySelectorAll('button') ?? [])].find((b) => ${re}.test(b.textContent.trim()))`;
const SET = buttonIn(/^set as default$/i);
const CLEAR = buttonIn(/^clear$/i);
const SEND = buttonIn(/^send \d+ sats?$/i);
const fieldValue = () => js(`${FIELD}?.value ?? null`);
const stored = (key) => js(`localStorage.getItem(${JSON.stringify(key)})`);
const dialogText = () => js(`${DIALOG}?.innerText ?? ''`);
const setState = () => js(`(() => { const b = ${SET}; return b ? (b.disabled ? 'disabled' : 'enabled') : 'absent'; })()`);
const marked = async () => /✓\s*default/i.test(await dialogText());

/** Select the field's whole text, as a fresh tap does. `focus()` on a field
 *  that already has focus fires no focus event, so nothing would be selected
 *  and the next keystroke would edit the old number instead of replacing it. */
const selectAll = () => js(`(() => { const f = ${FIELD}; if (!f) return false; f.blur(); f.focus(); f.select(); return true; })()`);
/** Type over the field's whole text. */
async function type(text) {
  await selectAll();
  await wait(50);
  await send('Input.insertText', { text });
  await wait(150);
}
/** Backspace over the field's whole text: an emptied field. */
async function empty() {
  await selectAll();
  await wait(50);
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  }
  await wait(150);
}
async function press(expr) {
  const found = await js(`(() => { const b = ${expr}; if (!b) return false; b.click(); return true; })()`);
  await wait(200);
  return found;
}

/** A fresh store, the episode page, and nothing open. `extra` runs before load. */
async function openEpisode(extra = '') {
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until('document.readyState === "complete"');
  await js(`localStorage.clear(); ${extra}`);
  await send('Page.navigate', { url: EPISODE_URL });
  await until('document.readyState === "complete"');
  return until(`!!document.querySelector('button[aria-label="Boost this episode"]')`, 60000);
}
async function openBoost() {
  await js(`document.querySelector('button[aria-label="Boost this episode"]')?.click()`);
  return until(`!!(${FIELD})`, 15000);
}
async function closeDialog() {
  await press(buttonIn(/^(cancel|close)$/i));
  return until(`!${DIALOG}`, 5000);
}

// ---------------------------------------------------------------------------
section('1. Single boost');
t.ok('the episode offers BOOST', await openEpisode());
t.ok('the modal opens', await openBoost());
t.equal('with no default, the field is blank', await fieldValue(), '');
t.equal('the control is there, and disabled on a blank field', await setState(), 'disabled');

// The field used to report only a NON-empty value upward, so emptying it left
// `sats` at its last number: a blank field beside "Send 1000 sat". A default
// pre-fills the field, so emptying it is now the common way to type a new one.
await type('1000');
await empty();
const sentBlank = await js(`${SEND}?.textContent.trim() ?? ''`);
t.ok('an emptied field leaves no amount on Send', /send 0 sat/i.test(sentBlank), sentBlank);

await type('1000');
t.equal('1000 enables it', await setState(), 'enabled');
await press(SET);
t.equal('pressing it saves bmb:boost_default', await stored('bmb:boost_default'), '1000');
t.ok('the control now reads ✓ default', await marked());
t.ok('with a clear button', await js(`!!${CLEAR}`));
t.equal('and set-as-default is gone', await setState(), 'absent');

t.ok('the modal closes', await closeDialog());
await openBoost();
t.equal('reopened, the field holds the default', await fieldValue(), '1000');
t.ok('and the control reads ✓ default', await marked());

await empty();
t.equal('an emptied field is blank', await fieldValue(), '');
const sendText = await js(`${SEND}?.textContent.trim() ?? ''`);
t.ok('and Send no longer names the old amount', !/1000/.test(sendText), sendText);
t.ok('a blank field is not marked ✓ default', !(await marked()));

await type('1000');
await press(CLEAR);
t.equal('clear removes bmb:boost_default', await stored('bmb:boost_default'), null);
t.equal('and set-as-default is back, enabled', await setState(), 'enabled');
await closeDialog();
await openBoost();
t.equal('reopened after clear, the field is blank', await fieldValue(), '');

await type('50');
t.equal('below 100, the control is disabled', await setState(), 'disabled');
await closeDialog();

for (const bad of ['abc', '50', '-5', '1e3', '100.5', '']) {
  await js(`localStorage.setItem('bmb:boost_default', ${JSON.stringify(bad)})`);
  await openBoost();
  t.equal(`a stored ${JSON.stringify(bad)} opens blank`, await fieldValue(), '');
  await closeDialog();
}

// ---------------------------------------------------------------------------
section('2. Boost-all, per track — its own key, never the single boost\'s');
async function openBoostAll() {
  await js(`document.querySelector('button[aria-label="More actions"]')?.click()`);
  await until(`[...document.querySelectorAll('[role="menuitem"]')].some((b) => /boost all \\d+ tracks/i.test(b.textContent))`, 10000);
  await js(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => /boost all \\d+ tracks/i.test(b.textContent))?.click()`);
  return until(`!!(${FIELD})`, 15000);
}
t.ok('the episode offers BOOST again', await openEpisode(`localStorage.setItem('bmb:boost_default', '1000');`));
t.ok('boost-all opens from the ⋯ menu', await openBoostAll());
t.ok('it is the per-track field', /amount per track/i.test(await dialogText()));
t.equal('a single-boost default of 1000 does NOT fill it: it opens at 100', await fieldValue(), '100');
t.equal('its control is there, enabled at 100', await setState(), 'enabled');

await type('250');
await press(SET);
t.equal('pressing it saves bmb:boost_all_default', await stored('bmb:boost_all_default'), '250');
t.equal('and leaves bmb:boost_default alone', await stored('bmb:boost_default'), '1000');
t.ok('the control reads ✓ default', await marked());
await closeDialog();
await openBoostAll();
t.equal('reopened, boost-all holds its own default', await fieldValue(), '250');
await closeDialog();
await openBoost();
t.equal('and the single boost still holds its own', await fieldValue(), '1000');
await closeDialog();
await openBoostAll();
await press(CLEAR);
t.equal('clear on boost-all removes only its key', await stored('bmb:boost_all_default'), null);
t.equal('bmb:boost_default survives it', await stored('bmb:boost_default'), '1000');
await closeDialog();
await openBoostAll();
t.equal('reopened after clear, boost-all is back at 100', await fieldValue(), '100');
await closeDialog();

// ---------------------------------------------------------------------------
section('Page health');
t.equal('no page exceptions', exceptions, []);

console.log(`\n${t.count - t.fails}/${t.count} passed`);
await exit(t.fails ? 1 : 0);
