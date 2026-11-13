// e2e for the community-playlist screens (maker, home button), in a real browser.
//
// Needs a dev server started with, on the command line (never in .env.local):
//   COMMUNITY_DB_URL=postgres://postgres:test@localhost:54329/postgres
//   (the local Postgres, with the schema applied: `npm run community:schema`)
//   ADMIN_NPUBS=<any npub> NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on
//   NEXT_PUBLIC_COMMUNITY_FEED_ORIGIN=http://localhost:3123 npm run dev -- -p 3123
// APP_URL overrides the server.
//
// The switch-OFF half is a second run against a second server, in two commands:
//   1. the same dev server command WITHOUT NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on
//   2. node scripts/e2e-community-ui.mjs --off
// (`node scripts/e2e-community-api.mjs --off` is the API half, same server.)
// The signer is a throwaway key behind a fake NIP-07 `window.nostr`, and relays point
// at a LOCAL relay. No EVENT reaches a public relay (checked by the assertion
// 'no event of any kind went to a public relay'). Feed reads and profile reads still reach the
// public network.
import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, MINI_BAR, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { getToken } from 'nostr-tools/nip98';

const OFF = process.argv.includes('--off'); // run against a dev server started WITHOUT the switch
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
let IP = `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
const published = []; // every event that reached the LOCAL relay
const relay = createRelay({ port: 0, log: null, onEvent: (e) => published.push(e) });
const PORT = await relay.ready;

const { page } = await launchChrome({
  name: `communityui-${process.env.CLAUDE_CODE_SESSION_ID || 'local'}`,
  args: ['--disable-gpu'],
  autoplay: true, // the song preview plays real audio with no user gesture inside the headless tab
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
const labels = Object.fromEntries(real.map((e) => [e.guid, { title: e.title, ...(e.feedTitle ? { artist: e.feedTitle } : {}), ...((e.image || e.feedImage) ? { image: e.image || e.feedImage } : {}) }]));
const withArt = real.filter((e) => e.image || e.feedImage).length;
// Every row keeps a 40 x 40 art box; a row whose song has a cover shows it through /api/art.
const rowArt = () => js(`[...document.querySelectorAll('[data-song-row]')].map((r) => { const b = r.querySelector('[data-song-art]')?.getBoundingClientRect(); const i = r.querySelector('[data-song-art] img'); return { box: !!b && Math.round(b.width) === 40 && Math.round(b.height) === 40, img: i ? i.getAttribute('src').includes('/api/art') : null }; })`);
const draft = (over = {}) => ({ title: 'e2e community playlist', description: 'made by e2e-community-ui', artUrl: null, songs, ...over });

await phone();

if (OFF) {
  console.log('--- OFF. switch off: the old page, byte for byte in what it claims (390 x 844) ---');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    (() => { window.__fetched = []; const f = window.fetch; window.fetch = (...a) => { window.__fetched.push(String(a[0])); return f(...a); }; })();
  ` });
  await js(`localStorage.setItem('bmb:fav_privacy:${npub}', 'public'); 1`);
  await go('/playlists');
  const section = (h) => `[...document.querySelectorAll('section')].find((s) => s.querySelector('h2')?.textContent === ${JSON.stringify(h)})`;
  t.ok('the Community section is there', await waitFor(`${section('Community playlists')}`, 30000));
  t.ok('the old blurb', await js(`${section('Community playlists')}.innerText.includes('Built on other hosts, and mostly by other people in the V4V community.')`));
  t.ok('not the new blurb', await js(`!document.body.innerText.includes('Made by listeners on BMB')`));
  await waitFor(`!document.body.innerText.includes('loading playlists')`, 60000);
  const rowsAll = `[...document.querySelectorAll('section li')].filter((l) => l.innerText.includes('PLAYLIST'))`;
  const countable = await js(`${rowsAll}.length`);
  t.ok('there are more than 12 playlist rows to count', countable > 12, String(countable));
  t.ok('every one of the 12 count slots is used', await waitFor(`${rowsAll}.filter((l) => l.innerText.includes(' tracks')).length === 12`, 90000), String(await js(`${rowsAll}.filter((l) => l.innerText.includes(' tracks')).length`)));
  t.equal('no stored rows, no EDIT', await js(`document.querySelectorAll('a[data-edit-playlist]').length`), 0);
  t.equal('the page never asked the store', await js(`window.__fetched.filter((u) => u.includes('/api/community-playlists')).length`), 0);
  t.ok('off: no horizontal overflow', await overflowFree());
  console.log(`\n${t.count - t.fails}/${t.count} passed`);
  await exit(t.fails ? 1 : 0);
}

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
// For the preview lines: songs 0 and 1 sit in the LISTEN QUEUE (so a preview that advanced would
// start song 1), and song 2 is a saved favorite (the Add songs sheet's FAVORITES tab).
const queueItem = (e) => ({ episode: e, podcast: { id: e.feedId ?? 0, podcastGuid: e.podcastGuid, title: e.feedTitle ?? e.title, image: e.feedImage, medium: 'music' } });
await js(`(() => { localStorage.setItem('bmb:listen_queue:${npub}', ${JSON.stringify(JSON.stringify([queueItem(real[0]), queueItem(real[1])]))});
  localStorage.setItem('bmb:fav_privacy:${npub}', 'public');
  localStorage.setItem('bmb:favepisodes:${npub}', ${JSON.stringify(JSON.stringify({ [real[2].guid]: { itemGuid: real[2].guid, feedGuid: real[2].podcastGuid, title: real[2].title, podcastTitle: real[2].feedTitle, image: real[2].image || real[2].feedImage, medium: 'music', addedAt: 1 } }))}); return 1; })()`);
