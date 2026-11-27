// End-to-end check of the spam-reply fold and the viewer's `word` mutes on the
// HOME PAGE, in headless Chrome (docs/nostr.md "Spam replies").
//
// Usage (a dev server must be up):
//   npm run e2e:replyspam                       # http://localhost:3000
//   APP_URL=http://localhost:3123 npm run e2e:replyspam
//
// What it pins, in the order a visitor meets it:
//
//   1. SIGNED OUT, the case Chad reported: the read index answers with a FIXED
//      bundle (scripts/fixtures/reply-spam-bundle.json — three real home-page
//      threads read on 2026-11-26, 20 real replies, 9 of them spam). Every
//      fixture spam reply is folded and every fixture real reply is open. The
//      public relays still answer as on the real site, so the run also asserts
//      that NO reply linking a spam host shows outside a fold, whatever the
//      relays brought.
//   2. SHOW opens the fold and HIDE closes it again.
//   3. A phone, under CDP device emulation (390 x 844, mobile: true): no
//      horizontal overflow, and the fold's button is at least 24 x 24.
//   4. SIGNED IN with a throwaway key: a kind:10000 on a LOCAL relay mutes one
//      word, and the one real reply holding it leaves the page — with the two
//      replies under it, as under a muted author — while the rest stay open
//      and the spam stays folded.
//
// NOTHING REACHES A PUBLIC RELAY WHILE A KEY IS SIGNED IN. Section 4 blocks
// every `wss://` URL in the tab (`Network.setBlockedURLs`), points the publish
// set at the local relay (`bmb:relays`), and fails the run on any EVENT frame
// sent anywhere but 127.0.0.1. Sections 1-3 are signed out, with no signer.

import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44, nip04 } from 'nostr-tools';
import { readFileSync } from 'node:fs';

const APP = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const BUNDLE = JSON.parse(readFileSync(new URL('./fixtures/reply-spam-bundle.json', import.meta.url), 'utf8'));
const SPAM_HOST = /https?:\/\/(?:ai\.evmnest\.cc|ai\.solhub\.cc|one\.evmverse\.cc|gweiportal\.top)\b/;
const isSpam = (e) => SPAM_HOST.test(e.content);
const SPAM_IDS = BUNDLE.replies.filter(isSpam).map((e) => e.id);
const REAL_IDS = BUNDLE.replies.filter((e) => !isSpam(e)).map((e) => e.id);
const ROOT_IDS = BUNDLE.notes.map((e) => e.id);
// The word section 4 mutes, and the one real fixture reply that holds it.
const WORD = 'donnerstag';
const WORD_IDS = BUNDLE.replies.filter((e) => e.content.toLowerCase().includes(WORD)).map((e) => e.id);
// The replies UNDER it leave with it, as the replies under a muted author's
// reply always have: the card that would hold them is not rendered.
const parentOf = (e) => {
  const es = e.tags.filter((tg) => tg[0] === 'e');
  return (es.find((tg) => tg[3] === 'reply') ?? (es.length === 1 ? es[0] : null) ?? es.find((tg) => tg[3] === 'root'))?.[1];
};
const under = (ids) => {
  const out = [];
  const walk = (id) => { for (const r of BUNDLE.replies) if (parentOf(r) === id) { out.push(r.id); walk(r.id); } };
  ids.forEach(walk);
  return out;
};
const GONE_IDS = [...WORD_IDS, ...under(WORD_IDS)];

await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` (or set APP_URL).`);

const t = checker();
if (SPAM_IDS.length !== 9 || REAL_IDS.length !== 11 || WORD_IDS.length !== 1 || GONE_IDS.length !== 3) {
  t.fail('the fixture bundle is the one this script was written against',
    `spam ${SPAM_IDS.length} (9), real ${REAL_IDS.length} (11), "${WORD}" ${WORD_IDS.length} (1), with replies under it ${GONE_IDS.length} (3)`);
  await exit(1);
}

