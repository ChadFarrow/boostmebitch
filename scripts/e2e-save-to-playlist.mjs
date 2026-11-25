// e2e for "+ PLAYLIST" (components/community/save-to-playlist.tsx) against the
// playlist maker that has THE SAME DRAFT open (components/community/playlist-maker.tsx),
// and for "Your playlists" on /playlists (components/community/your-playlists.tsx).
//
// THE BUG IT WAS WRITTEN AGAINST (PR #673 review). The maker holds the draft in
// React state and writes ALL of it to its slot after every change. The sheet adds
// a song to that slot on disk and shows "✓ ADDED". The maker did not watch the
// slot, so its next edit wrote its older list over the add and the song was gone
// with nothing on screen. Sections 1 and 2 failed 7 of 18 on that code. The shapes:
//   1. SAME TAB: the maker at /playlists/make, the fullscreen player on top, + PLAYLIST.
//      The sheet and the maker share one document, so no `storage` event fires.
//   2. SECOND TAB: the sheet in tab B, the maker in tab A, an edit in A at once and later.
//   3. NO EVENT AT ALL: the slot written behind the maker with a bare `localStorage`
//      write, which notifies nothing — the case of another tab's `storage` event
//      that has not arrived yet. The maker's own WRITE must take the song in.
//   4. A PUBLISHED playlist (the store stubbed by CDP `Fetch`): "Your playlists" lists
//      it; the sheet adds to its unsaved changes ("+1 not saved"); the maker open on
//      `?id=` takes in an add from another tab and KEEPS the version it loaded, even
//      when the sheet seeded the slot from a NEWER copy — or SAVE would overwrite a
//      change made elsewhere instead of meeting the 409.
//   5. TWO FAST TAPS on + ADD: "✓ ADDED", never "Already in it" over a real add.
// Each maker case ends with one character typed in the maker, then a read of the slot.
//
// AN ADD SENDS NOTHING: every non-GET request of the run is recorded and must be
// zero. Signed out; section 4 makes this browser's guest key with I DON'T HAVE NOSTR
// (made and kept in this profile only). PUBLISH and SAVE are never pressed.
//
//   NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on npm run dev -- -p 3173
//   APP_URL=http://localhost:3173 node scripts/e2e-save-to-playlist.mjs   (--headed to watch)
// The album is the fixture (Tinderbox, as e2e-album.mjs): any `medium=music` album
// with two or more tracks works.

