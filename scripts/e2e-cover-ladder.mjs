// End-to-end for <PodcastCover>'s onError ladder when a URL fails INSTANTLY.
//
// Usage:
//   npm run build && npm start                    # in another terminal
//   npm run e2e:coverladder                       # headless
//   APP_URL=http://127.0.0.1:3019 npm run e2e:coverladder -- --headed --keep
//
// WHAT IT PINS: a cover never rests on a broken image. It ends on an image that
// loaded, or on the initial tile, and nothing in between.
//
// THE FAULT IT WAS WRITTEN AGAINST. The ladder was an index, and a passive
// effect reset it to 0 on mount and on every change of the URLs. A URL that
// fails with no round trip (blocked, offline, refused by the browser) fires
// `error` before that effect has run. `onError` moved the index to 1, then the
// effect moved it back to 0: the same URL, so the same `key`, so React kept the
// <img> that had already failed, and a failed <img> fires nothing again. Traced
// on 2026-11-07 on Homegrown Hits 157, whose `episode-157.gif` is a 404: every
// mounted cover logged `onError`, `0->1`, then the reset, then `idx=0`, and
// stayed a broken image for good.
//
// `Network.setBlockedURLs` is the instant failure on purpose. A 404 from a
// server takes a round trip and lands after the effect, which is why the
// feed-buttons e2e answers with Fetch interception instead and never saw this.
// The note is seeded into the feed's own cache, signed out, so nothing can be
// published. The lookups are real: Podcast Index and the show's own RSS.

import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run build && npm start\` in another terminal.`);

const HGH = 'ac746d09-7c3b-5bcd-b28a-f12d6456ca8f'; // Homegrown Hits
const HGH_ITEM = 'de330c86-439f-46d5-a83e-ee870aa20c1c'; // Episode 157
const BLOCKED = 'episode-157.gif'; // that episode's own art; both its URLs carry the name unencoded

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const rawEvent = finalizeEvent({
  kind: 1, created_at: Math.floor(Date.now() / 1000) + 3600, content: 'E2E-LADDER a note',
  tags: [
    ['i', `podcast:guid:${HGH}`], ['k', 'podcast:guid'],
    ['i', `podcast:item:guid:${HGH_ITEM}`], ['k', 'podcast:item:guid'],
  ],
}, sk);
const NOTES = [{
  id: rawEvent.id, pubkey, npub: nip19.npubEncode(pubkey), nevent: nip19.neventEncode({ id: rawEvent.id }),
  createdAt: rawEvent.created_at, content: rawEvent.content, isBoost: true, client: 'BoostMeBuddy',
  podcastGuid: HGH, episodeGuids: [HGH_ITEM], amountSats: 21, quotesResolved: true, author: null, replies: [], rawEvent,
}];

const { page } = await launchChrome({ name: 'coverladder', args: ['--disable-gpu'] });
const { send, js, until } = page;
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setBlockedURLs', { urls: [`*${BLOCKED}*`] });
const pageErrors = [];
page.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300));
  }
});
const t = checker();

// Every cover of this show on the page, by state. `pending` is a lazy image not
// on screen yet, or one still loading: neither is a verdict.
const COVERS = `(() => {
  const out = { loaded: 0, broken: [], pending: 0, tiles: 0 };
  for (const i of document.querySelectorAll('img')) {
    const src = i.getAttribute('src') || '';
    if (!/homegrownhits/.test(src)) continue;
    if (!i.complete) out.pending += 1;
    else if (i.naturalWidth > 0) out.loaded += 1;
    else out.broken.push(src.slice(-60));
  }
  const card = [...document.querySelectorAll('article')].find((a) => a.innerText.includes('E2E-LADDER'))
    ?.querySelector('.mt-2.border.border-line');
  if (card && !card.querySelector('img') && card.querySelector('[aria-hidden="true"]')) out.tiles += 1;
  return JSON.stringify(out);
})()`;
const covers = async () => JSON.parse(await js(COVERS));

console.log('\n1. The episode art fails instantly, at phone width');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Page.navigate', { url: `${APP}/privacy` });
await until('document.readyState === "complete"');
await js(`localStorage.clear(); localStorage.setItem('bmb:feed:global', ${JSON.stringify(JSON.stringify(NOTES))});`);
await send('Page.navigate', { url: `${APP}/` });
await until('document.readyState === "complete"');
const CARD = `[...document.querySelectorAll('article')].find((a) => a.innerText.includes('E2E-LADDER'))?.querySelector('.mt-2.border.border-line')`;
t.ok('the card names the episode', await until(`(${CARD}?.innerText ?? '').includes('Episode 157')`, 40000));
// The cover is lazy, so it loads only once it is on screen.
await js(`${CARD}.scrollIntoView({ block: 'center' })`);
const settled = await until(`(() => { const c = JSON.parse(${COVERS}); return c.pending === 0 && (c.loaded + c.tiles + c.broken.length) > 0; })()`, 30000);
t.ok('the card cover reached a verdict', settled, JSON.stringify(await covers()));
// A broken image is permanent, a ladder step is not: give any step time to land.
await wait(3000);
const after = await covers();
t.ok('at least one cover of the show was checked', after.loaded + after.tiles + after.broken.length > 0, JSON.stringify(after));
t.equal('no cover rests on a broken image', after.broken, []);
t.ok('the card shows a loaded image or the initial tile', await js(`(() => {
  const c = ${CARD}; const i = c?.querySelector('img');
  return i ? i.complete && i.naturalWidth > 0 : !!c?.querySelector('[aria-hidden="true"]'); })()`),
  await js(`${CARD}?.firstElementChild?.firstElementChild?.outerHTML?.slice(0, 200) ?? 'no card'`));

t.equal('no page exception', pageErrors, []);

console.log(`\n${t.count - t.fails} of ${t.count} passed`);
await exit(t.fails ? 1 : 0);
