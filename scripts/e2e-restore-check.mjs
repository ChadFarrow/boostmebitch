// e2e:restorecheck — the restore CHECK, driven in a real browser.
//
// `check:favbackup` pins `checkRestore` and `restoreTags` as pure functions.
// What it cannot see is the wiring this script exercises: the Podcast Index
// answers reaching the check through the app's own `/api/by-guid/batch`, the
// boxes changing what RESTORE publishes, and nothing at all publishing before
// the press — on a desktop viewport and under phone emulation.
//
// THE FILE IS SHAPED LIKE THE ONE THAT PROMPTED THIS (2026-11-18): songs with no
// `medium` tag, and an album filed under `podcast`. It was signed by its owner's
// key, so `parseFavoritesBackup` accepted it, and the library lost its singles
// and its SHUFFLE with nothing on screen to say why. This file adds a duplicate,
// a feed id the format cannot read, and a feed Podcast Index does not hold.
//
// PRIVATE BY CONSTRUCTION. A throwaway key, the in-memory relay from
// `npm run relay`, and `bmb:relays` pointing every favorites read and publish
// at it. On top of that the browser cannot resolve ANY host but this machine
// (`--host-resolver-rules`), so a code path that ignored `bmb:relays` would fail
// to connect rather than post to a public relay. Podcast Index is asked only by
// the dev server, server-side, read-only. No wallet, no boost.
//
// Needs a dev server: `npm run dev`, then `npm run e2e:restorecheck`
// (`BMB_APP=http://localhost:3077` for another port).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.BMB_APP ?? 'http://localhost:3000';
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);

const t = checker();
const sg = (g) => `podcast:guid:${g}`;
const ig = (g) => `podcast:item:guid:${g}`;
const ALT = ['alt', 'PC 2.0 Favorites'];
const KS = [['k', 'podcast:guid'], ['k', 'podcast:item:guid']];

// ---- real feeds, chosen at run time ---------------------------------------
// Three music albums from the DeMu list, confirmed `music` through the same
// batch route the check uses, and Podcasting 2.0 as a show. A random UUID is
// the feed Podcast Index does not hold.
const demu = await (await fetch(`${APP}/api/demu`)).json();
const candidates = (demu.albums ?? []).filter((a) => a.podcastGuid && a.medium === 'music').slice(0, 8);
const PC20 = '917393e3-1b1e-5cef-ace4-edaa54e1f810';
const facts = (await (await fetch(
  `${APP}/api/by-guid/batch?guids=${[...candidates.map((a) => a.podcastGuid), PC20].join(',')}`,
)).json()).podcasts ?? {};
const albums = candidates.filter((a) => facts[a.podcastGuid]?.medium === 'music').map((a) => a.podcastGuid);
if (albums.length < 3 || !facts[PC20]?.medium) {
  console.error('Podcast Index did not confirm three music albums and a show; cannot build the fixture.');
  process.exit(2);
}
const [A1, A2, A3] = albums;
const UNKNOWN = crypto.randomUUID();
console.log(`  albums ${A1.slice(0, 8)} ${A2.slice(0, 8)} ${A3.slice(0, 8)}, show PC20 (${facts[PC20].medium})\n`);

// ---- keys, files, relay ---------------------------------------------------
const sk = generateSecretKey();
const pk = getPublicKey(sk);
const npub = nip19.npubEncode(pk);
const now = Math.floor(Date.now() / 1000);

// What the relays hold now: five favorites, only one of which is in the file.
const CURRENT = finalizeEvent({
  kind: 10333, created_at: now - 3600, content: '',
  tags: [ALT, ['medium', 'music'], ['i', sg(A3)], ['i', sg(A3), ig('cur-1')], ['i', sg(A3), ig('cur-2')],
    ['i', sg(A2), ig('cur-3')], ['medium', 'podcast'], ['i', sg(PC20)], ...KS],
}, sk);

const BAD_TAGS = [ALT,
  ['i', sg(A1), ig('song-1')], ['i', sg(A1), ig('song-2')], ['i', sg(A2), ig('song-3')],
  ['i', sg(A2), ig('song-3')],
  ['i', 'podcast:guid:not-a-uuid'],
  ['medium', 'podcast'], ['i', sg(A1)], ['i', sg(PC20)], ['i', sg(UNKNOWN)],
  ...KS];
