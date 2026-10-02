// Drives the listen queue in a real browser, with the identity half that
// nothing has ever driven.
//
// Usage:
//   npm run dev                  # in another terminal (or build && npm start)
//   CHROME_PATH=/usr/bin/google-chrome npm run e2e:queue
//   npm run e2e:queue -- --headed --keep
//
// WHY THIS EXISTS. PR #132 shipped with no test of any kind, and its own body
// says where the hole is: "Everything above ran signed out (`:guest`). The four
// identity sites are wired and reviewed but not driven." Per-npub `bmb:*` state
// with an adoption-on-sign-in step is precisely where this repo's silent data
// losses have happened, so that is the half this file is for.
//
// `check:queue` pins the four pure decisions and cannot see any of this: whether
// the bytes reach the right KEY, whether a reload finds them, whether switching
// accounts shows you somebody else's queue, and whether signing out leaves a
// queue on disk that comes back. All of that is wiring.
//
// WHAT IT DRIVES, AND WHAT IT STILL DOES NOT. Sections 1-5 press the real
// controls. Section 4 reaches a signed-in state the way the app does on a page
// load — the RESTORE effect, one of the identity sites — by seeding
// `bmb:npub` + `bmb:signer` and reloading, which is the same thing
// `e2e-favorites.mjs` does. **`completeSignIn`'s adopt branch is NOT driven
// here**: it runs on an interactive sign-in through the modal, not on a
// restore. That one is still owed, and saying so is better than a section that
// looks like it covers it.
//
// A throwaway key lives in this process and is reached from the page over a CDP
// binding, so `window.nostr` is indistinguishable from an extension; the relay
// is the same in-memory NIP-01 one `npm run relay` starts, imported rather than
// copied. NOTHING REACHES A PUBLIC RELAY.

import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44, nip04 } from 'nostr-tools';

const APP = process.env.APP_URL ?? 'http://localhost:3000';

// Measured feeds, both real and both still published.
const HGH = 'ac746d09-7c3b-5bcd-b28a-f12d6456ca8f';   // Homegrown Hits (music)
const PC20 = '917393e3-1b1e-5cef-ace4-edaa54e1f810';  // Podcasting 2.0 (talk)

await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.
(and \`rm -rf .next\` first if you have just run a production build)`);

// The browser comes from scripts/cdp.mjs: CHROME_PATH, else the usual install
// paths; muted, on a free debug port, closed on any exit. That retired this
// file's own busy-port guard — a leftover run on a FIXED port used to hand the
// script the OLD browser, and every assertion graded that one instead.
// `--headed` and `--keep` are read by the harness.
const { page } = await launchChrome({ name: 'queue', args: ['--disable-gpu', '--window-size=1200,900'] });
const { send } = page;
// Throws on a page exception, which is what this file's assertions expect.
const js = page.jsOrThrow;

const skA = generateSecretKey();
const pkA = getPublicKey(skA);
const npubA = nip19.npubEncode(pkA);
const convoA = nip44.v2.utils.getConversationKey(skA, pkA);
const npubB = nip19.npubEncode(getPublicKey(generateSecretKey()));

// Port 0 and read back, never a fixed port: another run can already hold one.
const relay = createRelay({ port: 0, log: null, onEvent: () => {} });
const PORT = await relay.ready;

