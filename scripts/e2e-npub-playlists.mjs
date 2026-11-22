#!/usr/bin/env node
/**
 * e2e: an npub's page (`/npub/<npub>`) lists the community playlists that npub
 * made, and only while community playlists are switched on.
 *
 * Asked for on 2026-11-19 ("Could that also show people's playlists since they
 * have npubs in them?", then "add this to the beta feature for playlist so that
 * feature ships with playlists"). `<NpubPlaylists>` reads
 * `/api/community-playlists?owner=<hex>`; this drives it in a real browser.
 *
 * Needs the LOCAL Postgres and a dev server started with, on the command line:
 *   COMMUNITY_DB_URL=postgres://postgres:test@localhost:54329/postgres \
 *   NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on NEXT_PUBLIC_COMMUNITY_FEED_ORIGIN=http://localhost:3124 \
 *   npm run dev -- -p 3124
 * and the same COMMUNITY_DB_URL in this script's environment: it writes its own
 * rows straight into that database (three throwaway keys) and deletes them at the
 * end. It REFUSES a database that is not on this machine — beta and production
 * share one real store, and nothing here may ever write to it.
 *
 * The switch-OFF half is a second run against a server started WITHOUT
 * NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on: `node scripts/e2e-npub-playlists.mjs --off`.
 *
 * What it drives, signed out:
 * - a maker with three playlists: the section, its count, the rows newest first,
 *   the track counts (one singular), no NOT IN PI stamp, and the section ABOVE
 *   "Boosts sent";
 * - opening a row: the show view on `/` with "← back to boosts", and that link
 *   back to the same npub page;
 * - folding the section, kept across a reload, and unfolding it;
 * - an npub with no playlists: the store answers, and NOTHING renders;
 * - the store failing: the heading with RETRY and no rows; RETRY then lists them;
 * - a slow answer for one npub after the page moved to another: the late rows
 *   never paint on the second person's page. (Next mounts a new page for each
 *   npub, so this passes even without the component's own guard — measured. It
 *   pins what the reader sees, not the guard.);
 * - the viewer muting the maker: the count stays, the rows are hidden, and the
 *   page says why;
 * - under phone emulation (390×844): no sideways overflow, a 24px fold control
 *   and 24px rows;
 * - with the switch off: no section and no request.
 *
 * The browser resolves no host but this machine, so nothing reaches a relay.
 *
 *   APP_URL=http://localhost:3124 COMMUNITY_DB_URL=… node scripts/e2e-npub-playlists.mjs
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { localAppUrl, localDbUrl } from './local-target.mjs';

const OFF = process.argv.includes('--off');
const APP = localAppUrl('http://localhost:3124');
const DB_URL = localDbUrl();
if (!DB_URL) {
  console.error('Set COMMUNITY_DB_URL to the LOCAL test database (see the top of this file).');
  process.exit(2);
}
await requireApp(APP, `Nothing is serving ${APP}. Start the dev server (see the top of this file).`);

const key = () => {
  const pk = getPublicKey(generateSecretKey());
  return { pk, npub: nip19.npubEncode(pk) };
};
const A = key(); // three playlists
const B = key(); // none
const C = key(); // one

const db = new pg.Pool({ connectionString: DB_URL, max: 2 });
const now = Date.now();
const rows = [
  // owner, title, songs, age in minutes (bigger = older)
  [A, 'e2e A oldest', 3, 30],
  [A, 'e2e A middle', 1, 20],
  [A, 'e2e A newest', 12, 10],
  [C, 'e2e C only', 2, 5],
];
for (const [o, title, n, ageMin] of rows) {
  const at = new Date(now - ageMin * 60_000).toISOString();
  const songs = Array.from({ length: n }, (_, i) => ({ feedGuid: randomUUID(), itemGuid: `e2e-${i}` }));
  await db.query(
    `insert into community_playlists (id, owner_pubkey, owner_name, title, description, art_url, songs, podcast_guid, created_at, updated_at)
     values ($1, $2, $3, $4, $5, null, $6, $7, $8, $8)`,
    [randomUUID(), o.pk, 'e2e maker', title, 'made by e2e-npub-playlists', JSON.stringify(songs), randomUUID(), at],
  );
}
const cleanup = () => db.query('delete from community_playlists where owner_pubkey = any($1)', [[A.pk, B.pk, C.pk]]);

const t = checker();
const { page } = await launchChrome({
  name: `npubplaylists-${process.env.CLAUDE_CODE_SESSION_ID || 'local'}`,
  args: ['--window-size=1280,900', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
});
const { send, js, jsOrThrow, until } = page;
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');

/** Every answer the page got from the owner list, in order: `{ owner, status }`. */
const answers = [];
page.on((m) => {
  if (m.method !== 'Network.responseReceived') return;
  const u = m.params.response.url;
  if (!u.includes('/api/community-playlists?owner=')) return;
  answers.push({ owner: new URL(u).searchParams.get('owner'), status: m.params.response.status });
});