await go('/playlists/make');
t.ok('the form appears', await waitFor(`document.querySelector('#pl-title')`));
await wait(500);
t.equal('the saved title is back', await js(`document.querySelector('#pl-title').value`), 'e2e community playlist');
t.equal('twelve rows', await rows(), 12);
t.ok('the songs have covers to show', withArt > 0, 'no cover in the source playlist');
await wait(300);
const art3 = await rowArt();
t.ok('every row has a 40 x 40 art box', art3.every((a) => a.box), JSON.stringify(art3));
t.equal('every song with a cover shows it through /api/art', art3.filter((a) => a.img === true).length, withArt);
const numbers = () => js(`[...document.querySelectorAll('[data-song-row] [data-song-number]')].map((n) => n.textContent.trim())`);
t.equal('the rows are numbered 1 to 12', await numbers(), Array.from({ length: 12 }, (_, k) => String(k + 1)));
t.ok('a row shows the saved title, no fetch', (await body()).includes(real[0].title));
const txt = await body();
for (const w of ['TITLE', 'DESCRIPTION', 'PLAYLIST ART LINK', '+ ADD SONGS', 'PUBLISH',
  'Square is preferred, 1400–3000 px. Empty: BMB makes the cover from the first four songs.',
  'Only you can change this playlist.']) t.ok(`copy: ${w}`, txt.includes(w), 'missing');
t.ok('footer names the signer', /Signed in as \S+/.test(txt));
t.equal('row buttons are labelled', await js(`['Move up','Move down','Remove'].map((l) => document.querySelectorAll('[aria-label="' + l + '"]').length)`), [12, 12, 12]);
t.equal('row buttons are at least 32 x 32', await tooSmall('[data-song-row] button', 32, 32), []);
t.equal('every button on the page is at least 24 x 24', await tooSmall('main button, main a', 24, 24), []);
t.ok('maker: no horizontal overflow', await overflowFree());
t.ok('PUBLISH is on with 12 songs and a title', await js(`!${byText('PUBLISH')}.disabled`));