const { page } = await launchChrome({ name: 'replyspam' });
const { send, js, until } = page;

// ── The read index answers with the fixture ─────────────────────────────────
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/nostr/index*', requestStage: 'Request' }] });
const bundleBody = Buffer.from(JSON.stringify(BUNDLE)).toString('base64');
page.on(async (m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  const path = new URL(request.url).searchParams.get('path');
  if (path === '/feed/global') {
    await send('Fetch.fulfillRequest', {
      requestId, responseCode: 200, body: bundleBody,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    });
  } else {
    await send('Fetch.continueRequest', { requestId });
  }
});

// ── Every EVENT frame, and where it went ────────────────────────────────────
const sockets = new Map();
const publicEvents = [];
await send('Network.enable');
page.on((m) => {
  if (m.method === 'Network.webSocketCreated') sockets.set(m.params.requestId, m.params.url);
  if (m.method === 'Network.webSocketFrameSent') {
    const url = sockets.get(m.params.requestId) ?? '?';
    const data = m.params.response?.payloadData ?? '';
    if (data.startsWith('["EVENT"') && !/^ws:\/\/127\.0\.0\.1[:/]/.test(url)) publicEvents.push(url);
  }
});

await send('Page.enable');
await send('Runtime.enable');

const sel = (id) => `article[data-note-id="${id}"]`;
const present = (ids) => js(`${JSON.stringify(ids)}.filter((id) => document.querySelector('article[data-note-id="' + id + '"]')).length`);
// A reply card outside every fold that links a spam host.
const openSpam = () => js(`[...document.querySelectorAll('article[data-note-id]')]
  .filter((a) => !a.closest('[data-spam-reply]') && ${SPAM_HOST}.test(a.textContent)).length`);
// The fold under the Reed thread (all eight of its fixture replies are spam).
const REED_ROOT = BUNDLE.notes.find((n) => BUNDLE.replies.filter((r) => r.tags.some((tg) => tg[1] === n.id)).every(isSpam)).id;
const reedFold = `document.querySelector('${sel(REED_ROOT)}')?.parentElement.querySelector(':scope > div > [data-spam-fold]')`;

async function loadHome(label) {
  await send('Page.navigate', { url: `${APP}/` });
  const roots = await until(`${JSON.stringify(ROOT_IDS)}.every((id) => document.querySelector('article[data-note-id="' + id + '"]'))`, 45000);
  t.ok(`${label}: the three fixture threads render`, roots);
  // The relay pass lands seconds after the index; give it time to add its
  // replies so the open-spam assertion covers what it brought too.
  await until(`!!${reedFold}`, 20000);
  await wait(15000);
}

// ── 1. Signed out ───────────────────────────────────────────────────────────
console.log('\n1. Signed out');
// A fresh Chrome profile: no `bmb:*` key, no signer, no mute list.
await loadHome('signed out');
t.equal('every fixture spam reply is folded (none rendered)', await present(SPAM_IDS), 0);
t.equal('every fixture real reply is open', await present(REAL_IDS), REAL_IDS.length);
t.equal('no reply linking a spam host is open, relays included', await openSpam(), 0);
const folds = await js(`[...document.querySelectorAll('[data-spam-fold]')].map((f) => Number(f.dataset.spamFold))`);
console.log(`     ${folds.length} fold(s) on the page, ${folds.reduce((a, b) => a + b, 0)} replies folded`);
const reedCount = await js(`Number(${reedFold}?.dataset.spamFold ?? 0)`);
t.ok('the Reed thread folds at least its 8 fixture spam replies', reedCount >= 8, `fold says ${reedCount}`);
t.ok('the fold says how many and offers SHOW',
  /^\d+ repl(y|ies) hidden as likely spam · show$/.test(await js(`${reedFold}?.querySelector('button')?.textContent ?? ''`)),
  await js(`${reedFold}?.querySelector('button')?.textContent ?? ''`));