const BAD = finalizeEvent({ kind: 10333, created_at: now - 7200, content: '', tags: BAD_TAGS }, sk);
const STRANGER = finalizeEvent({ kind: 10333, created_at: now - 7200, content: '', tags: BAD_TAGS }, generateSecretKey());

const dir = mkdtempSync(join(tmpdir(), 'bmb-restore-check-'));
const file = (name, ev) => { const p = join(dir, name); writeFileSync(p, `${JSON.stringify(ev, null, 2)}\n`); return p; };
const BAD_FILE = file('bad.json', BAD);
const STRANGER_FILE = file('stranger.json', STRANGER);

const published = [];
const relay = createRelay({ port: 0, log: null, onEvent: (e) => { if (e.kind === 10333) published.push(e); } });
const PORT = await relay.ready;
const seed = (ev) => {
  // Through the socket, as any client would, so replacement is the relay's own.
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', ev]));
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d[0] !== 'OK') return;
      ws.close();
      if (d[2]) resolve();
      else reject(new Error(d[3]));
    };
    ws.onerror = reject;
  });
};
await seed(CURRENT);
const seeded = published.length;

// ---- browser --------------------------------------------------------------
const { page } = await launchChrome({
  name: `restore-check-${process.env.CLAUDE_CODE_SESSION_ID ?? 'run'}`,
  args: ['--disable-gpu', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
});
const { send, until } = page;
const js = page.jsOrThrow;
await send('Page.enable');
await send('Runtime.enable');
await send('DOM.enable');

await send('Runtime.addBinding', { name: 'bmbSigner' });
page.on(async (m) => {
  if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'bmbSigner') return;
  const { rid, fn, args } = JSON.parse(m.params.payload);
  let out; let err = null;
  if (fn === 'getPublicKey') out = pk;
  else if (fn === 'signEvent') out = finalizeEvent(args[0], sk);
  else err = `no such method ${fn}`;
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
    window.nostr = { getPublicKey: () => call('getPublicKey'), signEvent: (e) => call('signEvent', e) };
  })();
