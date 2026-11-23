// e2e for the pings a playlist write sends after it LANDS (docs/feeds.md):
//   - lib/community/archive-notify.ts: one GitHub workflow_dispatch of
//     playlist-archive.yml ("The GitHub copy");
//   - lib/community/pi-notify.ts: the Podcast Index notice ("Podcast Index"). On a
//     publish or SAVE: the rules (`piNoticeAllowed`: one notice per feed per 10
//     minutes, a first notice counts against 5 per owner and 30 over all a day), then
//     `hub/pubnotify` with NO key headers, the podping, a SECOND `hub/pubnotify`, and a
//     read-key lookup (`podcasts/byguid`, then `podcasts/byfeedurl`) whose id is stored.
//     On a delete: one `hub/pubnotify` and the podping. Never `add/byfeedurl`.
//   - lib/community/podping-notify.ts: one podping (medium musicL) through the
//     msp-podping-service pusher, with each notice.
// A refused write sends none of them.
//
// NOTHING REACHES GITHUB, PODCAST INDEX OR HIVE. One stub on 127.0.0.1 plays all
// three; the override variables accept only a loopback address (`archiveDispatchBase`,
// `piNotifyBase`, `podpingEndpoint`), and a non-loopback one turns the ping OFF,
// never real. The podping token here is a test value, `test-podping-token`.
// `PI_NOTIFY_SETTLE_MS` shortens the wait before the second pubnotify; the server takes
// it only toward a loopback stub (`piSecondNotifyMs`):
//   node scripts/e2e-playlist-pings.mjs --stub 48555                  (in one shell)
//   COMMUNITY_DB_URL=postgres://… ADMIN_NPUBS=<the npub printed below> \
//   NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on NEXT_PUBLIC_COMMUNITY_FEED_ORIGIN=http://localhost:3123 \
//   GITHUB_ARCHIVE_TOKEN=test-archive-token PLAYLIST_ARCHIVE_API=http://127.0.0.1:48555 \
//   COMMUNITY_PI_NOTIFY=on PI_NOTIFY_API=http://127.0.0.1:48555 PI_NOTIFY_SETTLE_MS=1000 \
//   PODPING_ENDPOINT_URL=http://127.0.0.1:48555/podping PODPING_BEARER_TOKEN=test-podping-token \
//   npm run dev -- -p 3123
//   COMMUNITY_DB_URL=postgres://… STUB_URL=http://127.0.0.1:48555 node scripts/e2e-playlist-pings.mjs
// APP_URL overrides the server, on this machine only (scripts/local-target.mjs). The main
// run needs the server's COMMUNITY_DB_URL (local only, `localDbUrl`): it moves a notice
// time back past the 10-minute window, and adds deleted rows to fill the daily caps.
//
// The server still needs the real PODCAST_INDEX_KEY/SECRET in .env.local: the
// publish route verifies each song against Podcast Index (a READ). The stub
// records only whether PI's auth headers are present, never their values.
//
// `--browser`: PUBLISH, SAVE and DELETE pressed in the maker, in headless Chrome,
// at 1280 x 900 and at 390 x 844. Same server as above.
//
// `--quiet-server`: restart the server with the three overrides set to
// `http://127.0.0.1.nip.io:48555` (the podping one to `.../podping`). That name
// resolves to the stub, so if a guard let it through, the stub would count it.
// Publish, edit and delete send nothing.
//
// `--pi-switch-off`: restart the server as in the main run but WITHOUT
// COMMUNITY_PI_NOTIFY. A publish then sends the GitHub ping and no PI call and no
// podping (one switch covers both).
//
// `--no-podping`: restart the server as in the main run but WITHOUT the two
// PODPING_* variables. The Podcast Index calls go as usual and no podping is sent.
//
// Same NIP-98 signing and per-5-requests x-real-ip as e2e-community-api.mjs, and
// the same test-only admin key (07…07). It deletes what it makes.

import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { getToken } from 'nostr-tools/nip98';
import { npubEncode } from 'nostr-tools/nip19';
import { localAppUrl, localDbUrl } from './local-target.mjs';

const DISPATCH = '/repos/ChadFarrow/boostmebitch/actions/workflows/playlist-archive.yml/dispatches';
const PI_ADD = '/api/1.0/add/byfeedurl';
const PI_PING = '/api/1.0/hub/pubnotify';
const PI_BYGUID = '/api/1.0/podcasts/byguid';
const PI_BYURL = '/api/1.0/podcasts/byfeedurl';
const PODPING = '/podping';
const PODPING_TOKEN = 'test-podping-token';
const LISTED_ID = 7777777;
/** The marker on the rows the cap half adds straight to the database. */
const SYNTHETIC = 'e2e-playlist-pings synthetic cap row';

