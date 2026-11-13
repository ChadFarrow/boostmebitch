// Drives a wallet relay that refuses one dial, in a real browser, with a stored NWC
// connection. The reported failure: on the Zapstore app "Cannot reach your wallet's
// relay" stayed on screen until the user pasted the same connection in again.
//
// WHY THIS IS AN E2E AND NOT ONLY A `check:*`. `check:nwcerror` pins that a failed
// dial is classified as a suspect socket and that the SDK client cannot recover from
// one. What it cannot see is the WIRING in `lib/v4v/nwc.ts`, which cannot load under
// plain Node: that the pool replaces the client, that the notification subscription
// moves with it, that nothing redials on a timer, and that a payment is still never
// retried.
//
// NOTHING HERE LEAVES THE MACHINE FOR MONEY OR FOR NOSTR. The wallet is a stub, the
// relay is `local-relay.mjs` behind a gate, and the NWC URI names only them. A
// signed-out boost shares a SITE-SIGNED PUBLIC NOTE by default, so this script seeds
// `bmb:share_nostr` off, blocks both signing routes, and fails if either was asked.
// Start the server with no site key as well:
//
//   SITE_NOSTR_SK= npm run build && SITE_NOSTR_SK= npm run start
//   npm run e2e:nwcrelay
//
// The playlist page is read from the real network, because it is the cheapest way to
// a row with a BOOST button. Its value block is stubbed on the wire.

import http from 'node:http';
import net from 'node:net';
import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { createRelay } from './local-relay.mjs';

const APP = process.env.E2E_APP ?? 'http://localhost:3000';
const PLAYLIST = 'https://raw.githubusercontent.com/ChadFarrow/chadf-musicl-playlists/refs/heads/main/docs/HGH-music-playlist.xml';
const NOTICE = 'Cannot reach your wallet';
const SATS = (n) => n.toLocaleString('en-US');

await requireApp(APP, `Nothing is serving ${APP}. Start it with \`SITE_NOSTR_SK= npm run build && SITE_NOSTR_SK= npm run start\`.`);
const t = checker();
const section = (s) => console.log(`\n${s}`);

// --- The relay, behind a gate that can refuse an upgrade -----------------------------
const relayKinds = [];
const relay = createRelay({
  port: 0,
  log: null,
  onReq: (filters) => { for (const f of filters) relayKinds.push(...(f.kinds ?? [])); },
});
const relayPort = await relay.ready;

// `dials` counts upgrade ATTEMPTS, refused or not, because the thing the relay's
// rate limit counts is a dial. A refusal is the `429` + `Retry-After: 600` a HAR
// measured from Cloudflare in front of relay.getalby.com.
const gate = { dials: 0, refuse: false, sockets: new Set() };
const gateServer = http.createServer();
gateServer.on('upgrade', (req, sock, head) => {
  gate.dials += 1;
  if (gate.refuse) {
    sock.end('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 600\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const up = net.connect(relayPort, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) up.write(head);
    up.pipe(sock);
    sock.pipe(up);
  });
  gate.sockets.add(sock);
  sock.on('error', () => {});
  up.on('error', () => sock.destroy());
  sock.on('close', () => { gate.sockets.delete(sock); up.destroy(); });
  up.on('close', () => sock.destroy());
});
await new Promise((r) => gateServer.listen(0, '127.0.0.1', r));
const gatePort = gateServer.address().port;
/** A phone waking: every open socket is gone, and the next dial is refused. */
const dropAndRefuse = () => {
  gate.refuse = true;
  for (const s of gate.sockets) s.destroy();
};

// --- A stub NIP-47 wallet, connected to the relay directly, not through the gate ------
const walletSk = generateSecretKey();
const walletPub = getPublicKey(walletSk);
const clientSk = generateSecretKey();
const clientPub = getPublicKey(clientSk);
const clientHex = Buffer.from(clientSk).toString('hex');
const conversation = nip44.getConversationKey(walletSk, clientPub);
const wallet = { sats: 12345, paid: 0, payRequests: [] };
const METHODS = ['get_info', 'get_balance', 'pay_keysend', 'pay_invoice', 'notifications'];