await send('Page.enable'); await send('Runtime.enable');
await send('Runtime.addBinding', { name: 'bmbSigner' });
page.on(async (m) => {
  if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'bmbSigner') return;
  const { rid, fn, args } = JSON.parse(m.params.payload);
  let out, err = null;
  try {
    if (fn === 'getPublicKey') out = pkA;
    else if (fn === 'signEvent') out = finalizeEvent(args[0], skA);
    else if (fn === 'nip44.encrypt') out = nip44.v2.encrypt(args[1], convoA);
    else if (fn === 'nip44.decrypt') out = nip44.v2.decrypt(args[1], convoA);
    else if (fn === 'nip04.encrypt') out = await nip04.encrypt(skA, args[0], args[1]);
    else if (fn === 'nip04.decrypt') out = await nip04.decrypt(skA, args[0], args[1]);
    else err = `no such method ${fn}`;
  } catch (e) { err = String(e?.message ?? e); }
  await send('Runtime.evaluate', {
    expression: `window.__bmbResolve(${JSON.stringify(rid)}, ${JSON.stringify(out ?? null)}, ${JSON.stringify(err)})`,
  });
});
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    (() => {
      const waiting = new Map();
      window.__bmbResolve = (rid, out, err) => {
        const p = waiting.get(rid); if (!p) return; waiting.delete(rid);
        err ? p.reject(new Error(err)) : p.resolve(out);
      };
      let n = 0;
      const call = (fn, args) => new Promise((resolve, reject) => {
        const rid = 'r' + (++n);
        waiting.set(rid, { resolve, reject });
        window.bmbSigner(JSON.stringify({ rid, fn, args }));
      });
      window.nostr = {
        getPublicKey: () => call('getPublicKey', []),
        signEvent: (e) => call('signEvent', [e]),
        nip44: { encrypt: (p, t) => call('nip44.encrypt', [p, t]), decrypt: (p, c) => call('nip44.decrypt', [p, c]) },
        nip04: { encrypt: (p, t) => call('nip04.encrypt', [p, t]), decrypt: (p, c) => call('nip04.decrypt', [p, c]) },
      };
    })();
  `,
});

const t = checker();
function section(n) { console.log(`\n${n}`); }
function check(label, actual, expected) { t.equal(label, actual, expected); }

const queueOnDisk = (who) => js(`
  (() => {
    const raw = localStorage.getItem('bmb:listen_queue:' + ${JSON.stringify(who)});
    return raw ? JSON.parse(raw) : null;
  })()
`);

/**
 * Queue the first N episode rows on the page, the way a listener does: open the
 * row's ⋯ and press QUEUE in it. Since #462 (2026-10-01) QUEUE is in that menu
 * at EVERY width — there is no inline control to press — and the menu closes
 * itself after a tile press. Returns how many it queued.
 */
const pressQueueExpr = (n) => `
  (async () => {
    const tick = () => new Promise((r) => setTimeout(r, 350));
    let pressed = 0;
    // Row by row until N are queued. A row whose menu has NO queue tile is
    // skipped and its menu closed: a live or upcoming item cannot be queued
    // (\`canQueueEpisode\`), and Homegrown Hits lists its live episode at the top
    // while it is on air (measured 2026-10-01: "● LIVE Episode 153").
    for (const t of document.querySelectorAll('button[aria-label^="More actions for "]')) {
      if (pressed >= ${n}) break;
      t.click();
      await tick();
      const add = document.querySelector('[aria-label^="Actions for "] button[aria-label^="Add "]');
      if (add) { add.click(); pressed++; }
      else t.click();
      await tick();
    }
    return pressed;
  })()
`;
const pressQueue = (n) => js(pressQueueExpr(n));

const seedRelays = `localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))});`;

await send('Page.navigate', { url: APP }); await wait(3000);
await js(`(() => { localStorage.clear(); ${seedRelays} return 1; })()`);

console.log(`\n  throwaway npub ${npubA.slice(0, 20)}…   relay ws://127.0.0.1:${PORT}\n`);

// ---------------------------------------------------------------------------
section('1. Signed out, the queue fills from two different shows and persists');
// ---------------------------------------------------------------------------
await send('Page.navigate', { url: `${APP}/?podcast=${HGH}` }); await wait(14000);
const pressed1 = await pressQueue(2);
await wait(1500);
await send('Page.navigate', { url: `${APP}/?podcast=${PC20}` }); await wait(14000);
const pressed2 = await pressQueue(1);
await wait(1500);

const guest = await queueOnDisk('guest');
check('two shows queued, under the guest key, in press order',
  { pressed: pressed1 + pressed2, len: guest?.length ?? 0, shows: new Set((guest ?? []).map((i) => i.podcast?.podcastGuid)).size },
  { pressed: 3, len: 3, shows: 2 });

