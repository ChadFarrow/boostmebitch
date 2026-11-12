// e2e for the community-playlist screens (maker, home button), in a real browser.
//
// Needs a dev server started with, on the command line (never in .env.local):
//   COMMUNITY_DB_URL=postgres://postgres:test@localhost:54329/postgres
//   ADMIN_NPUBS=<any npub> NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on
//   NEXT_PUBLIC_COMMUNITY_FEED_ORIGIN=http://localhost:3123 npm run dev -- -p 3123
// and the schema applied (`npm run community:schema`). APP_URL overrides the server.
// The signer is a throwaway key behind a fake NIP-07 `window.nostr`, and relays point
// at a LOCAL relay, so nothing reaches a public relay.
import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { getToken } from 'nostr-tools/nip98';

const APP = (process.env.APP_URL || 'http://localhost:3123').replace(/\/$/, '');
await requireApp(APP, `Nothing is serving ${APP}. Start the dev server (see the top of this file).`);

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const npub = nip19.npubEncode(pk);
// A second throwaway key, for "someone else opens my playlist". The fake signer answers with `cur`.
const sk2 = generateSecretKey();
const pk2 = getPublicKey(sk2);
const npub2 = nip19.npubEncode(pk2);
let cur = { sk, pk };
// A fresh fake client address per run, so the 6-writes-a-minute limit never makes a run wait.
const IP = `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
const relay = createRelay({ port: 0, log: null });
const PORT = await relay.ready;

const { page } = await launchChrome({
  name: `communityui-${process.env.CLAUDE_CODE_SESSION_ID || 'local'}`,
  args: ['--disable-gpu'],
});
const { send } = page;
const js = page.jsOrThrow;
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Network.setExtraHTTPHeaders', { headers: { 'x-real-ip': IP } });

// A window.nostr indistinguishable from an extension, reached over a CDP binding.
await send('Runtime.addBinding', { name: 'bmbSigner' });
page.on(async (m) => {
  if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'bmbSigner') return;
  const { rid, fn, args } = JSON.parse(m.params.payload);
  let out, err = null;
  try {
    if (fn === 'getPublicKey') out = cur.pk;
    else if (fn === 'signEvent') out = finalizeEvent(args[0], cur.sk);
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
    window.nostr = { getPublicKey: () => call('getPublicKey'), signEvent: (e) => window.__silent ? new Promise(() => {}) : call('signEvent', e) };
  })();
` });

const t = checker();
const SONG_SOURCE = 'https://v4vmusic.com/playlist/334bb12d-1f72-4c0e-88e1-266bd1e2dff9.xml';
const ART_TOO_SMALL = 'https://headstarts.uk/msp/hear-my-roar/hearmyroar%20logo.jpg';
const KEY = `bmb:playlist_draft:${npub}`;
const editKey = (id) => `${KEY}:${id}`;
await send('Page.navigate', { url: APP });
await wait(500);
await js(`(() => { localStorage.clear(); return 1; })()`);