` });

async function signIn() {
  await send('Page.navigate', { url: `${APP}/favorites` });
  await wait(500);
  await js(`(() => {
    localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))});
    localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
    localStorage.setItem('bmb:signer', 'nip07');
    localStorage.setItem('bmb:fav_privacy:' + ${JSON.stringify(npub)}, 'public');
  })()`);
  await send('Page.navigate', { url: `${APP}/favorites` });
  await until(`!!document.querySelector('[data-restore-input]')`, 30000);
}

async function choose(path) {
  const { root } = (await send('DOM.getDocument', { depth: -1 })).result;
  const { nodeId } = (await send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-restore-input]' })).result;
  await send('DOM.setFileInputFiles', { nodeId, files: [path] });
}

// `textContent`, never `innerText`: the buttons are uppercased by CSS, and
// innerText reports what is painted.
const panelText = () => js(`(document.querySelector('[data-restore-panel]')?.textContent ?? '').replace(/\\s+/g, ' ')`);
const applyLabel = () => js(`(document.querySelector('[data-restore-apply]')?.textContent ?? '').trim()`);
const checked = (attr) => js(`document.querySelector('[${attr}] input')?.checked ?? null`);
const runningMedium = (tags) => {
  const out = new Map(); let m;
  for (const tag of tags) {
    if (tag[0] === 'medium') m = tag[1];
    if (tag[0] === 'i') out.set(JSON.stringify(tag), m);
  }
  return out;
};

async function measure(label) {
  const r = await js(`(() => {
    const d = document.documentElement;
    const panel = document.querySelector('[data-restore-panel]');
    const small = [];
    for (const el of panel.querySelectorAll('label, button')) {
      if (el.classList.contains('btn-inline')) continue; // inside a sentence: exempt
      const b = el.getBoundingClientRect();
      if (b.width < 24 || b.height < 24) small.push(el.innerText.slice(0, 30) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height));
    }
    const p = panel.getBoundingClientRect();
    return { overflow: d.scrollWidth - d.clientWidth, small, panelRight: Math.round(p.right), vw: d.clientWidth };
  })()`);
  t.equal(`${label}: no horizontal overflow`, r.overflow, 0);
  t.equal(`${label}: every control in the panel is at least 24x24`, r.small, []);
  t.ok(`${label}: the panel fits the viewport`, r.panelRight <= r.vw, JSON.stringify(r));
}

async function shot(name) {
  const { data } = (await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).result;
  const p = join(process.env.SHOT_DIR ?? dir, `${name}.png`);
  writeFileSync(p, Buffer.from(data, 'base64'));
  console.log(`  screenshot ${p}`);
}

try {
  // ---- 1. desktop: the check, the boxes, and the repaired publish ----------
  console.log('  1. desktop — a misfiled backup, default repairs\n');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await signIn();
  await until(`document.body.innerText.includes('restore from backup')`, 30000);

  await choose(STRANGER_FILE);
  await until(`document.body.innerText.includes('Not restored')`, 15000);
  t.ok('a file signed by another key is refused', (await js(`document.body.innerText`)).includes('belongs to a different Nostr account'));

  await choose(BAD_FILE);
  await until(`!!document.querySelector('[data-restore-findings]')`, 30000);
  const text = await panelText();
  t.ok('the medium repair is offered, ticked', (await checked('data-restore-fix-medium')) === true, text);
  t.ok('it counts four favorites: three songs and the album', text.includes('Set the medium on 4 favorites'), text);
  t.ok('it says three have none', text.includes('3 have none'), text);
  t.ok('it names the mistake: podcast → music', text.includes('1 carries another one (podcast → music)'), text);
  t.ok('the duplicate repair is offered, ticked', (await checked('data-restore-fix-duplicates')) === true);
  t.ok('dropping the unreadable row is offered, NOT ticked', (await checked('data-restore-fix-unreadable')) === false);
  t.ok('the feed Podcast Index does not hold is reported and kept', text.includes('1 favorite is from a feed Podcast Index does not know'), text);
  t.ok('the loss is the set difference: 4 of 5', text.includes('4 of the 5 favorites on the relays are not in this backup'), text);
  t.equal('the button says it repairs, and the removal it confirms', await applyLabel(), 'restore with repairs — removes 4');
  t.equal('NOTHING was published by choosing the file', published.length, seeded);
  await shot('desktop-panel');

  await js(`document.querySelector('[data-restore-apply]').click()`);
  await until(`document.body.innerText.includes('Restored ')`, 30000);
  t.equal('exactly one publish, after the press', published.length, seeded + 1);
  const landed = published[published.length - 1];
  const media = runningMedium(landed.tags);
  t.equal('it is signed by the account', landed.pubkey, pk);
  t.equal('the encrypted half rides through untouched', landed.content, BAD.content);
  for (const song of ['song-1', 'song-2']) {
    t.equal(`${song} is under music now`, media.get(JSON.stringify(['i', sg(A1), ig(song)])), 'music');
  }
  t.equal('song-3 is under music, once', landed.tags.filter((x) => x[2] === ig('song-3')).length, 1);
  t.equal('the album is under music, not podcast', media.get(JSON.stringify(['i', sg(A1)])), 'music');
  t.equal('the show stays under podcast', media.get(JSON.stringify(['i', sg(PC20)])), 'podcast');
  t.ok('the unreadable row is KEPT (its box was not ticked)', landed.tags.some((x) => x[1] === 'podcast:guid:not-a-uuid'));
  t.ok('the feed Podcast Index does not hold is kept', landed.tags.some((x) => x[1] === sg(UNKNOWN)));
  t.ok('the restore message reports the repairs', (await js(`document.body.innerText`)).includes('with the repairs you chose'));
  await until(`document.body.innerText.includes('SHUFFLE')`, 30000).catch(() => {});
  const lib = await js(`document.body.innerText`);
  t.ok('the library offers SHUFFLE on the singles again', lib.includes('SHUFFLE'));
  t.ok('no song is left under "medium unknown"', !/medium unknown items/i.test(lib));
  await shot('desktop-after');

  // ---- 2. phone: layout, cancel, and "restore as saved" -------------------
  console.log('\n  2. phone emulation — layout, cancel, nothing ticked\n');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send('Page.reload');
  await until(`!!document.querySelector('[data-restore-input]')`, 30000);
  let before = published.length;
  await choose(BAD_FILE);
  await until(`!!document.querySelector('[data-restore-findings]')`, 30000);
  await js(`document.querySelector('[data-restore-panel]').scrollIntoView({ block: 'start' })`);
  await wait(300);
  await measure('phone');
  await shot('phone-panel');
  await js(`[...document.querySelectorAll('[data-restore-panel] button')].find((b) => b.textContent.trim() === 'cancel').click()`);
  await wait(300);
  t.ok('cancel closes the panel', !(await js(`!!document.querySelector('[data-restore-panel]')`)));
  t.equal('cancel publishes nothing', published.length, before);

  await choose(BAD_FILE);
  await until(`!!document.querySelector('[data-restore-findings]')`, 30000);
  for (const attr of ['data-restore-fix-medium', 'data-restore-fix-duplicates']) {
    await js(`document.querySelector('[${attr}]').click()`);
  }
  await wait(200);
  t.ok('with no box ticked the button is a plain restore', (await applyLabel()).startsWith('restore') && !(await applyLabel()).includes('repairs'), await applyLabel());
  before = published.length;
  await js(`document.querySelector('[data-restore-apply]').click()`);
  await until(`document.body.innerText.includes('Restored ')`, 30000);
  t.equal('one publish', published.length, before + 1);
  t.equal('nothing ticked publishes the file\'s tags byte for byte', published[published.length - 1].tags, BAD_TAGS);

  // ---- 3. Podcast Index does not answer: "not checked", then CHECK AGAIN ---
  console.log('\n  3. Podcast Index refuses — not checked, check again\n');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await js(`Object.keys(localStorage).filter((k) => k.startsWith('bmb:pmeta')).forEach((k) => localStorage.removeItem(k))`);
  // BOTH routes: the page load resolves the library through the single-feed
  // route too, and what it learns sits in the same memory the check reads.
  await send('Fetch.enable', { patterns: [{ urlPattern: '*api/by-guid*' }] });
  let refused = 0;
  const stopRefusing = page.on(async (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    refused += 1;
    await send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 429, body: Buffer.from('{"error":"rate limited"}').toString('base64') });
  });
  const beforeReload = published.length;
  await send('Page.reload');
  await until(`!!document.querySelector('[data-restore-input]')`, 30000);
  await wait(3000);
  // The ordinary sync may republish the restored file in this app's own
  // framing on the next load. That is the existing cycle, not the check — but
  // it must delete nothing.
  const lastId = (tags) => new Set(tags.filter((x) => x[0] === 'i').map((x) => x[x.length - 1]));
  for (const ev of published.slice(beforeReload)) {
    const kept = lastId(ev.tags);
    t.ok('a republish on reload deletes nothing', [...lastId(BAD_TAGS)].every((k) => kept.has(k)), JSON.stringify(ev.tags));
  }
  before = published.length;
  await choose(BAD_FILE);
  await until(`!!document.querySelector('[data-restore-findings]')`, 30000);
  let p3 = await panelText();
  t.ok('the batch route was asked and refused', refused > 0);
  t.ok('the favorites are NOT CHECKED, never "unknown"', /\d+ favorites? (was|were) not checked/.test(p3) && !p3.includes('does not know'), p3);
  t.ok('no medium repair is invented without an answer', !(await js(`!!document.querySelector('[data-restore-fix-medium]')`)));
  t.ok('the structural findings still show', !!(await js(`!!document.querySelector('[data-restore-fix-duplicates]')`)));
  t.ok('RESTORE is not held by an unanswered lookup', !(await js(`document.querySelector('[data-restore-apply]').disabled`)));
  stopRefusing();
  await send('Fetch.disable');
  await js(`[...document.querySelectorAll('[data-restore-notchecked] button')][0].click()`);
  await until(`!!document.querySelector('[data-restore-fix-medium]')`, 30000);
  p3 = await panelText();
  t.ok('CHECK AGAIN finds the medium problems', p3.includes('Set the medium on 4 favorites'), p3);
  t.ok('and nothing is left unchecked', !/not checked/.test(p3), p3);
  t.equal('still nothing published by the check', published.length, before);
} catch (e) {
  t.fail('the run threw', e?.stack ?? String(e));
} finally {
  await relay.close?.();
  if (!process.env.SHOT_DIR) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ${t.count - t.fails}/${t.count} passed\n`);
await exit(t.fails ? 1 : 0);
