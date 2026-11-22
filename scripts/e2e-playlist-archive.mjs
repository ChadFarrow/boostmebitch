// e2e for the GitHub copy of the community playlists (docs/feeds.md, "The GitHub
// copy"): scripts/playlist-archive.mjs and scripts/playlist-archive-git.sh run
// exactly as .github/workflows/playlist-archive.yml runs them, against a dev
// server's real feeds, with a LOCAL bare git repo in place of GitHub.
//
// What it proves, that `check:playlistarchive` (pure functions) cannot:
// - a playlist deleted from the site, by the ADMIN action and by its owner, keeps
//   its last copy: the file moves, byte for byte, to playlists/removed/, git
//   records a rename, and index.json lists it under `removed` with the time;
// - the next runs commit NOTHING (the removal time is carried, not stamped again),
//   also when no list answers;
// - with COMMUNITY_DB_URL given to this script too: a row restored by hand in the
//   database moves back out of removed/, and a second delete stamps a new time.
//
// Needs a dev server started as for scripts/e2e-community-api.mjs (its header):
//   COMMUNITY_DB_URL=postgres://postgres:test@localhost:54329/postgres
//   ADMIN_NPUBS=npub1nzwqkakt2cuhrlwfhme3asrvx4s0xfyadm57tkpu2a39t9hqtahs7fsn89
//   NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on NEXT_PUBLIC_COMMUNITY_FEED_ORIGIN=http://localhost:3123
//   npm run dev -- -p 3123
// APP_URL overrides the server. Pass the same COMMUNITY_DB_URL to this script for
// the restore half (both on this machine only: scripts/local-target.mjs); without it that half is skipped and says so.
//
// NOTHING LEAVES THE MACHINE but the song reads the API e2e makes too: no GitHub
// (the remote is a bare repo in a temp folder, and GITHUB_TOKEN is removed from the
// job's environment), no Podcast Index, no relay. It deletes what it makes.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeEvent } from 'nostr-tools/pure';
import { getToken } from 'nostr-tools/nip98';
import { localAppUrl, localDbUrl } from './local-target.mjs';

const APP = localAppUrl('http://localhost:3123');
const DB_URL = localDbUrl();
const PLAYLISTS = '/api/community-playlists';
const HERE = dirname(fileURLToPath(import.meta.url));
const ARCHIVE = join(HERE, 'playlist-archive.mjs');
const GIT = join(HERE, 'playlist-archive-git.sh');
// TEST-ONLY admin key, the one scripts/e2e-community-api.mjs uses (public, worthless).
const ADMIN_SK = Uint8Array.from(Buffer.from('07'.repeat(32), 'hex'));
// A song source: "New Music Nudge Unit", as in scripts/e2e-community-api.mjs.
const SONG_SOURCE = 'https://v4vmusic.com/playlist/334bb12d-1f72-4c0e-88e1-266bd1e2dff9.xml';

let fails = 0;
let count = 0;
const check = (label, cond, detail = '') => {
  count++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) { fails++; if (detail) console.log(`         ${detail}`); }
  return !!cond;
};

let sent = 0;
const nextIp = () => `10.97.${Math.floor(sent++ / 5) % 250}.${Math.floor(Math.random() * 250) + 1}`;

