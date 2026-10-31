// End-to-end for the OPML import and export on /favorites.
//
// Usage:
//   npm run dev                                   # in another terminal
//   npm run e2e:opml                              # headless
//   APP_URL=http://127.0.0.1:3017 npm run e2e:opml -- --headed --keep
//
// WHAT IT PINS THAT `check:opml` CANNOT SEE — the wiring between the pure rules
// and the page:
//
//   1. A PRIVATE FEED ADDRESS NEVER LEAVES THE PAGE. Every request the page
//      makes is recorded over CDP's Network domain, and none may carry the
//      Patreon key the fixture lists. `check:opml` proves `planOpmlImport`
//      keeps it back; only this proves nothing else sends it.
//   2. Signed out, phone width: the import adds through the store into
//      `bmb:favorites:guest`, the result panel SURVIVES the empty card
//      unmounting under it, and two addresses for one show add one favorite.
//   3. The export downloads a file holding each imported show's feed address.
//   4. A second import of the same file adds nothing.
//   5. No horizontal overflow at 390px, and every new control is 24×24 or more.
//   6. Signed in, mode never chosen: ADD asks where favorites go and publishes
//      NOTHING before the answer; after "Public" the relay holds a kind:10333
//      with both shows' `i` tags and an empty `content`.
//
// The relay is the in-memory one `npm run relay` starts and the signer is a
// throwaway key reached over a CDP binding — the `e2e:favorites` shape — so no
// account is involved and nothing reaches a public relay. The LOOKUPS are real:
// they go to this app's `/api/by-guid/batch` and from there to Podcast Index,
// which is why the fixture names real public feeds.

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44, nip04 } from 'nostr-tools';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);

// ---- the fixture ----------------------------------------------------------
const PC20_GUID = '917393e3-1b1e-5cef-ace4-edaa54e1f810';
const NA_GUID = '856cd618-7f34-57ea-9b84-3600f1f65e7f';
const SECRET = 'E2ESECRETTOKEN0123';
const work = mkdtempSync(join(tmpdir(), 'bmb-e2e-opml-'));
const downloads = join(work, 'downloads');
const OPML = join(work, 'subscriptions.opml');
writeFileSync(OPML, `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>e2e subscriptions</title></head>
  <body>
    <outline text="feeds">
      <outline type="rss" text="Podcasting 2.0" xmlUrl="https://feeds.podcastindex.org/pc20.xml"/>
      <outline type="rss" text="No Agenda Show" xmlUrl="http://feed.nashownotes.com/rss.xml"/>
      <outline type="rss" text="No Agenda, canonical address" xmlUrl="https://feeds.noagendaassets.com/noagenda.xml"/>
      <outline type="rss" text="A feed nobody indexed" xmlUrl="https://feeds.example.invalid/bmb-e2e-none.xml"/>
      <outline type="rss" text="Members Only" xmlUrl="https://www.patreon.com/rss/bmb-e2e?auth=${SECRET}"/>
      <outline type="rss" text="Podcasting 2.0, again" xmlUrl="https://feeds.podcastindex.org/pc20.xml"/>
      <outline type="rss" text="Not a feed" xmlUrl="javascript:alert(1)"/>
    </outline>
  </body>
</opml>
`);

// ---- relay + signer -------------------------------------------------------
const published = [];
const relay = createRelay({ port: 0, log: null, onEvent: (e) => { if (e.kind === 10333) published.push(e); } });
const PORT = await relay.ready;

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const npub = nip19.npubEncode(pk);
const convo = nip44.v2.utils.getConversationKey(sk, pk);

const { page } = await launchChrome({ name: 'opml', args: ['--disable-gpu'] });
const { send, js, until } = page;
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('DOM.enable');
await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

const requests = [];
const pageErrors = [];
page.on((m) => {
  if (m.method === 'Network.requestWillBeSent') {
    requests.push(`${m.params.request.url} ${m.params.request.postData ?? ''}`);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300));
  }
});
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
// Installed for every navigation, used only by the signed-in half: with no
// `bmb:npub` the app never asks it anything.
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