import { checker, exit, launchChrome, MINI_BAR, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:3173';
const ALBUM_GUID = '537df90e-0cc4-535b-84d0-dcb3ca87f1f8';
await requireApp(APP, `Nothing is serving ${APP}. Start the dev server (see the top of this file).`);

const t = checker();
const b = await launchChrome({ name: `savetoplaylist-${process.env.CLAUDE_CODE_SESSION_ID || 'local'}`, args: ['--disable-gpu'], autoplay: true });

const SEED = { feedGuid: 'seed-feed', itemGuid: 'seed-item' };
const slotKey = (slot, owner = 'guest') => `bmb:playlist_draft:${owner}:${slot}`;
const seedDraft = (title) => JSON.stringify({
  draft: { title, description: '', ownerName: '', artUrl: null, songs: [SEED] },
  editingId: null, expectedUpdatedAt: null,
  labels: { [SEED.itemGuid]: { title: 'Seed song' } }, createdAt: Date.now(),
});

// ---- the stubbed store (section 4) ------------------------------------------
const STUB_ID = 'e2e00000-0000-4000-8000-0000000000a1';
const STUB_TITLE = 'Stub published';
const stub = { owner: null, updatedAt: '2026-11-20T00:00:00.000Z', served: [] };
const stubSongs = Array.from({ length: 10 }, (_, i) => ({ feedGuid: `stub-feed-${i}`, itemGuid: `stub-item-${i}` }));
const json = (v) => Buffer.from(JSON.stringify(v)).toString('base64');
const summary = () => ({
  id: STUB_ID, title: STUB_TITLE, description: '', feedUrl: `https://www.boostmebuddy.com/feeds/playlists/${STUB_ID}.xml`,
  podcastGuid: 'e2e00000-0000-4000-8000-0000000000b2', ownerPubkey: stub.owner, ownerNpub: 'npub1stub', ownerName: null,
  coverUrl: '', songCount: stubSongs.length, createdAt: '2026-11-19T00:00:00.000Z', updatedAt: stub.updatedAt,
});
const stored = () => ({
  id: STUB_ID, title: STUB_TITLE, description: '', ownerName: '', artUrl: null, songs: stubSongs,
  ownerPubkey: stub.owner, createdAt: '2026-11-19T00:00:00.000Z', updatedAt: stub.updatedAt,
});

const writes = []; // every non-GET request, in every tab
async function setup(tab, { stubStore = false } = {}) {
  await tab.send('Page.enable'); await tab.send('Runtime.enable'); await tab.send('Network.enable');
  await tab.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  tab.on((m) => {
    const r = m.method === 'Network.requestWillBeSent' ? m.params.request : null;
    if (r && !['GET', 'HEAD', 'OPTIONS'].includes(r.method)) writes.push(`${r.method} ${r.url}`);
  });
  if (!stubStore) return;
  // Only OUR store's two reads are answered here; everything else goes to the real server.
  await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/community-playlists*', requestStage: 'Request' }] });
  tab.on((m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    const u = new URL(request.url);
    const reply = (body) => tab.send('Fetch.fulfillRequest', {
      requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }],
      body: json(body),
    }).catch(() => {});
    if (request.method === 'GET' && u.pathname === '/api/community-playlists' && u.searchParams.get('owner')) {
      // The owner asked about is this browser's guest key: the stub is "theirs".
      stub.owner = u.searchParams.get('owner');
      return void reply({ playlists: [summary()] });
    }
    if (request.method === 'GET' && u.pathname === `/api/community-playlists/${STUB_ID}` && stub.owner) {
      stub.served.push(stub.updatedAt);
      return void reply({ playlist: stored() });
    }
    void tab.send('Fetch.continueRequest', { requestId }).catch(() => {});
  });
}

const PLAY = 'li button[aria-label^="Play "], li button[aria-label="Play"]';
/** Load the album and play its `n`th track. */
async function playAlbumTrack(tab, n = 0) {
  await tab.send('Page.navigate', { url: `${APP}/?podcast=${ALBUM_GUID}` });
  if (!await tab.until(`document.querySelectorAll(${JSON.stringify(PLAY)}).length > ${n}`, 40000)) throw new Error('the album rows never rendered');
  await tab.js(`document.querySelectorAll(${JSON.stringify(PLAY)})[${n}].click()`);
  if (!await tab.until(`!!document.querySelector(${JSON.stringify(MINI_BAR)})`, 20000)) throw new Error('the mini player never appeared');
}

/** Press a control (an in-app link stays client-side: a full load would drop the playing item). */
async function press(tab, selector) {
  if (!await tab.until(`!!document.querySelector(${JSON.stringify(selector)})`, 30000)) throw new Error(`no ${selector}`);
  await tab.js(`document.querySelector(${JSON.stringify(selector)}).click()`);
}

/** Go to `path` in-app: its link when one is on screen, else the Next router (client-side either way). */
async function goInApp(tab, path) {
  const how = await tab.js(`(() => {
    const a = document.querySelector(${JSON.stringify(`a[href="${path}"]`)});
    if (a) { a.click(); return 'link'; }
    if (window.next?.router?.push) { window.next.router.push(${JSON.stringify(path)}); return 'router'; }
    return null;
  })()`);
  if (!how) throw new Error(`no in-app way to ${path}`);
  if (!await tab.until(`location.pathname === ${JSON.stringify(path)}`, 30000)) throw new Error(`never reached ${path}`);
}

/** The maker's "N songs" line. */
const makerSongs = (tab) => tab.js(`(() => {
  const p = [...document.querySelectorAll('[data-songs-panel] p')].map((x) => x.textContent).find((x) => /^\\d+ songs?$/.test(x || ''));
  return p ?? null;
})()`);

