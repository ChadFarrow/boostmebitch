// Drives a RAIL SWITCH under the header's balance chip, in a real browser, and
// asserts that one rail's balance is never shown or stored under another.
//
// THE BUG (full-code review 2026-11-19). `useWalletBalance` kept the balance as a
// bare number. In the render where the rail moved — the wallet modal's switch, or
// a new wallet disconnecting the old one — the number was still the OLD rail's:
// the reset runs in an effect, after that render. So the chip painted NWC's sats
// labelled WebLN for a frame, and the cache effect wrote them to
// `bmb:wallet_balance:<npub>` UNDER WebLN in the same commit — AFTER
// `clearOtherWallets` had cleared that key, so its clear did not hold.
//
// Measured on main: section 2 fails both of its checks — the cache reads
// `{"rail":"webln","balance":777777}` and the page showed "777,777 sats (WebLN)".
// On THIS path the entry is mostly harmless afterwards, because the next WebLN
// connect runs `clearOtherWallets` again. The harm that lasts is on a switch
// between two rails that are BOTH connected (the picker's tap on a connected rail,
// the boost modal's rail picker), which clears nothing: there a new rail whose read
// never lands — an NWC relay that does not answer — leaves the old rail's number
// on disk under its name, and the next load paints it there. That path needs a
// second rail beside NWC (Spark), which no stand-in here can provide.
//
// WHAT IT PINS:
//   1. With NWC connected the chip shows NWC's 777,777 and caches it under NWC.
//   2. Switching to WebLN (which disconnects NWC) never shows a number labelled
//      WebLN, and never writes 777,777 under WebLN.
//
// NOTHING LEAVES THE MACHINE. The NWC wallet is a stub on a local relay, WebLN is
// a stand-in whose every payment method rejects, nobody is signed in, nothing is
// paid or published, and Chrome resolves no host but the app's and loopback.
//
//   npm run build && npm run start          (or any server on BMB_APP)
//   BMB_APP=http://localhost:3000 npm run e2e:walletrail
//   MOBILE=1 ... runs it under phone emulation (390×844, mobile: true).

import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { createRelay } from './local-relay.mjs';

const APP = process.env.BMB_APP ?? process.env.E2E_APP ?? 'http://localhost:3000';
const MOBILE = process.env.MOBILE === '1';
const SATS = 777_777;
const SHOWN = SATS.toLocaleString('en-US');
const CACHE_KEY = 'bmb:wallet_balance:guest';

await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run build && npm run start\`.`);
const t = checker();
const section = (s) => console.log(`\n${s}`);

// --- A stub NIP-47 wallet on a local relay ------------------------------------------
const relay = createRelay({ port: 0, log: null });
const relayPort = await relay.ready;
const walletSk = generateSecretKey();
const walletPub = getPublicKey(walletSk);
const clientSk = generateSecretKey();
const clientPub = getPublicKey(clientSk);
const conversation = nip44.getConversationKey(walletSk, clientPub);
const METHODS = ['get_info', 'get_balance', 'pay_keysend', 'pay_invoice', 'notifications'];
const walletWs = new WebSocket(`ws://127.0.0.1:${relayPort}`);
const signAndSend = (tmpl) => walletWs.send(JSON.stringify(['EVENT', finalizeEvent({ created_at: Math.floor(Date.now() / 1000), ...tmpl }, walletSk)]));
const paid = [];
walletWs.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg[0] !== 'EVENT' || msg[1] !== 'wallet') return;
  const e = msg[2];
  const { method } = JSON.parse(nip44.decrypt(e.content, conversation));
  let body;
  if (method === 'get_info') {
    body = { result_type: method, result: { methods: METHODS, notifications: ['payment_received', 'payment_sent'], alias: 'stub', pubkey: walletPub, network: 'mainnet', block_height: 1, block_hash: '00', color: '#000000' } };
  } else if (method === 'get_balance') {
    body = { result_type: method, result: { balance: SATS * 1000 } };
  } else {
    // A payment request is a failure of this script: nothing here pays. Any other
    // method (get_budget, a read) is merely not stubbed.
    if (method.startsWith('pay_')) paid.push(method);
    body = { result_type: method, result: null, error: { code: 'NOT_IMPLEMENTED', message: 'e2e: this wallet pays nothing' } };
  }
  signAndSend({ kind: 23195, tags: [['p', clientPub], ['e', e.id]], content: nip44.encrypt(JSON.stringify(body), conversation) });
};
await new Promise((resolve, reject) => { walletWs.onopen = resolve; walletWs.onerror = reject; });
walletWs.send(JSON.stringify(['REQ', 'wallet', { kinds: [23194], '#p': [walletPub] }]));
signAndSend({ kind: 13194, tags: [['encryption', 'nip44_v2'], ['notifications', 'payment_received payment_sent']], content: METHODS.join(' ') });
const URI = `nostr+walletconnect://${walletPub}?relay=ws://127.0.0.1:${relayPort}&secret=${Buffer.from(clientSk).toString('hex')}`;

// --- The browser --------------------------------------------------------------------
const { page } = await launchChrome({
  name: 'wallet-balance-rail',
  args: ['--disable-gpu', `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE ${new URL(APP).hostname}`],
});
const { send, js, until } = page;
await send('Page.enable');
await send('Runtime.enable');
if (MOBILE) {
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
}