console.log('--- 3b. the song list is readable, and each song previews alone ---');
const alphaOf = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const c = getComputedStyle(el).backgroundColor;
  const m = /^rgba?\\(([^)]*)\\)$/.exec(c); if (m) { const p = m[1].split(/[ ,\\/]+/).filter(Boolean); return p.length > 3 ? Number(p[3]) : 1; }
  const m2 = /\\/\\s*([\\d.]+%?)/.exec(c) || /,\\s*([\\d.]+)\\s*\\)$/.exec(c); if (m2) return m2[1].endsWith('%') ? parseFloat(m2[1]) / 100 : Number(m2[1]); return c === 'transparent' ? 0 : 1; })()`);
const panelAlpha = await alphaOf('[data-songs-panel]');
t.ok('the song list sits on a panel with a background alpha of at least 0.85', panelAlpha !== null && panelAlpha >= 0.85, String(panelAlpha));
t.ok('the panel holds the list and the song count', await js(`(() => { const p = document.querySelector('[data-songs-panel]'); return !!p && !!p.querySelector('ol[aria-label="Songs"]') && /\\d+ songs?/.test(p.innerText); })()`));
t.ok('the artist line is bone/70, not muted', await js(`(() => { const a = document.querySelector('[data-song-row] p.text-xs'); return !!a && a.classList.contains('text-bone/70') && !a.classList.contains('text-muted'); })()`));
const previewBtn = (title, scope = 'main') => `[...document.querySelectorAll(${JSON.stringify(scope + ' [data-song-preview]')})].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(title)})`;
const mini = () => js(`document.querySelector(${JSON.stringify(MINI_BAR)})?.innerText ?? ''`);
const audioPlaying = `(() => { const a = document.querySelector('audio'); return a && !a.paused && a.currentTime > 0; })()`;
const plog = () => js(`(localStorage.getItem('bmb:plog:device') || '').slice(-1700)`);
const audioState = () => js(`(() => { const a = document.querySelector('audio'); return a ? { paused: a.paused, t: a.currentTime, d: a.duration, ended: a.ended, err: a.error?.code ?? null, rs: a.readyState, seekable: a.seekable.length ? a.seekable.end(0) : 0, src: a.currentSrc.slice(0, 90) } : null; })()`);
t.equal('every row has a preview button with a play label', await js(`[...document.querySelectorAll('[data-song-row] [data-song-preview]')].map((b) => b.getAttribute('aria-label'))`), real.map((e) => `Play ${e.title}`));
t.ok('each preview button shows a visible play glyph', await js(`[...document.querySelectorAll('[data-song-row] [data-song-preview]')].every((b) => b.textContent.includes('▶'))`));
t.equal('preview buttons are 40 x 40', await js(`[...document.querySelectorAll('[data-song-row] [data-song-preview]')].filter((b) => { const r = b.getBoundingClientRect(); return Math.round(r.width) !== 40 || Math.round(r.height) !== 40; }).length`), 0);
t.equal('preview buttons are at least 24 x 24', await tooSmall('[data-song-preview]', 24, 24), []);
// Song 0 is already the CURRENT item here (the listen queue cued it), so the first tap is a toggle on a loaded song.
t.ok('tap the cover: it plays', await click(previewBtn(`Play ${real[0].title}`)));
t.ok('the mini-player shows that song', await waitFor(`document.querySelector(${JSON.stringify(MINI_BAR)})?.innerText.includes(${JSON.stringify(real[0].title)})`, 40000), await mini());
t.ok('and the button now says Pause', await waitFor(`${previewBtn(`Pause ${real[0].title}`)}`, 20000));
t.ok('with a pause glyph over the cover', await js(`${previewBtn(`Pause ${real[0].title}`)}?.textContent.includes('❚❚')`));
t.ok('the audio is playing', await waitFor(`(() => { const a = document.querySelector('audio'); return a && !a.paused && a.currentTime > 0; })()`, 40000), JSON.stringify(await audioState()));
t.ok('tap again: it pauses', await click(previewBtn(`Pause ${real[0].title}`)) && await waitFor(`document.querySelector('audio')?.paused === true && ${previewBtn(`Play ${real[0].title}`)}`, 15000), JSON.stringify(await audioState()));
t.ok('the mini-player still shows the song', (await mini()).includes(real[0].title));
t.ok('the preview of a song does not play it at a saved place: it starts at the beginning', (await audioState())?.t < 30);
// "just the song": play it again, then jump to the last half second. Songs 0 and 1 are in the listen
// queue, so a player that advanced would now be playing song 1.
t.ok('tap again: it plays', await click(previewBtn(`Play ${real[0].title}`)) && await waitFor(`document.querySelector('audio') && !document.querySelector('audio').paused`, 20000));
t.ok('the audio has a length', await waitFor(`Number.isFinite(document.querySelector('audio')?.duration) && document.querySelector('audio').duration > 2`, 30000), JSON.stringify(await audioState()));
// The mini-player's own seek slider (setting `audio.currentTime` directly is overwritten by the player's position sync).
await js(`(() => { const a = document.querySelector('audio'); const r = document.querySelector('input[aria-label="Seek"]'); const v = String(a.duration - 0.6);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(r, v); r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
t.ok('the song reaches its end', await waitFor(`document.querySelector('audio')?.ended === true || (document.querySelector('audio')?.paused && document.querySelector('audio').currentTime >= document.querySelector('audio').duration - 0.2)`, 30000), JSON.stringify(await audioState()) + await plog());
await wait(2500);
const after = await mini();
t.ok('after the end the mini-player still shows the same song', after.includes(real[0].title), after);
t.ok('...and not the next song in the queue', !after.includes(real[1].title) || real[1].title === real[0].title, after);
t.ok('...and the audio is paused, not restarted', (await audioState())?.paused === true, JSON.stringify(await audioState()));
t.ok('...and the button says Play again', await js(`!!${previewBtn(`Play ${real[0].title}`)}`));
await js(`localStorage.removeItem('bmb:listen_queue:${npub}'); 1`);

t.ok('a song that is not loaded yet: tap its cover', await click(previewBtn(`Play ${real[4].title}`)));
t.ok('the mini-player switches to it', await waitFor(`document.querySelector(${JSON.stringify(MINI_BAR)})?.innerText.includes(${JSON.stringify(real[4].title)})`, 40000), await mini());
t.ok('and its button says Pause', await waitFor(`${previewBtn(`Pause ${real[4].title}`)}`, 20000));
await waitFor(audioPlaying, 40000); // let it really start before the next one: pausing a load in flight leaves the player's own stall guard armed
t.ok('and the first song says Play again', await js(`!!${previewBtn(`Play ${real[0].title}`)}`));
console.log('--- 3c. the Add songs sheet previews too ---');
t.ok('open Add songs', await click(byText('+ ADD SONGS')) && await waitFor(`document.querySelector('[role=dialog]')?.innerText.includes('Add songs')`, 10000));
await click(`[...document.querySelectorAll('[role=dialog] [role=tab]')].find((b) => b.textContent.trim() === 'FAVORITES')`);
t.ok('FAVORITES lists the saved song', await waitFor(`document.querySelector('[role=dialog] [aria-label="Saved songs"] [data-add-row]')`, 30000));
t.ok('the favorite row has a preview button', await waitFor(`${previewBtn(`Play ${real[2].title}`, '[role=dialog]')}`, 10000));
t.ok('FAVORITES: tap its cover', await click(previewBtn(`Play ${real[2].title}`, '[role=dialog]')));
t.ok('FAVORITES: the mini-player shows that song (resolved by guid)', await waitFor(`document.querySelector(${JSON.stringify(MINI_BAR)})?.innerText.includes(${JSON.stringify(real[2].title)})`, 40000), await mini());
t.ok('FAVORITES: the button says Pause', await waitFor(`${previewBtn(`Pause ${real[2].title}`, '[role=dialog]')}`, 20000));
await waitFor(audioPlaying, 40000);
t.ok('the sheet: no horizontal overflow', await overflowFree());
t.equal('the sheet preview buttons are at least 24 x 24', await tooSmall('[role=dialog] [data-song-preview]', 24, 24), []);
await click(previewBtn(`Pause ${real[2].title}`, '[role=dialog]'));
await click(`[...document.querySelectorAll('[role=dialog] [role=tab]')].find((b) => b.textContent.trim() === 'SEARCH')`);
const q = (real[3].feedTitle || real[3].title).slice(0, 40);
await setValue('[role=dialog] input[type=search]', q);
t.ok('SEARCH: an album is listed', await waitFor(`document.querySelector('[role=dialog] [data-album-row]')`, 40000));
await click(`document.querySelector('[role=dialog] [data-album-row]')`);
t.ok('SEARCH: the album lists tracks with preview buttons', await waitFor(`document.querySelector('[role=dialog] [aria-label="Songs in this album"] [data-song-preview]')`, 40000));
const trackLabel = await js(`document.querySelector('[role=dialog] [aria-label="Songs in this album"] [data-song-preview]').getAttribute('aria-label')`);
const trackTitle = trackLabel.replace(/^Play /, '');
t.ok('SEARCH: tap a track cover', await click(`document.querySelector('[role=dialog] [aria-label="Songs in this album"] [data-song-preview]')`));
t.ok('SEARCH: the mini-player shows that track', await waitFor(`document.querySelector(${JSON.stringify(MINI_BAR)})?.innerText.includes(${JSON.stringify(trackTitle)})`, 40000), `${trackTitle} / ${await mini()}`);
await waitFor(audioPlaying, 40000);
t.ok('SEARCH: its button says Pause', await waitFor(`document.querySelector('[role=dialog] [aria-label="Songs in this album"] [data-song-preview]')?.getAttribute('aria-label') === ${JSON.stringify('Pause ' + trackTitle)}`, 20000), `${trackLabel} / ${await js(`document.querySelector('[role=dialog] [aria-label="Songs in this album"] [data-song-preview]')?.getAttribute('aria-label')`)} / ${JSON.stringify(await audioState())} / ${await plog()}`);
t.ok('the album: no horizontal overflow', await overflowFree());
t.ok('the song of the album plays under its OWN feed, not a playlist', await js(`!document.querySelector(${JSON.stringify(MINI_BAR)})?.innerText.includes('e2e community playlist')`));
await click(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'DONE')`);
await wait(500);

console.log('--- 3d. a song that cannot load says so ---');
await js(`localStorage.removeItem('bmb:favepisodes:${npub}'); 1`);
await seed(draft({ songs: [{ feedGuid: real[0].podcastGuid, itemGuid: 'no-such-song-guid-e2e' }, ...songs.slice(0, 9)] }), labels);
await go('/playlists/make');
t.ok('the draft is back', await waitFor(`document.querySelectorAll('[data-song-row]').length === 10`, 20000));
t.ok('tap the broken song', await click(`document.querySelector('[data-song-row] [data-song-preview]')`));
t.ok('it says: Could not load this song.', await waitFor(`document.querySelector('[data-song-row] [data-preview-error]')?.innerText.includes('Could not load this song.')`, 40000));
t.ok('the line is a polite live region', await js(`document.querySelector('[data-song-row] [data-preview-error]')?.getAttribute('aria-live') === 'polite'`));
t.ok('and the button is back to Play', await js(`document.querySelector('[data-song-row] [data-song-preview]').getAttribute('aria-label').startsWith('Play ') && document.querySelector('[data-song-row] [data-song-preview]').textContent.includes('▶')`));
t.ok('and nothing started playing', await js(`!document.querySelector('audio') || document.querySelector('audio').paused`), JSON.stringify(await audioState()));
t.ok('the failed row: no horizontal overflow', await overflowFree());
await seed(draft(), labels);
await go('/playlists/make');
t.ok('the form is back', await waitFor(`document.querySelector('#pl-title')`));
await wait(500);
t.equal('twelve rows again', await rows(), 12);

console.log('--- 4. the reason PUBLISH is off ---');
await setValue('#pl-title', '');
await wait(300);
t.ok('no title: PUBLISH is off', await js(`${byText('PUBLISH')}.disabled`));
t.ok('and it says Add a title', (await js(`document.querySelector('[data-testid=why-blocked]')?.innerText`)) === 'Add a title');
await setValue('#pl-title', 'shit mix');
await wait(300);
t.ok('profanity: shows what will publish', (await body()).includes('Will publish as: **** mix'));
// A secret key in the title or the description: refused on screen, before anything is sent.
// A throwaway key made for this line; it belongs to nobody.
const NSEC = nip19.nsecEncode(generateSecretKey());
await js(`window.__cpWrites = 0; const f0 = window.fetch; window.fetch = (u, i) => { if (String(u).includes('/api/community-playlists') && i?.method && i.method !== 'GET') window.__cpWrites++; return f0(u, i); }; 1`);
await setValue('#pl-title', `my mix ${NSEC}`);
await wait(300);
t.equal('an nsec in the title: PUBLISH is off and the reason names the title',
  await js(`[${byText('PUBLISH')}.disabled, document.querySelector('[data-testid=why-blocked]')?.innerText ?? '']`).then(([d, w]) => [d, /title/i.test(w) && /secret key/i.test(w)]),
  [true, true]);
await click(byText('PUBLISH'));
await wait(300);
t.equal('...and pressing it sends nothing', await js(`window.__cpWrites`), 0);
await setValue('#pl-title', 'e2e community playlist');
await setValue('#pl-desc', `my songs, key=nostr:${NSEC.toUpperCase()}`);
await wait(300);
t.equal('an nsec glued into the description: PUBLISH is off and the reason names the description',
  await js(`[${byText('PUBLISH')}.disabled, document.querySelector('[data-testid=why-blocked]')?.innerText ?? '']`).then(([d, w]) => [d, /description/i.test(w) && /secret key/i.test(w)]),
  [true, true]);
await setValue('#pl-desc', 'made by e2e-community-ui');
await wait(300);
t.ok('without it, PUBLISH is on again', await js(`!${byText('PUBLISH')}.disabled`));
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
t.equal('after a move the numbers still run 1 to 9 in order', await numbers(), Array.from({ length: 9 }, (_, k) => String(k + 1)));
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
t.ok('a small picture is refused in words', await waitFor(`document.querySelector('[data-testid=refusals]')?.innerText.includes('The picture must be at least 300 px on its shortest side.')`, 30000));
t.ok('with the cover preview still on screen', await js(`!!document.querySelector('[data-testid=cover-preview]')`));
// A body the server will not read: 500 songs with long item guids pass every rule on the
// page, and the route answers 400 `payload too large`. The page must say so, not "try again".
{
  const huge = Array.from({ length: 500 }, (_, i) => ({ feedGuid: songs[0].feedGuid, itemGuid: `e2e-huge-${i}-${'x'.repeat(600)}` }));
  await seed(draft({ songs: huge }), {});
  await go('/playlists/make');
  await waitFor(`document.querySelectorAll('[data-song-row]').length === 500`, 30000);
  t.ok('a 500-song draft over the size cap: PUBLISH is on (every rule on the page passes)', await js(`!${byText('PUBLISH')}.disabled`));
  await click(byText('PUBLISH'));
  t.ok('the server\'s "payload too large" is shown as: too large, remove some songs',
    await waitFor(`/too large/i.test(document.querySelector('[data-testid=refusals]')?.innerText ?? '') && /remove some songs/i.test(document.querySelector('[data-testid=refusals]')?.innerText ?? '')`, 30000),
    await js(`document.querySelector('[data-testid=refusals]')?.innerText ?? '(no refusal box)'`));
  t.ok('...not the generic "Try again" line', !(await js(`document.querySelector('[data-testid=refusals]')?.innerText ?? ''`)).includes('Could not save the playlist'));
}

console.log('--- 6. a silent signer ---');
await seed(draft(), labels);
await go('/playlists/make');
await waitFor(`document.querySelector('#pl-title')`); await wait(500);
await setValue('#pl-desc', 'still here after a timeout');
// 400 ms, not the brief's 5 s: same code path in signedFetch, shorter run.
await js(`window.__silent = true; window.__bmbSignTimeoutMs = 400; 1`);
await click(byText('PUBLISH'));
t.ok('no answer: the page says so', await waitFor(`document.querySelector('[data-testid=refusals]')?.innerText.includes('signer did not answer')`, 10000));
t.ok('and PUBLISH is on again', await js(`!${byText('PUBLISH')}.disabled`));
t.equal('and the 12 rows are still on the page', await rows(), 12);
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


console.log('--- 7a. /playlists: listed first, EDIT on your own, hearts (390 x 844) ---');
// A fresh fake address: /api/playlist allows 30 a minute, and this page counts rows as well as opening one.
IP = `10.79.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
await send('Network.setExtraHTTPHeaders', { headers: { 'x-real-ip': IP } });
// Recorders, installed for every later document: each EVENT frame the page sends, with the
// socket it went to; and a switch (localStorage) that fakes the store's answer.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (() => {
    window.__ws = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { try { if (String(d).startsWith('["EVENT"')) window.__ws.push({ url: this.url, kind: JSON.parse(d)[1].kind }); } catch {} return send.call(this, d); };
    const f = window.fetch;
    window.fetch = (...a) => {
      let mode = null; try { mode = localStorage.getItem('__e2eStore'); } catch {}
      if (mode && String(a[0]) === '/api/community-playlists') {
        if (mode === 'down') return Promise.resolve(new Response('{}', { status: 503 }));
        if (mode === 'dupe') return Promise.resolve(new Response(JSON.stringify({ playlists: [{ id: '11111111-1111-4111-8111-111111111111', title: 'DUPE STORED', description: '', feedUrl: 'https://v4vmusic.com/playlist/508a029b-020f-4334-9704-e0a9a5f800fb.xml', podcastGuid: 'dupe-guid', ownerPubkey: 'a'.repeat(64), ownerNpub: 'npub1dupe', coverUrl: '', songCount: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }] }), { status: 200 }));
      }
      return f(...a);
    };
  })();
