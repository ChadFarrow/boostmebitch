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
//   2. Boost-all opens at 100 beside a single-boost default, and saves and
//      clears its OWN key without touching the single boost's.
//   3. The zap dialog on a note card: the same, with its own key.
//   4. At 390 and 320 wide, no surface overflows sideways and the control
//      clears 24×24 (WCAG 2.5.8).
//
// NOTHING IS PAID OR PUBLISHED. No wallet is connected, so Send stays disabled,
// and this script never presses it. The control writes one localStorage key.
// Section 3 signs in with a THROWAWAY key (a NIP-07 shim, as e2e:favorites
// does) and points the app at an in-memory relay on port 0, and asserts that
// the zap control sent that relay nothing.
//
//   npm run build && npm start          # in another terminal
//   npm run e2e:boostdefault            # add --headed to watch it
//
// It needs the network: the episode comes from Podcast Index through the app's
// routes.
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { createRelay } from './local-relay.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip04, nip19, nip44 } from 'nostr-tools';

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
  // The two modals have a Cancel; the zap dialog has only the shell's ×.
  if (!(await press(buttonIn(/^(cancel|close)$/i)))) {
    await press(`${DIALOG}?.querySelector('button[aria-label="Close"]')`);
  }
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
section('3. Zap a note — signed in with a throwaway key, local relay only');
const relayEvents = [];
const relay = createRelay({ port: 0, log: null, onEvent: (e) => relayEvents.push(e) });
const PORT = await relay.ready;
const sk = generateSecretKey();
const pk = getPublicKey(sk);
const npub = nip19.npubEncode(pk);
const convo = nip44.v2.utils.getConversationKey(sk, pk);
// A window.nostr indistinguishable from an extension, from the app's side —
// the shim e2e:favorites uses. Installed only now, so sections 1 and 2 ran
// with no signer at all.
await send('Runtime.addBinding', { name: 'bmbSigner' });
page.on(async (m) => {
  if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'bmbSigner') return;
  const { rid, fn, args } = JSON.parse(m.params.payload);
  let out, err = null;
  try {
    if (fn === 'getPublicKey') out = pk;
    else if (fn === 'signEvent') out = finalizeEvent(args[0], sk);
    else if (fn === 'nip44.encrypt') out = nip44.v2.encrypt(args[1], convo);
    else if (fn === 'nip44.decrypt') out = nip44.v2.decrypt(args[1], convo);
    else if (fn === 'nip04.encrypt') out = await nip04.encrypt(sk, args[0], args[1]);
    else if (fn === 'nip04.decrypt') out = await nip04.decrypt(sk, args[0], args[1]);
    else err = `no such method ${fn}`;
  } catch (e) { err = String(e?.message ?? e); }
  await js(`window.__bmbResolve(${JSON.stringify(rid)}, ${JSON.stringify({ out, err })})`);
});
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (() => {
    const waiting = new Map(); let n = 0;
    window.__bmbResolve = (rid, r) => { const p = waiting.get(rid); waiting.delete(rid); r.err ? p.reject(new Error(r.err)) : p.resolve(r.out); };
    const call = (fn, ...args) => new Promise((resolve, reject) => {
      const rid = 'r' + (++n); waiting.set(rid, { resolve, reject });
      window.bmbSigner(JSON.stringify({ rid, fn, args }));
    });
    window.nostr = {
      getPublicKey: () => call('getPublicKey'),
      signEvent: (e) => call('signEvent', e),
      nip44: { encrypt: (p, t) => call('nip44.encrypt', p, t), decrypt: (p, c) => call('nip44.decrypt', p, c) },
      nip04: { encrypt: (p, t) => call('nip04.encrypt', p, t), decrypt: (p, c) => call('nip04.decrypt', p, c) },
    };
  })();