// ---- helpers ---------------------------------------------------------------
const phone = () => send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
const waitFor = async (expr, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await js(`!!(${expr})`)) return true; await wait(250); }
  return false;
};
const go = async (path) => { await send('Page.navigate', { url: `${APP}${path}` }); await wait(1500); };
const body = () => js(`document.body.innerText`);
const overflowFree = () => js(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`);
const tooSmall = (sel, w = 24, h = 24) => js(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => { const r = e.getBoundingClientRect(); return r.width < ${w} || r.height < ${h}; }).map((e) => e.textContent.trim() || e.getAttribute('aria-label'))`);
const click = (finder) => js(`(() => { const b = ${finder}; if (b) b.click(); return !!b; })()`);
const byText = (label) => `[...document.querySelectorAll('main button, main a')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
const setValue = (sel, v) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(v)});
  el.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
const rows = () => js(`document.querySelectorAll('[data-song-row]').length`);
const stored = () => js(`localStorage.getItem(${JSON.stringify(KEY)})`).then((v) => (v ? JSON.parse(v) : null));
const seed = (draft, labels = {}) => js(`(() => { localStorage.setItem(${JSON.stringify(KEY)}, JSON.stringify({
  draft: ${JSON.stringify(draft)}, editingId: null, expectedUpdatedAt: null, labels: ${JSON.stringify(labels)} })); return 1; })()`);
const signedIn = () => js(`(() => { localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))});
  localStorage.setItem('bmb:npub', ${JSON.stringify(npub)}); localStorage.setItem('bmb:signer', 'nip07'); return 1; })()`);

// ---- twelve real songs from the app's own resolver ---------------------------
const src = await fetch(`${APP}/api/playlist?url=${encodeURIComponent(SONG_SOURCE)}&limit=40`).then((r) => r.json()).catch(() => ({}));
const real = (src.episodes ?? []).filter((e) => !e.unresolved && e.guid && e.podcastGuid).slice(0, 12);
t.ok('twelve real songs to seed with', real.length === 12, `got ${real.length}`);
const songs = real.map((e) => ({ feedGuid: e.podcastGuid, itemGuid: e.guid }));
const labels = Object.fromEntries(real.map((e) => [e.guid, { title: e.title, ...(e.feedTitle ? { artist: e.feedTitle } : {}) }]));
const draft = (over = {}) => ({ title: 'e2e community playlist', description: 'made by e2e-community-ui', artUrl: null, songs, ...over });

await phone();

// ---- 1. home: the button, next to BROWSE PLAYLISTS ---------------------------
console.log('--- 1. home: MAKE PLAYLIST next to BROWSE PLAYLISTS (390 x 844) ---');
await go('/');
t.ok('home shows + MAKE PLAYLIST', await waitFor(`document.body.innerText.includes('+ MAKE PLAYLIST')`), 'not found');
const pair = await js(`(() => { const f = (t) => [...document.querySelectorAll('a')].find((a) => a.textContent.trim() === t)?.getBoundingClientRect();
  const a = f('♫ BROWSE PLAYLISTS'), b = f('+ MAKE PLAYLIST'); return a && b ? { sameRow: Math.abs(a.top - b.top) < 4, gap: b.left - a.right } : null; })()`);
t.ok('both buttons on one row', pair?.sameRow === true, JSON.stringify(pair));
t.ok('home: no horizontal overflow', await overflowFree());
t.equal('home: both buttons at least 24 x 24', await tooSmall('section[aria-labelledby="home-playlists-heading"] a'), []);

// ---- 2. signed out: the maker asks for sign-in --------------------------------
console.log('--- 2. signed out ---');
await go('/playlists/make');
t.ok('signed out: the page says SIGN IN', await waitFor(`document.querySelector('main')?.innerText.includes('SIGN IN')`));
t.ok('and the SIGN IN button is there to press', await click(byText('SIGN IN')));
await wait(600);
t.ok('SIGN IN opens the sign-in dialog', await js(`!!document.querySelector('[role="dialog"]')`));
t.ok('signed out: no horizontal overflow', await overflowFree());

// ---- 3. signed in: the saved draft comes back ----------------------------------
console.log('--- 3. signed in: the saved draft ---');
await go('/');
await signedIn();
await seed(draft(), labels);
await go('/playlists/make');
t.ok('the form appears', await waitFor(`document.querySelector('#pl-title')`));
await wait(500);
t.equal('the saved title is back', await js(`document.querySelector('#pl-title').value`), 'e2e community playlist');
t.equal('twelve rows', await rows(), 12);
t.ok('a row shows the saved title, no fetch', (await body()).includes(real[0].title));
const txt = await body();
for (const w of ['TITLE', 'DESCRIPTION', 'PLAYLIST ART LINK', '+ ADD SONGS', 'PUBLISH',
  'Square, 1400–3000 px. Empty: BMB makes the cover from the first four songs.',
  'Only you can change this playlist.']) t.ok(`copy: ${w}`, txt.includes(w), 'missing');
t.ok('footer names the signer', /Signed in as \S+/.test(txt));
t.equal('row buttons are labelled', await js(`['Move up','Move down','Remove'].map((l) => document.querySelectorAll('[aria-label="' + l + '"]').length)`), [12, 12, 12]);
t.equal('row buttons are at least 32 x 32', await tooSmall('[data-song-row] button', 32, 32), []);
t.equal('every button on the page is at least 24 x 24', await tooSmall('main button, main a', 24, 24), []);
t.ok('maker: no horizontal overflow', await overflowFree());
t.ok('PUBLISH is on with 12 songs and a title', await js(`!${byText('PUBLISH')}.disabled`));

console.log('--- 4. the reason PUBLISH is off ---');
await setValue('#pl-title', '');
await wait(300);
t.ok('no title: PUBLISH is off', await js(`${byText('PUBLISH')}.disabled`));
t.ok('and it says Add a title', (await js(`document.querySelector('[data-testid=why-blocked]')?.innerText`)) === 'Add a title');
await setValue('#pl-title', 'shit mix');
await wait(300);
t.ok('profanity: shows what will publish', (await body()).includes('Will publish as: **** mix'));
await setValue('#pl-title', 'e2e community playlist');
await click(`document.querySelectorAll('[aria-label="Remove"]')[0]`);
await click(`document.querySelectorAll('[aria-label="Remove"]')[0]`);
await wait(300);
t.equal('two removed: ten left, PUBLISH on', await js(`[document.querySelectorAll('[data-song-row]').length, !${byText('PUBLISH')}.disabled]`), [10, true]);
await click(`document.querySelectorAll('[aria-label="Remove"]')[0]`);
await wait(300);
t.equal('nine songs: PUBLISH off, says Add 1 more', await js(`[${byText('PUBLISH')}.disabled, document.querySelector('[data-testid=why-blocked]')?.innerText]`), [true, 'Add 1 more song']);
const first = real[3].guid; // the one now second
await click(`document.querySelectorAll('[aria-label="Move down"]')[0]`);
await wait(300);
t.ok('down moves a row', (await js(`document.querySelectorAll('[data-song-row]')[1].innerText`)).includes(real[3].title));
await wait(300);
const saved = await stored();
t.equal('the draft on disk has nine songs and the new order', [saved?.draft.songs.length, saved?.draft.songs[1].itemGuid], [9, first]);
await go('/playlists/make');
await waitFor(`document.querySelector('#pl-title')`);
await wait(500);
t.equal('after a reload: same title and nine rows', [await js(`document.querySelector('#pl-title').value`), await rows()], ['e2e community playlist', 9]);

console.log('--- 5. the server says no ---');
await seed(draft({ songs: [...songs.slice(0, 11), { feedGuid: songs[0].feedGuid, itemGuid: 'no-such-song-guid-e2e' }] }), { ...labels, 'no-such-song-guid-e2e': { title: 'Ghost Song' } });
await go('/playlists/make');
await waitFor(`document.querySelector('#pl-title')`); await wait(500);
await click(byText('PUBLISH'));
t.ok('a song that is not found is named', await waitFor(`document.querySelector('[data-testid=refusals]')?.innerText.includes('Ghost Song')`, 30000));
t.ok('the page stays on the maker', await js(`!document.querySelector('[data-testid=published]')`));
await seed(draft({ artUrl: ART_TOO_SMALL }), labels);
await go('/playlists/make');
await waitFor(`document.querySelector('#pl-title')`); await wait(500);
await click(byText('PUBLISH'));
t.ok('a small picture is refused in words', await waitFor(`document.querySelector('[data-testid=refusals]')?.innerText.includes('The picture must be at least 1400 × 1400 px.')`, 30000));
t.ok('with the cover preview still on screen', await js(`!!document.querySelector('[data-testid=cover-preview]')`));

console.log('--- 6. a silent signer ---');
await seed(draft(), labels);
await go('/playlists/make');
await waitFor(`document.querySelector('#pl-title')`); await wait(500);
await setValue('#pl-desc', 'still here after a timeout');
await js(`window.__silent = true; window.__bmbSignTimeoutMs = 400; 1`);
await click(byText('PUBLISH'));
t.ok('no answer: the page says so', await waitFor(`document.querySelector('[data-testid=refusals]')?.innerText.includes('signer did not answer')`, 10000));
t.ok('and PUBLISH is on again', await js(`!${byText('PUBLISH')}.disabled`));
t.equal('and the draft is still in localStorage', (await stored())?.draft.description, 'still here after a timeout');
await js(`window.__silent = false; delete window.__bmbSignTimeoutMs; 1`);

console.log('--- 7. publish, edit, save, delete ---');
await click(byText('PUBLISH'));
t.ok('a 201 shows the Published view', await waitFor(`document.querySelector('[data-testid=published]')`, 30000));
const pub = await body();
t.ok('with the track count', pub.includes('♫ PLAYLIST · 12 TRACKS'));
for (const w of ['PLAY', 'EDIT', 'SHARE', 'COPY', 'Paste this address into any Podcasting 2.0 app to follow the playlist. It updates when you edit it.'])
  t.ok(`published: ${w}`, pub.includes(w), 'missing');
const feedUrl = await js(`document.querySelector('#feed-address').value`);
const id = /feeds\/playlists\/([0-9a-f-]{36})\.xml$/.exec(feedUrl)?.[1];
t.ok('the feed address is the playlist feed', !!id, feedUrl);
t.equal('the feed answers 200', (await fetch(feedUrl)).status, 200);
t.equal('the saved draft is gone', await stored(), null);
t.ok('published: no horizontal overflow', await overflowFree());
t.equal('published: controls at least 24 x 24', await tooSmall('main button, main a, main input', 24, 24), []);


// Node-side PUT as the owner: makes the page's version number stale.
const putAsOwner = async (draftBody, expected) => {
  const url = `${APP}/api/community-playlists/${id}`;
  const payload = { draft: draftBody, expectedUpdatedAt: expected };
  const token = await getToken(url, 'PUT', (e) => finalizeEvent(e, sk), true, payload);
  return fetch(url, { method: 'PUT', headers: { authorization: token, 'content-type': 'application/json', 'x-real-ip': IP }, body: JSON.stringify(payload) });
};
const serverVersion = async () => (await (await fetch(`${APP}/api/community-playlists/${id}`)).json()).playlist;
const openEdit = async () => {
  await go(`/playlists/make?id=${id}`);
  return waitFor(`document.querySelector('#pl-title') && !!${byText('SAVE')}`, 20000);
};


console.log('--- 7b. add songs: SEARCH and FAVORITES (390 x 844) ---');
// A fresh, empty draft, a title, and favorites seeded the way the signed-in cache is stored.
const favKey = `bmb:favepisodes:${npub}`;
const favs = Object.fromEntries(real.slice(6, 12).map((e, i) => [e.guid, {
  itemGuid: e.guid, feedGuid: e.podcastGuid, title: e.title, podcastTitle: e.feedTitle ?? 'Artist', medium: 'music', addedAt: 1000 + i }]));
favs['ep-podcast-guid'] = { itemGuid: 'ep-podcast-guid', feedGuid: 'feed-podcast-guid', title: 'A Podcast Episode', medium: 'podcast', addedAt: 5000 };
favs['undef-with-enclosure'] = { itemGuid: 'undef-with-enclosure', feedGuid: 'feed-x', title: 'Undefined Medium Episode', enclosureUrl: 'https://example.com/a.mp3', addedAt: 5002 };
favs['no-feed-guid'] = { itemGuid: 'no-feed-guid', title: 'Orphan Track', medium: 'music', addedAt: 5001 };
await go('/');
await js(`localStorage.setItem(${JSON.stringify(favKey)}, ${JSON.stringify(JSON.stringify(favs))}); 1`);
await js(`localStorage.removeItem(${JSON.stringify(KEY)}); 1`);
await go('/playlists/make');
await waitFor(`document.querySelector('#pl-title')`); await wait(500);
await setValue('#pl-title', 'sheet playlist');
const dlg = (sel) => `document.querySelector('[role=dialog]')${sel ? '.querySelector(' + JSON.stringify(sel) + ')' : ''}`;
const dlgBtn = (label) => `[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
t.ok('+ ADD SONGS opens the sheet', await click(byText('+ ADD SONGS')) && await waitFor(dlg()));
t.ok('the header reads 0 in sheet playlist', await waitFor(`document.querySelector('[data-testid=add-count]')?.innerText === '0 in sheet playlist'`));
t.ok('the one-at-a-time line is shown', (await js(`document.querySelector('[role=dialog]').innerText`)).includes('Pick songs one at a time. A whole album cannot go in.'));
// a pasted secret key is refused and never fetched
await js(`window.__searchCalls = 0; const f = window.fetch; window.fetch = (...a) => { if (String(a[0]).includes('/api/search')) window.__searchCalls++; return f(...a); }; 1`);
await setValue('[role=dialog] input[type=search]', 'nsec1' + 'q'.repeat(58));
await wait(700);
t.ok('an nsec is refused in words', await js(`!!document.querySelector('[data-testid=search-secret]')`));
t.equal('and no search request left', await js(`window.__searchCalls`), 0);
await js(`window.__fetch429 = true; if (!window.__origFetch) { window.__origFetch = window.fetch; window.fetch = (...a) => (window.__fetch429 && String(a[0]).includes('/api/search') ? Promise.resolve(new Response('{}', { status: 429 })) : window.__origFetch(...a)); } 1`);
await setValue('[role=dialog] input[type=search]', 'bitcoin');
t.ok('a 429 says the search failed, not that nothing matched', await waitFor(`document.querySelector('[role=dialog]').innerText.includes('Search failed. Try again.') && !document.querySelector('[role=dialog]').innerText.includes('No albums found')`, 10000));
await js(`window.__fetch429 = false; 1`);
await setValue('[role=dialog] input[type=search]', '');
await setValue('[role=dialog] input[type=search]', 'bitcoin');
t.ok('SEARCH lists albums', await waitFor(`document.querySelectorAll('[data-album-row]').length > 0`, 30000));
t.equal('the secret message is gone', await js(`!!document.querySelector('[data-testid=search-secret]')`), false);
t.ok('the sheet: no horizontal overflow', await overflowFree() && await js(`(() => { const c = document.querySelector('[role=dialog]'); return c.scrollWidth <= c.clientWidth; })()`));
t.equal('the sheet: every control at least 24 x 24', await tooSmall('[role=dialog] button, [role=dialog] input', 24, 24), []);
// open an album that has songs
let opened = false;
const nAlbums = await js(`document.querySelectorAll('[data-album-row]').length`);
for (let i = 0; i < Math.min(nAlbums, 12) && !opened; i++) {
  await js(`document.querySelectorAll('[data-album-row]')[${i}].click(); 1`);
  opened = await waitFor(`document.querySelectorAll('[data-add-row] button[aria-label^="Add "]').length >= 6 || ${dlgBtn('← RESULTS')}`, 20000)
    && await js(`document.querySelectorAll('[data-add-row] button[aria-label^="Add "]').length >= 6`);
  if (!opened) { await click(dlgBtn('← RESULTS')); await wait(300); }
}
t.ok('an album opens with at least 6 addable songs', opened);
for (let i = 0; i < 6; i++) { await js(`document.querySelector('[data-add-row] button[aria-label^="Add "]').click(); 1`); await wait(150); }
t.equal('6 rows flipped to ADDED', await js(`document.querySelectorAll('[data-added]').length`), 6);
t.equal('the header reads 6 in sheet playlist', await js(`document.querySelector('[data-testid=add-count]').innerText`), '6 in sheet playlist');
t.ok('a row has an ADDED label', (await js(`document.querySelector('[data-added]').innerText`)).includes('✓ ADDED'));
await click(dlgBtn('FAVORITES'));
t.ok('FAVORITES lists the six saved songs, no podcast, no orphan', await waitFor(`document.querySelectorAll('[data-add-row]').length === 6`, 10000), await body());
const favText = await js(`document.querySelector('[role=dialog]').innerText`);
t.ok('no podcast episode and no orphan listed', !favText.includes('A Podcast Episode') && !favText.includes('Orphan Track') && !favText.includes('Undefined Medium Episode'));
t.equal('each favorite has + ADD', await js(`document.querySelectorAll('[data-add-row] button[aria-label^="Add "]').length`), 6);
t.equal('favorites: every control at least 24 x 24', await tooSmall('[role=dialog] button', 24, 24), []);
for (let i = 0; i < 6; i++) { await js(`document.querySelector('[data-add-row] button[aria-label^="Add "]').click(); 1`); await wait(150); }
t.equal('the header reads 12 in sheet playlist', await js(`document.querySelector('[data-testid=add-count]').innerText`), '12 in sheet playlist');
t.equal('six ADDED in favorites', await js(`document.querySelectorAll('[data-added]').length`), 6);
await click(dlgBtn('DONE'));
await wait(400);
t.ok('DONE closes the sheet', await js(`!document.querySelector('[role=dialog]')`));
t.equal('the maker shows twelve rows', await rows(), 12);
await click(byText('PUBLISH'));
t.ok('PUBLISH succeeds with those 12', await waitFor(`document.querySelector('[data-testid=published]')?.innerText.includes('♫ PLAYLIST · 12 TRACKS')`, 30000), await body());
// empty favorites copy
await js(`localStorage.removeItem(${JSON.stringify(favKey)}); localStorage.removeItem(${JSON.stringify(KEY)}); 1`);
await go('/playlists/make');
await waitFor(`document.querySelector('#pl-title')`); await wait(500);
await click(byText('+ ADD SONGS')); await waitFor(dlg());
await click(dlgBtn('FAVORITES')); await wait(300);
t.ok('empty favorites say so, once the read answered', await waitFor(`document.querySelector('[role=dialog]').innerText.includes('No saved songs yet. Tap ♡ on a song to save it.')`, 30000));

// A song already in the playlist reads ADDED; remove it in the maker and the sheet offers + ADD again.
await js(`localStorage.setItem(${JSON.stringify(favKey)}, ${JSON.stringify(JSON.stringify({ [real[0].guid]: favs[real[0].guid] ?? { itemGuid: real[0].guid, feedGuid: real[0].podcastGuid, title: real[0].title, medium: 'music', addedAt: 1 } }))}); 1`);
await seed(draft({ songs: [songs[0]] }), labels);
await go('/playlists/make');
await waitFor(`document.querySelector('#pl-title')`); await wait(500);
await click(byText('+ ADD SONGS')); await waitFor(dlg());
await click(dlgBtn('FAVORITES'));
t.ok('a song already in the playlist shows ADDED', await waitFor(`document.querySelectorAll('[data-added]').length === 1`, 20000));
await click(dlgBtn('DONE')); await wait(300);
await click(`document.querySelectorAll('[aria-label="Remove"]')[0]`); await wait(300);
await click(byText('+ ADD SONGS')); await waitFor(dlg());
await click(dlgBtn('FAVORITES')); await wait(300);
t.equal('after removing it, the sheet offers + ADD again', await js(`[document.querySelectorAll('[data-added]').length, document.querySelectorAll('[data-add-row] button[aria-label^="Add "]').length]`), [0, 1]);

// An unanswered favorites read is not "no saved songs": relays that never answer.
await js(`localStorage.removeItem(${JSON.stringify(favKey)}); localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify(['ws://127.0.0.1:1']))}); 1`);
await seed(draft(), labels);
await go('/playlists/make');
await waitFor(`document.querySelector('#pl-title')`); await wait(300);
await click(byText('+ ADD SONGS')); await waitFor(dlg());
await click(dlgBtn('FAVORITES'));
const sawLoading = await waitFor(`document.querySelector('[data-testid=fav-loading]') || document.querySelector('[data-testid=fav-degraded]')`, 20000);
const unanswered = await js(`document.querySelector('[role=dialog]').innerText`);
t.ok('an unanswered read says loading or could-not-read, never "No saved songs yet"', sawLoading && !unanswered.includes('No saved songs yet'), unanswered);
await signedIn();

console.log('--- 8. edit from the server, two slots, a stale version ---');
await js(`localStorage.removeItem(${JSON.stringify(KEY)}); 1`);
await seed(draft({ title: 'other draft' }), labels);
t.ok('?id=<id> loads with no draft on disk', await openEdit());
t.ok('titles come from the server', await waitFor(`document.querySelector('[data-song-row]')?.innerText.includes(${JSON.stringify(real[0].title)})`, 20000));
t.equal('prefilled: title, twelve rows, DELETE offered', [await js(`document.querySelector('#pl-title').value`), await rows(), await js(`!!${byText('DELETE')}`)], ['e2e community playlist', 12, true]);
t.equal('loading wrote no edit draft', await js(`localStorage.getItem(${JSON.stringify(editKey(id))})`), null);
await setValue('#pl-title', 'e2e community playlist v2');
await wait(400);
t.equal('a change writes the edit slot', JSON.parse(await js(`localStorage.getItem(${JSON.stringify(editKey(id))})`))?.draft.title, 'e2e community playlist v2');
t.equal('and leaves the new-draft slot alone', (await stored())?.draft.title, 'other draft');
await click(byText('SAVE'));
t.ok('SAVE shows the Published view with the new title', await waitFor(`document.querySelector('[data-testid=published]')?.innerText.includes('e2e community playlist v2')`, 30000));
t.equal('the edit slot is cleared after a save', await js(`localStorage.getItem(${JSON.stringify(editKey(id))})`), null);
await click(byText('EDIT'));
await waitFor(`!!${byText('SAVE')}`);
await setValue('#pl-title', 'e2e community playlist v3');
await click(byText('SAVE'));
t.ok('a second SAVE works', await waitFor(`document.querySelector('[data-testid=published]')?.innerText.includes('e2e community playlist v3')`, 30000));

await click(byText('EDIT'));
await waitFor(`!!${byText('SAVE')}`);
const cur1 = await serverVersion();
const put = await putAsOwner({ title: 'changed by script', description: cur1.description, artUrl: cur1.artUrl, songs: cur1.songs }, cur1.updatedAt);
t.equal('the script PUT lands', put.status, 200);
await setValue('#pl-title', 'my edit');
await click(byText('SAVE'));
t.ok('a 409 shows the warning', await waitFor(`document.querySelector('[data-testid=refusals]')?.innerText.includes('This playlist changed elsewhere. Your edits are kept; SAVE again to overwrite.')`, 20000));
t.equal('and keeps the form', await js(`document.querySelector('#pl-title').value`), 'my edit');
await wait(500);
await click(byText('SAVE'));
t.ok('the next SAVE succeeds', await waitFor(`document.querySelector('[data-testid=published]')?.innerText.includes('my edit')`, 30000));
t.equal('the server has the user edit', (await serverVersion()).title, 'my edit');

console.log('--- 9. someone else ---');
cur = { sk: sk2, pk: pk2 };
await js(`localStorage.setItem('bmb:npub', ${JSON.stringify(npub2)}); 1`);
await go(`/playlists/make?id=${id}`);
t.ok('another key is refused in words', await waitFor(`document.querySelector('main')?.innerText.includes('Only the person who made this playlist can edit it.')`, 20000));
t.ok('and sees no SAVE', await js(`!${byText('SAVE')}`));
cur = { sk, pk };
await js(`localStorage.setItem('bmb:npub', ${JSON.stringify(npub)}); 1`);

console.log('--- 10. delete ---');
t.ok('the owner opens it again', await openEdit());
await click(byText('DELETE'));
t.ok('DELETE asks first', await waitFor(`document.querySelector('[role=dialog]')?.innerText.includes('Delete this playlist?')`));
t.equal('and nothing is deleted yet', (await fetch(feedUrl)).status, 200);
await click(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'DELETE')`);
t.ok('confirmed: the page says it is gone', await waitFor(`document.body.innerText.includes('playlist deleted')`, 20000));
t.equal('and the feed answers 410', (await fetch(feedUrl)).status, 410);
t.equal('the edit slot is gone', await js(`localStorage.getItem(${JSON.stringify(editKey(id))})`), null);

console.log(`\n${t.count - t.fails}/${t.count} passed`);
await exit(t.fails ? 1 : 0);