` });
const community = `[...document.querySelectorAll('section')].find((s) => s.querySelector('h2')?.textContent === 'Community playlists')`;
const comRows = `[...${community}.querySelectorAll('li')]`;
const plGuid = (await (await fetch(`${APP}/api/community-playlists`)).json()).playlists.find((p) => p.id === id)?.podcastGuid;
t.ok('the stored playlist has a podcastGuid', !!plGuid, String(plGuid));
await js(`localStorage.setItem('bmb:fav_privacy:${npub}', 'public'); 1`);
await go('/playlists');
t.ok('Community lists the new playlist', await waitFor(`${community} && ${comRows}.some((l) => l.innerText.includes('e2e community playlist'))`, 30000));
t.ok('...first', await js(`${comRows}[0].innerText.includes('e2e community playlist')`));
t.ok('the blurb is the new one', await js(`${community}.innerText.includes('Made by listeners on BMB, and by other people in the V4V community.')`));
t.equal('exactly one EDIT in the section, on that row', await js(`[${comRows}.filter((l) => l.querySelector('a[data-edit-playlist]')).length, ${comRows}[0].querySelector('a[data-edit-playlist]')?.getAttribute('href')]`), [1, `/playlists/make?id=${id}`]);
t.equal('EDIT is named for its playlist', await js(`${comRows}[0].querySelector('a[data-edit-playlist]')?.getAttribute('aria-label')`), 'Edit e2e community playlist');
t.ok('EDIT is a sibling of the row button, never inside it', await js(`!document.querySelector('li button a[data-edit-playlist], li button [data-edit-playlist]')`));
t.ok('the stored row prints no NOT IN PI', await js(`!${comRows}[0].innerText.includes('NOT IN PI')`));
t.ok('a curated row PI has not indexed still stamps NOT IN PI (the stamp is not suppressed everywhere)', await waitFor(`${comRows}.some((l) => !l.querySelector('a[data-edit-playlist]') && !l.innerText.includes('e2e community playlist') && l.innerText.includes('NOT IN PI'))`, 30000));
t.ok('the stored row shows its track count', await waitFor(`${comRows}[0].innerText.includes('12 tracks')`, 30000));
t.ok('counted rows == min(12, countable rows), not fewer', await waitFor(`(() => { const r = [...document.querySelectorAll('section li')].filter((l) => l.innerText.includes('PLAYLIST')); return r.length >= 1 && r.filter((l) => l.innerText.includes(' tracks')).length === Math.min(12, r.length); })()`, 90000), await js(`[...document.querySelectorAll('section li')].filter((l) => l.innerText.includes(' tracks')).length + ' of ' + [...document.querySelectorAll('section li')].length`));
t.ok('/playlists: no horizontal overflow', await overflowFree());
t.equal('EDIT is at least 24 x 24', await tooSmall('a[data-edit-playlist]', 24, 24), []);
t.equal('the row heart is at least 24 x 24', await tooSmall('li button[aria-label$="podcast"]', 24, 24), []);
t.ok("ChadF's playlists still lists its own", await js(`!!document.querySelector('section h2') && [...document.querySelectorAll('section')].some((s) => s.querySelector('h2')?.textContent === "ChadF's playlists")`));
// someone else sees the row and no EDIT
cur = { sk: sk2, pk: pk2 };
await js(`localStorage.setItem('bmb:npub', ${JSON.stringify(npub2)}); 1`);
await go('/playlists');
t.ok('another key still sees the row', await waitFor(`${community} && ${comRows}.some((l) => l.innerText.includes('e2e community playlist'))`, 30000));
t.ok('the page is signed in as key 2 (account button names it)', await waitFor(`[...document.querySelectorAll('[aria-label^="Account:"]')].some((b) => b.getAttribute('aria-label').includes(${JSON.stringify(npub2.slice(0, 6) + '…' + npub2.slice(-6))}))`, 20000), await js(`[...document.querySelectorAll('[aria-label^="Account:"]')].map((b) => b.getAttribute('aria-label')).join('|')`));
t.equal('...with no EDIT anywhere', await js(`document.querySelectorAll('a[data-edit-playlist]').length`), 0);
cur = { sk, pk };
await js(`localStorage.setItem('bmb:npub', ${JSON.stringify(npub)}); 1`);

// the store cannot be reached: the curated rows stay, and the page says something is missing
await js(`localStorage.setItem('__e2eStore', 'down'); 1`);
await go('/playlists');
t.ok('store down: the curated rows are still listed', await waitFor(`${community} && ${comRows}.length >= 1 && !${community}.innerText.includes('loading playlists')`, 40000));
t.ok('store down: the line names the missing half, with a RETRY', await js(`${community}.innerText.includes("Playlists made on BMB couldn't be loaded just now.") && !![...${community}.querySelectorAll('[data-testid=store-down] button')].find((b) => b.textContent.includes('RETRY'))`));
t.ok('store down: not folded into a count ("1 more")', await js(`!/\\d+ more couldn't be loaded/.test(${community}.innerText) && !/\\d+ of \\d+ playlists/i.test(${community}.innerText)`));
t.ok('store down: no stored row, no EDIT', await js(`!${community}.innerText.includes('e2e community playlist') && !document.querySelector('a[data-edit-playlist]')`));
// a stored playlist and a curated one with the same feed URL: one row
await js(`localStorage.setItem('__e2eStore', 'dupe'); 1`);
await go('/playlists');
t.ok('same feed URL: the stored row shows', await waitFor(`${community} && ${comRows}.some((l) => l.innerText.includes('DUPE STORED'))`, 40000));
await waitFor(`!${community}.innerText.includes('loading playlists')`, 40000);
t.equal('same feed URL: it appears once, and the count line equals the rows', await js(`(() => { const n = ${comRows}.length; const m = /^(\\d+)(?: of \\d+)? playlists$/mi.exec(${community}.innerText); return [${comRows}.filter((l) => l.innerText.includes('DUPE STORED')).length, m && Number(m[1]) === n && n <= 7]; })()`), [1, true]);
t.ok('same feed URL: that row has no EDIT', await js(`!${comRows}[0].querySelector('a[data-edit-playlist]')`));
await js(`localStorage.removeItem('__e2eStore'); 1`);

