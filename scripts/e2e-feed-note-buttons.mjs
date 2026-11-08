// End-to-end for the heart and queue on the home feed's notes.
//
// Usage:
//   npm run dev                                   # in another terminal
//   npm run e2e:feedbuttons                       # headless
//   APP_URL=http://127.0.0.1:3019 npm run e2e:feedbuttons -- --headed --keep
//
// WHAT IT PINS:
//
//   1. A track boost tags two items, and its card still offers the EPISODE. A
//      press favorites and queues the episode under its own show, never the
//      track under the episode's show or the episode under the track's album.
//   2. A bot's note names an episode and has no app link: no card, the label
//      stays, and the controls are there and work.
//   3. A note tagging only a show offers neither. That is a recorded rule (a show
//      favorite is a different subject, docs/nostr.md).
//   4. An item Podcast Index does not hold is a 404 with nothing stored, and the
//      note still renders as the show.
//   5. A record with no guid, stored on a device by an older build, does not hold
//      the controls back. It is read as absent and replaced.
//   6. No horizontal overflow at 390 and 320, and each control clears 24×24.
//   7. An episode whose own art fails still shows the SHOW's cover, never the
//      initial tile. Homegrown Hits 157's `episode-157.gif` was a 404 on the
//      show's server, and the card had no show art behind it, because
//      `buildPodcast` drops `artwork` when it equals `image`. The test answers
//      that file with a 404 itself, so it holds whatever the show's server does
//      next.
//
// The notes are seeded into the feed's own stale-while-revalidate cache, so they
// paint with no relay, in the wire shapes measured on the live feed. Signed out, so
// no key exists and nothing can be published. The LOOKUPS are real: they go to this
// app's routes and from there to Podcast Index and the shows' own RSS, which is why
// the guids below name real shows.

import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);

// ---- the fixture ----------------------------------------------------------
const SHOW = 'fafd2bfc-98ac-5010-9fcb-7403abfd420a'; // Two For Tunestr
const ITEM = 'f7cb78c5-c90b-4ace-a6a3-4b6ef01f9d9b'; // Open Range
const ALBUM = '6725424d-08a9-5fc2-a352-b8b2dd09a323';
const TRACK = '08d15078-94b7-4fdd-b141-91ec4aef8db2';
const BOWL = '2d418249-453a-5714-8abc-5b657570b641'; // Bowl After Bowl
const BOWL_ITEM = 'https://bowlafterbowl.com/episodes/episode-466/';
const LIVE = 'c1959795-28f1-502d-ad3e-70abf5a034a9'; // v4vmusic Show
const LIVE_ITEM = 'c1fbf44d-3e12-4c7c-a1a0-1b8fc385ee1d'; // its live item, not in PI
const HGH = 'ac746d09-7c3b-5bcd-b28a-f12d6456ca8f'; // Homegrown Hits
const HGH_ITEM = 'de330c86-439f-46d5-a83e-ee870aa20c1c'; // Episode 157
const HGH_ART = 'episode-157.gif'; // that episode's own art, answered 404 below

const now = Math.floor(Date.now() / 1000);
const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const npub = nip19.npubEncode(pubkey);
let n = 0;
// The feed's own cached shape. Signed by a throwaway key that nothing else uses,
// so a card a later relay pass tries to thread or resolve is still a real event.
const note = (marker, { tags, client = null, isBoost = true, podcastGuid = null, episodeGuids = [] }) => {
  n += 1;
  const rawEvent = finalizeEvent({ kind: 1, created_at: now + 3600 - n, tags, content: `${marker} a note` }, sk);
  return {
    id: rawEvent.id, pubkey, npub, nevent: nip19.neventEncode({ id: rawEvent.id }),
    createdAt: rawEvent.created_at, content: rawEvent.content, isBoost, client, podcastGuid, episodeGuids,
    amountSats: isBoost ? 21 : undefined, quotesResolved: true, author: null, replies: [], rawEvent,
  };
};
const NOTES = [
  note('E2E-TRACK', {
    client: 'BoostMeBuddy', podcastGuid: SHOW, episodeGuids: [ITEM, TRACK],
    tags: [
      ['i', `podcast:guid:${SHOW}`], ['k', 'podcast:guid'],
      ['i', `podcast:item:guid:${ITEM}`], ['k', 'podcast:item:guid'],
      ['i', `podcast:guid:${ALBUM}`], ['i', `podcast:item:guid:${TRACK}`],
    ],
  }),
  note('E2E-BOT', {
    client: 'BoostAfterBoost', podcastGuid: BOWL, episodeGuids: [BOWL_ITEM],
    tags: [['i', `podcast:guid:${BOWL}`], ['i', `podcast:item:guid:${BOWL_ITEM}`]],
  }),
  note('E2E-SHOW', {
    podcastGuid: BOWL,
    tags: [['i', `podcast:guid:${BOWL}`]],
  }),
  note('E2E-MISS', {
    client: 'BoostMeBitch', podcastGuid: LIVE, episodeGuids: [LIVE_ITEM],
    tags: [['i', `podcast:guid:${LIVE}`], ['i', `podcast:item:guid:${LIVE_ITEM}`]],
  }),
  note('E2E-ART', {
    client: 'BoostMeBuddy', podcastGuid: HGH, episodeGuids: [HGH_ITEM],
    tags: [
      ['i', `podcast:guid:${HGH}`], ['k', 'podcast:guid'],
      ['i', `podcast:item:guid:${HGH_ITEM}`], ['k', 'podcast:item:guid'],
    ],
  }),
];

