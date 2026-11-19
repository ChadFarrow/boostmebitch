// e2e for the two pings a playlist write sends after it LANDS (docs/feeds.md):
//   - lib/community/archive-notify.ts: one GitHub workflow_dispatch of
//     playlist-archive.yml ("The GitHub copy");
//   - lib/community/pi-notify.ts: Podcast Index add/byfeedurl + hub/pubnotify on a
//     publish or edit, hub/pubnotify alone on a delete ("Podcast Index").
// A refused write sends neither.
//
// NOTHING REACHES GITHUB OR PODCAST INDEX. One stub on 127.0.0.1 plays both; the
// two override variables accept only a loopback address (`archiveDispatchBase`,
// `piNotifyBase`), and a non-loopback override turns the ping OFF, never real:
//
//   node scripts/e2e-playlist-pings.mjs --stub 48555                  (in one shell)
//   COMMUNITY_DB_URL=postgres://… ADMIN_NPUBS=<the npub printed below> \
//   NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on NEXT_PUBLIC_COMMUNITY_FEED_ORIGIN=http://localhost:3123 \
//   GITHUB_ARCHIVE_TOKEN=test-archive-token PLAYLIST_ARCHIVE_API=http://127.0.0.1:48555 \
//   COMMUNITY_PI_NOTIFY=on PI_NOTIFY_API=http://127.0.0.1:48555 \
//   npm run dev -- -p 3123
//   STUB_URL=http://127.0.0.1:48555 node scripts/e2e-playlist-pings.mjs
//
// The server still needs the real PODCAST_INDEX_KEY/SECRET in .env.local: the
// publish route verifies each song against Podcast Index (a READ). The stub
// records only whether PI's auth headers are present, never their values.
//
// `--browser`: PUBLISH, SAVE and DELETE pressed in the maker, in headless Chrome,
// at 1280 x 900 and at 390 x 844. Same server as above.
//
// `--quiet-server`: restart the server with both overrides set to
// `http://127.0.0.1.nip.io:48555`. That name resolves to the stub, so if a guard
// let it through, the stub would count it. Publish, edit and delete send nothing.
//
// `--pi-switch-off`: restart the server as in the main run but WITHOUT
// COMMUNITY_PI_NOTIFY. A publish then sends the GitHub ping and no PI call.
//
// Same NIP-98 signing and per-5-requests x-real-ip as e2e-community-api.mjs, and
// the same test-only admin key (07…07). It deletes what it makes.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { getToken } from 'nostr-tools/nip98';
import { npubEncode } from 'nostr-tools/nip19';

const DISPATCH = '/repos/ChadFarrow/boostmebitch/actions/workflows/playlist-archive.yml/dispatches';
const PI_ADD = '/api/1.0/add/byfeedurl';
const PI_PING = '/api/1.0/hub/pubnotify';

// ── the stub ────────────────────────────────────────────────────────────────
const stubAt = process.argv.indexOf('--stub');
if (stubAt >= 0) {
  const port = Number(process.argv[stubAt + 1]);
  const ADD_OK = { status: 200, delayMs: 0, body: { status: 'true', feedId: 7777777, existed: 'false', description: 'Feed added.' } };
  let log = [];
  let addMode = ADD_OK;
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://stub');
      if (u.pathname === '/__log') {
        if (req.method === 'DELETE') log = [];
        return json(res, 200, log);
      }
      if (u.pathname === '/__mode') {
        addMode = body ? { ...ADD_OK, ...JSON.parse(body) } : ADD_OK;
        return json(res, 200, addMode);
      }
      const h = req.headers;
      const entry = { method: req.method, path: u.pathname, ua: h['user-agent'] ?? null };
      if (u.pathname.startsWith('/api/1.0/')) {
        Object.assign(entry, {
          url: u.searchParams.get('url'),
          piAuth: !!h['x-auth-key'] && /^\d+$/.test(h['x-auth-date'] ?? '') && /^[0-9a-f]{40}$/.test(h.authorization ?? ''),
        });
      } else {
        Object.assign(entry, { auth: h.authorization, accept: h.accept, version: h['x-github-api-version'], body });
      }
      log.push(entry);
      if (u.pathname === PI_ADD) {
        const m = addMode;
        return setTimeout(() => json(res, m.status, m.body), m.delayMs);
      }
      if (u.pathname === PI_PING) return json(res, 200, { status: 'true', description: 'Feed marked for immediate update.' });
      res.writeHead(204);
      res.end();
    });
  }).listen(port, '127.0.0.1', () => console.log(`stub GitHub + Podcast Index API on http://127.0.0.1:${port}`));
} else {
  await run();
}