// The trim is a denylist and the value block is the reason. A queue read back
// days later is what pays the artist.
const shape = await js(`
  (() => {
    const q = JSON.parse(localStorage.getItem('bmb:listen_queue:guest') || '[]');
    return {
      noDescription: q.every((i) => i.episode.description === undefined),
      noContentEncoded: q.every((i) => i.episode.contentEncoded === undefined),
      keptEnclosure: q.every((i) => !!i.episode.enclosureUrl),
      keptAShow: q.every((i) => typeof i.podcast?.id === 'number'),
    };
  })()
`);
check('description and contentEncoded are trimmed; the enclosure and a show survive',
  shape, { noDescription: true, noContentEncoded: true, keptEnclosure: true, keptAShow: true });

// ---------------------------------------------------------------------------
section('2. The same episode cannot be queued twice');
// ---------------------------------------------------------------------------
// A queued row does not offer a second Add — its control has become Remove.
// That is `epKey` answering, which is why this is the assertion rather than
// pressing Add twice and hoping: pressing twice would hit a DIFFERENT row.
const before = (await queueOnDisk('guest')).length;
const toggled = await js(`
  (async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // The first row's ⋯ menu holds its QUEUE tile (#462: at every width).
    const openFirstMenu = async () => {
      document.querySelector('button[aria-label^="More actions for "]')?.click();
      await sleep(350);
      return document.querySelector('[aria-label^="Actions for "]');
    };
    const menu1 = await openFirstMenu();
    const remove = menu1?.querySelector('button[aria-label^="Remove "]');
    const hadRemove = !!remove;
    remove?.click();
    await sleep(800);
    const afterRemove = JSON.parse(localStorage.getItem('bmb:listen_queue:guest') || '[]').length;
    // Re-add the same row: its control is an Add again.
    const menu2 = await openFirstMenu();
    menu2?.querySelector('button[aria-label^="Add "]')?.click();
    await sleep(800);
    const afterReAdd = JSON.parse(localStorage.getItem('bmb:listen_queue:guest') || '[]').length;
    return { hadRemove, afterRemove, afterReAdd };
  })()
`);
check('a queued row offers Remove, and the round trip returns to the same length',
  { before, ...toggled }, { before: 3, hadRemove: true, afterRemove: 2, afterReAdd: 3 });

// ---------------------------------------------------------------------------
section('3. It survives a reload, and the player finds it without autoplaying');
// ---------------------------------------------------------------------------
await send('Page.navigate', { url: `${APP}/listen` }); await wait(8000);
const afterReload = await js(`
  (() => {
    const rows = document.querySelectorAll('li');
    const audio = document.querySelector('audio');
    return {
      rows: rows.length,
      playing: audio ? !audio.paused : null,
      headingSaysUpNext: /up next/i.test(document.body.textContent || ''),
    };
  })()
`);
check('the queue renders after a reload and nothing started playing',
  afterReload, { rows: 3, playing: false, headingSaysUpNext: true });

// ---------------------------------------------------------------------------
section('4. A signed-in account gets ITS queue, never another account\'s');
// ---------------------------------------------------------------------------
// The restore effect is one of the four identity sites. Seeded the way
// e2e-favorites.mjs seeds it, because that is what a page load actually does.
await js(`
  (() => {
    localStorage.setItem('bmb:npub', ${JSON.stringify(npubA)});
    localStorage.setItem('bmb:signer', 'nip07');
    const guest = localStorage.getItem('bmb:listen_queue:guest');
    localStorage.setItem('bmb:listen_queue:' + ${JSON.stringify(npubA)}, guest);
    localStorage.setItem('bmb:listen_queue:' + ${JSON.stringify(npubB)}, '[]');
    return 1;
  })()
`);
await send('Page.navigate', { url: `${APP}/listen` }); await wait(12000);
const asA = await js(`document.querySelectorAll('li').length`);
check("account A sees A's three", { rows: asA }, { rows: 3 });