// ── the stub ────────────────────────────────────────────────────────────────
const stubAt = process.argv.indexOf('--stub');
if (stubAt >= 0) {
  const port = Number(process.argv[stubAt + 1]);
  const PP_OK = { status: 200, delayMs: 0, location: null, body: { message: 'enqueued' } };
  const PING_OK = { status: 200, delayMs: 0 };
  let log = [];
  let ppMode = PP_OK;
  let pingMode = PING_OK;
  // Lookups: a miss, as PI answers a feed it does not hold, unless a guid or a feed
  // URL is named here, which answers as listed under LISTED_ID.
  let listed = { guids: [], urls: [] };
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  // What a reader the ping woke would get: the stub reads the feed AS THE PING ARRIVES,
  // the way Podcast Index and a podping reader do, before it answers. Loopback only, so
  // the stub never fetches anything off this machine.
  const readFeed = async (url) => {
    try {
      const u = new URL(url);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return { status: 'not-loopback' };
      const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(7000) });
      const t = await r.text();
      return { status: r.status, title: (t.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? null };
    } catch (e) {
      return { status: 'error', error: String(e?.message ?? e) };
    }
  };
  http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const u = new URL(req.url, 'http://stub');
      if (u.pathname === '/__log') {
        if (req.method === 'DELETE') log = [];
        return json(res, 200, log);
      }
      if (u.pathname === '/__ppmode') {
        ppMode = body ? { ...PP_OK, ...JSON.parse(body) } : PP_OK;
        return json(res, 200, ppMode);
      }
      if (u.pathname === '/__pingmode') {
        pingMode = body ? { ...PING_OK, ...JSON.parse(body) } : PING_OK;
        return json(res, 200, pingMode);
      }
      if (u.pathname === '/__listed') {
        listed = body ? { guids: [], urls: [], ...JSON.parse(body) } : { guids: [], urls: [] };
        return json(res, 200, listed);
      }
      const h = req.headers;
      const entry = { at: Date.now(), method: req.method, path: u.pathname, ua: h['user-agent'] ?? null };
      if (u.pathname === PODPING) {
        // The token is a test value, so it may be compared; only the verdict is logged.
        Object.assign(entry, {
          url: u.searchParams.get('url'),
          reason: u.searchParams.get('reason'),
          medium: u.searchParams.get('medium'),
          detailed: u.searchParams.get('detailed_response'),
          params: [...u.searchParams.keys()].length,
          bearerOk: h.authorization === `Bearer ${PODPING_TOKEN}`,
          tokenInUrl: req.url.includes(PODPING_TOKEN),
        });
      } else if (u.pathname.startsWith('/api/1.0/')) {
        Object.assign(entry, {
          url: u.searchParams.get('url'),
          guid: u.searchParams.get('guid'),
          piAuth: !!h['x-auth-key'] && /^\d+$/.test(h['x-auth-date'] ?? '') && /^[0-9a-f]{40}$/.test(h.authorization ?? ''),
          // ANY of PI's three key headers: a keyless pubnotify carries none.
          anyKeyHeader: !!(h['x-auth-key'] || h['x-auth-date'] || h.authorization),
        });
      } else {
        Object.assign(entry, { auth: h.authorization, accept: h.accept, version: h['x-github-api-version'], body });
      }
      if (u.pathname === PI_PING || u.pathname === PODPING) entry.fed = await readFeed(entry.url);
      log.push(entry);
      if (u.pathname === PI_ADD) return json(res, 401, { status: 'false', description: 'Authorization error' });
      if (u.pathname === PI_BYGUID) {
        return listed.guids.includes(entry.guid)
          ? json(res, 200, { status: 'true', feed: { id: LISTED_ID, podcastGuid: entry.guid, medium: 'musicL' }, description: 'Found matching feed.' })
          : json(res, 200, { status: 'true', feed: [], description: 'No feeds match this guid.' });
      }
      if (u.pathname === PI_BYURL) {
        return listed.urls.includes(entry.url)
          ? json(res, 200, { status: 'true', feed: { id: LISTED_ID, url: entry.url, medium: 'musicL' }, description: 'Found matching feed.' })
          : json(res, 400, { status: 'false', description: 'Feed url not found.' });
      }
      if (u.pathname === PODPING) {
        const m = ppMode;
        return setTimeout(() => {
          if (m.location) { res.writeHead(m.status, { location: m.location }); res.end(); } else json(res, m.status, m.body);
        }, m.delayMs);
      }
      if (u.pathname === PI_PING) {
        const m = pingMode;
        return setTimeout(() => json(res, m.status, m.status === 200
          ? { status: 'true', description: 'Feed marked for immediate update.' }
          : { status: 'false', description: 'Server error' }), m.delayMs);
      }
      res.writeHead(204);
      res.end();
    });
  }).listen(port, '127.0.0.1', () => console.log(`stub GitHub + Podcast Index API + podping pusher on http://127.0.0.1:${port}`));
} else {
  await run();
}