async function go(path) {
  await send('Page.navigate', { url: `${APP}${path}` });
  await wait(400);
  await until('document.readyState === "complete"', 30000);
}
const SECTION = '[data-npub-playlists]';
const hasSection = () => js(`!!document.querySelector('${SECTION}')`);
/** The section as the reader sees it. */
const readSection = () => jsOrThrow(`(() => {
  const s = document.querySelector('${SECTION}');
  if (!s) return null;
  const toggle = s.querySelector('header button');
  return {
    heading: s.querySelector('h2')?.textContent.trim() ?? null,
    expanded: toggle?.getAttribute('aria-expanded'),
    count: toggle?.querySelector('.text-xs')?.textContent.trim() ?? null,
    rows: [...s.querySelectorAll('li')].map((li) => li.textContent.replace(/\\s+/g, ' ').trim()),
    failed: !!s.querySelector('[data-npub-playlists-failed]'),
    retry: !!s.querySelector('[data-npub-playlists-failed] button'),
    text: s.textContent.replace(/\\s+/g, ' ').trim(),
  };
})()`);
const sentHeading = `[...document.querySelectorAll('h2')].find((h) => /Boosts sent/.test(h.textContent))`;
const waitAnswer = async (owner, from) => {
  for (let i = 0; i < 80; i++) {
    if (answers.slice(from).some((a) => a.owner === owner)) return true;
    await wait(100);
  }
  return false;
};

