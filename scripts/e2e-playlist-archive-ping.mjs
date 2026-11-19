// e2e for lib/community/archive-notify.ts: after each playlist write that LANDED,
// the server sends exactly one workflow_dispatch for playlist-archive.yml, and after
// a refused write it sends none (docs/feeds.md, "The GitHub copy").
//
// NOTHING REACHES GITHUB. Start a stub that records requests, then the dev server
// pointed at it (PLAYLIST_ARCHIVE_API accepts only a loopback address):
//
//   node scripts/e2e-playlist-archive-ping.mjs --stub 48555          (in one shell)
//   COMMUNITY_DB_URL=postgres://… ADMIN_NPUBS=<the npub printed below> \
//   NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on NEXT_PUBLIC_COMMUNITY_FEED_ORIGIN=http://localhost:3123 \
//   GITHUB_ARCHIVE_TOKEN=test-archive-token PLAYLIST_ARCHIVE_API=http://127.0.0.1:48555 \
//   npm run dev -- -p 3123
//   STUB_URL=http://127.0.0.1:48555 node scripts/e2e-playlist-archive-ping.mjs
//
// `--quiet-server`: the server was started with the token and a local feed origin,
// and with PLAYLIST_ARCHIVE_API unset or NOT a loopback address. Use
// `http://127.0.0.1.nip.io:48555`: that name resolves to the stub, so if the guard
// (`archiveDispatchBase`) let it through, the stub would count it. A write must
// send nothing at all.
//
// `--browser`: PUBLISH, SAVE and DELETE pressed in the maker, in headless Chrome,
// at 1280 x 900 and at 390 x 844. Needs the stub-pointed server above.
//
// Same NIP-98 signing and per-5-requests x-real-ip as e2e-community-api.mjs, and
// the same test-only admin key (07…07). It deletes what it makes.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { getToken } from 'nostr-tools/nip98';
import { npubEncode } from 'nostr-tools/nip19';

// ── the stub ────────────────────────────────────────────────────────────────
const stubAt = process.argv.indexOf('--stub');
if (stubAt >= 0) {
  const port = Number(process.argv[stubAt + 1]);
  let log = [];
  http.createServer((req, res) => {
    if (req.url === '/__log') {
      if (req.method === 'DELETE') log = [];
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(log));
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      log.push({
        method: req.method, path: req.url, auth: req.headers.authorization, accept: req.headers.accept,
        version: req.headers['x-github-api-version'], ua: req.headers['user-agent'], body,
      });
      res.writeHead(204);
      res.end();
    });
  }).listen(port, '127.0.0.1', () => console.log(`stub GitHub API on http://127.0.0.1:${port}`));
} else {
  await run();
}