// A WebLN stand-in with NO getBalance, and a record of every number the page ever
// labels WebLN. The chip and the player's box both put "(<rail>)" in their title,
// so any element whose title names WebLN and whose text holds a digit is a WebLN
// balance on screen. This provider has none, so every such entry is a wrong one.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.webln = {
    enable: async () => {},
    isEnabled: async () => true,
    getInfo: async () => ({ node: { alias: 'e2e' }, methods: ['getInfo'] }),
    keysend: async () => { throw new Error('e2e: this wallet pays nothing'); },
    sendPayment: async () => { throw new Error('e2e: this wallet pays nothing'); },
    makeInvoice: async () => { throw new Error('e2e: this wallet pays nothing'); },
  };
  window.__weblnShown = [];
  const look = () => {
    for (const el of document.querySelectorAll('[title*="(WebLN)"]')) {
      if (/\\d/.test(el.textContent ?? '')) window.__weblnShown.push({ text: el.textContent, title: el.getAttribute('title') });
    }
  };
  new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title'] });
` });

const navigate = async (url) => {
  await send('Page.navigate', { url });
  await until(`document.readyState === 'complete'`, 30000);
};
const cached = () => js(`(() => { try { return JSON.parse(localStorage.getItem(${JSON.stringify(CACHE_KEY)})); } catch { return null; } })()`);
const weblnShown = () => js('window.__weblnShown');
const dialogs = () => js(`document.querySelectorAll('[role="dialog"]').length`);
const TOP = `[...document.querySelectorAll('[role="dialog"]')].at(-1)`;
const clickButton = (re) => js(`(() => {
  const b = [...(${TOP}?.querySelectorAll('button') ?? [])].find((x) => ${re}.test(x.textContent ?? ''));
  if (!b) return false; b.click(); return true;
})()`);
/** The header's ⚡ while a wallet is connected; signed out with none, the wallet
 *  is "Connect wallet" in the Sign in menu (components/auth-control.tsx). */
async function openWallet() {
  const direct = await js(`(() => { const b = document.querySelector('button[aria-label="Manage Lightning wallet"]'); if (!b) return false; b.click(); return true; })()`);
  if (!direct) {
    await js(`[...document.querySelectorAll('button[aria-haspopup="menu"]')].find((b) => /sign in/i.test(b.textContent ?? ''))?.click()`);
    await until(`[...document.querySelectorAll('[role="menuitem"]')].some((b) => /connect wallet/i.test(b.textContent ?? ''))`, 5000);
    await js(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => /connect wallet/i.test(b.textContent ?? ''))?.click()`);
  }
  return until(`${TOP} !== undefined`, 10000);
}

// ------------------------------------------------------------------------------------
section(`1. NWC connected: the chip shows its ${SHOWN} and caches it under NWC${MOBILE ? ' (phone emulation)' : ''}`);
await navigate(`${APP}/`);
await js(`localStorage.clear(); localStorage.setItem('bmb:nwc_uri', ${JSON.stringify(URI)}); 1`);
await navigate(`${APP}/`);
t.ok('the chip shows the NWC balance, labelled NWC',
  await until(`!!document.querySelector('[title="${SHOWN} sats (NWC)"]')`, 30000),
  await js(`[...document.querySelectorAll('[title*="sats ("]')].map((e) => e.title).join(' | ')`));
t.ok('the cache holds it under NWC', await until(`(() => { try { const c = JSON.parse(localStorage.getItem(${JSON.stringify(CACHE_KEY)})); return c?.rail === 'nwc' && c?.balance === ${SATS}; } catch { return false; } })()`, 10000),
  JSON.stringify(await cached()));

// ------------------------------------------------------------------------------------
section('2. Switch to WebLN (it disconnects NWC): no NWC number under WebLN');
t.ok('the wallet modal opened', await openWallet());
t.ok('"Switch wallet" is offered', await until(`[...(${TOP}?.querySelectorAll('button') ?? [])].some((b) => /switch wallet/i.test(b.textContent ?? ''))`, 10000));
await clickButton('/switch wallet/i');
t.ok('the picker lists WebLN', await until(`[...(${TOP}?.querySelectorAll('button') ?? [])].some((b) => /webln/i.test(b.textContent ?? ''))`, 10000));
await clickButton('/webln/i');
t.ok('connecting WebLN closed the modal', await until(`document.querySelectorAll('[role="dialog"]').length === 0`, 10000), `dialogs: ${await dialogs()}`);
t.ok('...and NWC is disconnected', await until(`!localStorage.getItem('bmb:nwc_uri')`, 5000));
await wait(3000);
const afterSwitch = await cached();
t.ok(`the cache never names WebLN with NWC's ${SHOWN}`, !(afterSwitch?.rail === 'webln' && afterSwitch?.balance === SATS), JSON.stringify(afterSwitch));
t.equal('no number was ever shown labelled WebLN', await weblnShown(), []);
t.ok('the chip shows nothing for WebLN, which has no balance', !(await js(`!!document.querySelector('[title*="(WebLN)"]')`)));

t.equal('no payment was asked of the NWC wallet', paid, []);

walletWs.close();
await relay.close();
console.log(`\n${t.count} checks, ${t.fails} failed`);
if (t.fails === 0) console.log('all end-to-end checks passed — nothing left this machine');
await exit(t.fails ? 1 : 0);
