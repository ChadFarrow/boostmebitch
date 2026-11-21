// e2e:irc — the IRC chat beside an RSS live stream (docs/irc.md).
//
// Two halves:
//  1. NODE: the shipping `lib/irc/client.ts` (through the e2e resolve hook)
//     against `scripts/irc-fake-server.mjs`. This pins what goes on the wire:
//     one typed message is one PRIVMSG, a taken nick is fixed on the SAME
//     connection, a kick keeps the connection, and a dropped connection is
//     NEVER reopened by itself (each one is a slot in ZeroNode's limit of 3
//     per address — a reconnect loop would spend them for everyone).
//  2. BROWSER (`--browser`): the panel in the fullscreen player, driven over
//     CDP, with the fake server on port 6790 standing in for the gateway and
//     Fetch fixtures for /api/live-shows and the audio. The dev server must be
//     started with the gateway address, because Next inlines it at build:
//
// Usage: npm run e2e:irc                                   (Node half)
//        NEXT_PUBLIC_IRC_GATEWAY_URL=ws://127.0.0.1:6790/ npx next dev -p 3047
//        npm run e2e:irc -- --browser [http://127.0.0.1:3047]
import { register } from 'node:module';
import { checker, wait, exit, launchChrome, requireApp, MINI_BAR } from './cdp.mjs';
import { createIrcFake } from './irc-fake-server.mjs';

register('./e2e-resolve-hook.mjs', import.meta.url);
const { openIrcSession } = await import('../lib/irc/client.ts');

const c = checker();

async function until(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await wait(20);
  }
  return !!cond();
}

function session(fake, nick, extra = {}) {
  const events = [];
  const closes = [];
  const s = openIrcSession({
    ...extra,
    url: fake.url, nick, channel: '#candr',
    onEvent: (e) => events.push(e),
    onClose: (r) => closes.push(r),
  });
  return { s, events, closes, joins: () => events.filter((e) => e.type === 'joined').length };
}

async function nodeHalf() {
  console.log('Node: lib/irc/client.ts against the fake server');
  const fake = await createIrcFake({ taken: ['taken_nick'], stall: ['slowfan'] });
  try {
    const a = session(fake, 'bmbfan');
    c.ok('the session joins the show channel', await until(() => a.joins() === 1), JSON.stringify(a.events));
    c.equal('it registered, then joined: NICK, USER, JOIN', fake.received.slice(0, 3),
      ['NICK bmbfan', 'USER webchat 0 * :webchat', 'JOIN #candr']);
    c.equal('one connection so far', fake.connections, 1);

    fake.say('dude', '#candr', 'yo');
    c.ok('a channel message arrives as a message event',
      await until(() => a.events.some((e) => e.type === 'message' && e.from === 'dude' && e.text === 'yo' && !e.self)),
      JSON.stringify(a.events));

    fake.sayRaw('PING :fake.irc');
    c.ok('a server PING is answered', await until(() => fake.received.includes('PONG :fake.irc')));

    const before = fake.received.length;
    a.s.send('hi\nJOIN #x');
    await until(() => fake.received.length > before);
    await wait(200);
    c.equal('a multi-line paste reaches the server as ONE PRIVMSG, and no JOIN',
      fake.received.slice(before), ['PRIVMSG #candr :hi JOIN #x']);
    c.ok('the panel shows our own line', a.events.some((e) => e.type === 'message' && e.self && e.text === 'hi JOIN #x'));

    const connsBefore = fake.connections;
    const b = session(fake, 'taken_nick');
    c.ok('a taken nick gives nickInUse', await until(() => b.events.some((e) => e.type === 'nickInUse' && e.nick === 'taken_nick')),
      JSON.stringify(b.events));
    b.s.nick('other');
    c.ok('a new nick joins', await until(() => b.joins() === 1), JSON.stringify(b.events));
    c.equal('…on the SAME connection', fake.connections - connsBefore, 1);

    const joinCount = () => fake.received.filter((l) => l === 'JOIN #candr').length;
    const joinsBefore = joinCount();
    fake.kick('bmbfan', 'spam');
    c.ok('a kick of the listener gives kicked', await until(() => a.events.some((e) => e.type === 'kicked' && e.by === 'op' && e.reason === 'spam')));
    a.s.rejoin();
    c.ok('REJOIN sends JOIN on the same connection', await until(() => joinCount() === joinsBefore + 1));
    c.ok('…and the listener is back in', await until(() => a.joins() === 2));

    const conns = fake.connections;
    fake.dropAll();
    c.ok('a dropped connection calls onClose', await until(() => a.closes.length === 1 && b.closes.length === 1));
    await wait(3000);
    c.equal('3 s later: no new connection (no reconnect)', fake.connections, conns);
    c.equal('…and onClose fired once', a.closes.length, 1);

    // A gateway that takes the socket and never welcomes: the session gives
    // up by itself (the panel's default is 20 s; 300 ms here), so "Joining…"
    // is never a screen with no way out.
    const slowConns = fake.connections;
    const slow = session(fake, 'slowfan', { registerTimeoutMs: 300 });
    c.ok('a session the server never welcomes closes by itself', await until(() => slow.closes.length === 1, 3000), JSON.stringify(slow.closes));
    c.ok('…saying the server did not answer', /no answer/i.test(slow.closes[0] ?? ''), JSON.stringify(slow.closes));
    await wait(500);
    c.equal('…once, and with no new connection', [slow.closes.length, fake.connections - slowConns], [1, 1]);
    const ok2 = session(fake, 'patient', { registerTimeoutMs: 300 });
    await until(() => ok2.joins() === 1);
    await wait(600);
    c.equal('a welcomed session is not closed by the timer', ok2.closes.length, 0);
    ok2.s.quit();

    const q = session(fake, 'quitter');
    await until(() => q.joins() === 1);
    q.s.quit();
    c.ok('quit() sends QUIT :bye', await until(() => fake.received.includes('QUIT :bye')));
    c.ok('…and onClose fires once', await until(() => q.closes.length === 1) && (await wait(200), q.closes.length === 1));
  } finally {
    await fake.close();
  }
}