async function run() {
  const APP = (process.env.APP_URL || 'http://localhost:3123').replace(/\/$/, '');
  const STUB = (process.env.STUB_URL || 'http://127.0.0.1:48555').replace(/\/$/, '');
  const QUIET = process.argv.includes('--quiet-server');
  const PI_OFF = process.argv.includes('--pi-switch-off');
  const PLAYLISTS = '/api/community-playlists';
  const SONG_SOURCE = 'https://v4vmusic.com/playlist/334bb12d-1f72-4c0e-88e1-266bd1e2dff9.xml';
  const ADMIN_SK = Uint8Array.from(Buffer.from('07'.repeat(32), 'hex'));

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
    const t0 = Date.now();
    const res = await fetch(`${APP}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null), ms: Date.now() - t0 };
  }
  const stubLog = async () => (await fetch(`${STUB}/__log`)).json();
  const clear = () => fetch(`${STUB}/__log`, { method: 'DELETE' });
  const mode = (m) => fetch(`${STUB}/__mode`, { method: 'POST', body: m ? JSON.stringify(m) : '' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const feedOf = (id) => `${APP}/feeds/playlists/${id}.xml`;

  /**
   * `after()` runs once the response is sent: wait until the expected number of
   * calls arrived (or `waitMs` passed), give a straggler 700 ms, then count each kind.
   * `feeds`: every PI call must name one of these, and the pings must cover them all.
   */
  const expectCalls = async (label, { gh, add, ping, feeds, waitMs = 3000 }) => {
    const total = gh + add + ping;
    let log = [];
    for (const end = Date.now() + waitMs; Date.now() < end;) {
      log = await stubLog();
      if (log.length >= total) break;
      await sleep(100);
    }
    await sleep(700);
    log = await stubLog();
    await clear();
    const by = (p) => log.filter((e) => e.path === p);
    const got = { gh: by(DISPATCH).length, add: by(PI_ADD).length, ping: by(PI_PING).length, other: log.length - by(DISPATCH).length - by(PI_ADD).length - by(PI_PING).length };
    check(`${label}: GitHub ${gh}, PI add ${add}, PI ping ${ping}`,
      got.gh === gh && got.add === add && got.ping === ping && got.other === 0, `got ${JSON.stringify(got)}: ${JSON.stringify(log)}`);
    if (feeds) {
      const pi = log.filter((e) => e.path.startsWith('/api/1.0/'));
      check(`${label}: every PI call names the playlist's feed URL`, pi.every((e) => feeds.includes(e.url)), JSON.stringify(pi.map((e) => e.url)));
      if (ping) check(`${label}: a ping for each feed`, feeds.every((f) => by(PI_PING).some((e) => e.url === f)), JSON.stringify(by(PI_PING).map((e) => e.url)));
    }
    return log;
  };

  if (process.argv.includes('--browser')) {
    await clear();
    const exitBrowser = await browser({ APP, check, expectCalls, clear, SONG_SOURCE });
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
  const draft = (over = {}) => ({ title: 'e2e playlist pings', description: 'made by e2e-playlist-pings', artUrl: null, songs, ...over });
  const owner = Uint8Array.from(randomBytes(32));
  const other = Uint8Array.from(randomBytes(32));
  await mode(null);
  await clear();
  const finish = () => { console.log(`${count - fails}/${count} passed`); process.exit(fails ? 1 : 0); };

  if (QUIET || PI_OFF) {
    const name = QUIET ? 'quiet server' : 'PI switch off';
    const c = await call('POST', PLAYLISTS, { sk: owner, body: { draft: draft() } });
    check(`${name}: publish -> 201`, c.status === 201, JSON.stringify(c));
    await expectCalls(`${name}: publish`, { gh: QUIET ? 0 : 1, add: 0, ping: 0 });
    const at = (await call('GET', `${PLAYLISTS}/${c.body?.id}`)).body?.playlist?.updatedAt;
    const e = await call('PUT', `${PLAYLISTS}/${c.body?.id}`, { sk: owner, body: { draft: draft({ title: 'e2e playlist pings 2' }), expectedUpdatedAt: at } });
    check(`${name}: edit -> 200`, e.status === 200, JSON.stringify(e).slice(0, 300));
    await expectCalls(`${name}: edit`, { gh: QUIET ? 0 : 1, add: 0, ping: 0 });
    const d = await call('DELETE', `${PLAYLISTS}/${c.body?.id}`, { sk: owner });
    check(`${name}: delete -> 200`, d.status === 200, JSON.stringify(d));
    await expectCalls(`${name}: delete`, { gh: QUIET ? 0 : 1, add: 0, ping: 0 });
    finish();
  }

  // Refused writes send nothing.
  const bad = await call('POST', PLAYLISTS, { sk: owner, body: { draft: draft({ title: '' }) } });
  check('publish with no title -> 400', bad.status === 400, JSON.stringify(bad));
  await expectCalls('a refused publish', { gh: 0, add: 0, ping: 0 });
  const unsigned = await call('POST', PLAYLISTS, { body: { draft: draft() } });
  check('unsigned publish -> 401', unsigned.status === 401, JSON.stringify(unsigned));
  await expectCalls('an unsigned publish', { gh: 0, add: 0, ping: 0 });

  // Publish: one dispatch in GitHub's exact form; add, then ping, for this feed.
  const c = await call('POST', PLAYLISTS, { sk: owner, body: { draft: draft() } });
  check('publish -> 201', c.status === 201, JSON.stringify(c));
  const id = c.body.id;
  const feed = feedOf(id);
  check('the 201 names the feed URL the pings must carry', c.body.feedUrl === feed, c.body.feedUrl);
  const log = await expectCalls('a publish', { gh: 1, add: 1, ping: 1, feeds: [feed] });
  const d = log.find((e) => e.path === DISPATCH);
  check('the dispatch is a POST to the playlist-archive workflow', d?.method === 'POST', JSON.stringify(d));
  check('it carries the token as a Bearer header', d?.auth === 'Bearer test-archive-token');
  check('it names GitHub\'s media type and API version', d?.accept === 'application/vnd.github+json' && d?.version === '2022-11-28');
  check('it has a User-Agent (GitHub requires one)', !!d?.ua);
  check('its body is only { ref: "main" }: no playlist data', d?.body === '{"ref":"main"}', d?.body);
  const add = log.find((e) => e.path === PI_ADD);
  check('the PI add is a GET with PI\'s three auth headers and a User-Agent', add?.method === 'GET' && add?.piAuth === true && !!add?.ua, JSON.stringify(add));
  check('the PI add comes before the ping', log.findIndex((e) => e.path === PI_ADD) < log.findIndex((e) => e.path === PI_PING));
  let updatedAt = (await call('GET', `${PLAYLISTS}/${id}`)).body?.playlist?.updatedAt;

  const edit = async (title) => {
    const r = await call('PUT', `${PLAYLISTS}/${id}`, { sk: owner, body: { draft: draft({ title }), expectedUpdatedAt: updatedAt } });
    if (r.status === 200) updatedAt = r.body?.playlist?.updatedAt;
    return r;
  };

  // Edit: a SAVE asks PI to add again (idempotent), so a refused add is retried.
  const put = await edit('e2e playlist pings 2');
  check('edit by the owner -> 200', put.status === 200, JSON.stringify(put).slice(0, 300));
  await expectCalls('an edit', { gh: 1, add: 1, ping: 1, feeds: [feed] });
  const stale = await call('PUT', `${PLAYLISTS}/${id}`, { sk: owner, body: { draft: draft({ title: 'stale' }), expectedUpdatedAt: '2020-01-01T00:00:00.000Z' } });
  check('edit with a stale expectedUpdatedAt -> 409', stale.status === 409, JSON.stringify(stale));
  await expectCalls('a stale edit', { gh: 0, add: 0, ping: 0 });
  const hijack = await call('PUT', `${PLAYLISTS}/${id}`, { sk: other, body: { draft: draft({ title: 'hijack' }), expectedUpdatedAt: updatedAt } });
  check('edit by another key -> 403', hijack.status === 403, JSON.stringify(hijack));
  await expectCalls('a forbidden edit', { gh: 0, add: 0, ping: 0 });

  // PI refuses the add (a key without write permission): the save still succeeds,
  // and the ping still goes.
  await mode({ status: 401, body: { status: 'false', description: 'Authorization error' } });
  const refused = await edit('e2e playlist pings 3');
  check('edit while PI refuses the add -> 200', refused.status === 200, JSON.stringify(refused).slice(0, 300));
  await expectCalls('an edit PI refuses', { gh: 1, add: 1, ping: 1, feeds: [feed] });
  // A 200 that says status "false" is a refusal too; same outcome.
  await mode({ status: 200, body: { status: 'false', description: 'Invalid feed' } });
  const soft = await edit('e2e playlist pings 4');
  check('edit while PI answers 200 status "false" -> 200', soft.status === 200);
  await expectCalls('an edit PI answers status "false"', { gh: 1, add: 1, ping: 1, feeds: [feed] });

  // PI hangs: the response does not wait, and the ping goes after the 8 s timeout.
  await mode({ delayMs: 10_000 });
  const slow = await edit('e2e playlist pings 5');
  check('edit while PI hangs -> 200', slow.status === 200);
  check(`...and the response does not wait for PI (${slow.ms} ms)`, slow.ms < 5000);
  await expectCalls('an edit while PI hangs (ping after the timeout)', { gh: 1, add: 1, ping: 1, feeds: [feed], waitMs: 14_000 });
  await mode(null);

  // Owner delete: a ping only (PI cannot delete; it reads the 410).
  const del = await call('DELETE', `${PLAYLISTS}/${id}`, { sk: owner });
  check('delete by the owner -> 200', del.status === 200, JSON.stringify(del));
  await expectCalls('an owner delete', { gh: 1, add: 0, ping: 1, feeds: [feed] });
  const del2 = await call('DELETE', `${PLAYLISTS}/${id}`, { sk: owner });
  check('delete again -> 410', del2.status === 410, JSON.stringify(del2));
  await expectCalls('a second delete', { gh: 0, add: 0, ping: 0 });

  // Admin delete, ban with and without deleteAll.
  const made = [];
  for (const t of ['A', 'B', 'C']) made.push(await call('POST', PLAYLISTS, { sk: other, body: { draft: draft({ title: `e2e playlist pings ${t}` }) } }));
  check('three playlists by another key -> 201 x3', made.every((m) => m.status === 201), JSON.stringify(made.map((m) => m.status)));
  const [fa, fb, fc] = made.map((m) => feedOf(m.body.id));
  await expectCalls('three publishes', { gh: 3, add: 3, ping: 3, feeds: [fa, fb, fc] });
  const ad = await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'delete', id: made[0].body.id } });
  check('admin delete -> deleted 1', ad.body?.deleted === 1, JSON.stringify(ad));
  await expectCalls('an admin delete', { gh: 1, add: 0, ping: 1, feeds: [fa] });
  const ad2 = await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'delete', id: made[0].body.id } });
  check('admin delete again -> deleted 0', ad2.body?.deleted === 0, JSON.stringify(ad2));
  await expectCalls('an admin delete of a deleted playlist', { gh: 0, add: 0, ping: 0 });
  const otherPub = getPublicKey(other);
  const banOnly = await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'ban', pubkey: otherPub } });
  check('ban only -> ok, deleted 0', banOnly.body?.ok === true && banOnly.body?.deleted === 0, JSON.stringify(banOnly));
  await expectCalls('a ban that deletes nothing', { gh: 0, add: 0, ping: 0 });
  const banAll = await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'ban', pubkey: otherPub, deleteAll: true } });
  check('ban and delete all -> deleted 2', banAll.body?.deleted === 2, JSON.stringify(banAll));
  await expectCalls('a ban that deletes two playlists', { gh: 1, add: 0, ping: 2, feeds: [fb, fc] });
  const unban = await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'unban', pubkey: otherPub } });
  check('unban -> ok', unban.body?.ok === true, JSON.stringify(unban));
  await expectCalls('an unban', { gh: 0, add: 0, ping: 0 });

  finish();
}