// favorites, local relay only
await go('/playlists');
await waitFor(`${community} && ${comRows}.some((l) => l.innerText.includes('e2e community playlist'))`, 30000);
const favGuids = (k) => js(`Object.keys(JSON.parse(localStorage.getItem(${JSON.stringify(k + ':' + npub)}) || '{}'))`);
const favEntry = (k, key) => js(`JSON.parse(localStorage.getItem(${JSON.stringify(k + ':' + npub)}) || '{}')[${JSON.stringify(key)}] ?? null`);
t.ok('the row heart (podcast) renders for a stored playlist', await js(`!!${comRows}[0].querySelector('button[aria-label="Favorite podcast"]')`));
await click(`${comRows}[0].querySelector('button[aria-label="Favorite podcast"]')`);
t.ok('row heart: favorites[<playlist podcastGuid>] is set', await waitFor(`JSON.parse(localStorage.getItem('bmb:favorites:${npub}') || '{}')[${JSON.stringify(plGuid)}]`, 15000), JSON.stringify(await favGuids('bmb:favorites')));
t.ok('the favorite is the playlist: its url and the musicL medium', await js(`(() => { const f = JSON.parse(localStorage.getItem('bmb:favorites:${npub}'))[${JSON.stringify(plGuid)}]; return f.url === ${JSON.stringify(feedUrl)} && /^musicl$/i.test(f.medium ?? ''); })()`), JSON.stringify(await favEntry('bmb:favorites', plGuid)));
const waitPublished = async (needle) => { for (let i = 0; i < 40; i++) { const e = published.filter((x) => x.kind === 10333 && JSON.stringify(x.tags).includes(needle)).at(-1); if (e) return e; await wait(250); } return null; };
const favEvent = await waitPublished(plGuid);
t.ok('a kind:10333 reached the LOCAL relay naming the playlist', !!favEvent);
const iAt = (favEvent?.tags ?? []).findIndex((x) => x[0] === 'i' && x[1] === `podcast:guid:${plGuid}`);
t.ok("its `i` tag sits in a run whose medium tag is musicL", iAt > 0 && favEvent.tags[iAt - 1][0] === 'medium' && /^musicl$/i.test(favEvent.tags[iAt - 1][1]), JSON.stringify(favEvent?.tags));
// open the row: the track list plays, 12 rows, header heart is pressed
await click(`${comRows}[0].querySelector(':scope > button')`);
t.ok('opening the row shows its 12 tracks', await waitFor(`document.querySelectorAll('button[aria-label^="More actions for"]').length === 12`, 40000), String(await js(`document.querySelectorAll('button[aria-label^="More actions for"]').length`)));
t.ok('the header heart is on the open playlist and is pressed', await js(`document.querySelectorAll('button[aria-label="Unfavorite podcast"]').length === 1`));
await click(`document.querySelector('button[aria-label="Unfavorite podcast"]')`);
t.ok('header heart off: the playlist favorite is gone', await waitFor(`!JSON.parse(localStorage.getItem('bmb:favorites:${npub}') || '{}')[${JSON.stringify(plGuid)}]`, 15000));
await click(`document.querySelector('button[aria-label="Favorite podcast"]')`);
t.ok('header heart on: favorites[<playlist podcastGuid>] is set again', await waitFor(`JSON.parse(localStorage.getItem('bmb:favorites:${npub}') || '{}')[${JSON.stringify(plGuid)}]`, 15000));
// a song's own heart, in its row menu
t.ok('the row menu opens', await click(`document.querySelectorAll('button[aria-label^="More actions for"]')[0]`) && await waitFor(`document.querySelector('[role=menu] button[aria-label="Favorite episode"]')`, 10000));
await click(`document.querySelector('[role=menu] button[aria-label="Favorite episode"]')`);
t.ok('a song heart: favoriteEpisodes[<itemGuid>] is set', await waitFor(`JSON.parse(localStorage.getItem('bmb:favepisodes:${npub}') || '{}')[${JSON.stringify(real[0].guid)}]`, 15000));
const songFav = await favEntry('bmb:favepisodes', real[0].guid);
t.equal("the song's feedGuid is its OWN feed, never the playlist's", [songFav?.feedGuid === real[0].podcastGuid, songFav?.feedGuid !== plGuid], [true, true]);
t.equal("the song favorite carries no medium or feedUrl copied from the playlist", [songFav?.medium ?? null, songFav?.feedUrl ?? null].map((v) => v === null || (v !== feedUrl && !/^musicl$/i.test(String(v)))), [true, true]);
t.ok('the playlist favorite is still there beside it', !!(await favEntry('bmb:favorites', plGuid)));
t.ok('the song favorite reached the LOCAL relay', !!(await waitPublished(real[0].guid)));
const outside = await js(`window.__ws.filter((w) => !/^ws:\\/\\/127\\.0\\.0\\.1:/.test(w.url))`);
t.equal('no event of any kind went to a public relay', outside, []);
t.ok('the local relay is the only one that took EVENTs', await js(`window.__ws.length > 0 && window.__ws.every((w) => w.url.startsWith('ws://127.0.0.1:${PORT}'))`));


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