// ── 2. The panel in the browser ─────────────────────────────────────────────
const GATEWAY_PORT = 6790;
const CANDR_GUID = '7c6f7875-2b73-491e-b32c-e2c8d6e91d53';
const OTHER_GUID = 'b0a40000-0000-4000-8000-0000000000aa';
const NSEC = `nsec1${'q'.repeat(58)}`;
const PRIVACY = 'IRC is public: the channel can keep a log of what you write, and ZeroNode sees your IP address.';
const HISTORY = 'You joined #candr. IRC keeps no history, so messages show from here on.';
const SECRET = 'That looks like a Nostr secret key (nsec). It was not sent.';

function silentWav(seconds) {
  const rate = 8000;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(n, 40);
  return b;
}

async function browserHalf(APP) {
  console.log(`\nBrowser: the panel in the fullscreen player (${APP})`);
  await requireApp(APP, `Nothing is serving ${APP}. Start it with \`NEXT_PUBLIC_IRC_GATEWAY_URL=ws://127.0.0.1:${GATEWAY_PORT}/ npm run dev\`.`);
  const AUDIO = silentWav(60);
  const now = Math.floor(Date.now() / 1000);
  const show = (feedId, podcastGuid, feedTitle) => ({
    guid: `irc-e2e-live-${feedId}`, title: `${feedTitle} live now`, description: `The ${feedTitle} broadcast.`,
    enclosureUrl: `${APP}/api/e2e-audio.wav?f=${feedId}`, enclosureType: 'audio/wav', liveStatus: 'live',
    liveStartTime: now - 600, value: null, feedId, feedTitle, feedUrl: `https://feeds.example.invalid/${feedId}.xml`,
    podcastGuid, verified: true,
  });
  const LIVE = [show(900801, CANDR_GUID, 'E2E Chad Show'), show(900802, OTHER_GUID, 'E2E Other Show')];

  const fake = await createIrcFake({ port: GATEWAY_PORT, taken: ['takenfan'] });
  fake.banned.add('bannedfan');
  const { page } = await launchChrome({ name: 'irc', autoplay: true, args: ['--disable-gpu'] });
  const { send, js, until } = page;
  try {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
    const answer = (u) => {
      if (u.pathname === '/api/live-shows') return { items: LIVE, unverifiedFeeds: 0, truncated: false };
      if (u.pathname === '/api/live-status') return { ok: true, items: [] };
      return {};
    };
    await send('Network.enable');
    // No public relay: the /live page's Nostr half would otherwise reach the internet.
    await send('Network.setBlockedURLs', { urls: ['wss://*'] });
    await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
    page.on(async (m) => {
      if (m.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = m.params;
      const u = new URL(request.url);
      try {
        if (u.pathname === '/api/e2e-audio.wav') {
          const range = Object.entries(request.headers).find(([k]) => k.toLowerCase() === 'range')?.[1];
          const mm = range && /bytes=(\d+)-(\d*)/.exec(range);
          const start = mm ? Number(mm[1]) : 0;
          const end = mm && mm[2] ? Math.min(Number(mm[2]), AUDIO.length - 1) : AUDIO.length - 1;
          const body = AUDIO.subarray(start, end + 1);
          await send('Fetch.fulfillRequest', {
            requestId, responseCode: mm ? 206 : 200,
            responseHeaders: [
              { name: 'content-type', value: 'audio/wav' },
              { name: 'accept-ranges', value: 'bytes' },
              { name: 'content-length', value: String(body.length) },
              ...(mm ? [{ name: 'content-range', value: `bytes ${start}-${end}/${AUDIO.length}` }] : []),
            ],
            body: body.toString('base64'),
          });
          return;
        }
        await send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'application/json' }],
          body: b64(answer(u)),
        });
      } catch { /* the page navigated away under a paused request */ }
    });
    await send('Page.enable');
    await send('Runtime.enable');

    const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
    const text = (sel) => js(`(${q(sel)}?.innerText ?? '')`);
    const click = (sel) => js(`(() => { const el = ${q(sel)}; if (el) el.click(); return !!el; })()`);
    const type = async (sel, value) => {
      await js(`(() => { const el = ${q(sel)}; el.focus(); el.select?.(); })()`);
      if (await js(`!!(${q(sel)}.value)`)) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      }
      if (value) await send('Input.insertText', { text: value });
    };
    const playCard = (title) => js(`(() => {
      for (const b of document.querySelectorAll('button')) {
        if (!/PLAY/.test(b.textContent)) continue;
        let el = b;
        while (el && !el.textContent.includes(${JSON.stringify(title)})) el = el.parentElement;
        // The card, not a list that holds every card: one PLAY inside.
        const plays = el ? [...el.querySelectorAll('button')].filter((x) => /PLAY/.test(x.textContent)).length : 0;
        if (el && plays === 1) { b.click(); return true; }
      }
      return false;
    })()`);
    const openPlayer = async (title) => {
      await until(`!!document.querySelector(${JSON.stringify(MINI_BAR)}) && document.querySelector(${JSON.stringify(MINI_BAR)}).textContent.includes(${JSON.stringify(title)})`, 15000);
      await js(`document.querySelector(${JSON.stringify(MINI_BAR)}).click()`);
      await until(`[...document.querySelectorAll('h1')].some((h) => h.textContent.includes(${JSON.stringify(title)}) && h.getBoundingClientRect().width > 0)`, 10000);
      await wait(400);
    };
    const closePlayer = () => click('[aria-label="Close fullscreen player"]');
    // Waits on the FAKE's record, in Node (the page's \`until\` evaluates in the page).
    const fakeGot = async (pred, ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (pred(fake.received)) return true; await wait(50); }
      return false;
    };
    const tabs = () => js(`JSON.stringify([...document.querySelectorAll('[data-live-tabs] [role=tab]')].map((t) => [t.textContent.trim().toLowerCase(), t.getAttribute('aria-selected')]))`).then(JSON.parse);
    const rows = () => js(`document.querySelectorAll('[data-irc-list] [data-irc-row]').length`);

    await send('Page.navigate', { url: `${APP}/live` });
    await until(`document.body.innerText.includes('E2E Other Show')`, 30000);

    c.ok('PLAY on a show that is not on the list', await playCard('E2E Other Show'));
    await openPlayer('E2E Other Show live now');
    c.ok('…its player has no IRC chat', !(await js(`!!${q('[data-irc-chat]')}`)));
    await closePlayer();

    c.ok('PLAY on Chad and Reeds (on the list)', await playCard('E2E Chad Show'));
    await openPlayer('E2E Chad Show live now');
    c.ok('its player has the IRC chat', await until(`!!${q('[data-irc-chat]')}`, 5000));
    const t1 = await tabs();
    c.equal('tabs: CHAT first and active, then ABOUT (PLAYED is left out while nothing has played)', t1,
      [['chat', 'true'], ['about', 'false']]);
    c.ok('the privacy line shows under the nick box', (await text('[data-irc-privacy]')).includes(PRIVACY)
      && await js(`${q('[data-irc-nick]')}.compareDocumentPosition(${q('[data-irc-privacy]')}) === Node.DOCUMENT_POSITION_FOLLOWING`));
    c.ok('the nick box shows', await js(`!!${q('[data-irc-nick]')}`));

    await type('[data-irc-nick]', NSEC);
    await click('[data-irc-join]');
    await wait(300);
    c.ok('a nick that is an nsec is refused', (await text('[data-irc-chat]')).includes(SECRET));
    c.equal('…and no connection was opened', fake.connections, 0);

    const liveConns = async (n, ms = 3000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (fake.live === n) return true; await wait(50); }
      return false;
    };
    const chatHas = (s, ms = 5000) => until(`(${q('[data-irc-chat]')}?.innerText ?? '').includes(${JSON.stringify(s)})`, ms);

    // A refused JOIN closes the connection at once: a banned listener must not
    // hold a slot of the per-address limit.
    await type('[data-irc-nick]', 'bannedfan');
    await click('[data-irc-join]');
    c.ok('a refused JOIN shows the server\'s reason', await chatHas('Cannot join channel (+b)', 8000));
    c.ok('…offers JOIN again', await until(`!!${q('[data-irc-join]')}`, 3000));
    c.ok('…and closes its connection', await liveConns(0), `live ${fake.live}`);
    c.equal('…which was the first one', fake.connections, 1);

    // A taken nick is fixed on the SAME connection, from the panel.
    await type('[data-irc-nick]', 'takenfan');
    await click('[data-irc-join]');
    c.ok('a taken nick says so and offers TRY', await until(`(${q('[data-irc-chat]')}?.innerText ?? '').includes('That nick is taken') && ${q('[data-irc-join]')}?.textContent.trim() === 'TRY'`, 8000));
    await type('[data-irc-nick]', 'e2efan');
    await click('[data-irc-join]');
    c.ok('JOIN reaches the server as JOIN #candr', await fakeGot((r) => r.includes('JOIN #candr')));
    await until(`!!${q('[data-irc-input]')}`, 5000);
    c.equal('…on the same connection as the taken nick', fake.connections, 2);
    c.equal('the gateway sees the app\'s own origin', fake.origins[0], new URL(APP).origin);
    c.ok('the history line shows', await until(`(${q('[data-irc-chat]')}?.innerText ?? '').includes(${JSON.stringify(HISTORY)})`, 5000));

    fake.say('dude', '#candr', 'hello from irc');
    c.ok('a channel message shows with its nick', await until(`[...document.querySelectorAll('[data-irc-row]')].some((r) => r.innerText.includes('dude') && r.innerText.includes('hello from irc'))`, 5000));

    let before = fake.received.length;
    await type('[data-irc-input]', 'a\nb');
    await click('[data-irc-send]');
    await wait(500);
    c.equal('a pasted line break leaves as ONE PRIVMSG', fake.received.slice(before), ['PRIVMSG #candr :a b']);

    before = fake.received.length;
    await type('[data-irc-input]', `my key ${NSEC} oops`);
    await click('[data-irc-send]');
    await wait(500);
    c.ok('a message holding an nsec is refused', (await text('[data-irc-chat]')).includes(SECRET));
    c.equal('…and nothing was sent', fake.received.slice(before), []);
    await type('[data-irc-input]', '');

    fake.say('dude', '#candr', 'javascript:alert(1) https://example.com');
    c.ok('a line with a javascript: link arrives', await until(`[...document.querySelectorAll('[data-irc-row]')].some((r) => r.innerText.includes('javascript:alert(1)'))`, 5000),
      await js(`JSON.stringify([...document.querySelectorAll('[data-irc-row]')].slice(-3).map((r) => r.innerText))`));
    const links = await js(`JSON.stringify([...([...document.querySelectorAll('[data-irc-row]')].find((r) => r.innerText.includes('javascript:alert(1)'))?.querySelectorAll('a') ?? [])].map((a) => a.href))`).then(JSON.parse);
    c.equal('only the https URL is a link', links, ['https://example.com/']);

    fake.sayRaw(':fake.irc 404 e2efan #candr :Cannot send to channel (+m)');
    c.ok('a refused message (404) is shown, not dropped', await chatHas('Cannot send to channel (+m)'));

    for (let i = 0; i < 250; i++) fake.say('flood', '#candr', `line ${i}`);
    c.ok('250 lines arrive', await until(`[...document.querySelectorAll('[data-irc-row]')].some((r) => r.innerText.includes('line 249'))`, 10000));
    c.equal('…and the panel keeps 200 rows', await rows(), 200);
    c.ok('…the newest ones', (await js(`document.querySelector('[data-irc-list] [data-irc-row]').innerText`)).includes('line 50'));

    const quitsAtAbout = fake.received.filter((l) => l === 'QUIT :bye').length;
    await js(`[...document.querySelectorAll('[data-live-tabs] [role=tab]')].find((t) => /about/i.test(t.textContent)).click()`);
    await wait(300);
    c.ok('ABOUT shows the episode notes', (await js(`document.body.innerText`)).includes('The E2E Chad Show broadcast.'));
    await js(`[...document.querySelectorAll('[data-live-tabs] [role=tab]')].find((t) => /chat/i.test(t.textContent)).click()`);
    await wait(300);
    c.equal('back on CHAT: no QUIT was sent', fake.received.filter((l) => l === 'QUIT :bye').length, quitsAtAbout);
    c.equal('…and the rows are kept', await rows(), 200);

    await js(`window.dispatchEvent(new Event('focus'))`);
    await wait(1500);
    c.ok('a live-status poll that reports nothing live leaves the panel', await js(`!!${q('[data-irc-chat]')}`));

    const joinCount = () => fake.received.filter((l) => l === 'JOIN #candr').length;
    let joinsNow = joinCount();
    fake.kick('e2efan', 'spam');
    c.ok('a kick says who and why, and offers JOIN AGAIN', await until(`!!${q('[data-irc-rejoin]')}`, 5000) && await chatHas('op removed you from #candr: spam'));
    await click('[data-irc-rejoin]');
    c.ok('JOIN AGAIN joins on the same connection', await fakeGot((r) => r.filter((l) => l === 'JOIN #candr').length > joinsNow) && await until(`!!${q('[data-irc-input]')}`, 5000));

    // Kicked AND banned: the rejoin is refused, and the slot is let go.
    fake.banned.add('e2efan');
    fake.kick('e2efan', 'bye');
    await until(`!!${q('[data-irc-rejoin]')}`, 5000);
    await click('[data-irc-rejoin]');
    c.ok('a refused rejoin shows the reason and JOIN', await until(`!!${q('[data-irc-join]')}`, 5000) && await chatHas('Cannot join channel (+b)'));
    c.ok('…and closes its connection', await liveConns(0), `live ${fake.live}`);
    fake.banned.delete('e2efan');

    // Services rename a guest on a registered nick: say so, and do not store it.
    joinsNow = joinCount();
    await click('[data-irc-join]');
    await fakeGot((r) => r.filter((l) => l === 'JOIN #candr').length > joinsNow);
    await until(`!!${q('[data-irc-input]')}`, 5000);
    fake.sayRaw(':e2efan!webchat@fake NICK :Guest4821');
    c.ok('a nick change the listener did not ask for is explained', await chatHas('The network changed your nick to Guest4821'));
    c.equal('…and is not stored as their nick', await js(`localStorage.getItem('bmb:irc_nick:guest')`), 'e2efan');

    const conns = fake.connections;
    fake.dropAll();
    c.ok('a dropped connection shows JOIN again', await until(`!!${q('[data-irc-join]')}`, 5000));
    await wait(3000);
    c.equal('3 s later: no new connection', fake.connections, conns);

    c.equal('the nick box remembers the last nick', await js(`${q('[data-irc-nick]')}.value`), 'e2efan');
    let joins = joinCount();
    await click('[data-irc-join]');
    c.ok('JOIN again on a press', await fakeGot((r) => r.filter((l) => l === 'JOIN #candr').length > joins));
    await until(`!!${q('[data-irc-input]')}`, 5000);

    // Leave ABOUT open: the next show with a chat must still open on CHAT.
    await js(`[...document.querySelectorAll('[data-live-tabs] [role=tab]')].find((t) => /about/i.test(t.textContent)).click()`);
    const quits = () => fake.received.filter((l) => l === 'QUIT :bye').length;
    const quitsBefore = quits();
    await closePlayer();
    await playCard('E2E Other Show');
    c.ok('playing another show quits the channel', await fakeGot(() => quits() > quitsBefore));
    await playCard('E2E Chad Show');
    await openPlayer('E2E Chad Show live now');
    c.equal('a show opened after ABOUT was left open starts on CHAT', (await tabs())[0], ['chat', 'true']);

    console.log('\nBrowser: a 390 x 844 phone');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await send('Page.navigate', { url: `${APP}/live` });
    await until(`document.body.innerText.includes('E2E Chad Show')`, 30000);
    await playCard('E2E Chad Show');
    await openPlayer('E2E Chad Show live now');
    joins = fake.received.filter((l) => l === 'JOIN #candr').length;
    const joinBox = await js(`JSON.stringify((() => { const r = ${q('[data-irc-join]')}.getBoundingClientRect(); return [r.width, r.height]; })())`).then(JSON.parse);
    c.ok('JOIN is at least 24 x 24', joinBox[0] >= 24 && joinBox[1] >= 24, JSON.stringify(joinBox));
    await click('[data-irc-join]');
    await until(`!!${q('[data-irc-input]')}`, 8000);
    const m = await js(`JSON.stringify((() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
      return {
        list: Math.round(${q('[data-irc-list]')}.getBoundingClientRect().height),
        sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
        send: box(${q('[data-irc-send]')}),
        tabs: [...document.querySelectorAll('[data-live-tabs] [role=tab]')].map(box),
      };
    })())`).then(JSON.parse);
    c.ok(`the message list is at least 240px tall (${m.list}px)`, m.list >= 240, JSON.stringify(m) + (m.list >= 240 ? '' : '\n         ' + await js(`JSON.stringify((() => {
      const out = [];
      let el = ${q('[data-irc-list]')};
      while (el && el !== document.body) {
        const kids = [...el.children].map((k) => [k.tagName + (k.dataset && Object.keys(k.dataset).length ? '[' + Object.keys(k.dataset).join(',') + ']' : ''), Math.round(k.getBoundingClientRect().height)]);
        out.push([el.tagName, (el.className || '').toString().slice(0, 60), Math.round(el.getBoundingClientRect().height), kids]);
        el = el.parentElement;
      }
      return out;
    })())`)));
    c.equal('no sideways overflow', m.sw, m.cw);
    c.ok('Send is at least 24 x 24', m.send[0] >= 24 && m.send[1] >= 24, JSON.stringify(m.send));
    c.ok('every tab is at least 24 x 24', m.tabs.length >= 2 && m.tabs.every(([w, h]) => w >= 24 && h >= 24), JSON.stringify(m.tabs));

    console.log('\nBrowser: a 1280 x 800 desktop');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `${APP}/live` });
    await until(`document.body.innerText.includes('E2E Chad Show')`, 30000);
    await playCard('E2E Chad Show');
    await openPlayer('E2E Chad Show live now');
    const d = await js(`JSON.stringify((() => {
      const chat = ${q('[data-irc-chat]')}.getBoundingClientRect();
      const h1 = [...document.querySelectorAll('h1')].find((h) => h.textContent.includes('E2E Chad Show live now') && h.getBoundingClientRect().width > 0).getBoundingClientRect();
      return { chatLeft: Math.round(chat.left), chatH: Math.round(chat.height), mid: innerWidth / 2, titleLeft: Math.round(h1.left),
        sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
    })())`).then(JSON.parse);
    c.ok('the chat is in the right-hand pane, under the title', d.chatLeft >= d.mid && d.titleLeft >= d.mid, JSON.stringify(d));
    c.ok(`…and tall (${d.chatH}px)`, d.chatH >= 300, JSON.stringify(d));
    c.equal('…with no sideways overflow', d.sw, d.cw);
  } finally {
    await fake.close();
  }
}

await nodeHalf();
const bi = process.argv.indexOf('--browser');
if (bi !== -1) {
  const next = process.argv[bi + 1];
  await browserHalf(next && !next.startsWith('--') ? next : (process.env.APP_URL ?? 'http://127.0.0.1:3047'));
}
console.log(`\n${c.count - c.fails}/${c.count} passed`);
await exit(c.fails ? 1 : 0);