// ── 2. SHOW and HIDE ────────────────────────────────────────────────────────
console.log('\n2. SHOW / HIDE');
await js(`${reedFold}.querySelector('button').click(); 1`);
await wait(500);
const shown = await js(`${reedFold}.querySelectorAll('[data-spam-reply]').length`);
t.equal('SHOW renders every folded reply in that thread', shown, reedCount);
t.equal('the button now says hide', await js(`${reedFold}.querySelector('button').textContent.endsWith('· hide')`), true);
t.equal('aria-expanded follows', await js(`${reedFold}.querySelector('button').getAttribute('aria-expanded')`), 'true');
await js(`${reedFold}.querySelector('button').click(); 1`);
await wait(500);
t.equal('HIDE folds them again', await js(`${reedFold}.querySelectorAll('[data-spam-reply]').length`), 0);

// ── 3. A phone ──────────────────────────────────────────────────────────────
console.log('\n3. Phone, 390 x 844, mobile: true');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true });
await loadHome('phone');
const layout = await js(`(() => {
  const d = document.documentElement;
  const b = ${reedFold}?.querySelector('button');
  b?.scrollIntoView({ block: 'center' });
  const r = b?.getBoundingClientRect();
  return { sw: d.scrollWidth, cw: d.clientWidth, w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height * 10) / 10 : 0, right: r ? Math.round(r.right) : 0 };
})()`);
t.ok('no horizontal overflow', layout.sw <= layout.cw, `scrollWidth ${layout.sw}, clientWidth ${layout.cw}`);
t.ok('the fold button is at least 24 x 24', layout.w >= 24 && layout.h >= 24, `${layout.w} x ${layout.h}`);
t.ok('the fold button fits the screen', layout.right <= layout.cw, `right edge ${layout.right}, width ${layout.cw}`);
await send('Emulation.clearDeviceMetricsOverride');
await send('Emulation.setTouchEmulationEnabled', { enabled: false });

// ── 4. Signed in, one muted word ────────────────────────────────────────────
console.log(`\n4. Signed in, muting the word "${WORD}"`);
const sk = generateSecretKey();
const pk = getPublicKey(sk);
const npub = nip19.npubEncode(pk);
const convo = nip44.v2.utils.getConversationKey(sk, pk);
const relay = createRelay({ port: 0, log: null });
const PORT = await relay.ready;
const muteList = finalizeEvent({
  kind: 10000, created_at: Math.floor(Date.now() / 1000) - 60, tags: [['word', WORD]], content: '',
}, sk);
relay.events.set(muteList.id, muteList);

await send('Network.setBlockedURLs', { urls: ['wss://*'] });
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
await js(`(() => { localStorage.clear();
  localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))});
  localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
  localStorage.setItem('bmb:signer', 'nip07');
  return 1; })()`);
await send('Page.navigate', { url: `${APP}/` });
const rootsIn = await until(`${JSON.stringify(ROOT_IDS)}.every((id) => document.querySelector('article[data-note-id="' + id + '"]'))`, 45000);
t.ok('signed in: the three fixture threads render', rootsIn);
const wordGone = await until(`!document.querySelector('${sel(WORD_IDS[0])}')`, 30000);
t.ok(`the reply holding "${WORD}" leaves the page`, wordGone);
t.equal('the 2 replies under it leave with it', await present(GONE_IDS), 0);
t.equal('every other fixture real reply is still open',
  await present(REAL_IDS.filter((id) => !GONE_IDS.includes(id))), REAL_IDS.length - GONE_IDS.length);
t.equal('every fixture spam reply is still folded', await present(SPAM_IDS), 0);
t.ok('the Reed thread still shows its fold', await js(`!!${reedFold}`));
t.equal('no EVENT frame went to a public relay', publicEvents, []);

relay.close?.();
console.log(`\n${t.count - t.fails}/${t.count} passed`);
await exit(t.fails ? 1 : 0);