await js(`(() => { localStorage.setItem('bmb:npub', ${JSON.stringify(npubB)}); return 1; })()`);
await send('Page.navigate', { url: `${APP}/listen` }); await wait(12000);
const asB = await js(`
  (() => ({
    rows: document.querySelectorAll('li').length,
    saysEmpty: /nothing queued/i.test(document.body.textContent || ''),
    aStillOnDisk: JSON.parse(localStorage.getItem('bmb:listen_queue:' + ${JSON.stringify(npubA)}) || '[]').length,
  }))()
`);
check("account B sees its own empty queue, and A's is untouched on disk",
  asB, { rows: 0, saysEmpty: true, aStillOnDisk: 3 });

// ---------------------------------------------------------------------------
section('5. Signing out does not leave a guest queue that comes back');
// ---------------------------------------------------------------------------
// `setListenQueue([])` clears MEMORY. The store seeds `listenQueue` from
// `storage.listenQueue.get(null)` at module scope, so a guest queue left on
// disk reappears on the next load — which the sign-out comment explicitly says
// must not happen.
await js(`(() => { localStorage.setItem('bmb:npub', ${JSON.stringify(npubA)}); return 1; })()`);
await send('Page.navigate', { url: APP }); await wait(12000);
const opened = await js(`
  (() => {
    const t = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-expanded') !== null) && /account|menu|signed/i.test(b.getAttribute('aria-label') || ''));
    if (t) { t.click(); return true; }
    return false;
  })()
`);
await wait(1200);
const signedOut = await js(`
  (() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().toLowerCase() === 'sign out');
    if (!b) return 'no sign-out control found';
    b.click();
    return 'clicked';
  })()
`);
await wait(4000);
// ABSENT OR EMPTY, and the distinction matters in one direction only.
//
// This used to assert `length === 0`, which required the key to still EXIST —
// so it was quietly pinning the implementation (`set(null, [])`) rather than the
// property. That implementation dropped `safeSet`'s boolean, so on a full or
// blocked store the `[]` went to the memory mirror and the old bytes survived on
// disk: the guest queue came back on the next load, which is the exact thing
// this section exists to refuse. The fix removes the key instead, and an absent
// key is STRICTLY STRONGER — `storage.listenQueue.get` returns `[]` for both, and
// only one of them can fail to reach disk.
//
// What must still fail here is a non-empty queue, which is why this reads the
// length rather than just asserting falsiness.
const guestAfter = await js(`
  (() => {
    const raw = localStorage.getItem('bmb:listen_queue:guest');
    return { raw, len: raw === null ? 'absent' : JSON.parse(raw).length };
  })()
`);
check('the account menu opened and sign out ran', { opened, signedOut }, { opened: true, signedOut: 'clicked' });
check('the guest queue is gone from DISK, not merely from memory',
  { gone: guestAfter.len === 'absent' || guestAfter.len === 0, saw: guestAfter.len },
  { gone: true, saw: guestAfter.len });

await send('Page.navigate', { url: `${APP}/listen` }); await wait(8000);
const resurrect = await js(`document.querySelectorAll('li').length`);
check('and it does not come back on the next load', { rows: resurrect }, { rows: 0 });

// ---------------------------------------------------------------------------
section('6. The dock reaches it, Listen is second, and /queue still lands');
// ---------------------------------------------------------------------------
const dock = await js(`
  (() => {
    const nav = document.querySelector('nav[aria-label="Main"]');
    const items = [...nav.querySelectorAll('a,button')];
    return {
      labels: items.map((i) => i.textContent.trim()),
      current: items.find((i) => i.getAttribute('aria-current') === 'page')?.textContent.trim() ?? null,
    };
  })()
`);
check('five tabs, Listen second, Wallet gone, and /listen is current',
  dock, { labels: ['Home', 'Listen', 'Live', 'Favorites', 'Downloads'], current: 'Listen' });

// The tab was `/queue` until 2026-10-01. A shared link, a bookmark and the
// installed app's last route can still say so; it must land, not 404.
await send('Page.navigate', { url: `${APP}/queue` }); await wait(6000);
const landed = await js(`({ path: location.pathname, tab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim().split(' ')[0] ?? null })`);
check('/queue redirects to /listen, open on UP NEXT', landed, { path: '/listen', tab: 'Up' });