async function run() {
  const APP = localAppUrl('http://localhost:3123');
  const DB_URL = localDbUrl();
  const STUB = (process.env.STUB_URL || 'http://127.0.0.1:48555').replace(/\/$/, '');
  const QUIET = process.argv.includes('--quiet-server');
  const PI_OFF = process.argv.includes('--pi-switch-off');
  const PP_OFF = process.argv.includes('--no-podping');
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
  const ppMode = (m) => fetch(`${STUB}/__ppmode`, { method: 'POST', body: m ? JSON.stringify(m) : '' });
  const pingMode = (m) => fetch(`${STUB}/__pingmode`, { method: 'POST', body: m ? JSON.stringify(m) : '' });
  const listedIn = (m) => fetch(`${STUB}/__listed`, { method: 'POST', body: m ? JSON.stringify(m) : '' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const feedOf = (id) => `${APP}/feeds/playlists/${id}.xml`;
  const LOOKS = new Set([PI_BYGUID, PI_BYURL]);

  /**
   * `after()` runs once the response is sent: wait until the expected number of
   * calls arrived (or `waitMs` passed), give a straggler 700 ms, then count each kind.
   * `ping`: hub/pubnotify calls (two for a publish notice, one for a delete).
   * `look`: Podcast Index lookups (byguid, byfeedurl). An add/byfeedurl is never right.
   * `feeds`: every PI call must name one of these, and the pings must cover them all.
   * `fed`: what the stub must have read from the feed as each ping and podping arrived —
   * `{ status, title }`, `title` a string or `{ [feedUrl]: title }`. The write must have
   * LANDED before anything announces it: a reader the ping wakes gets the new feed.
   */
  const expectCalls = async (label, { gh, ping, look = 0, pp = PP_OFF ? 0 : (ping ? Math.max(1, ping - 1) : 0), feeds, fed, waitMs = 4000 }) => {
    const total = gh + ping + look + pp;
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
    const looks = log.filter((e) => LOOKS.has(e.path));
    const got = {
      gh: by(DISPATCH).length, add: by(PI_ADD).length, ping: by(PI_PING).length, look: looks.length, pp: by(PODPING).length,
      other: log.length - by(DISPATCH).length - by(PI_ADD).length - by(PI_PING).length - looks.length - by(PODPING).length,
    };
    check(`${label}: GitHub ${gh}, PI pubnotify ${ping}, PI lookups ${look}, podping ${pp}, no add`,
      got.gh === gh && got.add === 0 && got.ping === ping && got.look === look && got.pp === pp && got.other === 0,
      `got ${JSON.stringify(got)}: ${JSON.stringify(log)}`);
    const pings = by(PI_PING);
    if (pings.length) {
      check(`${label}: every pubnotify is a GET with a User-Agent and NO key header`,
        pings.every((e) => e.method === 'GET' && !!e.ua && e.anyKeyHeader === false), JSON.stringify(pings));
    }
    if (looks.length) {
      check(`${label}: every lookup carries the read key's three headers`, looks.every((e) => e.method === 'GET' && e.piAuth === true), JSON.stringify(looks));
      // One feed only: several feeds are announced side by side.
      if (feeds?.length === 1) check(`${label}: the lookups come after the last pubnotify`,
        looks.every((l) => pings.every((p) => p.at <= l.at)), JSON.stringify(log.map((e) => [e.path, e.at])));
    }
    if (feeds) {
      const pi = log.filter((e) => e.path.startsWith('/api/1.0/') && e.url !== null);
      check(`${label}: every PI call names the playlist's feed URL`, pi.every((e) => feeds.includes(e.url)), JSON.stringify(pi.map((e) => e.url)));
      if (ping) check(`${label}: a ping for each feed`, feeds.every((f) => pings.some((e) => e.url === f)), JSON.stringify(pings.map((e) => e.url)));
    }
    if (pp) {
      const pps = by(PODPING);
      if (feeds) check(`${label}: a podping for each feed, and for no other`, pps.length === feeds.length && feeds.every((f) => pps.some((e) => e.url === f)), JSON.stringify(pps.map((e) => e.url)));
      check(`${label}: every podping is musicL, update, four parameters, a GET with the Bearer token`,
        pps.every((e) => e.method === 'GET' && e.medium === 'musicL' && e.reason === 'update' && e.detailed === 'true' && e.params === 4 && e.bearerOk && !!e.ua), JSON.stringify(pps));
      check(`${label}: the token is in no URL`, pps.every((e) => e.tokenInUrl === false));
    }
    if (fed && (ping || pp)) {
      const reads = log.filter((e) => e.path === PI_PING || e.path === PODPING);
      const want = (e) => (typeof fed.title === 'object' ? fed.title[e.url] : fed.title);
      check(`${label}: as each ping and podping arrived, the feed read ${fed.status}${fed.title ? ' with the saved title' : ''}`,
        reads.length === ping + pp && reads.every((e) => e.fed?.status === fed.status && (fed.title === undefined || e.fed?.title === want(e))),
        JSON.stringify(reads.map((e) => ({ path: e.path, url: e.url, fed: e.fed }))));
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
  // Build the feed route once, so the first ping's read of it does not wait on a compile.
  await fetch(feedOf('00000000-0000-4000-8000-000000000000'));
  await ppMode(null);
  await pingMode(null);
  await listedIn(null);
  await clear();
  const finish = () => { console.log(`${count - fails}/${count} passed`); process.exit(fails ? 1 : 0); };

  if (QUIET || PI_OFF) {
    const name = QUIET ? 'quiet server' : 'PI switch off';
    const c = await call('POST', PLAYLISTS, { sk: owner, body: { draft: draft() } });
    check(`${name}: publish -> 201`, c.status === 201, JSON.stringify(c));
    await expectCalls(`${name}: publish`, { gh: QUIET ? 0 : 1, ping: 0 });
    const at = (await call('GET', `${PLAYLISTS}/${c.body?.id}`)).body?.playlist?.updatedAt;
    const e = await call('PUT', `${PLAYLISTS}/${c.body?.id}`, { sk: owner, body: { draft: draft({ title: 'e2e playlist pings 2' }), expectedUpdatedAt: at } });
    check(`${name}: edit -> 200`, e.status === 200, JSON.stringify(e).slice(0, 300));
    await expectCalls(`${name}: edit`, { gh: QUIET ? 0 : 1, ping: 0 });
    const d = await call('DELETE', `${PLAYLISTS}/${c.body?.id}`, { sk: owner });
    check(`${name}: delete -> 200`, d.status === 200, JSON.stringify(d));
    await expectCalls(`${name}: delete`, { gh: QUIET ? 0 : 1, ping: 0 });
    finish();
  }

  if (!DB_URL) {
    console.log('FAIL the main run needs the server\'s COMMUNITY_DB_URL (a local database): it moves notice times and fills the caps');
    process.exit(1);
  }
  const { default: pg } = await import('pg');
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  // Earlier runs' first notices would count against today's caps: move them a day back.
  await db.query(`update community_playlists set pi_first_notified_at = pi_first_notified_at - interval '2 days'
                   where pi_first_notified_at > now() - interval '1 day'`);
  await db.query('delete from community_playlists where title = $1', [SYNTHETIC]);
  /** Move the last notice past the 10-minute window, as if the maker came back later. */
  const later = (id) => db.query(`update community_playlists set pi_notified_at = pi_notified_at - interval '11 minutes' where id = $1`, [id]);
  const piRow = async (id) => (await db.query(
    'select pi_feed_id, pi_notified_at, pi_first_notified_at from community_playlists where id = $1', [id])).rows[0] ?? null;
  /** `n` deleted rows whose first notice was a moment ago, owned by `pubkey` (or by strangers). */
  const fillCap = async (n, pubkey) => {
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      await db.query(
        `insert into community_playlists (id, owner_pubkey, title, songs, podcast_guid, deleted_at, deleted_by, pi_notified_at, pi_first_notified_at)
         values ($1, $2, $3, '[]'::jsonb, $4, now(), 'e2e', now() - interval '1 hour', now() - interval '1 hour')`,
        [id, pubkey ?? randomBytes(32).toString('hex'), SYNTHETIC, randomUUID()]);
    }
  };
  const finishDb = async () => { await db.query('delete from community_playlists where title = $1', [SYNTHETIC]); await db.end(); finish(); };

  // Refused writes send nothing.
  const bad = await call('POST', PLAYLISTS, { sk: owner, body: { draft: draft({ title: '' }) } });
  check('publish with no title -> 400', bad.status === 400, JSON.stringify(bad));
  await expectCalls('a refused publish', { gh: 0, ping: 0 });
  const unsigned = await call('POST', PLAYLISTS, { body: { draft: draft() } });
  check('unsigned publish -> 401', unsigned.status === 401, JSON.stringify(unsigned));
  await expectCalls('an unsigned publish', { gh: 0, ping: 0 });

  // Publish: one dispatch in GitHub's exact form; a keyless pubnotify and the podping,
  // a second pubnotify, then the two lookups (the stub does not list the feed).
  const c = await call('POST', PLAYLISTS, { sk: owner, body: { draft: draft() } });
  check('publish -> 201', c.status === 201, JSON.stringify(c));
  const id = c.body.id;
  const feed = feedOf(id);
  check('the 201 names the feed URL the pings must carry', c.body.feedUrl === feed, c.body.feedUrl);
  check('no response body carries the podping token', !JSON.stringify(c).includes('test-podping-token'));
  const log = await expectCalls('a publish', { gh: 1, ping: 2, look: 2, feeds: [feed], fed: { status: 200, title: 'e2e playlist pings' } });
  const d = log.find((e) => e.path === DISPATCH);
  check('the dispatch is a POST to the playlist-archive workflow', d?.method === 'POST', JSON.stringify(d));
  check('it carries the token as a Bearer header', d?.auth === 'Bearer test-archive-token');
  check('it names GitHub\'s media type and API version', d?.accept === 'application/vnd.github+json' && d?.version === '2022-11-28');
  check('it has a User-Agent (GitHub requires one)', !!d?.ua);
  check('its body is only { ref: "main" }: no playlist data', d?.body === '{"ref":"main"}', d?.body);
  const pings = log.filter((e) => e.path === PI_PING);
  check(`the second pubnotify waits for the settle time (${pings[1]?.at - pings[0]?.at} ms apart)`, pings.length === 2 && pings[1].at - pings[0].at >= 900);
  const looks = log.filter((e) => LOOKS.has(e.path));
  const guid = looks.find((e) => e.path === PI_BYGUID)?.guid;
  check('the lookups ask byguid with the feed guid, then byfeedurl', looks.map((e) => e.path).join() === [PI_BYGUID, PI_BYURL].join() && /^[0-9a-f-]{36}$/.test(guid ?? ''), JSON.stringify(looks));
  let row = await piRow(id);
  check('the store records the first notice, and no PI id', !!row?.pi_first_notified_at && !!row?.pi_notified_at && row?.pi_feed_id === null, JSON.stringify(row));
  let updatedAt = (await call('GET', `${PLAYLISTS}/${id}`)).body?.playlist?.updatedAt;

  const edit = async (title) => {
    const r = await call('PUT', `${PLAYLISTS}/${id}`, { sk: owner, body: { draft: draft({ title }), expectedUpdatedAt: updatedAt } });
    if (r.status === 200) updatedAt = r.body?.playlist?.updatedAt;
    return r;
  };

  // A SAVE inside 10 minutes: saved, and no notice (the throttle).
  const quick = await edit('e2e playlist pings 2');
  check('edit by the owner -> 200', quick.status === 200, JSON.stringify(quick).slice(0, 300));
  await expectCalls('a SAVE inside 10 minutes (throttled)', { gh: 1, ping: 0 });
  // Past the window: the notice again, and the lookups again (still no PI id).
  await later(id);
  const prev = (await piRow(id)).pi_notified_at;
  const put = await edit('e2e playlist pings 3');
  check('edit after the window -> 200', put.status === 200);
  await expectCalls('a SAVE after the window', { gh: 1, ping: 2, look: 2, feeds: [feed], fed: { status: 200, title: 'e2e playlist pings 3' } });
  row = await piRow(id);
  check('the store moved the last notice time', row.pi_notified_at > prev, JSON.stringify(row));
  const stale = await call('PUT', `${PLAYLISTS}/${id}`, { sk: owner, body: { draft: draft({ title: 'stale' }), expectedUpdatedAt: '2020-01-01T00:00:00.000Z' } });
  check('edit with a stale expectedUpdatedAt -> 409', stale.status === 409, JSON.stringify(stale));
  await expectCalls('a stale edit', { gh: 0, ping: 0 });
  const hijack = await call('PUT', `${PLAYLISTS}/${id}`, { sk: other, body: { draft: draft({ title: 'hijack' }), expectedUpdatedAt: updatedAt } });
  check('edit by another key -> 403', hijack.status === 403, JSON.stringify(hijack));
  await expectCalls('a forbidden edit', { gh: 0, ping: 0 });

  // Two SAVEs at once past the window: the version check lets one land, and one notice goes.
  await later(id);
  const cur = (await call('GET', `${PLAYLISTS}/${id}`)).body?.playlist;
  const [s1, s2] = await Promise.all(['e2e playlist pings 4a', 'e2e playlist pings 4b'].map((title) =>
    call('PUT', `${PLAYLISTS}/${id}`, { sk: owner, body: { draft: draft({ title }), expectedUpdatedAt: cur.updatedAt } })));
  check('two SAVEs at once: one lands, one is stale (409)', [s1.status, s2.status].sort().join() === '200,409', `${s1.status} ${s2.status}`);
  updatedAt = (s1.status === 200 ? s1 : s2).body?.playlist?.updatedAt;
  await expectCalls('the SAVE that landed', { gh: 1, ping: 2, look: 2, feeds: [feed] });

  // PI lists the feed: the guid lookup answers, the byfeedurl one is not asked, and the
  // store keeps the id; the next notice asks nothing.
  await listedIn({ guids: [guid] });
  await later(id);
  await edit('e2e playlist pings 5');
  await expectCalls('a SAVE once PI lists the feed', { gh: 1, ping: 2, look: 1, feeds: [feed], fed: { status: 200, title: 'e2e playlist pings 5' } });
  row = await piRow(id);
  check(`the store keeps the PI id (${row?.pi_feed_id})`, String(row?.pi_feed_id) === String(LISTED_ID), JSON.stringify(row));
  await listedIn(null);
  await later(id);
  await edit('e2e playlist pings 6');
  await expectCalls('a SAVE of a feed with a PI id: no lookup', { gh: 1, ping: 2, look: 0, feeds: [feed], fed: { status: 200, title: 'e2e playlist pings 6' } });

  // PI's pubnotify hangs: the response does not wait, and both go after their timeouts.
  await pingMode({ delayMs: 10_000 });
  await later(id);
  const slow = await edit('e2e playlist pings 7');
  check('edit while PI hangs -> 200', slow.status === 200);
  check(`...and the response does not wait for PI (${slow.ms} ms)`, slow.ms < 5000);
  await expectCalls('an edit while PI hangs (each pubnotify times out at 8 s)', { gh: 1, ping: 2, feeds: [feed], waitMs: 22_000 });
  // PI answers 500: the save is unchanged, nothing retries.
  await pingMode({ status: 500 });
  await later(id);
  const five = await edit('e2e playlist pings 8');
  check('edit while PI answers 500 -> 200', five.status === 200);
  await expectCalls('an edit PI answers 500', { gh: 1, ping: 2, feeds: [feed] });
  await pingMode(null);

  // The pusher (podping) misbehaves: the save still succeeds, and one podping is tried.
  if (!PP_OFF) {
    const pusher = [
      ['the pusher answers 401', { status: 401, body: { message: 'unauthorized' } }],
      ['the pusher calls it a duplicate', { body: { message: 'duplicate' } }],
      // A redirect is never followed: the token must not go where the pusher points.
      ['the pusher redirects (not followed: no other call)', { status: 302, location: '/leak' }],
      ['the pusher hangs', { delayMs: 10_000 }],
    ];
    let n = 9;
    for (const [what, m] of pusher) {
      await ppMode(m);
      await later(id);
      const title = `e2e playlist pings ${n++}`;
      const r = await edit(title);
      check(`edit while ${what} -> 200`, r.status === 200, JSON.stringify(r).slice(0, 300));
      if (m.delayMs) check(`...and the response does not wait for the pusher (${r.ms} ms)`, r.ms < 5000);
      await expectCalls(`an edit while ${what}`, { gh: 1, ping: 2, feeds: [feed], fed: { status: 200, title }, waitMs: 12_000 });
    }
    await ppMode(null);
  }

  // Owner delete: one ping and the podping (PI cannot delete; it reads the 410). No rules.
  const del = await call('DELETE', `${PLAYLISTS}/${id}`, { sk: owner });
  check('delete by the owner -> 200', del.status === 200, JSON.stringify(del));
  await expectCalls('an owner delete', { gh: 1, ping: 1, pp: PP_OFF ? 0 : 1, feeds: [feed], fed: { status: 410 } });
  const del2 = await call('DELETE', `${PLAYLISTS}/${id}`, { sk: owner });
  check('delete again -> 410', del2.status === 410, JSON.stringify(del2));
  await expectCalls('a second delete', { gh: 0, ping: 0 });

  // Three playlists by another key (a key made in the browser looks the same to the server).
  const made = [];
  for (const t of ['A', 'B', 'C']) made.push(await call('POST', PLAYLISTS, { sk: other, body: { draft: draft({ title: `e2e playlist pings ${t}` }) } }));
  check('three playlists by another key -> 201 x3', made.every((m) => m.status === 201), JSON.stringify(made.map((m) => m.status)));
  const [fa, fb, fc] = made.map((m) => feedOf(m.body.id));
  await expectCalls('three publishes', { gh: 3, ping: 6, look: 6, pp: PP_OFF ? 0 : 3, feeds: [fa, fb, fc],
    fed: { status: 200, title: { [fa]: 'e2e playlist pings A', [fb]: 'e2e playlist pings B', [fc]: 'e2e playlist pings C' } } });

  // The owner cap: three first notices today plus two more is five. The sixth new
  // playlist publishes and its feed works, with no notice.
  const otherPub = getPublicKey(other);
  await fillCap(2, otherPub);
  const capped = await call('POST', PLAYLISTS, { sk: other, body: { draft: draft({ title: 'e2e playlist pings capped' }) } });
  check('a sixth new playlist today -> 201', capped.status === 201, JSON.stringify(capped));
  await expectCalls('a publish over the owner cap', { gh: 1, ping: 0 });
  check('its feed answers 200', (await fetch(feedOf(capped.body.id))).status === 200);
  check('the store records no notice for it', (await piRow(capped.body.id))?.pi_first_notified_at === null);
  // A feed told before is not new: its SAVE past the window is announced over the cap.
  await later(made[1].body.id);
  const bAt = (await call('GET', `${PLAYLISTS}/${made[1].body.id}`)).body?.playlist?.updatedAt;
  const bSave = await call('PUT', `${PLAYLISTS}/${made[1].body.id}`, { sk: other, body: { draft: draft({ title: 'e2e playlist pings B2' }), expectedUpdatedAt: bAt } });
  check('a SAVE of a feed told before, at the owner cap -> 200', bSave.status === 200);
  await expectCalls('a SAVE at the owner cap of a feed told before', { gh: 1, ping: 2, look: 2, feeds: [fb], fed: { status: 200, title: 'e2e playlist pings B2' } });

  // The global cap: 30 first notices today over all makers stop a stranger's first one.
  const today = Number((await db.query(`select count(*) from community_playlists where pi_first_notified_at > now() - interval '1 day'`)).rows[0].count);
  await fillCap(Math.max(0, 30 - today));
  const stranger = Uint8Array.from(randomBytes(32));
  const g = await call('POST', PLAYLISTS, { sk: stranger, body: { draft: draft({ title: 'e2e playlist pings global cap' }) } });
  check('a new maker\'s first playlist over the global cap -> 201', g.status === 201, JSON.stringify(g));
  await expectCalls('a publish over the global cap', { gh: 1, ping: 0 });

  // /admin: the Podcast Index state, looked up while the page loads; the capped
  // playlists are listed with no notice, and a listed one gets its id stored.
  await listedIn({ urls: [feedOf(g.body.id)] });
  const adm = await call('GET', `${PLAYLISTS}/admin`, { sk: ADMIN_SK });
  check('admin GET -> 200 with a Podcast Index state per playlist', adm.status === 200 && Array.isArray(adm.body?.pi), JSON.stringify(adm.body?.pi)?.slice(0, 300));
  const st = (pid) => adm.body?.pi?.find((x) => x.id === pid);
  check('admin: the owner-capped playlist: not in PI, never told, asked now',
    st(capped.body.id)?.piFeedId === null && st(capped.body.id)?.piNotifiedAt === null && st(capped.body.id)?.asked === true, JSON.stringify(st(capped.body.id)));
  check('admin: a told playlist PI does not list: not in PI, with its notice time', st(made[0].body.id)?.piFeedId === null && !!st(made[0].body.id)?.piNotifiedAt);
  check('admin: the one PI lists (by URL): its id, stored', st(g.body.id)?.piFeedId === LISTED_ID
    && String((await piRow(g.body.id))?.pi_feed_id) === String(LISTED_ID), JSON.stringify(st(g.body.id)));
  check('admin: no deleted playlist', !st(id));
  const admLog = await stubLog();
  check('admin: only lookups, each with the read key, no pubnotify, no podping, no add',
    admLog.length > 0 && admLog.every((e) => LOOKS.has(e.path) && e.piAuth === true), JSON.stringify(admLog.slice(0, 5)));
  await clear();
  await listedIn(null);
  const forbid = await call('GET', `${PLAYLISTS}/admin`, { sk: other });
  check('admin GET by a maker -> 403, and no lookup', forbid.status === 403 && (await stubLog()).length === 0);
  await clear();

  // Admin delete, ban with and without deleteAll: a ping and a podping each.
  const ad = await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'delete', id: made[0].body.id } });
  check('admin delete -> deleted 1', ad.body?.deleted === 1, JSON.stringify(ad));
  await expectCalls('an admin delete', { gh: 1, ping: 1, pp: PP_OFF ? 0 : 1, feeds: [fa], fed: { status: 410 } });
  const ad2 = await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'delete', id: made[0].body.id } });
  check('admin delete again -> deleted 0', ad2.body?.deleted === 0, JSON.stringify(ad2));
  await expectCalls('an admin delete of a deleted playlist', { gh: 0, ping: 0 });
  const banOnly = await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'ban', pubkey: otherPub } });
  check('ban only -> ok, deleted 0', banOnly.body?.ok === true && banOnly.body?.deleted === 0, JSON.stringify(banOnly));
  await expectCalls('a ban that deletes nothing', { gh: 0, ping: 0 });
  const banAll = await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'ban', pubkey: otherPub, deleteAll: true } });
  check('ban and delete all -> deleted 3', banAll.body?.deleted === 3, JSON.stringify(banAll));
  const fcap = feedOf(capped.body.id);
  await expectCalls('a ban that deletes three playlists', { gh: 1, ping: 3, pp: PP_OFF ? 0 : 3, feeds: [fb, fc, fcap], fed: { status: 410 } });
  const unban = await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'unban', pubkey: otherPub } });
  check('unban -> ok', unban.body?.ok === true, JSON.stringify(unban));
  await expectCalls('an unban', { gh: 0, ping: 0 });
  const gDel = await call('DELETE', `${PLAYLISTS}/${g.body.id}`, { sk: stranger });
  check('the stranger deletes the global-cap playlist -> 200', gDel.status === 200);
  await expectCalls('that delete', { gh: 1, ping: 1, pp: PP_OFF ? 0 : 1, feeds: [feedOf(g.body.id)], fed: { status: 410 } });
  // This run's first notices leave today's count, so the next run starts from zero.
  await db.query(`update community_playlists set pi_first_notified_at = pi_first_notified_at - interval '2 days'
                   where pi_first_notified_at > now() - interval '1 day'`);

  await finishDb();
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
    await expectCalls(`${s.name}: PUBLISH pressed in the page`, { gh: 1, ping: 2, look: 2, feeds: [feedUrl] });
    // The status line: the real lookup (a localhost feed is never in Podcast Index).
    check(`${s.name}: published: the Podcast Index line says waiting, with no button`,
      await waitFor(`document.querySelector('[data-testid=pi-listing]')?.dataset.pi === 'waiting'`, 20000)
      && await js(`document.querySelector('[data-testid=pi-listing]').innerText.startsWith('Podcast Index: waiting') && !document.querySelector('[data-testid=pi-listing] a, [data-testid=pi-listing] button')`),
      await js(`document.querySelector('[data-testid=pi-listing]')?.outerHTML ?? 'no line'`));
    const id = /feeds\/playlists\/([0-9a-f-]{36})\.xml$/.exec(feedUrl)?.[1];
    check(`${s.name}: the feed address names the new playlist`, !!id, feedUrl);

    await go(`/playlists/make?id=${id}`);
    check(`${s.name}: EDIT opens with SAVE`, await waitFor(`document.querySelector('#pl-title') && !!${byText('SAVE')}`));
    await js(`(() => { const el = document.querySelector('#pl-title');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(`${title} v2`)});
      el.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
    await click(byText('SAVE'));
    check(`${s.name}: SAVE shows the Published view with the new title`, await waitFor(`document.querySelector('[data-testid=published]')?.innerText.includes(${JSON.stringify(`${title} v2`)})`, 30000));
    // Inside 10 minutes of the PUBLISH: saved and copied, no notice (the throttle).
    await expectCalls(`${s.name}: SAVE pressed in the page`, { gh: 1, ping: 0 });

    await go(`/playlists/make?id=${id}`);
    await waitFor(`!!${byText('DELETE')}`);
    await click(byText('DELETE'));
    check(`${s.name}: DELETE asks first`, await waitFor(`document.querySelector('[role=dialog]')?.innerText.includes('Delete this playlist?')`));
    await expectCalls(`${s.name}: the DELETE question alone`, { gh: 0, ping: 0 });
    await click(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'DELETE')`);
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) { gone = (await fetch(feedUrl)).status === 410; if (!gone) await wait(250); }
    check(`${s.name}: the feed answers 410 after DELETE`, gone);
    await expectCalls(`${s.name}: DELETE confirmed in the page`, { gh: 1, ping: 1, pp: 1, feeds: [feedUrl] });
  }
  relay.close();
  return exit;
}