const t = checker();
const text = () => js('document.body.innerText');
const panel = () => js(`(() => { const p=[...document.querySelectorAll('.card')].find(c=>c.innerText.toLowerCase().includes('import from')); return p ? p.innerText : null; })()`);
const clickButton = (label) => js(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().toLowerCase()===${JSON.stringify(label)}); if (b && !b.disabled) { b.click(); return true; } return false; })()`);

/**
 * Hand the file to the OPML input, as a picker would. NOT "the first file
 * input": signed in, `⇧ RESTORE FROM BACKUP` has one earlier in the page, and
 * the first run of this script fed the OPML to the restore control.
 */
async function pickFile() {
  // `send` answers with the whole CDP message; the value is under `result`.
  const { root } = (await send('DOM.getDocument', { depth: -1 })).result;
  const { nodeId } = (await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[data-opml-input]' })).result;
  if (!nodeId) throw new Error('no file input on the page');
  await send('DOM.setFileInputFiles', { nodeId, files: [OPML] });
}

async function fresh(seed) {
  await send('Page.navigate', { url: `${APP}/favorites` });
  await until('document.readyState === "complete"');
  await js(`(() => { localStorage.clear(); ${seed ?? ''} return 1; })()`);
  await send('Page.navigate', { url: `${APP}/favorites` });
  await until('document.readyState === "complete"');
}

/** No horizontal overflow, and the size of every new control. */
async function measure(where) {
  const r = JSON.parse(await js(`(() => {
    const el = document.documentElement;
    const panelEl = [...document.querySelectorAll('.card')].find(c => c.innerText.toLowerCase().includes('import from'));
    const row = [...document.querySelectorAll('p')].find(p => p.textContent.trim() === 'other podcast apps')?.parentElement;
    const empty = [...document.querySelectorAll('.card')].find(c => c.innerText.includes('Coming from another podcast app?'));
    const targets = [panelEl, row, empty].filter(Boolean)
      .flatMap(c => [...c.querySelectorAll('button, summary')])
      .map(b => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) }; })
      .filter(x => x.w > 0);
    return JSON.stringify({ scroll: el.scrollWidth, client: el.clientWidth, small: targets.filter(x => x.w < 24 || x.h < 24), n: targets.length });
  })()`));
  t.ok(`${where}: no horizontal overflow (${r.scroll} ≤ ${r.client})`, r.scroll <= r.client);
  t.ok(`${where}: all ${r.n} new controls are 24×24 or more`, r.small.length === 0, JSON.stringify(r.small));
}

// ===========================================================================
console.log('\n1–5. Signed out, at phone width');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await fresh();
t.ok('the empty card offers the import', await until(`document.body.innerText.includes('Coming from another podcast app?')`));
await measure('empty card');
await pickFile();
t.ok('the lookup finishes and the panel offers the add', await until(`(() => { const p=[...document.querySelectorAll('.card')].find(c=>c.innerText.toLowerCase().includes('import from')); return p && p.innerText.includes('ready to add'); })()`, 60000));
let p = (await panel()) ?? '';
t.ok('two shows are ready to add', p.includes('2 shows are ready to add'), p);
t.ok('the second address for No Agenda is "already", not a second favorite', p.includes('1 show is in your favorites already'), p);
t.ok('the unindexed feed is listed as not in Podcast Index', p.includes('Not in Podcast Index — 1'), p);
t.ok('the Patreon feed is listed as private, not looked up', p.includes('Look like private feeds — not looked up — 1'), p);
t.ok('the javascript: address is not a web address', p.includes('Not a web address — 1'), p);
t.ok('the repeated address is counted', p.includes('1 address is in the file twice'), p);
t.ok('the private key is nowhere in the page', !(await js('document.documentElement.outerHTML')).includes(SECRET));
await measure('review panel');

await clickButton('add 2 shows');
t.ok('the guest store holds both shows', await until(`(() => { const f=JSON.parse(localStorage.getItem('bmb:favorites:guest')||'{}'); return !!f[${JSON.stringify(PC20_GUID)}] && !!f[${JSON.stringify(NA_GUID)}]; })()`, 5000));
t.equal('and nothing else', await js(`Object.keys(JSON.parse(localStorage.getItem('bmb:favorites:guest')||'{}')).sort()`), [PC20_GUID, NA_GUID].sort());
p = (await panel()) ?? '';
t.ok('the panel survived the empty card unmounting, and says where they went', p.includes('Added 2 shows') && p.includes('saved on this device'), p);
t.ok('the "not added" list is still on screen', p.includes('Not in Podcast Index — 1'), p);
// Lowercased: the count is CSS `uppercase`, and `innerText` applies it.
t.ok('the library renders them', await until(`document.body.innerText.toLowerCase().includes('2 saved')`, 8000));
await measure('library with the panel open');

await clickButton('⇩ export opml');
let file = null;
for (let i = 0; i < 40 && !file; i++) {
  await wait(250);
  try { file = readdirSync(downloads).find((f) => f.endsWith('.opml')) ?? null; } catch { /* not created yet */ }
}
t.ok('the export downloads a .opml file', !!file, readdirSync(work).join(', '));
if (file) {
  const xml = readFileSync(join(downloads, file), 'utf8');
  t.ok(`its name is <site>-shows-<date>.opml (${file})`, /^boostme(bitch|buddy)-shows-\d{4}-\d{2}-\d{2}\.opml$/.test(file));
  t.ok('it lists Podcasting 2.0', xml.includes('xmlUrl="https://feeds.podcastindex.org/pc20.xml"'), xml);
  t.ok("it lists No Agenda by Podcast Index's address for it", xml.includes('xmlUrl="https://feeds.noagendaassets.com/noagenda.xml"'), xml);
  t.equal('and exactly two shows', (xml.match(/<outline /g) ?? []).length, 2);
}
t.ok('the page names the file it saved', (await text()).includes('Saved 2 shows to boostme'));

await clickButton('done');
await pickFile();
t.ok('a second import of the same file finds nothing new', await until(`(() => { const p=[...document.querySelectorAll('.card')].find(c=>c.innerText.toLowerCase().includes('import from')); return p && p.innerText.includes('There is no new show to add.'); })()`, 30000));
p = (await panel()) ?? '';
t.ok('all three addresses read as already a favorite', p.includes('3 shows are in your favorites already'), p);
t.ok('and no add button is offered', !(await js(`[...document.querySelectorAll('button')].some(b => b.textContent.trim().toLowerCase().startsWith('add '))`)));
await clickButton('done');

// ===========================================================================
// A FRESH ACCOUNT IS PUBLIC BEFORE IT PRESSES ANYTHING. `seedFavoritesMode`
// seeds an EMPTY relay list as public (PC20-Nostr#47), so the never-chosen
// prompt does not appear and ADD publishes — exactly what a ♡ does. The first
// version of this script expected the prompt and was wrong; what the import
// owes the user instead is the sentence BEFORE the button, asserted below.
console.log('\n6. Signed in, an empty relay list (seeded Public), against a local relay');
await send('Emulation.clearDeviceMetricsOverride');
const signIn = (extra = '') => `
  localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))});
  localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
  localStorage.setItem('bmb:signer', 'nip07');
  ${extra}