` });

// One boost note by a SECOND throwaway key, whose profile has a Lightning
// address — the dialog shows its amount field only then. In the feed cache's
// own shape (e2e:feedbuttons), dated an hour ahead so it sorts first.
const authorSk = generateSecretKey();
const authorPk = getPublicKey(authorSk);
const BOWL = '2d418249-453a-5714-8abc-5b657570b641'; // Bowl After Bowl
const rawNote = finalizeEvent({
  kind: 1, created_at: Math.floor(Date.now() / 1000) + 3600,
  tags: [['i', `podcast:guid:${BOWL}`]], content: 'E2E-ZAP a note to zap',
}, authorSk);
const NOTE = {
  id: rawNote.id, pubkey: authorPk, npub: nip19.npubEncode(authorPk), nevent: nip19.neventEncode({ id: rawNote.id }),
  createdAt: rawNote.created_at, content: rawNote.content, isBoost: true, client: null, podcastGuid: BOWL,
  episodeGuids: [], amountSats: 21, quotesResolved: true, replies: [], rawEvent: rawNote,
  author: { name: 'Zap Test', lud16: 'zaptest@example.invalid' },
};
const ZAP_BUTTON = `[...document.querySelectorAll('article')].find((a) => a.innerText.includes('E2E-ZAP'))?.querySelector('button[aria-label="Zap"]')`;

/** Signed in, the seeded note on the home feed. `extra` runs before load. */
async function openFeed(extra = '') {
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until('document.readyState === "complete"');
  await js(`localStorage.clear();
    localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))});
    localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
    localStorage.setItem('bmb:signer', 'nip07');
    localStorage.setItem('bmb:feed:global', ${JSON.stringify(JSON.stringify([NOTE]))});
    ${extra}`);
  await send('Page.navigate', { url: `${APP}/` });
  await until('document.readyState === "complete"');
  return until(`!!(${ZAP_BUTTON})`, 40000);
}
async function openZap() {
  await js(`${ZAP_BUTTON}?.click()`);
  return until(`!!(${FIELD})`, 10000);
}

t.ok('signed in, the note offers ⚡ zap',
  await openFeed(`localStorage.setItem('bmb:boost_default', '1000'); localStorage.setItem('bmb:boost_all_default', '250');`));
t.ok('the zap dialog opens with its amount field', await openZap());
t.equal('the other two defaults do NOT fill it: it opens at 100', await fieldValue(), '100');
t.equal('its control is there, enabled at 100', await setState(), 'enabled');
const before = relayEvents.length;
await type('2100');
await press(SET);
t.equal('pressing it saves bmb:zap_default', await stored('bmb:zap_default'), '2100');
t.equal('bmb:boost_default is untouched', await stored('bmb:boost_default'), '1000');
t.equal('bmb:boost_all_default is untouched', await stored('bmb:boost_all_default'), '250');
t.ok('the control reads ✓ default', await marked());
await wait(1000);
t.equal('the relay received nothing from the control', relayEvents.length - before, 0);
t.ok('the zap dialog closes', await closeDialog());
await openZap();
t.equal('reopened, the zap dialog holds its own default', await fieldValue(), '2100');
await press(CLEAR);
t.equal('clear removes bmb:zap_default', await stored('bmb:zap_default'), null);
await closeDialog();
await openZap();
t.equal('reopened after clear, it is back at 100', await fieldValue(), '100');
await closeDialog();

// ---------------------------------------------------------------------------
section('4. Phone widths: no sideways overflow, and a control big enough to tap');
const measure = () => js(`(() => {
  const d = ${DIALOG};
  const b = ${SET} ?? ${CLEAR};
  const r = b ? b.getBoundingClientRect() : null;
  const de = document.documentElement;
  return JSON.stringify({
    page: de.scrollWidth - de.clientWidth,
    dialog: d ? d.scrollWidth - d.clientWidth : null,
    w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0,
    inside: r ? r.left >= 0 && r.right <= window.innerWidth : false,
  });
})()`).then(JSON.parse);
const surfaces = [
  ['single boost', openEpisode, openBoost],
  ['boost-all', openEpisode, openBoostAll],
  ['zap', openFeed, openZap],
];
for (const [width, height] of [[390, 844], [320, 640]]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 3, mobile: true });
  for (const [name, load, open] of surfaces) {
    await load();
    await open();
    const m = await measure();
    t.equal(`${width}px, ${name}: the page does not overflow`, m.page <= 0, true);
    t.equal(`${width}px, ${name}: the dialog does not overflow`, m.dialog !== null && m.dialog <= 0, true);
    t.ok(`${width}px, ${name}: the control is on screen`, m.inside, JSON.stringify(m));
    t.ok(`${width}px, ${name}: the control is at least 24×24`, m.w >= 24 && m.h >= 24, `${m.w}×${m.h}`);
    await closeDialog();
  }
}
await send('Emulation.clearDeviceMetricsOverride');
await relay.close();

// ---------------------------------------------------------------------------
section('Page health');
t.equal('no page exceptions', exceptions, []);

console.log(`\n${t.count - t.fails}/${t.count} passed`);
await exit(t.fails ? 1 : 0);