// ---------------------------------------------------------------------------
section('7. A queued episode resumes where it was left, and finishing it forgets the place');
// ---------------------------------------------------------------------------
{
  // #414 (resume position) and the queue were written on different branches.
  // `play()` starts an episode at its saved place; the queue's own paths wrote
  // `positionSec: 0`, so a half-heard episode queued as Up Next started at 0:00
  // and then overwrote its saved place. This drives the reveal path (a reload
  // with a queue on disk) and the drain path (the last item plays to its end).
  //
  // Its own browser with autoplay: the drain needs a REAL `ended` — the writer
  // forgets on `el.ended`, which a synthetic event does not set. Signed out, so
  // no signer is needed.
  const { page: q2 } = await launchChrome({ name: 'queue-resume', autoplay: true, args: ['--disable-gpu', '--window-size=1200,900'] });
  const js2 = q2.jsOrThrow;
  await q2.send('Page.enable'); await q2.send('Runtime.enable');
  await q2.send('Page.navigate', { url: `${APP}/?podcast=${PC20}` }); await wait(14000);
  const pressed = (await js2(pressQueueExpr(1))) === 1;
  await wait(1500);
  const item = await js2(`(() => { const q = JSON.parse(localStorage.getItem('bmb:listen_queue:guest') || '[]'); return q[0] ?? null; })()`);
  check('one talk episode queued', { pressed, queued: !!item?.episode?.enclosureUrl }, { pressed: true, queued: true });
  // `resumeKey`: the episode's own podcastGuid, then its guid.
  const key = item ? `${item.episode.podcastGuid || item.podcast.podcastGuid}::${item.episode.guid || `id:${item.episode.id}`}` : '';
  await js2(`(() => { localStorage.setItem('bmb:resume', JSON.stringify({ [${JSON.stringify(key)}]: { t: 600, d: 7200, at: Date.now() } })); return true; })()`);

  // Reload: `revealQueue` puts the head in the player without playing it, and
  // the source effect seeks to `positionSec` on `loadedmetadata`.
  await q2.send('Page.navigate', { url: `${APP}/listen` });
  const seeked = await q2.until(`(() => { const a = document.querySelector('audio'); return !!a && a.readyState >= 1 && a.currentTime >= 599; })()`, 30000);
  const at = await js2(`(() => { const a = document.querySelector('audio'); return a ? Math.round(a.currentTime) : null; })()`);
  check('the revealed queue head sits at its saved 10:00, not 0:00', { seeked, at: at >= 599 && at < 620 }, { seeked: true, at: true });

  // The revealed head is ACTIVE and PAUSED, the one state where the row's name
  // and its press disagreed: the label read `active` alone, so a screen reader
  // heard "Pause" on a row whose press starts playback. Found on a Pixel 6.
  const headRow = await js2(`(() => {
    const a = document.querySelector('audio');
    const b = document.querySelector('li button[aria-label^="Pause "], li button[aria-label^="Resume "], li button[aria-label^="Play "]');
    return { paused: !!a && a.paused, verb: b ? b.getAttribute('aria-label').split(' ')[0] : null };
  })()`);
  check('the paused head row is named Resume, never Pause', headRow, { paused: true, verb: 'Resume' });

  // Finish it: the last item drains, and a finished episode keeps no place.
  await js2(`(() => { const a = document.querySelector('audio'); a.currentTime = Math.max(0, a.duration - 4); return true; })()`);
  await js2(`(() => { const b = document.querySelector('button[aria-label="Play"]'); b && b.click(); return !!b; })()`);
  const drained = await q2.until(`(() => JSON.parse(localStorage.getItem('bmb:listen_queue:guest') || '[]').length === 0)()`, 30000);
  await wait(1500);
  const left = await js2(`(() => { const m = JSON.parse(localStorage.getItem('bmb:resume') || '{}'); return m[${JSON.stringify(key)}] ?? null; })()`);
  check('it played to the end and left the queue', drained, true);
  check('...and its saved place is gone', left, null);
  await q2.close();
}