`;
await fresh(signIn());
// BOTH conditions. The empty card alone is also what the page shows for the
// moment before the signer restores — signed out, nothing to read — so it
// passes before the relay read has even started. The privacy menu renders
// only with an identity.
t.ok('the empty card shows once signed in and the relay read answers', await until(`
  !!document.querySelector('button[aria-haspopup="menu"][aria-label^="Favorites are"]')
  && document.body.innerText.includes('Coming from another podcast app?')`, 30000));
await pickFile();
const addReady = `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().toLowerCase()==='add 2 shows'); return !!b && !b.disabled; })()`;
t.ok('the lookup finishes', await until(addReady, 60000), `panel: ${JSON.stringify(await panel())}`);
p = (await panel()) ?? '';
t.ok('BEFORE the add, the panel says the shows go onto a PUBLIC list', p.includes('public favorites list on Nostr'), p);
t.equal('nothing is published by the lookup', published.length, 0);
await clickButton('add 2 shows');
for (let i = 0; i < 60 && !published.length; i++) await wait(250);
t.ok('the relay receives a kind:10333', published.length > 0);
const last = published.at(-1);
if (last) {
  const ids = last.tags.filter((x) => x[0] === 'i').map((x) => x[1]);
  t.ok('it carries Podcasting 2.0', ids.includes(`podcast:guid:${PC20_GUID}`), JSON.stringify(last.tags));
  t.ok('it carries No Agenda', ids.includes(`podcast:guid:${NA_GUID}`), JSON.stringify(last.tags));
  t.equal('and its content is empty — a public list', last.content, '');
}
await wait(3000);
t.equal('ONE publish for the whole import — one signing prompt, not one per show', published.length, 1);

// ===========================================================================
console.log('\n7. Signed in, "Not on Nostr": the import stays on this device');
const before = published.length;
// A second key's worth of state is not needed: the same account, with its mode
// set to 'off' and its local favorites cleared, is the case.
await fresh(signIn(`localStorage.setItem('bmb:fav_privacy:' + ${JSON.stringify(npub)}, 'off');`));
t.ok('the empty card shows', await until(`document.body.innerText.includes('Coming from another podcast app?')`, 30000));
await pickFile();
t.ok('the lookup finishes', await until(addReady, 60000), `panel: ${JSON.stringify(await panel())}`);
p = (await panel()) ?? '';
t.ok('before the add, the panel says they stay on this device', p.includes('saved on this device only'), p);
await clickButton('add 2 shows');
t.ok('the account store holds both shows', await until(`(() => { const f=JSON.parse(localStorage.getItem('bmb:favorites:' + ${JSON.stringify(npub)})||'{}'); return !!f[${JSON.stringify(PC20_GUID)}] && !!f[${JSON.stringify(NA_GUID)}]; })()`, 5000));
await wait(3000);
t.equal('and nothing is published', published.length, before);

// ===========================================================================
console.log('\nAcross both halves');
const leaked = requests.filter((r) => r.includes(SECRET) || r.toLowerCase().includes('patreon.com'));
t.ok(`no request of ${requests.length} carried the private feed address`, leaked.length === 0, leaked.join('\n'));
t.ok('the lookups went to the POST batch route', requests.some((r) => r.includes('/api/by-guid/batch') && r.includes('url:https://feeds.podcastindex.org/pc20.xml')));
t.ok('no uncaught page error', pageErrors.length === 0, pageErrors.join('\n'));

console.log(`\n${t.count - t.fails} of ${t.count} passed`);
relay.close();
await exit(t.fails ? 1 : 0);