// ---- the page -------------------------------------------------------------
const { page } = await launchChrome({ name: 'feedbuttons', args: ['--disable-gpu'] });
const { send, js, until } = page;
await send('Page.enable');
await send('Runtime.enable');
// Answer that file with a real 404, as the show's server did. Both the /api/art
// proxy URL and the raw one carry the file name unencoded. NOT
// Network.setBlockedURLs: a block fails with no round trip, and an instant
// failure can land between <PodcastCover>'s ladder reset and its remount, which
// leaves a broken <img> with no error left to fire. That race is older than this
// card and a 404 from a server does not hit it; this test is about the card.
await send('Fetch.enable', { patterns: [{ urlPattern: `*${HGH_ART}*` }] });
page.on((m) => {
  if (m.method === 'Fetch.requestPaused') {
    send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 404, body: '' }).catch(() => {});
  }
});
const pageErrors = [];
page.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300));
  }
});
const t = checker();

const ARTICLE = (marker) =>
  `[...document.querySelectorAll('article')].find((a) => a.innerText.includes(${JSON.stringify(marker)}))`;
const control = (marker, re) =>
  `[...(${ARTICLE(marker)}?.querySelectorAll('button') ?? [])].find((b) => ${re}.test((b.getAttribute('aria-label') || '') + ' ' + b.textContent))`;
const HEART = /favorit/i;
const QUEUE = /queue/i;
const has = (marker, re) => js(`!!${control(marker, re)}`);
const hasCard = (marker) => js(`!!${ARTICLE(marker)}?.querySelector('.mt-2.border.border-line')`);
const textOf = (marker) => js(`${ARTICLE(marker)}?.innerText ?? ''`);
const stored = async (key) => JSON.parse((await js(`localStorage.getItem(${JSON.stringify(key)})`)) ?? 'null');

async function open(extra = '') {
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until('document.readyState === "complete"');
  await js(`localStorage.clear();
    localStorage.setItem('bmb:feed:global', ${JSON.stringify(JSON.stringify(NOTES))});
    ${extra}`);
  await send('Page.navigate', { url: `${APP}/` });
  await until('document.readyState === "complete"');
  await until(`!!${ARTICLE('E2E-TRACK')}`, 30000);
}

// ---------------------------------------------------------------------------
console.log('\n1. A track boost, at phone width');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await open();
t.ok('the heart appears', await until(`!!${control('E2E-TRACK', HEART)}`, 40000));
t.ok('the queue appears', await has('E2E-TRACK', QUEUE));
t.ok('it is a card', await hasCard('E2E-TRACK'));
t.ok('the card names the episode, not the track', (await textOf('E2E-TRACK')).includes('Open Range'));
await js(`${control('E2E-TRACK', HEART)}.click()`);
await wait(300);
const favs = (await stored('bmb:favepisodes:guest')) ?? {};
t.ok('the heart saves the episode', !!favs[ITEM], Object.keys(favs).join());
t.ok('the heart does not save the track', !favs[TRACK]);
t.equal('the episode is saved under its own show', favs[ITEM]?.feedGuid, SHOW);
await js(`${control('E2E-TRACK', QUEUE)}.click()`);
t.ok('the queue takes the episode', await until(`(JSON.parse(localStorage.getItem('bmb:listen_queue:guest') ?? '[]')).some((i) => i.episode?.guid === ${JSON.stringify(ITEM)})`, 40000));
const q1 = (await stored('bmb:listen_queue:guest')) ?? [];
t.equal('the queue holds one item', q1.length, 1);
t.equal('the queued item is under its own show', q1[0]?.podcast?.podcastGuid, SHOW);

