// End-to-end for A LINK IN A BOOST MESSAGE NEXT TO AN @MENTION, through the
// real modal and the real picker, against nothing but this machine.
//
// Usage:
//   npm run build && npx next start -p 3417      # in another terminal
//   APP_URL=http://127.0.0.1:3417 npm run e2e:mentionlinks
//   add --headed to watch, --keep to leave the browser open
//
// THE BUG. The step that turns a picked `@name` into `nostr:npub…` in the note
// replaced the name EVERYWHERE in the text, links included. A Castopod episode
// link is https://host/@<handle>/episodes/<slug>, so a boost that linked one
// and mentioned someone named "<handle>" published
// https://host/nostr:npub1…/episodes/<slug> — a dead link, in a kind:1 that can
// never be edited. `inlineMentions` now places a name only where it stands
// alone, the way the picker writes it; check:mentions pins the rule.
//
// WHY AN E2E. check:mentions sees `inlineMentions` alone. This drives what the
// sender does: type the link, type `@ha`, pick from the list, send — and reads
// the note the relay received. It also reads the boostagram the wallet was
// handed, which must keep the text exactly as typed: the fix is for the NOTE.
//
// NOTHING LEAVES THE MACHINE. Chrome resolves no host but this one
// (`--host-resolver-rules`), the note goes to a relay on a free local port, the
// keys are generated per run, the signer is a NIP-07 stand-in over a CDP
// binding, and the wallet is a WebLN stand-in that records each keysend and
// moves nothing. `/api/item-value` is answered by the script with a
// one-recipient keysend block. The person mentioned is a cached kind:0 seeded
// into localStorage, so the picker's local tier offers them with no network.
// The SERVER still reads Podcast Index for the episode page; back-to-back runs
// can draw a PI 429, which fails at "episode open" — wait a few minutes.
//
// What it pins:
//   1. The report: a Castopod link and a picked mention of the same name. The
//      link reaches the note whole, the typed `@handle` becomes the URI, and
//      the person gets a `p` tag.
//   2. The name occurs only in the link (the typed `@handle` was deleted after
//      the pick): the link stays whole and the mention still reaches the body,
//      on a line of its own at the end, and the tags.

import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip04, nip19, nip44 } from 'nostr-tools';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const SHOW = 'fafd2bfc-98ac-5010-9fcb-7403abfd420a'; // Two For Tunestr
const ITEM = 'f7cb78c5-c90b-4ace-a6a3-4b6ef01f9d9b'; // Open Range
const EPISODE_URL = `${APP}/?podcast=${SHOW}&episode=${encodeURIComponent(ITEM)}`;
// The shape of a Castopod episode URL: /@<podcast handle>/episodes/<slug>.
const LINK = 'https://castopod.example/@handle/episodes/ep-1';

await requireApp(`${APP}/privacy`,
  `Nothing is serving ${APP}. Start it with \`npm run build && npx next start -p <port>\` and pass APP_URL.`);

const t = checker();
const section = (s) => console.log(`\n${s}`);

// ---- the relay, the sender, and the person mentioned ------------------------
const sk = generateSecretKey();
const pk = getPublicKey(sk);
const npub = nip19.npubEncode(pk);
const published = [];
const PORT = await createRelay({ port: 0, log: null, onEvent: (e) => published.push(e) }).ready;
const RELAY = `ws://127.0.0.1:${PORT}`;
const notesSince = (mark) => published.slice(mark).filter((e) => e.kind === 1 && e.pubkey === pk && e.content.startsWith('⚡ Boost ⚡'));

// Named exactly the handle in the link — the collision the bug needs.
const handlePk = getPublicKey(generateSecretKey());
const handleNpub = nip19.npubEncode(handlePk);

// ---- the browser -------------------------------------------------------------
const { page } = await launchChrome({
  name: 'mention-links',
  args: ['--disable-gpu', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
});
const { send, js, until } = page;
const exceptions = [];
page.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push((m.params.exceptionDetails?.exception?.description ?? 'exception').slice(0, 300));
  }
});
await send('Page.enable');
await send('Runtime.enable');