try {
  if (OFF) {
    console.log('— switch OFF —');
    const from = answers.length;
    await go(`/npub/${A.npub}`);
    t.ok('the boost page renders', await until(`!!${sentHeading}`, 20000));
    await wait(2000);
    t.ok('no playlists section', !(await hasSection()));
    t.equal('no request to the owner list', answers.slice(from).length, 0);
  } else {
    console.log('— desktop, a maker with three playlists —');
    let from = answers.length;
    await go(`/npub/${A.npub}`);
    t.ok('the section appears', await until(`!!document.querySelector('${SECTION} li')`, 20000));
    t.ok('the store answered 200', answers.slice(from).some((a) => a.owner === A.pk && a.status === 200));
    let s = await readSection();
    t.ok('the heading says Playlists', /Playlists/.test(s.heading), s.heading);
    t.equal('the count', s.count, '(3)');
    t.equal('three rows', s.rows.length, 3);
    t.ok('newest first', /A newest/.test(s.rows[0]) && /A middle/.test(s.rows[1]) && /A oldest/.test(s.rows[2]), JSON.stringify(s.rows));
    t.ok('12 tracks', /12 tracks/.test(s.rows[0]), s.rows[0]);
    t.ok('1 track, singular', /1 track(?!s)/.test(s.rows[1]), s.rows[1]);
    t.ok('3 tracks', /3 tracks/.test(s.rows[2]), s.rows[2]);
    t.ok('no NOT IN PI stamp', !/NOT IN PI/.test(s.text));
    t.ok('the section sits above "Boosts sent"', await js(`(() => {
      const sec = document.querySelector('${SECTION}');
      const sent = ${sentHeading};
      return !!(sec && sent && (sec.compareDocumentPosition(sent) & Node.DOCUMENT_POSITION_FOLLOWING));
    })()`));

    console.log('— open a row, then come back —');
    await jsOrThrow(`document.querySelector('${SECTION} li > button').click()`);
    t.ok('the show view opens on /', await until(`location.pathname === '/'`, 10000));
    t.ok('"← back to boosts" is offered', await until(
      `[...document.querySelectorAll('a')].some((a) => /back to boosts/.test(a.textContent))`, 10000));
    t.equal('it links to this npub', await js(
      `[...document.querySelectorAll('a')].find((a) => /back to boosts/.test(a.textContent))?.getAttribute('href')`),
    `/npub/${A.npub}`);
    await jsOrThrow(`[...document.querySelectorAll('a')].find((a) => /back to boosts/.test(a.textContent)).click()`);
    t.ok('back on the npub page', await until(`location.pathname === '/npub/${A.npub}'`, 10000));
    t.ok('the section is there again', await until(`!!document.querySelector('${SECTION} li')`, 10000));

    console.log('— fold, reload, unfold —');
    await jsOrThrow(`document.querySelector('${SECTION} header button').click()`);
    await wait(200);
    s = await readSection();
    t.equal('folded: aria-expanded', s.expanded, 'false');
    t.equal('folded: no rows', s.rows.length, 0);
    t.equal('folded: the count stays', s.count, '(3)');
    t.ok('the fold is stored', await js(`JSON.parse(localStorage.getItem('bmb:sect_collapsed') || '[]').includes('npub:playlists')`));
    await go(`/npub/${A.npub}`);
    await until(`!!document.querySelector('${SECTION}')`, 20000);
    await wait(300);
    s = await readSection();
    t.equal('still folded after a reload', s.expanded, 'false');
    await jsOrThrow(`document.querySelector('${SECTION} header button').click()`);
    await wait(200);
    s = await readSection();
    t.equal('unfolded', s.expanded, 'true');
    t.equal('unfolded: rows back', s.rows.length, 3);
    t.ok('the fold is cleared', await js(`!JSON.parse(localStorage.getItem('bmb:sect_collapsed') || '[]').includes('npub:playlists')`));

    console.log('— an npub with no playlists —');
    from = answers.length;
    await go(`/npub/${B.npub}`);
    t.ok('the store answered for it', await waitAnswer(B.pk, from));
    t.ok('the boost page renders', await until(`!!${sentHeading}`, 20000));
    await wait(800);
    t.ok('no section at all', !(await hasSection()));

    console.log('— the store fails, then RETRY —');
    await send('Fetch.enable', { patterns: [{ urlPattern: '*api/community-playlists?owner=*', requestStage: 'Request' }] });
    let failNext = true;
    const held = [];
    let hold = false;
    const offFetch = page.on((m) => {
      if (m.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = m.params;
      if (failNext) {
        failNext = false;
        void send('Fetch.fulfillRequest', {
          requestId, responseCode: 503,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from('{"error":"down"}').toString('base64'),
        });
      } else if (hold) {
        held.push({ requestId, owner: new URL(request.url).searchParams.get('owner') });
      } else {
        void send('Fetch.continueRequest', { requestId });
      }
    });
    await go(`/npub/${A.npub}`);
    t.ok('the failure is shown', await until(`!!document.querySelector('[data-npub-playlists-failed]')`, 20000));
    s = await readSection();
    t.ok('with RETRY', s.retry);
    t.equal('and no rows', s.rows.length, 0);
    t.equal('and no count', s.count, null);
    await jsOrThrow(`document.querySelector('[data-npub-playlists-failed] button').click()`);
    t.ok('RETRY lists them', await until(`document.querySelectorAll('${SECTION} li').length === 3`, 10000));
    s = await readSection();
    t.ok('the failure line is gone', !s.failed);

    console.log('— a late answer for the npub the page left —');
    hold = true;
    await go(`/npub/${A.npub}`);
    for (let i = 0; i < 50 && !held.some((h) => h.owner === A.pk); i++) await wait(100);
    t.ok("A's request is held", held.some((h) => h.owner === A.pk));
    // Client-side, so the component stays mounted and only `pubkey` changes.
    const pushed = await js(`(() => { if (!window.next?.router?.push) return false; window.next.router.push('/npub/${C.npub}'); return true; })()`);
    if (!pushed) {
      t.fail('client-side navigation is available (window.next.router)');
    } else {
      t.ok('moved to C', await until(`location.pathname === '/npub/${C.npub}'`, 10000));
      for (let i = 0; i < 50 && !held.some((h) => h.owner === C.pk); i++) await wait(100);
      await wait(500);
      // Release EVERY held request for an owner: a dev build mounts the page
      // twice (React StrictMode), so each npub may be asked for twice, and only
      // the newest of those may paint.
      const release = async (owner) => {
        const mine = held.filter((h) => h.owner === owner && !h.done);
        for (const h of mine) { h.done = true; await send('Fetch.continueRequest', { requestId: h.requestId }); }
        return mine.length;
      };
      t.ok("C's request is held", (await release(C.pk)) > 0);
      t.ok("C's playlist shows", await until(`document.querySelectorAll('${SECTION} li').length === 1`, 10000));
      t.ok("A's request was still held", (await release(A.pk)) > 0);
      await wait(1500);
      s = await readSection();
      t.ok('the section is still there', !!s);
      s = s ?? { rows: [], count: null };
      t.equal("A's late answer did not paint", s.rows.length, 1);
      t.ok("the one row is C's", /C only/.test(s.rows[0] ?? ''), JSON.stringify(s.rows));
      t.equal('the count is C\'s', s.count, '(1)');
    }
    hold = false;
    offFetch();
    await send('Fetch.disable');

    console.log('— the viewer has muted the maker —');
    await jsOrThrow(`localStorage.setItem('bmb:muted:guest', JSON.stringify({ publicPubkeys: ['${A.pk}'], privatePubkeys: [], updatedAt: 1 }))`);
    await go(`/npub/${A.npub}`);
    t.ok('the section still shows', await until(`!!document.querySelector('${SECTION} header')`, 20000));
    await wait(300);
    s = await readSection();
    t.equal('the count stays', s.count, '(3)');
    t.equal('the rows are hidden', s.rows.length, 0);
    t.ok('the page says why', /you have muted this npub/.test(s.text), s.text);
    await jsOrThrow(`localStorage.removeItem('bmb:muted:guest')`);

    console.log('— phone, 390×844 —');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await go(`/npub/${A.npub}`);
    t.ok('the section appears', await until(`document.querySelectorAll('${SECTION} li').length === 3`, 20000));
    await wait(500);
    const m = await jsOrThrow(`(() => {
      const de = document.documentElement;
      const toggle = document.querySelector('${SECTION} header button').getBoundingClientRect();
      const rows = [...document.querySelectorAll('${SECTION} li > button')].map((b) => b.getBoundingClientRect());
      return {
        scrollW: de.scrollWidth, clientW: de.clientWidth,
        toggle: [toggle.width, toggle.height],
        rowsMinH: Math.min(...rows.map((r) => r.height)),
        rowsInside: rows.every((r) => r.left >= 0 && r.right <= de.clientWidth + 0.5),
      };
    })()`);
    t.ok('no sideways overflow', m.scrollW <= m.clientW, `${m.scrollW} > ${m.clientW}`);
    t.ok('the fold control is at least 24×24', m.toggle[0] >= 24 && m.toggle[1] >= 24, JSON.stringify(m.toggle));
    t.ok('each row is at least 24px tall', m.rowsMinH >= 24, String(m.rowsMinH));
    t.ok('each row fits the screen', m.rowsInside);
    await send('Emulation.clearDeviceMetricsOverride');
  }
} catch (e) {
  t.fail('the run threw', e?.stack ?? String(e));
} finally {
  await cleanup().catch((e) => console.log(`  (cleanup failed: ${e.message})`));
  await db.end().catch(() => {});
}

console.log(`\n${t.count - t.fails}/${t.count} passed`);
await exit(t.fails ? 1 : 0);