async function call(method, path, { sk, body } = {}) {
  const h = { 'x-real-ip': nextIp() };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (sk) h.authorization = await getToken(`${APP}${path.split('?')[0]}`, method, (e) => finalizeEvent(e, sk), true, body);
  const res = await fetch(`${APP}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const feedUrl = (id) => `${APP}/feeds/playlists/${id}.xml`;
const feedStatus = async (id) => (await fetch(feedUrl(id), { redirect: 'manual' })).status;
const exists = (p) => stat(p).then(() => true, () => false);

const res = await fetch(`${APP}${PLAYLISTS}`).catch(() => null);
if (!res || res.status !== 200) {
  console.log(`FAIL nothing serves ${APP}${PLAYLISTS} with the switch on (got ${res?.status ?? 'no answer'}). Start the dev server (see the top of this file).`);
  process.exit(1);
}

// ── set-up: 12 real songs, two playlists of one owner ───────────────────────
const src = await call('GET', `/api/playlist?url=${encodeURIComponent(SONG_SOURCE)}&limit=40`);
const songs = (src.body?.episodes ?? []).filter((e) => !e.unresolved && e.guid && e.podcastGuid).slice(0, 12)
  .map((e) => ({ feedGuid: e.podcastGuid, itemGuid: e.guid }));
if (songs.length < 12) {
  console.log(`FAIL could not read 12 songs from ${APP}/api/playlist (got ${songs.length})`);
  process.exit(1);
}
const owner = Uint8Array.from(randomBytes(32));
const tag = Math.random().toString(36).slice(2, 7);
const publish = async (title) => {
  const r = await call('POST', PLAYLISTS, { sk: owner, body: { draft: { title, description: 'made by e2e-playlist-archive', artUrl: null, songs } } });
  return r.body?.id ?? null;
};
const A = await publish(`e2e archive A ${tag}`);
const B = await publish(`e2e archive B ${tag}`);
check('two playlists published', !!A && !!B, JSON.stringify([A, B]));
if (!A || !B) process.exit(1);

// ── the job, as the workflow runs it ────────────────────────────────────────
const tmp = await mkdtemp(join(tmpdir(), 'bmb-archive-e2e-'));
const remote = join(tmp, 'remote.git');
execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'ignore' });
const jobEnv = { ...process.env, ARCHIVE_REMOTE: remote, ARCHIVE_BRANCH: 'playlists' };
delete jobEnv.GITHUB_TOKEN;
delete jobEnv.GITHUB_ACTIONS;
let runs = 0;
const sh = (cmd, args) => execFileSync(cmd, args, { env: jobEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

/** One run of the three workflow steps; returns what it wrote and whether it pushed. */
async function job(list = `${APP}${PLAYLISTS}`) {
  const work = join(tmp, `work-${++runs}`);
  const msg = join(tmp, `message-${runs}.txt`);
  sh('bash', [GIT, 'checkout', work]);
  const out = sh('node', [ARCHIVE, '--root', work, '--list', list, '--feed-origin', APP, '--message-file', msg]);
  const summary = JSON.parse(out.trim().split('\n').pop());
  const pushed = /^pushed /m.test(sh('bash', [GIT, 'push', work, msg]));
  const index = await readFile(join(work, 'playlists', 'index.json'), 'utf8');
  return { work, summary, pushed, message: await readFile(msg, 'utf8'), index, json: JSON.parse(index) };
}
const live = (r, id) => join(r.work, 'playlists', `${id}.xml`);
const removed = (r, id) => join(r.work, 'playlists', 'removed', `${id}.xml`);
const ids = (list) => list.map((e) => e.id);

try {
  console.log('--- run 1: both playlists are copied');
  const r1 = await job();
  check('run 1 pushed a commit', r1.pushed, r1.message);
  const copyA = await readFile(live(r1, A), 'utf8');
  check('the copy of A is the feed, byte for byte', copyA === await (await fetch(feedUrl(A))).text());
  check('the index lists A and B, and no removed copy', ids(r1.json.playlists).includes(A) && ids(r1.json.playlists).includes(B)
    && Array.isArray(r1.json.removed) && r1.json.removed.length === 0, r1.index);

  console.log('--- the admin deletes A');
  const before = Date.now();
  const del = await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'delete', id: A } });
  check('admin delete -> 200, deleted 1', del.status === 200 && del.body?.deleted === 1, JSON.stringify(del));
  check('A\'s feed answers 410', await feedStatus(A) === 410);

  console.log('--- run 2: A moves to playlists/removed/');
  const r2 = await job();
  const after = Date.now();
  check('run 2 pushed a commit', r2.pushed, r2.message);
  check('the summary counts one removal', r2.summary.removed === 1, JSON.stringify(r2.summary));
  check('A is no longer in playlists/', !(await exists(live(r2, A))));
  check('A is in playlists/removed/, byte for byte the last copy', (await readFile(removed(r2, A), 'utf8').catch(() => '')) === copyA);
  const eA = r2.json.removed.find((e) => e.id === A);
  const tA = Date.parse(eA?.removed ?? '');
  check('the index lists A under removed, with its file and the time of this run',
    !!eA && eA.file === `removed/${A}.xml` && tA >= before - 1000 && tA <= after + 1000, JSON.stringify(eA));
  check('and no longer among the live playlists, while B stays', !ids(r2.json.playlists).includes(A) && ids(r2.json.playlists).includes(B));
  check('the commit message says it was removed from the site', /1 removed from the site/.test(r2.message)
    && r2.message.includes('playlists/removed/') && r2.message.includes(A), r2.message);
  const status = sh('git', ['-C', r2.work, 'diff', '--name-status', '-M', 'HEAD~1', 'HEAD']);
  check('git records a rename, not a delete', new RegExp(`^R100\\s+playlists/${A}\\.xml\\s+playlists/removed/${A}\\.xml$`, 'm').test(status), status);

  console.log('--- run 3: nothing changed, nothing is committed');
  const r3 = await job();
  check('run 3 pushed nothing', !r3.pushed && r3.summary.removed === 0, JSON.stringify(r3.summary));
  check('and wrote the same index (the removal time is carried)', r3.index === r2.index);
  check('the removed copy is not asked about again', r3.summary.visited === r2.summary.visited - 1, JSON.stringify([r2.summary.visited, r3.summary.visited]));

  console.log('--- run 4: no list answers');
  const r4 = await job('http://127.0.0.1:9/nothing-here');
  check('run 4 pushed nothing, and A stays removed', !r4.pushed && await exists(removed(r4, A)) && r4.index === r2.index, r4.message);

  console.log('--- the owner deletes B');
  const delB = await call('DELETE', `${PLAYLISTS}/${B}`, { sk: owner });
  check('owner delete -> 200', delB.status === 200, JSON.stringify(delB));
  const r5 = await job();
  check('run 5: B moves to removed/ too', r5.pushed && await exists(removed(r5, B)) && !(await exists(live(r5, B))), r5.message);
  check('newest removal first, and A keeps its time', JSON.stringify(ids(r5.json.removed).filter((x) => x === A || x === B)) === JSON.stringify([B, A])
    && r5.json.removed.find((e) => e.id === A)?.removed === eA.removed, JSON.stringify(r5.json.removed));

  if (!DB_URL) {
    console.log('--- restore half SKIPPED: give this script the server\'s COMMUNITY_DB_URL to run it');
  } else {
    console.log('--- A is restored by hand in the database');
    const { default: pg } = await import('pg');
    const db = new pg.Client({ connectionString: DB_URL });
    await db.connect();
    try {
      await db.query('update community_playlists set deleted_at = null, deleted_by = null where id = $1', [A]);
      check('A\'s feed answers 200 again', await feedStatus(A) === 200);
      const r6 = await job();
      check('run 6: A is back in playlists/ and gone from removed/', r6.pushed && await exists(live(r6, A)) && !(await exists(removed(r6, A))), r6.message);
      check('the index has A live again, and B still removed', ids(r6.json.playlists).includes(A)
        && !ids(r6.json.removed).includes(A) && ids(r6.json.removed).includes(B));
      check('the commit message says A is back on the site', /1 back on the site/.test(r6.message), r6.message);
      const del2 = await call('POST', `${PLAYLISTS}/admin`, { sk: ADMIN_SK, body: { action: 'delete', id: A } });
      check('deleted again', del2.body?.deleted === 1);
      const r7 = await job();
      const tA2 = Date.parse(r7.json.removed.find((e) => e.id === A)?.removed ?? '');
      check('run 7: a second delete stamps a NEW time', r7.pushed && tA2 > tA, JSON.stringify([eA.removed, tA2]));
    } finally {
      await db.end();
    }
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
  // Both playlists end deleted (410) whatever happened above.
  await call('DELETE', `${PLAYLISTS}/${A}`, { sk: owner });
  await call('DELETE', `${PLAYLISTS}/${B}`, { sk: owner });
}

console.log(`\n${count - fails}/${count} passed`);
process.exit(fails ? 1 : 0);