// A second fake client address for the edit half: the 6-writes-a-minute limit is a window, so a
// run that takes its time before the edits can still land its seventh write inside one.
IP = `10.78.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
await send('Network.setExtraHTTPHeaders', { headers: { 'x-real-ip': IP } });
console.log('--- 8. edit from the server, two slots, a stale version ---');
await js(`localStorage.removeItem(${JSON.stringify(KEY)}); 1`);
await seed(draft({ title: 'other draft' }), labels);
t.ok('?id=<id> loads with no draft on disk', await openEdit());
t.ok('titles come from the server', await waitFor(`document.querySelector('[data-song-row]')?.innerText.includes(${JSON.stringify(real[0].title)})`, 20000));
t.ok('covers come from the server too', await waitFor(`document.querySelectorAll('[data-song-row] [data-song-art] img').length >= ${withArt}`, 20000), String(await js(`document.querySelectorAll('[data-song-row] [data-song-art] img').length`)));
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

console.log('--- 8b. a draft restored after a change elsewhere ---');
// A third fake address: this half writes three more times.
IP = `10.76.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
await send('Network.setExtraHTTPHeaders', { headers: { 'x-real-ip': IP } });
await click(byText('EDIT'));
await waitFor(`!!${byText('SAVE')}`);
await setValue('#pl-title', 'draft made before the change');
await wait(400);
t.equal('the edit slot holds the draft', JSON.parse(await js(`localStorage.getItem(${JSON.stringify(editKey(id))})`) ?? 'null')?.draft.title, 'draft made before the change');
const cur2 = await serverVersion();
const put2 = await putAsOwner({ title: 'changed elsewhere again', description: cur2.description, artUrl: cur2.artUrl, songs: cur2.songs }, cur2.updatedAt);
t.equal('meanwhile a script PUT lands', put2.status, 200);
t.ok('reopening the edit page restores the draft', await openEdit() && await waitFor(`document.querySelector('#pl-title')?.value === 'draft made before the change'`, 10000));
await click(byText('SAVE'));
t.ok('SAVE of the restored draft gets the 409 warning, not a silent overwrite',
  await waitFor(`document.querySelector('[data-testid=refusals]')?.innerText.includes('This playlist changed elsewhere. Your edits are kept; SAVE again to overwrite.')`, 20000),
  await js(`document.querySelector('[data-testid=refusals]')?.innerText ?? document.querySelector('main')?.innerText.slice(0, 200)`));
t.equal('...and the other edit is still on the server', (await serverVersion()).title, 'changed elsewhere again');
await wait(500);
if (await js(`!!${byText('SAVE')}`)) await click(byText('SAVE'));
t.ok('the next SAVE overwrites, as the warning said', await waitFor(`document.querySelector('[data-testid=published]')?.innerText.includes('draft made before the change')`, 30000));

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