// ---------------------------------------------------------------------------
console.log('\n2. A bot note: no card, and the controls');
t.ok('the heart appears', await until(`!!${control('E2E-BOT', HEART)}`, 40000));
t.ok('the queue appears', await has('E2E-BOT', QUEUE));
t.ok('no card', !(await hasCard('E2E-BOT')));
const bot = await textOf('E2E-BOT');
t.ok('the label names the show', bot.includes('Bowl After Bowl'), bot.slice(0, 200));
t.ok('the label names the episode', bot.includes('Episode 466'), bot.slice(0, 200));
await js(`${control('E2E-BOT', HEART)}.click()`);
await wait(300);
const favs2 = (await stored('bmb:favepisodes:guest')) ?? {};
t.equal('the heart saves it under its own show', favs2[BOWL_ITEM]?.feedGuid, BOWL);
await js(`${control('E2E-BOT', QUEUE)}.click()`);
t.ok('the queue takes it', await until(`(JSON.parse(localStorage.getItem('bmb:listen_queue:guest') ?? '[]')).some((i) => i.episode?.guid === ${JSON.stringify(BOWL_ITEM)})`, 60000));

// ---------------------------------------------------------------------------
console.log('\n3. The notes with no episode to offer');
t.ok('a show-only note has a label', await until(`${ARTICLE('E2E-SHOW')}?.innerText.includes('Bowl After Bowl')`, 20000));
t.ok('a show-only note has no heart', !(await has('E2E-SHOW', HEART)));
t.ok('a show-only note has no queue', !(await has('E2E-SHOW', QUEUE)));
t.ok('a PI miss still names the show', await until(`${ARTICLE('E2E-MISS')}?.innerText.includes('v4vmusic')`, 20000));
t.ok('a PI miss has no heart', !(await has('E2E-MISS', HEART)));
t.ok('a PI miss has no queue', !(await has('E2E-MISS', QUEUE)));
t.equal('a PI miss is a 404 at the route',
  await js(`fetch('/api/episode-by-guid?feedGuid=${LIVE}&itemGuid=${LIVE_ITEM}').then((r) => r.status)`), 404);
t.ok('a PI miss stores nothing', !(await stored(`bmb:epmeta:${LIVE}:${LIVE_ITEM}`)));

// ---------------------------------------------------------------------------
console.log('\n4. Layout');
for (const width of [390, 320]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 3, mobile: true });
  await wait(400);
  const m = JSON.parse(await js(`JSON.stringify({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
    btns: ['E2E-BOT', 'E2E-TRACK'].flatMap((mk) => {
      const a = [...document.querySelectorAll('article')].find((x) => x.innerText.includes(mk));
      return [...a.querySelectorAll('button')].filter((b) => /favorit|queue/i.test((b.getAttribute('aria-label') || '') + ' ' + b.textContent))
        .map((b) => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
    }),
  })`));
  t.equal(`${width}: no horizontal overflow`, m.sw, m.cw);
  t.ok(`${width}: four controls, each at least 24×24`, m.btns.length === 4 && m.btns.every((b) => b.w >= 24 && b.h >= 24), JSON.stringify(m.btns));
}
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

// ---------------------------------------------------------------------------
console.log('\n5. A bad record an older build stored on this device');
const BAD = `bmb:epmeta:${BOWL}:${BOWL_ITEM}`;
await open(`localStorage.setItem(${JSON.stringify(BAD)}, ${JSON.stringify(JSON.stringify({ t: Date.now(), v: { episode: null, season: null } }))});`);
t.ok('the controls still appear', await until(`!!${control('E2E-BOT', HEART)}`, 40000));
t.ok('the label names the episode', (await textOf('E2E-BOT')).includes('Episode 466'));
const healed = await stored(BAD);
t.equal('the record on disk is now the real one', healed?.v?.guid, BOWL_ITEM);

// ---------------------------------------------------------------------------
console.log('\n6. An episode whose own art fails');
const ART_CARD = `${ARTICLE('E2E-ART')}?.querySelector('.mt-2.border.border-line')`;
t.ok('the card appears', await until(`!!${ART_CARD}`, 40000));
t.ok('the card names the episode', await until(`(${ART_CARD}?.innerText ?? '').includes('Episode 157')`, 40000));
// The cover is lazy (`lowPriority`), so it loads only once it is on screen.
await js(`${ARTICLE('E2E-ART')}.scrollIntoView({ block: 'center' })`);
const COVER = `${ART_CARD}?.querySelector('img')`;
t.ok('the cover is an image that loaded, not the initial tile',
  await until(`!!${COVER} && ${COVER}.complete && ${COVER}.naturalWidth > 0`, 30000),
  await js(`(() => { const i = ${COVER}; if (!i) return 'no img: ' + (${ART_CARD}?.firstElementChild?.firstElementChild?.outerHTML?.slice(0, 160) ?? 'no card');
    const r = i.getBoundingClientRect();
    return JSON.stringify({ src: i.getAttribute('src'), currentSrc: i.currentSrc, complete: i.complete, w: i.naturalWidth, top: Math.round(r.top), vh: innerHeight }); })()`));
t.ok('the image is not the failed episode art',
  !String(await js(`${COVER}?.currentSrc ?? ''`)).includes(HGH_ART));

t.equal('no page exception', pageErrors, []);

console.log(`\n${t.count - t.fails} of ${t.count} passed`);
await exit(t.fails ? 1 : 0);