// ---------------------------------------------------------------------------
section('8. A queued episode\'s show notes cost ONE feed read, not a loop');
// ---------------------------------------------------------------------------
{
  // `<FullscreenPlayer>` fetches the notes `trimForQueue` deleted, then hands the
  // feed's value block to `refreshCurrentValue`. That replaces `current.episode`,
  // and the effect was keyed on that OBJECT — so the refresh re-ran the fetch,
  // whose fresh parse was never `===` the last one, for as long as the episode
  // played. The browser answered from its 60 s HTTP cache, then the server
  // answered 429 to every `/api/feed` from the IP. `<FullscreenPlayer>` is
  // mounted under `<Player>` whether or not it is open, so nothing had to be
  // pressed. Counted at `fetch`, which sees a cache hit the network log hides.
  const { page: q3 } = await launchChrome({ name: 'queue-notes', args: ['--disable-gpu', '--window-size=1200,900'] });
  const js3 = q3.jsOrThrow;
  await q3.send('Page.enable'); await q3.send('Runtime.enable');
  await q3.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__feedReads = 0;
    const f = window.fetch;
    window.fetch = function (input, init) {
      const u = typeof input === 'string' ? input : input && input.url;
      if (u && u.includes('/api/feed?')) window.__feedReads++;
      return f.call(this, input, init);
    };
  ` });
  await q3.send('Page.navigate', { url: `${APP}/?podcast=${PC20}` }); await wait(14000);
  const pressed = (await js3(pressQueueExpr(1))) === 1;
  await wait(1500);
  const trimmed = await js3(`(() => {
    const q = JSON.parse(localStorage.getItem('bmb:listen_queue:guest') || '[]');
    const e = q[0] && q[0].episode;
    return !!e && !e.description && !e.contentEncoded && !!(e.value || e.valueTimeSplits);
  })()`);
  check('one talk episode queued, trimmed, carrying a value block', { pressed, trimmed }, { pressed: true, trimmed: true });

  // `revealQueue` puts the head in the player: the path the loop ran on.
  await q3.send('Page.navigate', { url: `${APP}/listen` });
  const revealed = await q3.until(`(() => { const a = document.querySelector('audio'); return !!a && !!a.src; })()`, 30000);
  await wait(15000);
  const reads = await js3('window.__feedReads');
  check('the queue head reached the player', revealed, true);
  check('its notes were fetched, once — at least one read and no loop', { fetched: reads >= 1, bounded: reads <= 2 }, { fetched: true, bounded: true });
  if (reads > 2) console.log(`    /api/feed reads in 15 s: ${reads}`);
  await q3.close();
}

// ---------------------------------------------------------------------------
section('9. The play history: a minute of LISTENING puts an episode there, and BOOST opens on it');
// ---------------------------------------------------------------------------
{
  // Listeners queue several episodes, hear a few, and come back to boost them —
  // and the queue drains each one as it ends. HISTORY keeps them. This drives
  // the recording hook in the real player (`use-play-history.ts`), the store's
  // write-through, the second tab, and BOOST's feed round trip; `check:queue`
  // pins the arithmetic and sees none of the wiring.
  //
  // At 5×, so a minute of listening takes ~12 s. Signed out and with no wallet,
  // so the BOOST modal can only open — nothing can be paid.
  const { page: q4 } = await launchChrome({ name: 'queue-history', autoplay: true, args: ['--disable-gpu', '--window-size=1200,900'] });
  const js4 = q4.jsOrThrow;
  const history = () => js4(`JSON.parse(localStorage.getItem('bmb:play_history') || '[]')`);
  await q4.send('Page.enable'); await q4.send('Runtime.enable');
  await q4.send('Page.navigate', { url: `${APP}/privacy` }); await wait(2000);
  await js4(`(() => { localStorage.clear(); localStorage.setItem('bmb:playback_rate', '5'); return 1; })()`);
  await q4.send('Page.navigate', { url: `${APP}/?podcast=${PC20}` }); await wait(14000);
  const started = await js4(`(() => { const b = document.querySelector('li button[aria-label="Play"]'); b && b.click(); return !!b; })()`);
  const playing = await q4.until(`(() => { const a = document.querySelector('audio'); return !!a && a.readyState >= 1 && !a.paused && a.currentTime > 0; })()`, 30000);
  check('a talk episode plays', { started, playing }, { started: true, playing: true });

  // A SCRUB is not listening: two ten-minute jumps move the position twenty
  // minutes, and the history must stay empty a few seconds later (5× for 3 s
  // is ~15 s of listening, under the minute).
  await js4(`(() => { const a = document.querySelector('audio'); a.currentTime += 600; return 1; })()`);
  await wait(1200);
  await js4(`(() => { const a = document.querySelector('audio'); a.currentTime += 600; return 1; })()`);
  await wait(3000);
  check('twenty minutes of scrubbing puts nothing in the history', (await history()).length, 0);

  const recorded = await q4.until(`JSON.parse(localStorage.getItem('bmb:play_history') || '[]').length === 1`, 40000);
  const entry = (await history())[0] ?? null;
  check('a minute of listening records it, once', recorded, true);
  check('...trimmed and shaped like a queue item, with a time',
    entry && { trimmed: !entry.episode.description && !entry.episode.contentEncoded, show: typeof entry.podcast.id, at: Number.isFinite(entry.at) },
    { trimmed: true, show: 'number', at: true });

  // A boost already in this device's log for it — legs as `logStoredBoost`
  // writes them, one paid and one failed — so the mark can be read.
  await js4(`(() => {
    const e = JSON.parse(localStorage.getItem('bmb:play_history'))[0];
    localStorage.setItem('bmb:boosts:guest', JSON.stringify([{ uuid: 'e2e', ts: Date.now(), podcastTitle: e.podcast.title,
      podcastId: e.podcast.id, podcastGuid: e.podcast.podcastGuid, episodeTitle: e.episode.title, episodeGuid: e.episode.guid,
      sats: 100, legs: [{ recipient: 'a@x.com', sats: 90, ok: true }, { recipient: 'b@x.com', sats: 10, ok: false }] }]));
    return 1;
  })()`);

  // A reload, then the second tab: the history is on disk, not in memory.
  await q4.send('Page.navigate', { url: `${APP}/listen` }); await wait(6000);
  const opened = await js4(`(() => { const t = [...document.querySelectorAll('[role="tab"]')].find((x) => x.textContent.startsWith('History')); t && t.click(); return t ? t.textContent.trim() : null; })()`);
  await wait(800);
  const row = await js4(`(() => {
    const li = document.querySelector('[role="tabpanel"] li');
    return li ? { boost: !!li.querySelector('button[aria-label^="Boost "]'), mark: (li.textContent.match(/⚡ ([\\d,?]+) boosted/) || [])[1] ?? null } : null;
  })()`);
  check('the HISTORY tab counts it', opened, 'History · 1');
  check('its row has BOOST, and the mark counts only the leg that PAID', row, { boost: true, mark: '90' });

  // BOOST loads the episode from its feed again, then opens the modal on it.
  await js4(`document.querySelector('[role="tabpanel"] li button[aria-label^="Boost "]').click()`);
  const modal = await q4.until(`!!document.querySelector('[role="dialog"]')`, 20000);
  check('BOOST opens the boost modal (no wallet here, so nothing can be paid)', modal, true);
  await q4.close();
}

if (t.fails) {
  console.error(`\nQUEUE E2E FAILED (${t.fails})`);
  await exit(1);
}
console.log('\nQUEUE E2E OK');
// EXIT EXPLICITLY, and this is not tidiness. `createRelay` opens a
// WebSocketServer that is never closed, so it holds the event loop open for ever:
// without this the suite PASSES and then hangs, which is indistinguishable from a
// hang that failed — and it stalls anything CHAINED behind it. `exit` also
// closes the browser the harness started.
await exit(0);