async function escape(tab) {
  await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait(250);
}
/** Close every dialog (<StartChoice>, the sheet, the fullscreen player). */
async function closeDialogs(tab) {
  for (let i = 0; i < 6 && await tab.js(`!!document.querySelector('[role="dialog"]')`); i++) await escape(tab);
}

/** Type at the end of one of the maker's boxes. */
async function typeIn(tab, selector, text) {
  const ok = await tab.js(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); if (!i) return false;
    i.focus(); i.setSelectionRange(i.value.length, i.value.length); return true; })()`);
  if (!ok) throw new Error(`no ${selector} in the maker`);
  await tab.send('Input.insertText', { text });
}

/** Open the fullscreen player's "+ PLAYLIST" sheet. */
async function openSheet(tab) {
  await tab.js(`document.querySelector(${JSON.stringify(MINI_BAR)}).click()`);
  // ⋯ toggles its menu, which may still be open from the last visit.
  const more = 'button[aria-label="More actions for this episode"]';
  for (let i = 0; i < 3 && !await tab.js(`!!document.querySelector('[data-save-to-playlist]')`); i++) {
    await press(tab, more);
    await tab.until(`!!document.querySelector('[data-save-to-playlist]')`, 3000);
  }
  await press(tab, '[data-save-to-playlist]');
}
const addBtn = (title) => `button[aria-label=${JSON.stringify(`Add to ${title}`)}]`;
const rowAdded = (title) => `!!document.querySelector(${JSON.stringify(addBtn(title))})?.closest('li')?.querySelector('[data-added]')`;
/** Press + ADD on `title` in the open sheet; true once its row says ✓ ADDED. */
async function addInSheet(tab, title) {
  await press(tab, addBtn(title));
  return tab.until(rowAdded(title), 15000);
}
const rowText = (tab, title) => tab.js(`document.querySelector(${JSON.stringify(addBtn(title))})?.closest('li')?.textContent ?? null`);

const readSlot = async (tab, slot, owner) => JSON.parse(await tab.js(`localStorage.getItem(${JSON.stringify(slotKey(slot, owner))}) || 'null'`));
const guids = (s) => (s?.draft?.songs ?? []).map((x) => x.itemGuid);

try {
  // ---- 1. SAME TAB ---------------------------------------------------------
  console.log('\n1. same tab: the maker open, + PLAYLIST from the fullscreen player');
  const A = b.page;
  await setup(A);
  await A.send('Page.navigate', { url: `${APP}/` });
  await A.until(`document.readyState === 'complete'`, 30000);
  await A.js(`localStorage.setItem(${JSON.stringify(slotKey('new-reproone'))}, ${JSON.stringify(seedDraft('Repro one'))})`);
  await playAlbumTrack(A);
  await goInApp(A, '/playlists');
  await press(A, 'a[aria-label="Open Repro one"]');
  if (!await A.until(`location.pathname === '/playlists/make' && !!document.querySelector('[data-songs-panel]')`, 30000)) throw new Error('the maker never opened');
  t.ok('the player is still up on the maker (in-app navigation)', await A.js(`!!document.querySelector(${JSON.stringify(MINI_BAR)})`));
  await closeDialogs(A);
  t.equal('the maker shows the seeded song', await makerSongs(A), '1 song');
  await openSheet(A);
  t.ok('the sheet says ✓ ADDED', await addInSheet(A, 'Repro one'));
  t.equal('the slot holds both songs right after the add', guids(await readSlot(A, 'new-reproone')).length, 2);
  await closeDialogs(A);
  t.equal('the maker shows the added song without a reload', await makerSongs(A), '2 songs');
  await typeIn(A, '#pl-title', 'x');
  await wait(600);
  const after1 = await readSlot(A, 'new-reproone');
  t.equal('after an edit in the maker the slot still holds both songs', guids(after1).length, 2);
  t.equal('and the edit landed', after1?.draft?.title, 'Repro onex');
  t.equal('the maker still shows both songs', await makerSongs(A), '2 songs');
  t.ok('the added song has its label in the slot', !!after1?.labels?.[guids(after1)[1]]?.title);

  // ---- 2. SECOND TAB -------------------------------------------------------
  for (const pause of [0, 1500]) {
    const slot = `new-reprotwo${pause}`;
    const title = `Repro two ${pause}`;
    console.log(`\n2. second tab: the sheet in B, the maker in A, an edit in A ${pause} ms after the add`);
    await A.js(`localStorage.setItem(${JSON.stringify(slotKey(slot))}, ${JSON.stringify(seedDraft(title))})`);
    await A.send('Page.navigate', { url: `${APP}/playlists/make?draft=${slot}` });
    if (!await A.until(`!!document.querySelector('[data-songs-panel]')`, 30000)) throw new Error('the maker never opened in A');
    await closeDialogs(A);
    t.equal('A shows the seeded song', await makerSongs(A), '1 song');
    const B = await b.openTab();
    await setup(B);
    await playAlbumTrack(B);
    await openSheet(B);
    t.ok('B: the sheet says ✓ ADDED', await addInSheet(B, title));
    if (pause) await wait(pause);
    await typeIn(A, '#pl-title', 'y');
    await wait(800);
    const s = await readSlot(A, slot);
    t.equal(`A edited ${pause} ms later: the slot still holds both songs`, guids(s).length, 2);
    t.equal('and the edit landed', s?.draft?.title, `${title}y`);
    t.equal('A shows both songs', await makerSongs(A), '2 songs');
    await B.close();
  }

  // ---- 3. NO EVENT ---------------------------------------------------------
  console.log('\n3. no event: the slot written behind the maker, and nothing told it');
  {
    const slot = 'new-reprothree';
    const behind = (song, label) => A.js(`(() => { const k = ${JSON.stringify(slotKey(slot))}; const v = JSON.parse(localStorage.getItem(k));
      v.draft.songs.push(${JSON.stringify(song)}); ${label ? `v.labels[${JSON.stringify(song.itemGuid)}] = { title: ${JSON.stringify(label)} };` : ''}
      localStorage.setItem(k, JSON.stringify(v)); })()`);
    await A.js(`localStorage.setItem(${JSON.stringify(slotKey(slot))}, ${JSON.stringify(seedDraft('Repro three'))})`);
    await A.send('Page.navigate', { url: `${APP}/playlists/make?draft=${slot}` });
    if (!await A.until(`!!document.querySelector('[data-songs-panel]')`, 30000)) throw new Error('the maker never opened in A');
    await closeDialogs(A);
    await behind({ feedGuid: 'late-feed', itemGuid: 'late-item' }, 'Late song');
    await wait(300);
    t.equal('nothing told the maker yet: it shows 1 song', await makerSongs(A), '1 song');
    await typeIn(A, '#pl-desc', 'd');
    await wait(800);
    const s = await readSlot(A, slot);
    t.equal("the maker's write took the song in", guids(s), ['seed-item', 'late-item']);
    t.equal('and its own edit landed', s?.draft?.description, 'd');
    t.equal('the maker shows both songs', await makerSongs(A), '2 songs');
    t.ok("with the late song's label", await A.js(`document.querySelector('[data-songs-panel]').textContent.includes('Late song')`));
    // A song removed in the maker does not come back with the next add.
    const removed = await A.js(`(() => { const li = [...document.querySelectorAll('[data-songs-panel] li')].find((x) => x.textContent.includes('Seed song'));
      const r = li && [...li.querySelectorAll('button')].find((x) => /remove/i.test(x.getAttribute('aria-label') || '') || x.textContent.trim() === '×');
      if (!r) return false; r.click(); return true; })()`);
    t.ok('the seed song has a remove button', removed);
    await wait(500);
    t.equal('the seed song removed: the slot holds the late song only', guids(await readSlot(A, slot)), ['late-item']);
    await behind({ feedGuid: 'later-feed', itemGuid: 'later-item' });
    await typeIn(A, '#pl-desc', 'e');
    await wait(800);
    t.equal('another add: kept, and the removed song stays removed', guids(await readSlot(A, slot)), ['late-item', 'later-item']);
  }

  // ---- 4. A PUBLISHED PLAYLIST ---------------------------------------------
  console.log('\n4. a published playlist (the store stubbed): Your playlists, the sheet, the maker on ?id=');
  {
    const C = await b.openTab();
    await setup(C, { stubStore: true });
    // This browser's guest key, made the one way a person makes it.
    await C.send('Page.navigate', { url: `${APP}/playlists/make` });
    await press(C, '[data-start-guest]');
    if (!await C.until(`!document.querySelector('[data-start-guest]')`, 20000)) throw new Error("I DON'T HAVE NOSTR made no key");
    await C.send('Page.navigate', { url: `${APP}/playlists` });
    if (!await C.until(`!!document.querySelector('[data-your-playlists] a[data-edit-playlist]')`, 30000)) throw new Error('Your playlists never listed the stub');
    const page = await C.js(`(() => { const y = document.querySelector('[data-your-playlists]');
      const hs = [...document.querySelectorAll('main h2, h2')].map((h) => h.textContent.trim());
      return { first: hs[0], stub: y.textContent.includes(${JSON.stringify(STUB_TITLE)}), tracks: y.textContent.includes('10 tracks'),
        drafts: y.textContent.includes('Repro one'), empty: y.textContent.includes('No playlists yet') }; })()`);
    t.equal('/playlists: Your playlists is the first section', page.first, 'Your playlists');
    t.ok('it lists the published playlist with its track count', page.stub && page.tracks, JSON.stringify(page));
    t.ok('and this device\'s drafts under it, with no "No playlists yet"', page.drafts && !page.empty, JSON.stringify(page));
    t.equal('/playlists at 390 px: no sideways overflow', await C.js(`document.documentElement.scrollWidth - document.documentElement.clientWidth`), 0);

    // The sheet adds to the PUBLISHED playlist's unsaved changes.
    await playAlbumTrack(C, 0);
    await openSheet(C);
    if (!await C.until(`!!document.querySelector(${JSON.stringify(addBtn(STUB_TITLE))})`, 20000)) throw new Error('the sheet never listed the published playlist');
    t.ok('the sheet lists it as published', (await rowText(C, STUB_TITLE))?.includes('10 songs · published'), await rowText(C, STUB_TITLE));
    t.ok('+ ADD: ✓ ADDED', await addInSheet(C, STUB_TITLE));
    t.ok('the row now says +1 not saved', (await rowText(C, STUB_TITLE))?.includes('+1 not saved'), await rowText(C, STUB_TITLE));
    const owner = await C.js(`Object.keys(localStorage).find((k) => k.endsWith(':${STUB_ID}'))?.split(':')[2] ?? null`);
    t.ok("the edit slot is under the guest key's npub", !!owner && owner.startsWith('npub1'), String(owner));
    const s0 = await readSlot(C, STUB_ID, owner);
    t.equal('it holds the 10 stored songs and the new one', guids(s0).length, 11);
    t.equal('at the version it was read at', s0?.expectedUpdatedAt, '2026-11-20T00:00:00.000Z');
    await closeDialogs(C);

    // The maker opens on ?id= (in-app, so the player stays), and a second tab adds.
    await goInApp(C, '/playlists');
    await press(C, `[data-your-playlists] a[aria-label="Edit ${STUB_TITLE}"]`);
    if (!await C.until(`location.search.includes('id=${STUB_ID}') && !!document.querySelector('[data-songs-panel]')`, 30000)) throw new Error('the maker never opened on ?id=');
    await closeDialogs(C);
    t.equal('the maker shows the unsaved add', await makerSongs(C), '11 songs');
    const D = await b.openTab();
    await setup(D, { stubStore: true });
    await playAlbumTrack(D, 1);
    await openSheet(D);
    if (!await D.until(`!!document.querySelector(${JSON.stringify(addBtn(STUB_TITLE))})`, 20000)) throw new Error('tab D: no published row');
    t.ok('tab D: + ADD a second track: ✓ ADDED', await addInSheet(D, STUB_TITLE));
    await typeIn(C, '#pl-desc', 'z');
    await wait(800);
    const s1 = await readSlot(C, STUB_ID, owner);
    t.equal('the maker took it in: 12 songs in the slot', guids(s1).length, 12);
    t.equal('the maker shows 12', await makerSongs(C), '12 songs');
    t.equal('and its version is the one it loaded', s1?.expectedUpdatedAt, '2026-11-20T00:00:00.000Z');

    // The 409 rule: the playlist changes elsewhere AFTER the maker loaded it, with no
    // edit slot held. The sheet seeds the slot from the NEWER copy; the maker keeps its own.
    await C.js(`localStorage.removeItem(${JSON.stringify(slotKey(STUB_ID, owner))})`);
    await C.send('Page.navigate', { url: `${APP}/playlists/make?id=${STUB_ID}` });
    if (!await C.until(`!!document.querySelector('[data-songs-panel]')`, 30000)) throw new Error('the maker never reopened');
    await closeDialogs(C);
    t.equal('reopened with no unsaved changes: 10 songs', await makerSongs(C), '10 songs');
    stub.updatedAt = '2026-11-24T00:00:00.000Z';
    await closeDialogs(D);
    await openSheet(D);
    const servedBefore = stub.served.length;
    t.ok('tab D: + ADD again', await addInSheet(D, STUB_TITLE));
    // With no edit slot held, the sheet seeded it from the store, which now answers the
    // NEWER copy. (The slot itself is not read here: the maker writes its own version
    // back as soon as it takes the add in, which is the rule under test.)
    t.equal('the sheet seeded the slot from the newer copy', stub.served.slice(servedBefore), ['2026-11-24T00:00:00.000Z']);
    await typeIn(C, '#pl-desc', 'q');
    await wait(800);
    const s2 = await readSlot(C, STUB_ID, owner);
    t.equal('the maker took the add in: 11 songs', guids(s2).length, 11);
    t.equal('and KEPT the version it loaded, so SAVE still meets the 409', s2?.expectedUpdatedAt, '2026-11-20T00:00:00.000Z');
    await D.close();
    await C.close();
  }

  // ---- 5. TWO FAST TAPS ----------------------------------------------------
  console.log('\n5. two taps on + ADD before the sheet re-renders');
  {
    const E = await b.openTab();
    await setup(E);
    await E.send('Page.navigate', { url: `${APP}/` });
    await E.until(`document.readyState === 'complete'`, 30000);
    await E.js(`localStorage.setItem(${JSON.stringify(slotKey('new-reprofive'))}, ${JSON.stringify(seedDraft('Repro five'))})`);
    await playAlbumTrack(E, 0);
    await openSheet(E);
    if (!await E.until(`!!document.querySelector(${JSON.stringify(addBtn('Repro five'))})`, 20000)) throw new Error('no Repro five row');
    await E.js(`(() => { const b = document.querySelector(${JSON.stringify(addBtn('Repro five'))}); b.click(); b.click(); })()`);
    await E.until(rowAdded('Repro five'), 15000);
    await wait(500);
    const txt = await rowText(E, 'Repro five');
    t.ok('the row says ✓ ADDED', txt?.includes('✓ ADDED'), txt);
    t.ok('and not "Already in it"', !txt?.includes('Already in it'), txt);
    t.equal('the song is in the draft once', guids(await readSlot(E, 'new-reprofive')).length, 2);
    await E.close();
  }

  console.log('\nan add sends nothing');
  t.equal('no POST, PUT or DELETE left any tab in the whole run', writes, []);
} catch (e) {
  t.fail('run', e?.stack || String(e));
}

console.log(`\n${t.count - t.fails}/${t.count} passed`);
await exit(t.fails ? 1 : 0);