const walletWs = new WebSocket(`ws://127.0.0.1:${relayPort}`);
const signAndSend = (tmpl) => walletWs.send(JSON.stringify(['EVENT', finalizeEvent({ created_at: Math.floor(Date.now() / 1000), ...tmpl }, walletSk)]));
const answerFor = (method) => {
  if (method === 'get_info') return { methods: METHODS, notifications: ['payment_received', 'payment_sent'], alias: 'stub', pubkey: walletPub, network: 'mainnet', block_height: 1, block_hash: '00', color: '#000000' };
  if (method === 'get_balance') return { balance: wallet.sats * 1000 };
  if (method === 'pay_keysend' || method === 'pay_invoice') {
    wallet.paid += 1;
    wallet.payRequests.push(method);
    return { preimage: 'ab'.repeat(32) };
  }
  return null;
};
walletWs.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg[0] !== 'EVENT' || msg[1] !== 'wallet') return;
  const e = msg[2];
  const { method } = JSON.parse(nip44.decrypt(e.content, conversation));
  const result = answerFor(method);
  const body = result
    ? { result_type: method, result }
    : { result_type: method, result: null, error: { code: 'NOT_IMPLEMENTED', message: `${method} is not stubbed` } };
  signAndSend({ kind: 23195, tags: [['p', clientPub], ['e', e.id]], content: nip44.encrypt(JSON.stringify(body), conversation) });
};
await new Promise((resolve, reject) => { walletWs.onopen = resolve; walletWs.onerror = reject; });
walletWs.send(JSON.stringify(['REQ', 'wallet', { kinds: [23194], '#p': [walletPub] }]));
signAndSend({ kind: 13194, tags: [['encryption', 'nip44_v2'], ['notifications', 'payment_received payment_sent']], content: METHODS.join(' ') });
const pushNotification = () => signAndSend({
  kind: 23197,
  tags: [['p', clientPub]],
  content: nip44.encrypt(JSON.stringify({ notification_type: 'payment_received', notification: { type: 'incoming', amount: 1000 } }), conversation),
});

const URI = `nostr+walletconnect://${walletPub}?relay=ws://127.0.0.1:${gatePort}&secret=${clientHex}`;