// ── --browser: the maker in headless Chrome, desktop then phone ──────────────
// PUBLISH, SAVE and DELETE pressed in the real page, at 1280 x 900 and at
// 390 x 844 (CDP device emulation, mobile: true). The signer is a throwaway key
// behind a fake NIP-07 `window.nostr`; relays point at a LOCAL relay.
// Returns cdp.mjs's `exit`, which closes Chrome with Browser.close first.

async function browser({ APP, check, expectCalls, clear, SONG_SOURCE }) {
  const { launchChrome, exit, wait } = await import('./cdp.mjs');
  const { createRelay } = await import('./local-relay.mjs');
  const relay = createRelay({ port: 0, log: null, onEvent: () => {} });
  const PORT = await relay.ready;
  const sk = Uint8Array.from(randomBytes(32));
  const pk = getPublicKey(sk);
  const npub = npubEncode(pk);
  const KEY = `bmb:playlist_draft:${npub}`;

  const { page } = await launchChrome({ name: `playlistpings-${process.env.CLAUDE_CODE_SESSION_ID || 'local'}`, args: ['--disable-gpu'] });
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
    const title = `e2e playlist pings (${s.name})`;
    await js(`(() => { localStorage.setItem(${JSON.stringify(KEY)}, JSON.stringify({
      draft: ${JSON.stringify({ title, description: 'made by e2e-playlist-pings', artUrl: null, songs })},
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
    const feedUrl = await js(`document.querySelector('#feed-address')?.value ?? ''`);
    await expectCalls(`${s.name}: PUBLISH pressed in the page`, { gh: 1, add: 1, ping: 1, feeds: [feedUrl] });
    const id = /feeds\/playlists\/([0-9a-f-]{36})\.xml$/.exec(feedUrl)?.[1];
    check(`${s.name}: the feed address names the new playlist`, !!id, feedUrl);

    await go(`/playlists/make?id=${id}`);
    check(`${s.name}: EDIT opens with SAVE`, await waitFor(`document.querySelector('#pl-title') && !!${byText('SAVE')}`));
    await js(`(() => { const el = document.querySelector('#pl-title');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(`${title} v2`)});
      el.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
    await click(byText('SAVE'));
    check(`${s.name}: SAVE shows the Published view with the new title`, await waitFor(`document.querySelector('[data-testid=published]')?.innerText.includes(${JSON.stringify(`${title} v2`)})`, 30000));
    await expectCalls(`${s.name}: SAVE pressed in the page`, { gh: 1, add: 1, ping: 1, feeds: [feedUrl] });

    await go(`/playlists/make?id=${id}`);
    await waitFor(`!!${byText('DELETE')}`);
    await click(byText('DELETE'));
    check(`${s.name}: DELETE asks first`, await waitFor(`document.querySelector('[role=dialog]')?.innerText.includes('Delete this playlist?')`));
    await expectCalls(`${s.name}: the DELETE question alone`, { gh: 0, add: 0, ping: 0 });
    await click(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'DELETE')`);
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) { gone = (await fetch(feedUrl)).status === 410; if (!gone) await wait(250); }
    check(`${s.name}: the feed answers 410 after DELETE`, gone);
    await expectCalls(`${s.name}: DELETE confirmed in the page`, { gh: 1, add: 0, ping: 1, feeds: [feedUrl] });
  }
  relay.close();
  return exit;
}