const PAYEE = `02${getPublicKey(generateSecretKey())}`;
const ITEM_VALUE = {
  read: true,
  value: { type: 'lightning', method: 'keysend', suggested: '0.00000005000', recipients: [{ name: 'e2e payee', type: 'node', address: PAYEE, split: 100 }] },
  valueTimeSplits: [],
};
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/item-value*', requestStage: 'Request' }] });
page.on(async (m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  await send('Fetch.fulfillRequest', {
    requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    body: Buffer.from(JSON.stringify(ITEM_VALUE)).toString('base64'),
  });
});

// A WebLN wallet that records each keysend's TLV records and moves nothing.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__paid = [];
  window.webln = {
    enable: async () => {},
    isEnabled: async () => true,
    getInfo: async () => ({ node: { alias: 'e2e' }, methods: ['getInfo', 'getBalance', 'keysend'] }),
    getBalance: async () => ({ balance: 1000000 }),
    keysend: async (a) => {
      window.__paid.push({ amount: a.amount, records: a.customRecords ?? {} });
      return { preimage: '00'.repeat(32) };
    },
    sendPayment: async () => { throw new Error('e2e: keysend only'); },
    makeInvoice: async () => { throw new Error('e2e: keysend only'); },
  };
` });

// A NIP-07 signer whose key never enters the page: every call crosses a CDP
// binding to this process.
const convo = nip44.v2.utils.getConversationKey(sk, pk);
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

// ---- helpers -------------------------------------------------------------------
const DIALOG = `document.querySelector('[role="dialog"]')`;
const FIELD = `${DIALOG}?.querySelector('input[inputmode="numeric"], input[type="number"]')`;
const AREA = `${DIALOG}?.querySelector('textarea')`;
const OPTION = `[...(${DIALOG}?.querySelectorAll('[role="listbox"] [role="option"]') ?? [])].find((o) => /handle/.test(o.textContent))`;
const SEND = `[...(${DIALOG}?.querySelectorAll('button') ?? [])].find((b) => /^send \\d+ sats?$/i.test(b.textContent.trim()))`;

// `bmb:rail_pref` already webln: a rail CHANGE publishes an encrypted settings
// backup, which is noise here. The cached kind:0 is the cell `storage.profile`
// writes (`{ t, v }`), so the picker's local tier offers "handle" at once.
const SESSION = `localStorage.clear();
  localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([RELAY]))});
  localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
  localStorage.setItem('bmb:signer', 'nip07');
  localStorage.setItem('bmb:rail_pref', 'webln');
  localStorage.setItem('bmb:profile4:${handlePk}', JSON.stringify({ t: Date.now(), v: { name: 'handle', display_name: 'handle' } }));`;

async function openBoost() {
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until('document.readyState === "complete"');
  await js(`(() => { ${SESSION} return 1; })()`);
  await send('Page.navigate', { url: EPISODE_URL });
  await until('document.readyState === "complete"');
  const ready = await until(`!!document.querySelector('button[aria-label="Boost this episode"]')`, 60000);
  await until(`!!window.nostr && typeof window.nostr.signEvent === 'function'`, 20000);
  await wait(1000);
  await js(`document.querySelector('button[aria-label="Boost this episode"]')?.click()`);
  const open = await until(`!!(${FIELD}) && !!(${AREA})`, 15000);
  // The modal's minimum, typed like a person would.
  await js(`(() => { const f = ${FIELD}; f.focus(); f.select(); return 1; })()`);
  await send('Input.insertText', { text: '100' });
  await wait(200);
  return ready && open;
}
async function typeMessage(text) {
  await js(`(() => { const a = ${AREA}; a.focus(); a.setSelectionRange(a.value.length, a.value.length); return 1; })()`);
  await send('Input.insertText', { text });
  await wait(300);
}
async function press(key, code, keyCode, times = 1) {
  for (let i = 0; i < times; i += 1) {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
    await wait(60);
  }
  await wait(250);
}
/** Type `@ha`, wait for "handle" in the list, take it with Enter. */
async function pickHandle() {
  await typeMessage('@ha');
  const listed = await until(`!!(${OPTION})`, 10000);
  await press('Enter', 'Enter', 13);
  return listed;
}
async function sendAndRead() {
  const mark = published.length;
  await until(`!!(${SEND}) && !(${SEND}).disabled`, 15000);
  await js(`(${SEND}).click()`);
  for (let i = 0; i < 120 && !notesSince(mark).length; i += 1) await wait(250);
  const note = notesSince(mark)[0];
  await until(`!${DIALOG}`, 8000);
  return note;
}
const boostagramMessages = async () => (await js(`window.__paid`)).map((p) => {
  try { return JSON.parse(p.records['7629169']).message; } catch { return null; }
});

// ---------------------------------------------------------------------------
section('1. The report: a Castopod link, and a mention of the same name');
{
  t.ok('signed in, the boost modal is open', await openBoost());
  await typeMessage(`listen ${LINK} thanks `);
  t.equal('the @ inside the link does not open the picker', await js(`${AREA}.getAttribute('aria-expanded')`), 'false');
  t.ok('"@ha" lists handle', await pickHandle());
  const typed = `listen ${LINK} thanks @handle `;
  t.equal('the pick wrote @handle where the sender typed', await js(`${AREA}.value`), typed);

  const note = await sendAndRead();
  t.ok('the note reached the relay', !!note);
  const content = note?.content ?? '';
  t.ok('the link reaches the note whole', content.includes(LINK), content);
  t.ok('no URI was written into the link', !content.includes('/nostr:'), content);
  t.ok('the typed @handle became the URI, in place', content.includes(`thanks nostr:${handleNpub}`), content);
  t.equal('the URI is in the note once, not again in a trailing run',
    content.split(`nostr:${handleNpub}`).length - 1, 1);
  t.ok('handle is tagged', note?.tags.some((x) => x[0] === 'p' && x[1] === handlePk), JSON.stringify(note?.tags));
  const msgs = await boostagramMessages();
  t.ok('the wallet paid', msgs.length > 0);
  t.ok('the boostagram keeps the text exactly as typed', msgs.length > 0 && msgs.every((m) => m?.trim() === typed.trim()),
    JSON.stringify(msgs));
}

// ---------------------------------------------------------------------------
section('2. The name is only in the link: it stays whole, the mention goes to the end');
{
  t.ok('signed in, the boost modal is open', await openBoost());
  await typeMessage(`${LINK} `);
  t.ok('"@ha" lists handle', await pickHandle());
  // Delete the "@handle " the pick wrote. The pick stays attached.
  await press('Backspace', 'Backspace', 8, '@handle '.length);
  t.equal('only the link is left in the box', await js(`${AREA}.value`), `${LINK} `);
  t.ok('the mention is still attached',
    await js(`!!${DIALOG}?.querySelector('button[aria-label^="Remove mention of"]')`));

  const note = await sendAndRead();
  t.ok('the note reached the relay', !!note);
  const content = note?.content ?? '';
  t.ok('the link reaches the note whole', content.includes(LINK), content);
  t.ok('no URI was written into the link', !content.includes('/nostr:'), content);
  t.ok('the mention is a line of its own', content.split('\n').includes(`nostr:${handleNpub}`), content);
  t.ok('handle is tagged', note?.tags.some((x) => x[0] === 'p' && x[1] === handlePk), JSON.stringify(note?.tags));
}

// ---------------------------------------------------------------------------
section('Page health');
t.equal('no page exceptions', exceptions, []);

console.log(`\n${t.count - t.fails}/${t.count} passed`);
await exit(t.fails ? 1 : 0);