// --- The browser ----------------------------------------------------------------------
const { page } = await launchChrome({ name: 'nwc-relay', autoplay: true, args: ['--disable-gpu'] });
const { send, js, on } = page;
const signingAsked = [];
await send('Fetch.enable', {
  patterns: [
    { urlPattern: '*/api/item-value*', requestStage: 'Request' },
    { urlPattern: '*/api/nostr/site-sign*', requestStage: 'Request' },
    { urlPattern: '*/api/nostr/zap-receipt-sign*', requestStage: 'Request' },
  ],
});
const VALUE = {
  read: true,
  value: {
    type: 'lightning',
    method: 'keysend',
    recipients: [{ name: 'E2E stub node', type: 'node', address: `02${'ab'.repeat(32)}`, split: 100 }],
  },
  valueTimeSplits: [],
};
on(async (m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  if (!request.url.includes('/api/item-value')) {
    signingAsked.push(request.url);
    await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    return;
  }
  await send('Fetch.fulfillRequest', {
    requestId,
    responseCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    body: Buffer.from(JSON.stringify(VALUE)).toString('base64'),
  });
});
await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { if (location.protocol === 'http:' && !localStorage.getItem('e2e-seeded')) {
    localStorage.setItem('e2e-seeded', '1');
    localStorage.setItem('bmb:nwc_uri', ${JSON.stringify(URI)});
    localStorage.setItem('bmb:share_nostr', '0');
  } } catch {}`,
});

const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await js(`(${fn})()`);
    if (v) return v;
    await wait(200);
  }
  return null;
};
const untilNode = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await wait(100);
  }
  return false;
};
const chip = () => js(`document.querySelector('span.text-bolt.tabular-nums')?.textContent ?? null`);
const chipReads = (n) => until(`() => document.querySelector('span.text-bolt.tabular-nums')?.textContent === ${JSON.stringify(SATS(n))}`);
const returnToApp = () => js(`window.dispatchEvent(new Event('focus'))`);
const dialog = (s) => `document.querySelector('[role="dialog"]')${s}`;
const pressDialogButton = (re) => js(`(() => {
  const b = [...(${dialog('')}?.querySelectorAll('button') ?? [])].find((x) => ${re}.test(x.innerText) && !x.disabled);
  if (!b) return false;
  b.click();
  return true;
})()`);
/** Wait for the loop's one dial to land on a dropped socket, so the client is dead. */
const dropAndWaitForRefusal = async () => {
  const before = gate.dials;
  dropAndRefuse();
  await untilNode(() => gate.dials > before, 8000);
  await wait(300);
};

section('1. A healthy connection: one socket for the read and the subscription');
await send('Page.navigate', { url: `${APP}/?playlist=${encodeURIComponent(PLAYLIST)}` });
t.ok('the chip shows the wallet balance', await chipReads(wallet.sats), `chip reads ${await chip()}`);
t.ok('the notification subscription reached the relay', await untilNode(() => relayKinds.includes(23197)));
t.equal('one dial so far', gate.dials, 1);
t.equal('the stored connection is the seeded one', await js(`localStorage.getItem('bmb:nwc_uri') === ${JSON.stringify(URI)}`), true);

section('2. The socket drops and one dial is refused: nothing redials on a timer');
{
  const before = gate.dials;
  await dropAndWaitForRefusal();
  t.equal('the SDK loop dialled once', gate.dials - before, 1);
  const settled = gate.dials;
  await wait(6000);
  t.equal('and six quiet seconds add no dial', gate.dials - settled, 0);
}

section('3. The relay is back: returning to the app recovers, with no re-paste');
{
  gate.refuse = false;
  const before = gate.dials;
  wallet.sats = 23456;
  await returnToApp();
  t.ok('the chip shows the live balance again', await chipReads(wallet.sats), `chip reads ${await chip()}, dials +${gate.dials - before}`);
  t.ok('a new dial reached the relay', gate.dials - before >= 1, `dials +${gate.dials - before}`);
  t.ok('in one dial, not one per reader', gate.dials - before <= 1, `dials +${gate.dials - before}`);
  t.equal('the stored connection never changed', await js(`localStorage.getItem('bmb:nwc_uri') === ${JSON.stringify(URI)}`), true);
}

section('4. The notification subscription came along to the new client');
{
  relayKinds.length = 0;
  await untilNode(() => relayKinds.includes(23197), 3000);
  await wait(500);
  wallet.sats = 34567;
  pushNotification();
  t.ok('a pushed payment_received refreshes the chip, with no focus event', await chipReads(wallet.sats), `chip reads ${await chip()}`);
}

section('5. A long outage: reads dial at a bounded rate, and only when something asks');
{
  await dropAndWaitForRefusal();
  const before = gate.dials;
  for (let i = 0; i < 4; i += 1) {
    await returnToApp();
    await wait(1600);
  }
  const spent = gate.dials - before;
  t.ok('four returns in 6.4 s dial at most twice', spent <= 2, `dials +${spent}`);
  const settled = gate.dials;
  await wait(6000);
  t.equal('and nothing dials once nothing asks', gate.dials - settled, 0);
}

section('6. The boost modal: the notice, Check again, and a payment never retried');
{
  // Past the swap's rate limit, so each press below can really dial.
  await wait(5200);
  await js(`document.querySelector('ul.divide-y > li button.btn-bolt')?.click()`);
  const opened = await until(`() => !!document.querySelector('[role="dialog"]')`, 20000);
  t.ok('the modal opens', opened);
  t.ok('it says the relay cannot be reached', await until(`() => document.querySelector('[role="dialog"]')?.innerText.includes(${JSON.stringify(NOTICE)})`, 15000));

  await js(`(() => {
    const i = document.querySelector('[role="dialog"] input[inputmode="numeric"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '100');
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await until(`() => [...document.querySelectorAll('[role="dialog"] button')].some((b) => /send 100 sat/i.test(b.innerText) && !b.disabled)`);

  t.equal('this boost shares no note', await js(`localStorage.getItem('bmb:share_nostr')`), '0');
  t.equal('nothing has been paid', wallet.paid, 0);
  t.ok('Send is live: the notice warns and never gates', await pressDialogButton(/send 100 sat/i));
  t.ok('the leg fails and offers a retry', await until(`() => [...document.querySelectorAll('[role="dialog"] button')].some((b) => /retry 1 failed/i.test(b.innerText) && !b.disabled)`, 20000));
  t.equal('no payment reached the wallet', wallet.paid, 0);

  await wait(5200);
  gate.refuse = false;
  const before = gate.dials;
  t.ok('Check again is on screen', await pressDialogButton(/check again/i));
  t.ok('and it clears the notice, with no re-paste', await until(`() => !document.querySelector('[role="dialog"]')?.innerText.includes(${JSON.stringify(NOTICE)})`, 10000), `dials +${gate.dials - before}`);
  t.ok('it reached the relay', gate.dials - before >= 1, `dials +${gate.dials - before}`);

  t.ok('Retry is on screen', await pressDialogButton(/retry 1 failed/i));
  t.ok('the retry pays', await untilNode(() => wallet.paid >= 1, 10000));
  await wait(3000);
  t.equal('exactly once', wallet.paid, 1);
  t.equal('by keysend', wallet.payRequests, ['pay_keysend']);
  t.equal('the failed attempt and the retry asked no signing route', signingAsked, []);
}

section('7. Disconnect and paste again: the old workaround still works');
{
  await js(`document.querySelector('[role="dialog"] button[aria-label^="Close"]')?.click()`);
  await until(`() => !document.querySelector('[role="dialog"]')`, 5000);
  await js(`document.querySelector('button[aria-label="Manage Lightning wallet"]')?.click()`);
  await until(`() => !!document.querySelector('[role="dialog"]')`, 5000);
  await until(`() => [...document.querySelectorAll('[role="dialog"] button')].some((b) => /disconnect/i.test(b.innerText))`, 8000);
  t.ok('Disconnect is on screen', await pressDialogButton(/disconnect/i));
  t.ok('it removes the stored connection', await until(`() => localStorage.getItem('bmb:nwc_uri') === null`, 5000));

  await until(`() => [...document.querySelectorAll('[role="dialog"] button')].some((b) => /nwc/i.test(b.innerText))`, 5000);
  await pressDialogButton(/nwc/i);
  await until(`() => !!document.querySelector('[role="dialog"] input')`, 8000);
  await js(`(() => {
    const i = document.querySelector('[role="dialog"] input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(URI)});
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  wallet.sats = 45678;
  t.ok('Connect is on screen', await pressDialogButton(/^connect$/i));
  t.ok('it stores the connection', await until(`() => localStorage.getItem('bmb:nwc_uri') === ${JSON.stringify(URI)}`, 25000));
  t.ok('the chip reads the wallet through the new client', await chipReads(wallet.sats), `chip reads ${await chip()}`);
  await wait(1500);
  wallet.sats = 56789;
  pushNotification();
  t.ok('and a pushed payment still reaches it', await chipReads(wallet.sats), `chip reads ${await chip()}`);
}

console.log(`\n${t.fails ? `${t.fails} of ${t.count} checks FAILED.` : `All ${t.count} checks passed.`}`);
try { walletWs.close(); gateServer.close(); relay.close(); } catch { /* already gone */ }
await exit(t.fails ? 1 : 0);