async function run() {
  const APP = (process.env.APP_URL || 'http://localhost:3123').replace(/\/$/, '');
  const STUB = (process.env.STUB_URL || 'http://127.0.0.1:48555').replace(/\/$/, '');
  const QUIET = process.argv.includes('--quiet-server');
  const PLAYLISTS = '/api/community-playlists';
  const SONG_SOURCE = 'https://v4vmusic.com/playlist/334bb12d-1f72-4c0e-88e1-266bd1e2dff9.xml';
  const ADMIN_SK = Uint8Array.from(Buffer.from('07'.repeat(32), 'hex'));
  const DISPATCH = '/repos/ChadFarrow/boostmebitch/actions/workflows/playlist-archive.yml/dispatches';

  let fails = 0;
  let count = 0;
  const check = (label, cond, detail = '') => {
    count++;
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
    if (!cond) { fails++; if (detail) console.log(`         ${detail}`); }
    return !!cond;
  };
  let sent = 0;
  const nextIp = () => `10.97.${Math.floor(sent++ / 5) % 250}.${Math.floor(sent / 1250) + 1}`;
  async function call(method, path, { sk, body } = {}) {
    const h = { 'x-real-ip': nextIp() };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (sk) h.authorization = await getToken(`${APP}${path.split('?')[0]}`, method, (e) => finalizeEvent(e, sk), true, body);
    const res = await fetch(`${APP}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  const stubLog = async () => (await fetch(`${STUB}/__log`)).json();
  const clear = () => fetch(`${STUB}/__log`, { method: 'DELETE' });
  // `after()` runs once the response is sent: give it a moment, then count.
  const dispatchesAfter = async (expect) => {
    let log = [];
    for (let i = 0; i < 30; i++) {
      log = await stubLog();
      if (log.length > expect) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (log.length === expect) await new Promise((r) => setTimeout(r, 700));
    log = await stubLog();
    await clear();
    return log;
  };
  const expectDispatches = async (label, n) => {
    const log = await dispatchesAfter(n);
    check(`${label}: ${n} dispatch${n === 1 ? '' : 'es'}`, log.length === n, `got ${log.length}: ${JSON.stringify(log)}`);
    return log;
  };

  if (process.argv.includes('--browser')) {
    const exitBrowser = await browser({ APP, check, expectDispatches, clear, SONG_SOURCE });
    console.log(`${count - fails}/${count} passed`);
    await exitBrowser(fails ? 1 : 0);
  }

  console.log(`admin npub (for ADMIN_NPUBS): ${npubEncode(getPublicKey(ADMIN_SK))}`);
  const src = await call('GET', `/api/playlist?url=${encodeURIComponent(SONG_SOURCE)}&limit=40`);
  const songs = (src.body?.episodes ?? [])
    .filter((e) => !e.unresolved && e.guid && e.podcastGuid)
    .slice(0, 10)
    .map((e) => ({ feedGuid: e.podcastGuid, itemGuid: e.guid }));
  if (songs.length < 10) {
    console.log(`FAIL could not read 10 songs (got ${songs.length})`);
    process.exit(1);
  }
  const draft = (over = {}) => ({ title: 'e2e archive ping', description: 'made by e2e-playlist-archive-ping', artUrl: null, songs, ...over });
  const owner = Uint8Array.from(randomBytes(32));
  const other = Uint8Array.from(randomBytes(32));
  await clear();

  if (QUIET) {
    const c = await call('POST', PLAYLISTS, { sk: owner, body: { draft: draft() } });
    check('quiet server: publish -> 201', c.status === 201, JSON.stringify(c));
    await expectDispatches('quiet server: publish', 0);
    if (c.body?.id) await call('DELETE', `${PLAYLISTS}/${c.body.id}`, { sk: owner });
    await expectDispatches('quiet server: delete', 0);
    console.log(`${count - fails}/${count} passed`);
    process.exit(fails ? 1 : 0);
  }

  // Refused writes send nothing.
  const bad = await call('POST', PLAYLISTS, { sk: owner, body: { draft: draft({ title: '' }) } });
  check('publish with no title -> 400', bad.status === 400, JSON.stringify(bad));
  await expectDispatches('a refused publish', 0);
  const unsigned = await call('POST', PLAYLISTS, { body: { draft: draft() } });
  check('unsigned publish -> 401', unsigned.status === 401, JSON.stringify(unsigned));
  await expectDispatches('an unsigned publish', 0);

  // Publish: one dispatch, in GitHub's exact form.
  const c = await call('POST', PLAYLISTS, { sk: owner, body: { draft: draft() } });
  check('publish -> 201', c.status === 201, JSON.stringify(c));
  const [d] = await expectDispatches('a publish', 1);
  check('the dispatch is a POST to the playlist-archive workflow', d?.method === 'POST' && d?.path === DISPATCH, JSON.stringify(d));
  check('it carries the token as a Bearer header', d?.auth === 'Bearer test-archive-token');
  check('it names GitHub\'s media type and API version', d?.accept === 'application/vnd.github+json' && d?.version === '2022-11-28');
  check('it has a User-Agent (GitHub requires one)', !!d?.ua);
  check('its body is only { ref: "main" }: no playlist data', d?.body === '{"ref":"main"}', d?.body);
  const id = c.body.id;
  let updatedAt = (await call('GET', `${PLAYLISTS}/${id}`)).body?.playlist?.updatedAt;

  // Edit.
  const put = await call('PUT', `${PLAYLISTS}/${id}`, { sk: owner, body: { draft: draft({ title: 'e2e archive ping 2' }), expectedUpdatedAt: updatedAt } });
  check('edit by the owner -> 200', put.status === 200, JSON.stringify(put).slice(0, 300));
  await expectDispatches('an edit', 1);
  const stale = await call('PUT', `${PLAYLISTS}/${id}`, { sk: owner, body: { draft: draft({ title: 'stale' }), expectedUpdatedAt: updatedAt } });
  check('edit with a stale expectedUpdatedAt -> 409', stale.status === 409, JSON.stringify(stale));
  await expectDispatches('a stale edit', 0);
  updatedAt = put.body?.playlist?.updatedAt;
  const hijack = await call('PUT', `${PLAYLISTS}/${id}`, { sk: other, body: { draft: draft({ title: 'hijack' }), expectedUpdatedAt: updatedAt } });
  check('edit by another key -> 403', hijack.status === 403, JSON.stringify(hijack));
  await expectDispatches('a forbidden edit', 0);

  // Owner delete.
  const del = await call('DELETE', `${PLAYLISTS}/${id}`, { sk: owner });
  check('delete by the owner -> 200', del.status === 200, JSON.stringify(del));
  await expectDispatches('an owner delete', 1);
  const del2 = await call('DELETE', `${PLAYLISTS}/${id}`, { sk: owner });
  check('delete again -> 410', del2.status === 410, JSON.stringify(del2));
  await expectDispatches('a second delete', 0);

  // Admin delete, ban with and without deleteAll.
  const a = await call('POST', PLAYLISTS, { sk: other, body: { draft: draft({ title: 'e2e archive ping A' }) } });
  const b = await call('POST', PLAYLISTS, { sk: other, body: { draft: draft({ title: 'e2e archive ping B' }) } });
  check('two playlists by another key -> 201, 201', a.status === 201 && b.status === 201);
  await expectDispatches('two publishes', 2);
  const ad = await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'delete', id: a.body.id } });
  check('admin delete -> deleted 1', ad.body?.deleted === 1, JSON.stringify(ad));
  await expectDispatches('an admin delete', 1);
  const ad2 = await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'delete', id: a.body.id } });
  check('admin delete again -> deleted 0', ad2.body?.deleted === 0, JSON.stringify(ad2));
  await expectDispatches('an admin delete of a deleted playlist', 0);
  const otherPub = getPublicKey(other);
  const banOnly = await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'ban', pubkey: otherPub } });
  check('ban only -> ok, deleted 0', banOnly.body?.ok === true && banOnly.body?.deleted === 0, JSON.stringify(banOnly));
  await expectDispatches('a ban that deletes nothing', 0);
  const banAll = await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'ban', pubkey: otherPub, deleteAll: true } });
  check('ban and delete all -> deleted 1', banAll.body?.deleted === 1, JSON.stringify(banAll));
  await expectDispatches('a ban that deletes a playlist', 1);
  const unban = await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'unban', pubkey: otherPub } });
  check('unban -> ok', unban.body?.ok === true, JSON.stringify(unban));
  await expectDispatches('an unban', 0);

  console.log(`${count - fails}/${count} passed`);
  process.exit(fails ? 1 : 0);
}

// ── --browser: the maker in headless Chrome, desktop then phone ──────────────
// PUBLISH, SAVE and DELETE pressed in the real page each send ONE dispatch, at
// 1280 x 900 and at 390 x 844 (CDP device emulation, mobile: true). The signer is
// a throwaway key behind a fake NIP-07 `window.nostr`; relays point at a LOCAL relay.
// Returns cdp.mjs's `exit`, which closes Chrome with Browser.close first.

async function browser({ APP, check, expectDispatches, clear, SONG_SOURCE }) {
  const { launchChrome, exit, wait } = await import('./cdp.mjs');
  const { createRelay } = await import('./local-relay.mjs');
  const relay = createRelay({ port: 0, log: null, onEvent: () => {} });
  const PORT = await relay.ready;
  const sk = Uint8Array.from(randomBytes(32));
  const pk = getPublicKey(sk);
  const npub = npubEncode(pk);
  const KEY = `bmb:playlist_draft:${npub}`;

  const { page } = await launchChrome({ name: `archiveping-${process.env.CLAUDE_CODE_SESSION_ID || 'local'}`, args: ['--disable-gpu'] });
  const { send } = page;
  const js = page.jsOrThrow;
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Network.setExtraHTTPHeaders', { headers: { 'x-real-ip': `10.96.${Math.floor(Math.random() * 250)}.1` } });
  await send('Runtime.addBinding', { name: 'bmbSigner' });
  page.on(async (m) => {
    if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'bmbSigner') return;
    const { rid, fn, args } = JSON.parse(m.params.payload);
    let out, err = null;
    try {
      if (fn === 'getPublicKey') out = pk;
      else if (fn === 'signEvent') out = finalizeEvent(args[0], sk);
      else err = `no such method ${fn}`;
    } catch (e) { err = String(e?.message ?? e); }
    await js(`window.__bmbResolve(${JSON.stringify(rid)}, ${JSON.stringify({ out, err })})`);
  });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    (() => {
      const waiting = new Map(); let n = 0;
      window.__bmbResolve = (rid, r) => { const p = waiting.get(rid); waiting.delete(rid); if (!p) return; r.err ? p.reject(new Error(r.err)) : p.resolve(r.out); };
      const call = (fn, ...args) => new Promise((resolve, reject) => {
        const rid = 'r' + (++n); waiting.set(rid, { resolve, reject });
        window.bmbSigner(JSON.stringify({ rid, fn, args }));
      });
      window.nostr = { getPublicKey: () => call('getPublicKey'), signEvent: (e) => call('signEvent', e) };
    })();
  ` });

  const waitFor = async (expr, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await js(`!!(${expr})`)) return true; await wait(250); }
    return false;
  };
  const go = async (path) => { await send('Page.navigate', { url: `${APP}${path}` }); await wait(1500); };
  const byText = (label) => `[...document.querySelectorAll('main button, main a')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
  const click = (finder) => js(`(() => { const b = ${finder}; if (b) b.click(); return !!b; })()`);
  const overflowFree = () => js('document.documentElement.scrollWidth <= document.documentElement.clientWidth');
  const tooSmall = () => js(`[...document.querySelectorAll('main button, main a, main input')].filter((e) => { const r = e.getBoundingClientRect(); return r.width < 24 || r.height < 24; }).map((e) => e.textContent.trim() || e.getAttribute('aria-label'))`);

  const src = await fetch(`${APP}/api/playlist?url=${encodeURIComponent(SONG_SOURCE)}&limit=40`).then((r) => r.json()).catch(() => ({}));
  const real = (src.episodes ?? []).filter((e) => !e.unresolved && e.guid && e.podcastGuid).slice(0, 10);
  check('ten real songs to seed with', real.length === 10, `got ${real.length}`);
  const songs = real.map((e) => ({ feedGuid: e.podcastGuid, itemGuid: e.guid }));
  const labels = Object.fromEntries(real.map((e) => [e.guid, { title: e.title }]));

  await send('Page.navigate', { url: APP });
  await wait(500);
  await js(`(() => { localStorage.clear();
    localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))});
    localStorage.setItem('bmb:npub', ${JSON.stringify(npub)}); localStorage.setItem('bmb:signer', 'nip07'); return 1; })()`);

  const sizes = [
    { name: 'desktop 1280 x 900', metrics: { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false } },
    { name: 'phone 390 x 844', metrics: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } },
  ];
  for (const s of sizes) {
    console.log(`--- ${s.name} ---`);
    await send('Emulation.setDeviceMetricsOverride', s.metrics);
    const title = `e2e archive ping (${s.name})`;
    await js(`(() => { localStorage.setItem(${JSON.stringify(KEY)}, JSON.stringify({
      draft: ${JSON.stringify({ title, description: 'made by e2e-playlist-archive-ping', artUrl: null, songs })},
      editingId: null, expectedUpdatedAt: null, labels: ${JSON.stringify(labels)} })); return 1; })()`);
    await clear();
    await go('/playlists/make');
    check(`${s.name}: the maker loads the seeded draft`, await waitFor(`document.querySelector('#pl-title')?.value === ${JSON.stringify(title)}`));
    check(`${s.name}: maker: no horizontal overflow`, await overflowFree());
    await click(byText('PUBLISH'));
    check(`${s.name}: PUBLISH shows the Published view`, await waitFor(`document.querySelector('[data-testid=published]')`, 30000));
    check(`${s.name}: published: no horizontal overflow`, await overflowFree());
    const small = await tooSmall();
    check(`${s.name}: published: controls at least 24 x 24`, small.length === 0, JSON.stringify(small));
    await expectDispatches(`${s.name}: PUBLISH pressed in the page`, 1);
    const feedUrl = await js(`document.querySelector('#feed-address')?.value ?? ''`);
    const id = /feeds\/playlists\/([0-9a-f-]{36})\.xml$/.exec(feedUrl)?.[1];
    check(`${s.name}: the feed address names the new playlist`, !!id, feedUrl);

    await go(`/playlists/make?id=${id}`);
    check(`${s.name}: EDIT opens with SAVE`, await waitFor(`document.querySelector('#pl-title') && !!${byText('SAVE')}`));
    await js(`(() => { const el = document.querySelector('#pl-title');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(`${title} v2`)});
      el.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
    await click(byText('SAVE'));
    check(`${s.name}: SAVE shows the Published view with the new title`, await waitFor(`document.querySelector('[data-testid=published]')?.innerText.includes(${JSON.stringify(`${title} v2`)})`, 30000));
    await expectDispatches(`${s.name}: SAVE pressed in the page`, 1);

    await go(`/playlists/make?id=${id}`);
    await waitFor(`!!${byText('DELETE')}`);
    await click(byText('DELETE'));
    check(`${s.name}: DELETE asks first`, await waitFor(`document.querySelector('[role=dialog]')?.innerText.includes('Delete this playlist?')`));
    await expectDispatches(`${s.name}: the DELETE question alone`, 0);
    await click(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'DELETE')`);
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) { gone = (await fetch(feedUrl)).status === 410; if (!gone) await wait(250); }
    check(`${s.name}: the feed answers 410 after DELETE`, gone);
    await expectDispatches(`${s.name}: DELETE confirmed in the page`, 1);
  }
  relay.close();
  return exit;
}
