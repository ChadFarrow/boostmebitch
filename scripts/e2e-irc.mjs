// e2e:irc — the IRC chat beside an RSS live stream (docs/irc.md).
//
// Two halves:
//  1. NODE: the shipping `lib/irc/client.ts` (through the e2e resolve hook)
//     against `scripts/irc-fake-server.mjs`. This pins what goes on the wire:
//     one typed message is one PRIVMSG, a taken nick is fixed on the SAME
//     connection, a kick keeps the connection, and the session NEVER
//     registers on IRC again by itself (each connection is a slot in ZeroNode's
//     limit of 3 per address — a reconnect loop would spend them for
//     everyone). With the hold service (1b) it reopens only the socket, to a
//     held session, with `HOLD RESUME`.
//  2. BROWSER (`--browser`): the panel in the fullscreen player, driven over
//     CDP, with the fake server on port 6790 standing in for the gateway and
//     Fetch fixtures for /api/live-shows and the audio. The dev server must be
//     started with the gateway address, because Next inlines it at build:
//
// Usage: npm run e2e:irc                                   (Node half)
//        NEXT_PUBLIC_IRC_GATEWAY_URL=ws://127.0.0.1:6790/ npx next dev -p 3047
//        npm run e2e:irc -- --browser [http://127.0.0.1:3047]
//        … --shots <dir>   also saves PNGs of the phone pager on Chad's screen
import { register } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
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
  const ends = [];
  const s = openIrcSession({
    ...extra,
    url: fake.url, nick, channel: '#candr',
    onEvent: (e) => events.push(e),
    onClose: (r, end) => { closes.push(r); ends.push(end); },
  });
  return { s, events, closes, ends, joins: () => events.filter((e) => e.type === 'joined').length };
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
    c.equal('with no hold service the page sends no HOLD LIVE', fake.holdLives, 0);

    fake.say('dude', '#candr', 'yo');
    c.ok('a channel message arrives as a message event',
      await until(() => a.events.some((e) => e.type === 'message' && e.from === 'dude' && e.text === 'yo' && !e.self)),
      JSON.stringify(a.events));

    fake.sayRaw('PING :fake.irc');
    c.ok('a server PING is answered', await until(() => fake.received.includes('PONG :fake.irc')));
    // The socket test on a page that comes back needs a hold service: without
    // one, a slow answer would end the chat.
    a.s.wake();
    await wait(200);
    c.ok('with no hold service, wake() tests nothing (no PING)', !fake.received.some((l) => l.startsWith('PING ')));

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

// ── 1b. The hold service: a drop is not the end of the session ──────────────
// docs/irc.md, "Holding a dropped connection". The fake plays the service with
// a short hold; the session gets `HOLD TOKEN` and, after a drop, comes back
// with `HOLD RESUME` — never with a new NICK/USER, so it still cannot spend a
// ZeroNode slot by itself.
async function holdHalf() {
  console.log('Node: the hold service');
  const QUICK = { resumeDelaysMs: [50, 100, 200] };
  const fake = await createIrcFake({ hold: 2 });
  try {
    const links = [];
    const a = session(fake, 'holder', { ...QUICK, onLink: (l) => links.push(l) });
    c.ok('a held session joins', await until(() => a.joins() === 1), JSON.stringify(a.events));
    // HOLD LIVE (the hold plan, 2026-11-24): once after HOLD TOKEN, never a
    // socket's first frame — irc-hold reads a first HOLD frame as a resume.
    const liveAt = fake.received.indexOf('HOLD LIVE');
    c.ok('the page sends HOLD LIVE once, after HOLD TOKEN, behind its NICK and USER',
      fake.holdLives === 1 && liveAt > fake.received.indexOf('NICK holder') && liveAt > fake.received.indexOf('USER webchat 0 * :webchat'),
      JSON.stringify(fake.received.slice(0, 5)));
    fake.say('dude', '#candr', 'before');
    await until(() => a.events.some((e) => e.text === 'before'));
    const regs = fake.received.filter((l) => /^(NICK|USER) /.test(l)).length;
    const created = fake.sessionsCreated;

    fake.drop('holder');
    c.ok('a drop is reported as lost, not closed', await until(() => links.some((l) => l.kind === 'lost')), JSON.stringify(links));
    fake.say('dude', '#candr', 'during one');
    fake.say('dude', '#candr', 'during two');
    c.ok('…then it comes back by itself', await until(() => links.some((l) => l.kind === 'back'), 3000), JSON.stringify(links));
    c.equal('…with nothing missed', links.find((l) => l.kind === 'back')?.missed, 0);
    c.ok('…and the lines said while it was away arrive, in order', await until(() => {
      const t = a.events.filter((e) => e.type === 'message').map((e) => e.text);
      return t.indexOf('during one') > t.indexOf('before') && t.indexOf('during two') > t.indexOf('during one');
    }), JSON.stringify(a.events.map((e) => e.text ?? e.type)));
    c.equal('…and onClose never fired', a.closes, []);
    const resume = fake.received.find((l) => l.startsWith('HOLD RESUME '));
    c.ok('it resumed with HOLD RESUME <token> <seq>', /^HOLD RESUME [A-Za-z0-9_-]{16,} \d+$/.test(resume ?? ''), String(resume));
    c.equal('…and registered nothing again (no NICK, no USER)', fake.received.filter((l) => /^(NICK|USER) /.test(l)).length, regs);
    c.equal('…on the same IRC session', fake.sessionsCreated, created);
    c.equal('…so the channel saw no QUIT', fake.quits, []);
    c.equal('…and a resume sends no second HOLD LIVE (it is once per HOLD TOKEN)', fake.holdLives, 1);
    a.s.send('back again');
    c.ok('it can talk after the resume', await until(() => fake.received.includes('PRIVMSG #candr :back again')));

    // A phone that changes network: the server keeps writing into a socket
    // that delivers nothing. The page asks for those lines back by seq.
    fake.blackhole('holder');
    fake.say('dude', '#candr', 'lost in flight');
    await wait(100);
    c.ok('a line written into a dead socket has not arrived', !a.events.some((e) => e.text === 'lost in flight'));
    fake.drop('holder');
    c.ok('…and arrives after the resume, by seq', await until(() => a.events.some((e) => e.text === 'lost in flight'), 3000),
      JSON.stringify(a.events.map((e) => e.text ?? e.type)));
    c.equal('…once', a.events.filter((e) => e.text === 'lost in flight').length, 1);

    // A takeover (another window resumed the session): stop, never retry,
    // or two windows would take it from each other forever.
    const resumesBefore = fake.resumes.length;
    fake.closeWith('holder', 4001, 'resumed elsewhere');
    c.ok('a takeover closes the session', await until(() => a.closes.length === 1), JSON.stringify(a.closes));
    c.ok('…saying it went on in another window', /another window/i.test(a.closes[0] ?? ''), JSON.stringify(a.closes));
    c.ok('…and marks it, with the token, so the page keeps the hold the other window now uses',
      a.ends[0]?.elsewhere === true && /^[A-Za-z0-9_-]{22,}$/.test(a.ends[0]?.token ?? ''), JSON.stringify(a.ends[0] && { ...a.ends[0], token: '<token>' }));
    await wait(500);
    c.equal('…and it never tries to resume', fake.resumes.length, resumesBefore);

    // The session ended while away (hold ran out, or ZeroNode closed it): the
    // service answers HOLD GONE. No retry, no new session.
    const late = session(fake, 'latecomer', { resumeDelaysMs: [300] });
    await until(() => late.joins() === 1);
    const createdLate = fake.sessionsCreated;
    fake.drop('latecomer');
    fake.endSession('latecomer');
    c.ok('a resume after the hold ran out is told GONE and closes', await until(() => late.closes.length === 1, 5000), JSON.stringify(late.closes));
    c.ok('…saying the chat ended while it was away', /ended while you were away/i.test(late.closes[0] ?? ''), JSON.stringify(late.closes));
    await wait(400);
    c.equal('…with one resume and no new IRC session', [fake.resumes.filter((r) => r.token === fake.resumes.at(-1).token).length, fake.sessionsCreated], [1, createdLate]);

    // ZeroNode ends the connection while the page is attached: the server's
    // ERROR, then HOLD GONE on the live socket. That is the end — no resume.
    const ended = session(fake, 'endme', QUICK);
    await until(() => ended.joins() === 1);
    const r0 = fake.resumes.length;
    fake.endSession('endme');
    c.ok('an IRC connection that ends while attached closes the session', await until(() => ended.closes.length === 1), JSON.stringify(ended.closes));
    c.ok('…showing the server\'s ERROR', ended.events.some((e) => e.type === 'error' && /Closing link/.test(e.text)), JSON.stringify(ended.events));
    c.ok('…and not as "while you were away"', !/away/i.test(ended.closes[0] ?? ''), JSON.stringify(ended.closes));
    await wait(400);
    c.equal('…and it never tries to resume', fake.resumes.length, r0);

    // A network that stays down: it tries until it gives up (6 h; 1.5 s
    // here), then stops. Not at the token's `<seconds>`: HOLD GONE is the end.
    const down = session(fake, 'tunnel', { ...QUICK, resumeGiveUpMs: 1500 });
    await until(() => down.joins() === 1);
    const createdDown = fake.sessionsCreated;
    const tries = fake.resumes.length;
    fake.refuseResume = true;
    fake.drop('tunnel');
    c.ok('with the network down it gives up at the give-up time', await until(() => down.closes.length === 1, 4000), JSON.stringify(down.closes));
    c.ok('…as a lost connection', /connection lost/i.test(down.closes[0] ?? ''), JSON.stringify(down.closes));
    const triesMade = fake.resumes.length - tries;
    c.ok('…after several tries, each a HOLD RESUME', triesMade >= 3, String(triesMade));
    await wait(500);
    c.equal('…then none, and no new IRC session', [fake.resumes.length - tries, fake.sessionsCreated], [triesMade, createdDown]);
    fake.refuseResume = false;

    // A refresh is a drop (Chad, 2026-11-22): the old page saved hold(), and
    // the new page starts with `resume`. Here the old client stays alive, so
    // the takeover (4001) is what ends it — as the dead page's socket would.
    const old = session(fake, 'refresher', QUICK);
    await until(() => old.joins() === 1);
    fake.say('dude', '#candr', 'seen before the refresh');
    await until(() => old.events.some((e) => e.text === 'seen before the refresh'));
    const snap = old.s.hold();
    c.ok('hold() gives the token, the seq and the hold', !!snap && /^[A-Za-z0-9_-]{22,}$/.test(snap.token) && snap.seq > 0 && snap.holdS === 2, JSON.stringify(snap && { ...snap, token: '<token>' }));
    fake.say('dude', '#candr', 'said during the refresh');
    await until(() => old.events.some((e) => e.text === 'said during the refresh'));
    const regsBefore = fake.received.filter((l) => /^(NICK|USER) /.test(l)).length;
    const createdBefore = fake.sessionsCreated;
    const backLinks = [];
    const fresh = session(fake, 'refresher', { ...QUICK, resume: snap, onLink: (l) => backLinks.push(l) });
    c.ok('a new page resumes the held session', await until(() => backLinks.some((l) => l.kind === 'back')), JSON.stringify(backLinks));
    c.ok('…gets the line said during the refresh', await until(() => fresh.events.some((e) => e.text === 'said during the refresh')), JSON.stringify(fresh.events.map((e) => e.text ?? e.type)));
    c.ok('…and not the line it already had', !fresh.events.some((e) => e.text === 'seen before the refresh'));
    c.equal('…registers nothing (no NICK, no USER, no joined event)', [fake.received.filter((l) => /^(NICK|USER) /.test(l)).length, fresh.joins()], [regsBefore, 0]);
    c.equal('…on the same IRC session, with no QUIT', [fake.sessionsCreated, fake.quits.includes('refresher')], [createdBefore, false]);
    fresh.s.send('after the refresh');
    c.ok('…and it can talk', await until(() => fake.received.includes('PRIVMSG #candr :after the refresh')));
    c.ok('the old page is told it went on in another window', await until(() => old.closes.length === 1) && /another window/i.test(old.closes[0]), JSON.stringify(old.closes));
    c.ok('the new page can save it again, further on', fresh.s.hold()?.token === snap.token && fresh.s.hold().seq > snap.seq);
    fresh.s.quit();
    await until(() => fresh.closes.length === 1);

    // Kicked while away (code review, 2026-11-27: "the panel stays on joined").
    // The KICK is a line the service keeps and replays, so the page hears it on
    // the way back, after a drop and after a refresh; RESUMED names `*` then.
    // `blackhole` first, so the KICK reaches only the ring, never the page.
    const kdLinks = [];
    const kd = session(fake, 'kickdrop', { ...QUICK, onLink: (l) => kdLinks.push(l) });
    await until(() => kd.joins() === 1);
    fake.blackhole('kickdrop');
    fake.kick('kickdrop', 'away kick');
    await wait(100);
    c.ok('kicked while away: the KICK has not arrived yet', !kd.events.some((e) => e.type === 'kicked'));
    fake.drop('kickdrop');
    c.ok('…the resume replays it, so the page is told it was kicked', await until(() => kd.events.some((e) => e.type === 'kicked' && e.reason === 'away kick'), 3000),
      JSON.stringify(kd.events.map((e) => e.type)));
    c.ok('…after it came back', kdLinks.some((l) => l.kind === 'back'), JSON.stringify(kdLinks));
    kd.s.send('typed after the kick');
    await wait(200);
    c.ok('…and nothing typed after it reaches the channel', !fake.received.includes('PRIVMSG #candr :typed after the kick'));
    kd.s.quit();
    await until(() => kd.closes.length === 1);

    const kr = session(fake, 'kickfresh', QUICK);
    await until(() => kr.joins() === 1);
    const krSnap = kr.s.hold();
    fake.blackhole('kickfresh');
    fake.kick('kickfresh', 'kick during the refresh');
    await wait(100);
    const krNew = session(fake, 'kickfresh', { ...QUICK, resume: krSnap });
    c.ok('kicked during a refresh: the new page is told it was kicked', await until(() => krNew.events.some((e) => e.type === 'kicked' && e.reason === 'kick during the refresh'), 3000),
      JSON.stringify(krNew.events.map((e) => e.type)));
    krNew.s.send('typed after the refresh kick');
    await wait(200);
    c.ok('…and nothing typed after it reaches the channel', !fake.received.includes('PRIVMSG #candr :typed after the refresh kick'));
    krNew.s.quit();
    await until(() => krNew.closes.length === 1);

    const createdGhost = fake.sessionsCreated;
    const regsGhost = fake.received.filter((l) => /^(NICK|USER) /.test(l)).length;
    const ghost = session(fake, 'ghost', { ...QUICK, resume: { token: 'A'.repeat(22), seq: 5, holdS: 2 } });
    c.ok('a saved hold the service no longer has ends with GONE', await until(() => ghost.closes.length === 1), JSON.stringify(ghost.closes));
    c.ok('…saying the chat ended while it was away', /ended while you were away/i.test(ghost.closes[0] ?? ''), JSON.stringify(ghost.closes));
    c.equal('…and registers nothing', [fake.sessionsCreated, fake.received.filter((l) => /^(NICK|USER) /.test(l)).length], [createdGhost, regsGhost]);

    // LEAVE ends the session at once: no hold, no resume.
    const leaver = session(fake, 'leaver', QUICK);
    await until(() => leaver.joins() === 1);
    const live = fake.sessions;
    const resumesAtQuit = fake.resumes.length;
    leaver.s.quit();
    c.ok('quit() ends the held session at once', await until(() => fake.sessions === live - 1));
    await wait(400);
    c.equal('…and nothing resumes it', fake.resumes.length, resumesAtQuit);
    c.equal('…onClose fired once', leaver.closes.length, 1);
  } finally {
    await fake.close();
  }
}

// ── 1c. Hold while live: past `<seconds>`, and a socket that died quietly ──
// The hold plan (Chad, 2026-11-24): "you can do other things on your phone or
// just lock your phone without being disconnected from the chat." The page
// says HOLD LIVE and tries until HOLD GONE; the NEW irc-hold then holds a live
// show's chat past `<seconds>`, and TODAY's answers HOLD GONE at `<seconds>`.
// Either may be deployed when the page is, so both are run.
async function holdLiveHalf() {
  console.log('Node: hold while live, against the new irc-hold and today\'s');
  const QUICK = { resumeDelaysMs: [50, 100, 200], resumeSlowEveryMs: 100 };
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  // The token says 1 s; a page that sent HOLD LIVE is held 30 s by the new one.
  const fresh = await createIrcFake({ hold: 1, liveHold: 30 });
  const today = await createIrcFake({ hold: 1 });
  try {
    // ── A resume after more than 300 s (and more than `<seconds>`) ──
    const links = [];
    const a = session(fresh, 'lockedphone', { ...QUICK, onLink: (l) => links.push(l) });
    c.ok('a session on the new irc-hold joins and says HOLD LIVE', await until(() => a.joins() === 1) && await until(() => fresh.holdLives === 1));
    const regs = fresh.received.filter((l) => /^(NICK|USER) /.test(l)).length;
    fresh.refuseResume = true;
    fresh.drop('lockedphone');
    await until(() => links.some((l) => l.kind === 'lost'));
    fresh.say('dude', '#candr', 'said while the phone was locked');
    // Real time past the token's 1 s, and the page's own clock past 300 s:
    // the old page stopped at `<seconds>`; this one goes on until HOLD GONE.
    await wait(1500);
    skew = 301_000;
    const triesAt301 = fresh.resumes.length;
    await wait(400);
    c.ok('301 s away by its own clock, the page still tries (every minute after 5 minutes; 100 ms here)', fresh.resumes.length > triesAt301 && a.closes.length === 0,
      JSON.stringify({ tries: fresh.resumes.length - triesAt301, closes: a.closes }));
    fresh.refuseResume = false;
    c.ok('…and comes back to the held chat, past the token\'s <seconds>', await until(() => links.some((l) => l.kind === 'back'), 3000), JSON.stringify({ links, closes: a.closes }));
    c.ok('…with what was said while it was away', await until(() => a.events.some((e) => e.text === 'said while the phone was locked')));
    c.equal('…on the same IRC session, with no NICK or USER and no QUIT', [fresh.sessionsCreated, fresh.received.filter((l) => /^(NICK|USER) /.test(l)).length, fresh.quits], [1, regs, []]);
    skew = 0;

    // ── The same away time against today's irc-hold: HOLD GONE, cleanly ──
    const t = session(today, 'oldgateway', QUICK);
    c.ok('a session on today\'s irc-hold joins; it sends HOLD LIVE, which that one drops', await until(() => t.joins() === 1) && await until(() => today.holdLives === 1));
    today.refuseResume = true;
    today.drop('oldgateway');
    await wait(1500);
    today.refuseResume = false;
    c.ok('…away past <seconds>, its next try is told GONE and the chat closes', await until(() => t.closes.length === 1, 3000), JSON.stringify(t.closes));
    c.ok('…saying the chat ended while it was away', /ended while you were away/i.test(t.closes[0] ?? ''), JSON.stringify(t.closes));
    await wait(300);
    c.equal('…with no new IRC session and no NICK', [today.sessionsCreated, today.received.filter((l) => l === 'NICK oldgateway').length], [1, 1]);

    // ── The socket test when the page comes back (item 5) ──
    const sleepLinks = [];
    const z = session(fresh, 'sleeper', { ...QUICK, probeTimeoutMs: 400, onLink: (l) => sleepLinks.push(l) });
    await until(() => z.joins() === 1);
    const pings = () => fresh.received.filter((l) => l === 'PING :bmb-check').length;
    const resumesHealthy = fresh.resumes.length;
    z.s.wake();
    c.ok('wake() on a live socket sends one IRC PING', await until(() => pings() === 1));
    await wait(700);
    c.equal('…which is answered, so nothing reconnects', [fresh.resumes.length - resumesHealthy, sleepLinks.length, z.closes.length], [0, 0, 0]);
    // The socket dies with no close event (a phone that slept or changed
    // network): the server keeps writing into it, and nothing arrives.
    fresh.blackhole('sleeper');
    fresh.say('dude', '#candr', 'said while it slept');
    await wait(100);
    c.ok('a line written into the dead socket has not arrived', !z.events.some((e) => e.text === 'said while it slept'));
    const seqBefore = z.s.hold()?.seq ?? 0;
    z.s.wake();
    c.ok('wake() on a dead socket: no PONG in time, so it is dropped and resumed', await until(() => sleepLinks.some((l) => l.kind === 'back'), 3000), JSON.stringify(sleepLinks));
    c.ok('…and the line said while it slept arrives, once', await until(() => z.events.filter((e) => e.text === 'said while it slept').length === 1)
      && (await wait(200), z.events.filter((e) => e.text === 'said while it slept').length === 1), JSON.stringify(z.events.map((e) => e.text ?? e.type)));
    c.ok('…the PONG it missed counts in seq too, so the next resume asks for the right line', (z.s.hold()?.seq ?? 0) >= seqBefore + 2, `${seqBefore} → ${z.s.hold()?.seq}`);
    c.equal('…on the same IRC session, and the session never closed', [fresh.sessionsCreated, z.closes.length], [2, 0]);

    // ── A leave while the socket is away still says QUIT (item 7) ──
    const walkerLinks = [];
    const w = session(fresh, 'walker', { ...QUICK, onLink: (l) => walkerLinks.push(l) });
    await until(() => w.joins() === 1);
    fresh.refuseResume = true;
    fresh.drop('walker');
    await wait(300);
    fresh.refuseResume = false;
    w.s.quit();
    c.ok('a leave on purpose while away goes back only to QUIT, so the nick does not stay held', await until(() => fresh.quits.includes('walker'), 3000), JSON.stringify(fresh.quits));
    c.ok('…and the session closes once', await until(() => w.closes.length === 1) && (await wait(300), w.closes.length === 1), JSON.stringify(w.closes));
    c.equal('…and never says it came back (it went back only to leave)', walkerLinks.map((l) => l.kind), ['lost']);
  } finally {
    Date.now = realNow;
    await fresh.close();
    await today.close();
  }
}

// ── 2. The panel in the browser ─────────────────────────────────────────────
const GATEWAY_PORT = 6790;
const CANDR_GUID = '7c6f7875-2b73-491e-b32c-e2c8d6e91d53';
// The show that is not on the list is Lightning Thrashes, by its real guid. It
// was on the list until 2026-11-25, when Chad took it off: "thats a 24/7 replay
// stream so dont show a chat there" (lib/irc/shows.ts).
const OTHER_GUID = 'd5e73072-64a2-56a3-9dcd-4a00bfe561d5';
const MMO_GUID = '31740861-81e8-5dda-8801-a2abb2634271';
const MMO_TITLE = 'MMO Live Every Tuesday Night @ 5pm';
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
  // Long enough to be still playing when the hold section refreshes the page.
  const AUDIO = silentWav(900);
  const now = Math.floor(Date.now() / 1000);
  const show = (feedId, podcastGuid, feedTitle) => ({
    guid: `irc-e2e-live-${feedId}`, title: `${feedTitle} live now`, description: `The ${feedTitle} broadcast.`,
    enclosureUrl: `${APP}/api/e2e-audio.wav?f=${feedId}`, enclosureType: 'audio/wav', liveStatus: 'live',
    liveStartTime: now - 600, value: null, feedId, feedTitle, feedUrl: `https://feeds.example.invalid/${feedId}.xml`,
    podcastGuid, verified: true,
  });
  // Chad's screen on 2026-11-24 (docs/superpowers/specs/2026-11-24-irc-phone-pager-design.md):
  // MMO's own two-line title and a three-recipient value block, which is the
  // splits row under BOOST. The addresses are made up; nothing here pays.
  const mmo = {
    ...show(900803, MMO_GUID, 'Millennial Media Offensive'), title: MMO_TITLE,
    value: { type: 'lightning', method: 'keysend', recipients: ['02', '03', '02'].map((p, i) => ({ name: `Host ${i + 1}`, type: 'node', address: p + String(i + 1).repeat(64), split: [50, 40, 10][i] })) },
  };
  const LIVE = [show(900801, CANDR_GUID, 'E2E Chad Show'), show(900802, OTHER_GUID, 'E2E Other Show'), mmo];

  let fake = await createIrcFake({ port: GATEWAY_PORT, taken: ['takenfan'] });
  fake.banned.add('bannedfan');
  const browser = await launchChrome({ name: 'irc', autoplay: true, args: ['--disable-gpu'] });
  const { page } = browser;
  // `let`: the "closed app" section moves every helper below to a new tab.
  let { send, js, until } = page;
  try {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
    // The item a refresh reads again (`loadEpisodeFromFeed`). `feedLive` false
    // is the broadcast having ended while the page reloaded.
    let feedLive = true;
    const feedOf = (id) => {
      const item = LIVE.find((x) => x.feedId === id);
      if (!item) return {};
      return {
        podcast: { id, title: item.feedTitle, url: item.feedUrl, podcastGuid: item.podcastGuid, author: '', image: '', artwork: '', description: '', medium: 'podcast' },
        episodes: [{ ...item, liveStatus: feedLive ? 'live' : 'ended' }],
      };
    };
    const answer = (u) => {
      if (u.pathname === '/api/live-shows') return { items: LIVE, unverifiedFeeds: 0, truncated: false };
      if (u.pathname === '/api/feed') return feedOf(Number(u.searchParams.get('id')));
      if (u.pathname === '/api/live-status') return { ok: true, items: [] };
      return {};
    };
    // The fixtures, per tab: a new tab (the "closed app" section) needs them too.
    const setupTab = async (tab) => {
      await tab.send('Network.enable');
      // No public relay: the /live page's Nostr half would otherwise reach the internet.
      await tab.send('Network.setBlockedURLs', { urls: ['wss://*'] });
      await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
      tab.on(async (m) => {
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
            await tab.send('Fetch.fulfillRequest', {
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
          await tab.send('Fetch.fulfillRequest', {
            requestId, responseCode: 200,
            responseHeaders: [{ name: 'content-type', value: 'application/json' }],
            body: b64(answer(u)),
          });
        } catch { /* the page navigated away under a paused request */ }
      });
      await tab.send('Page.enable');
      await tab.send('Runtime.enable');
    };
    await setupTab(page);

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
    // A control in the phone pager's pinned bar: its size, and clear of ▶/❚❚
    // and BOOST, inside the screen, with no sideways scroll.
    const barFit = (sel) => js(`(() => {
      const bar = document.querySelector('[data-live-bar]');
      const b = bar?.querySelector(${JSON.stringify(sel)});
      const play = bar?.querySelector('[aria-label="Play"],[aria-label="Pause"]');
      const boost = [...(bar?.querySelectorAll('button') ?? [])].find((x) => /BOOST/.test(x.textContent));
      if (!b || !play || !boost) return null;
      const r = b.getBoundingClientRect(), p = play.getBoundingClientRect(), o = boost.getBoundingClientRect();
      const hit = (a, z) => a.right > z.left && a.left < z.right && a.bottom > z.top && a.top < z.bottom;
      const de = document.documentElement;
      return { w: Math.round(r.width), h: Math.round(r.height), clear: !hit(r, p) && !hit(r, o),
        inView: r.left >= 0 && r.right <= innerWidth && o.right <= innerWidth, noScroll: de.scrollWidth <= de.clientWidth };
    })()`);
    const fits = (f) => !!f && f.w >= 24 && f.h >= 24 && f.clear && f.inView && f.noScroll;
    // ▶/❚❚ ON THE BAR'S CENTRE LINE (Chad, 2026-11-24, on CHAT during MMO:
    // "Move the play button to the middle on the bottom"), the LIVE group to
    // its left and BOOST to its right, nothing touching ▶ or each other, all on
    // screen. `off` is how far ▶'s centre is from the screen's, in CSS px.
    const barLayout = () => js(`JSON.stringify((() => {
      const bar = document.querySelector('[data-live-bar]');
      if (!bar?.offsetParent) return null;
      const play = bar.querySelector('[aria-label="Play"],[aria-label="Pause"]');
      const boost = [...bar.querySelectorAll('button')].find((x) => /BOOST/.test(x.textContent));
      if (!play || !boost) return null;
      const R = (el) => el.getBoundingClientRect();
      const p = R(play), o = R(boost), b = R(bar);
      const hit = (a, z) => a.right > z.left && a.left < z.right && a.bottom > z.top && a.top < z.bottom;
      const live = [...bar.querySelectorAll('[data-live-edge] > *')].filter((x) => x.offsetParent || x.getClientRects().length).map(R);
      const de = document.documentElement;
      return {
        off: Math.round(Math.abs((p.left + p.right) / 2 - innerWidth / 2) * 10) / 10,
        barMid: Math.round(Math.abs((b.left + b.right) / 2 - innerWidth / 2) * 10) / 10,
        play: [Math.round(p.width), Math.round(p.height)], boost: [Math.round(o.width), Math.round(o.height)],
        liveW: live.length ? Math.round(Math.max(...live.map((r) => r.right)) - Math.min(...live.map((r) => r.left))) : 0,
        order: live.every((r) => r.right <= p.left) && o.left >= p.right,
        clear: !hit(o, p) && live.every((r) => !hit(r, p) && !hit(r, o)),
        inView: [p, o, ...live].every((r) => r.left >= 0 && r.right <= innerWidth),
        noScroll: de.scrollWidth <= de.clientWidth,
        h: Math.round(b.height),
      };
    })())`).then(JSON.parse);
    const centred = (l) => !!l && l.off <= 1 && l.barMid <= 1 && l.order && l.clear && l.inView && l.noScroll
      && l.play[0] >= 24 && l.play[1] >= 24 && l.boost[0] >= 24 && l.boost[1] >= 24;
    // The phone pager: the page on screen, and a tap on the strip to another.
    const pagerPage = () => js(`[...document.querySelectorAll('[data-live-page]')].find((p) => Math.abs(p.getBoundingClientRect().left) < 2)?.dataset.livePage ?? null`);
    const pagerTo = async (id) => {
      await js(`[...document.querySelectorAll('[data-live-pager] [data-live-tabs] [role=tab]')].find((t) => t.textContent.trim().toLowerCase() === ${JSON.stringify(id)})?.click()`);
      return until(`(() => { const r = document.querySelector('[data-live-page=${JSON.stringify(id)}]')?.getBoundingClientRect(); return !!r && Math.abs(r.left) < 2; })()`, 3000);
    };
    // PLAYER first (Chad, 2026-11-24: "I want the [art] to be the first thing
    // people see"): the cover whole on screen, above the pinned bar.
    const artFirst = () => js(`JSON.stringify((() => {
      const cover = document.querySelector('[data-live-page="player"] .aspect-square')?.getBoundingClientRect();
      const bar = document.querySelector('[data-live-bar]')?.getBoundingClientRect();
      return { cover: cover && [Math.round(cover.left), Math.round(cover.top), Math.round(cover.width), Math.round(cover.bottom)], barTop: bar && Math.round(bar.top) };
    })())`).then(JSON.parse);
    const artOk = (a) => !!a.cover && a.cover[0] >= 0 && a.cover[1] >= 0 && a.cover[2] >= 300 && a.barTop != null && a.cover[3] <= a.barTop;
    const rows = () => js(`document.querySelectorAll('[data-irc-list] [data-irc-row]').length`);

    await send('Page.navigate', { url: `${APP}/live` });
    await until(`document.body.innerText.includes('E2E Other Show')`, 30000);

    // A hold saved for #SirLibre while Lightning Thrashes was on the list. Its
    // live item never ends, so nothing on the page would ever clear it: the
    // panel must not mount, so the key is never read and opens no socket.
    const sirlibreHold = { channel: '#SirLibre', nick: 'e2eold', token: 'e2e-sirlibre-hold-token-0001', holdS: 300, seq: 0, at: Date.now(), phase: 'joined', rows: [] };
    await js(`localStorage.setItem('bmb:irc_hold:#sirlibre', ${JSON.stringify(JSON.stringify(sirlibreHold))})`);
    const connsBefore = fake.connections;
    const resumesBefore = fake.resumes.length;
    c.ok('PLAY on a show that is not on the list (Lightning Thrashes, a 24/7 replay)', await playCard('E2E Other Show'));
    await openPlayer('E2E Other Show live now');
    c.ok('…its player is open, the title on screen', await js(`[...document.querySelectorAll('h1')].some((h) => h.textContent.includes('E2E Other Show live now') && h.getBoundingClientRect().width > 0)`));
    await wait(1500);
    c.ok('…its player has no IRC chat', !(await js(`!!${q('[data-irc-chat]')}`)));
    c.equal('…a hold saved for #SirLibre opens no socket and sends no HOLD RESUME',
      [fake.connections - connsBefore, fake.resumes.length - resumesBefore], [0, 0]);
    await js(`localStorage.removeItem('bmb:irc_hold:#sirlibre')`);
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
    c.equal('the nick box takes at most 17 characters (ZeroNode NICKLEN)', await js(`${q('[data-irc-nick]')}.maxLength`), 17);
    // Chad, 2026-11-21: an empty panel did not read as a chat. Before the first
    // row the list says what it is and how to join.
    c.ok('before JOIN the list says what it is', (await text('[data-irc-list] [data-irc-empty]')).includes('Pick a nick'));

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
    // Chad, 2026-11-24 (hold plan item 8): more than "taken" — the nick is
    // most often the listener's own, held by their last chat.
    c.ok('a taken nick says so, says why it may be, and offers TRY', await until(`(${q('[data-irc-chat]')}?.innerText ?? '').includes('That nick is in use. If it was yours a moment ago, your last chat may still hold it. Try another nick, or wait a few minutes.') && ${q('[data-irc-join]')}?.textContent.trim() === 'TRY'`, 8000));
    await type('[data-irc-nick]', 'e2efan');
    await click('[data-irc-join]');
    c.ok('JOIN reaches the server as JOIN #candr', await fakeGot((r) => r.includes('JOIN #candr')));
    await until(`!!${q('[data-irc-input]')}`, 5000);
    c.equal('…on the same connection as the taken nick', fake.connections, 2);
    c.equal('the gateway sees the app\'s own origin', fake.origins[0], new URL(APP).origin);
    c.ok('the history line shows', await until(`(${q('[data-irc-chat]')}?.innerText ?? '').includes(${JSON.stringify(HISTORY)})`, 5000));
    c.ok('…and the empty line is gone', !(await js(`!!${q('[data-irc-empty]')}`)));
    c.equal('with no hold service the panel sends no HOLD LIVE', fake.holdLives, 0);

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

    // Names (Chad, 2026-11-22): 14px and bold, one color per person, your own
    // in the text color. `dude` is --nick-3 and `phifer` --nick-1 (check:irc).
    fake.say('phifer', '#candr', 'not brown yet');
    await chatHas('not brown yet');
    const names = await js(`JSON.stringify([...document.querySelectorAll('[data-irc-from]')].map((n) => {
      const cs = getComputedStyle(n);
      return { from: n.textContent, size: cs.fontSize, weight: Number(cs.fontWeight), color: cs.color };
    }))`).then(JSON.parse);
    const textColor = await js(`getComputedStyle(document.body).color`);
    const colorOf = (from) => [...new Set(names.filter((n) => n.from === from).map((n) => n.color))];
    c.ok('names are 14px and bold', names.length >= 4 && names.every((n) => n.size === '14px' && n.weight >= 700), JSON.stringify(names));
    c.ok('…one person keeps one color', colorOf('dude').length === 1, JSON.stringify(colorOf('dude')));
    c.ok('…two people get two colors', colorOf('dude')[0] !== colorOf('phifer')[0], JSON.stringify([colorOf('dude'), colorOf('phifer')]));
    c.ok('…not the text color', ![...colorOf('dude'), ...colorOf('phifer')].includes(textColor), textColor);
    c.equal('…and your own name is in the text color', colorOf('e2efan'), [textColor]);

    fake.sayRaw(':fake.irc 404 e2efan #candr :Cannot send to channel (+m)');
    c.ok('a refused message (404) is shown, not dropped', await chatHas('Cannot send to channel (+m)'));

    // 2,000 rows (hold plan item 6): a resume after a long hold can bring
    // ~1,500 lines. The speed on a phone is measured in `--perf`.
    for (let i = 0; i < 2100; i++) fake.say('flood', '#candr', `line ${i}`);
    c.ok('2,100 lines arrive', await until(`[...document.querySelectorAll('[data-irc-row]')].some((r) => r.innerText.includes('line 2099'))`, 30000));
    c.equal('…and the panel keeps 2,000 rows', await rows(), 2000);
    c.ok('…the newest ones', /line 100\s*$/.test(await js(`document.querySelector('[data-irc-list] [data-irc-row]').innerText`)));

    const quitsAtAbout = fake.received.filter((l) => l === 'QUIT :bye').length;
    await js(`[...document.querySelectorAll('[data-live-tabs] [role=tab]')].find((t) => /about/i.test(t.textContent)).click()`);
    await wait(300);
    c.ok('ABOUT shows the episode notes', (await js(`document.body.innerText`)).includes('The E2E Chad Show broadcast.'));
    await js(`[...document.querySelectorAll('[data-live-tabs] [role=tab]')].find((t) => /chat/i.test(t.textContent)).click()`);
    await wait(300);
    c.equal('back on CHAT: no QUIT was sent', fake.received.filter((l) => l === 'QUIT :bye').length, quitsAtAbout);
    c.equal('…and the rows are kept', await rows(), 2000);

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
    // Lightning Thrashes on a phone: the plain player, no pager and no CHAT page.
    await playCard('E2E Other Show');
    await openPlayer('E2E Other Show live now');
    await wait(1000);
    const lt390 = await js(`JSON.stringify({
      title: [...document.querySelectorAll('h1')].some((h) => h.textContent.includes('E2E Other Show live now') && h.getBoundingClientRect().width > 0),
      pager: !!${q('[data-live-pager]')},
      chat: !!${q('[data-irc-chat]')},
      chatTab: [...document.querySelectorAll('[role=tab]')].some((t) => t.textContent.trim().toLowerCase() === 'chat'),
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    })`).then(JSON.parse);
    c.ok('Lightning Thrashes at 390: the player is open, the title on screen', lt390.title, JSON.stringify(lt390));
    c.equal('…no phone pager, no CHAT page, no IRC chat', [lt390.pager, lt390.chatTab, lt390.chat], [false, false, false]);
    c.equal('…no sideways overflow', lt390.sw, lt390.cw);
    await closePlayer();
    await playCard('E2E Chad Show');
    await openPlayer('E2E Chad Show live now');
    c.equal('the phone pager opens on PLAYER, the art first', await pagerPage(), 'player');
    const art390 = await artFirst();
    c.ok('…the cover at least 300px wide, whole, above the pinned bar', artOk(art390), JSON.stringify(art390));
    c.ok('a tap on CHAT shows the chat', await pagerTo('chat'));
    joins = fake.received.filter((l) => l === 'JOIN #candr').length;
    const joinBox = await js(`JSON.stringify((() => { const r = ${q('[data-irc-join]')}.getBoundingClientRect(); return [r.width, r.height]; })())`).then(JSON.parse);
    c.ok('JOIN is at least 24 x 24', joinBox[0] >= 24 && joinBox[1] >= 24, JSON.stringify(joinBox));
    await click('[data-irc-join]');
    await until(`!!${q('[data-irc-input]')}`, 8000);
    const m = await js(`JSON.stringify((() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
      return {
        list: Math.round(${q('[data-irc-list]')}.getBoundingClientRect().height),
        border: getComputedStyle(${q('[data-irc-chat]')}).borderTopWidth,
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
    c.equal('no frame on a phone, as <LiveChat>', m.border, '0px');
    c.ok('Send is at least 24 x 24', m.send[0] >= 24 && m.send[1] >= 24, JSON.stringify(m.send));
    c.ok('every tab is at least 24 x 24', m.tabs.length >= 2 && m.tabs.every(([w, h]) => w >= 24 && h >= 24), JSON.stringify(m.tabs));

    console.log("\nBrowser: Chad's iPhone — 393 x 852 with its safe areas, MMO, a two-line title, a value block");
    // Emulation spends no safe areas by itself, which is how the 390 x 844
    // section above read 244px while Chad's phone showed two messages
    // (docs/ui.md, "The 93px you cannot see").
    await send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 3, mobile: true });
    await send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 59, left: 0, bottom: 34, right: 0 } });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Page.navigate', { url: `${APP}/live` });
    await until(`document.body.innerText.includes(${JSON.stringify(MMO_TITLE)})`, 30000);
    const si = process.argv.indexOf('--shots');
    const shotDir = si !== -1 ? process.argv[si + 1] : null;
    if (shotDir) mkdirSync(shotDir, { recursive: true });
    const shot = async (name) => {
      if (!shotDir) return;
      const { data } = (await send('Page.captureScreenshot', { format: 'png' })).result;
      writeFileSync(`${shotDir}/${name}.png`, Buffer.from(data, 'base64'));
    };
    c.ok('PLAY on MMO', await playCard(MMO_TITLE));
    await openPlayer(MMO_TITLE);
    await wait(300);
    c.equal('it opens on PLAYER, the art first', await pagerPage(), 'player');
    const artMmo = await artFirst();
    c.ok('…the cover at least 300px wide, whole, above the pinned bar', artOk(artMmo), JSON.stringify(artMmo));
    c.ok('…with ▶/❚❚ and BOOST under it', await js(`!!document.querySelector('[data-live-bar] [aria-label="Pause"],[data-live-bar] [aria-label="Play"]') && /BOOST/.test(document.querySelector('[data-live-bar]')?.textContent ?? '')`));
    await shot('0-open');
    c.ok('a tap on CHAT shows the chat', await pagerTo('chat'));
    const mmoQuits0 = fake.received.filter((l) => l === 'QUIT :bye').length;
    await until(`!!${q('[data-irc-join]')}`, 5000);
    await click('[data-irc-join]');
    c.ok('JOIN #MMO', await until(`!!${q('[data-irc-input]')}`, 8000) && await fakeGot((r) => r.includes('JOIN #MMO')));
    for (let i = 0; i < 30; i++) fake.say(`regular${i % 5}`, '#MMO', `line ${i} of the show chat`);
    await until(`document.querySelectorAll('[data-irc-list] [data-irc-row]').length >= 30`, 5000);
    const chadScreen = () => js(`JSON.stringify((() => {
      const box = (el) => { if (!el || !el.offsetParent) return null; const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
      const list = ${q('[data-irc-list]')}.getBoundingClientRect();
      const input = ${q('[data-irc-input]')}?.getBoundingClientRect();
      return {
        list: Math.round(list.height),
        rowsSeen: [...document.querySelectorAll('[data-irc-list] [data-irc-row]')].filter((r) => { const b = r.getBoundingClientRect(); return b.height && b.top >= list.top - 1 && b.bottom <= list.bottom + 1; }).length,
        sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
        pager: !!${q('[data-live-pager]')},
        bar: box(${q('[data-live-bar]')}),
        barBottom: ${q('[data-live-bar]')}?.offsetParent ? Math.round(${q('[data-live-bar]')}.getBoundingClientRect().bottom) : null,
        barButtons: [...document.querySelectorAll('[data-live-bar] button')].filter((b) => b.offsetParent).map((b) => [b.getAttribute('aria-label') || b.textContent.trim(), ...box(b)]),
        tabs: [...document.querySelectorAll('[data-live-tabs] [role=tab]')].map((t) => [t.textContent.trim().toLowerCase(), t.getAttribute('aria-selected'), ...box(t)]),
        inputOnScreen: !!input && input.left >= 0 && input.right <= innerWidth && input.bottom <= innerHeight,
      };
    })())`).then(JSON.parse);
    const chad = await chadScreen();
    await shot('1-chat');
    console.log('   measured:', JSON.stringify(chad));
    c.ok(`the message list is at least 400px tall on Chad's screen (${chad.list}px, ${chad.rowsSeen} rows in view)`, chad.list >= 400, JSON.stringify(chad));
    c.equal('no sideways overflow', chad.sw, chad.cw);
    c.ok('the pager is the layout', chad.pager);
    c.equal('the strip: PLAYER, CHAT (open), ABOUT', chad.tabs.map(([t, s]) => [t, s]), [['player', 'false'], ['chat', 'true'], ['about', 'false']]);
    c.ok('every tab is at least 24 x 24', chad.tabs.length === 3 && chad.tabs.every(([, , w, h]) => w >= 24 && h >= 24), JSON.stringify(chad.tabs));
    c.ok('the pinned bar has play/pause and BOOST, each at least 24 x 24',
      chad.barButtons.some(([l]) => /pause|play/i.test(l)) && chad.barButtons.some(([l]) => /boost/i.test(l)) && chad.barButtons.every(([, w, h]) => w >= 24 && h >= 24), JSON.stringify(chad.barButtons));
    c.ok('…and sits above the home indicator (852 - 34)', chad.barBottom !== null && chad.barBottom <= 852 - 34, String(chad.barBottom));
    c.ok('the composer is on screen', chad.inputOnScreen);
    const lay393 = await barLayout();
    console.log('   bar:', JSON.stringify(lay393));
    c.ok('▶/❚❚ is in the middle of the bar, ● LIVE to its left, BOOST to its right, none touching', centred(lay393), JSON.stringify(lay393));
    c.equal('…and the bar is still 77px', lay393?.h, 77);
    // The narrowest phone a site still meets: a side of the bar is ~108px.
    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 2, mobile: true });
    await send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    await wait(400);
    const lay320 = await barLayout();
    console.log('   bar at 320:', JSON.stringify(lay320));
    await shot('1b-chat-320');
    c.ok('…and at 320 px: ▶/❚❚ in the middle, LIVE and BOOST clear of it, on screen, no sideways scroll', centred(lay320), JSON.stringify(lay320));
    c.ok('…the bar no taller than 77px', !!lay320 && lay320.h <= 77, String(lay320?.h));
    await send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 3, mobile: true });
    await send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 59, left: 0, bottom: 34, right: 0 } });
    await wait(400);
    c.equal('back at 393: still on CHAT', await pagerPage(), 'chat');

    // Flick and tap. Nothing may reload the audio or touch the IRC session.
    await js(`(() => { window.__loadstarts = 0; for (const m of document.querySelectorAll('audio,video')) m.addEventListener('loadstart', () => { window.__loadstarts++; }); })()`);
    const playingNow = () => js(`[...document.querySelectorAll('audio,video')].filter((m) => !m.paused).length`);
    const playing0 = await playingNow();
    const activeTab = () => js(`(document.querySelector('[data-live-tabs] [role=tab][aria-selected=true]')?.textContent ?? '').trim().toLowerCase()`);
    const flick = async (dx) => {
      await send('Input.synthesizeScrollGesture', { x: 200, y: 420, xDistance: dx, yDistance: 0, gestureSourceType: 'touch', speed: 1600 });
      await wait(700);
    };
    await flick(-260);
    c.equal('a flick to the left shows ABOUT', await activeTab(), 'about');
    await shot('3-about');
    await flick(260);
    c.equal('a flick to the right comes back to CHAT', await activeTab(), 'chat');
    await flick(260);
    c.equal('another flick to the right shows PLAYER', await activeTab(), 'player');
    await shot('2-player');
    c.ok('…with the cover and the title on screen', await js(`(() => {
      const h = [...document.querySelectorAll('h1')].find((x) => x.textContent.includes(${JSON.stringify(MMO_TITLE)}));
      const r = h?.getBoundingClientRect();
      return !!r && r.left >= 0 && r.right <= innerWidth + 1 && r.width > 0;
    })()`));
    await click('[data-live-tabs] [role=tab]:nth-child(2)');
    await wait(900);
    c.equal('a tap on CHAT goes back to the chat', await activeTab(), 'chat');
    c.ok('…and its composer is on screen again', (await chadScreen()).inputOnScreen);
    c.equal('no QUIT and no second JOIN across the flicks', [fake.received.filter((l) => l === 'QUIT :bye').length - mmoQuits0, fake.received.filter((l) => l === 'JOIN #MMO').length], [0, 1]);
    c.equal('the audio did not reload (no loadstart) and still plays', [await js('window.__loadstarts'), await playingNow()], [0, playing0]);
    c.equal('one media element plays', playing0, 1);

    // The bar steps aside while the composer has focus, so the composer sits
    // where it sat before: at the overlay's bottom edge, over the keyboard.
    // The focus events are dispatched by hand as well: headless Chromium sends
    // none to a page that is not the focused page (e2e-keyboard.mjs says why).
    // They still prove the point — the composer is in a reverse portal, so only
    // a listener on the DOM tree hears them; React's onFocus never did.
    await js(`(() => { const el = ${q('[data-irc-input]')}; el.focus(); el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); })()`);
    await wait(200);
    c.ok('the bar hides while typing', !(await js(`!!${q('[data-live-bar]')}?.offsetParent`)));
    await shot('4-typing');
    c.ok('…and the composer sits at the overlay\'s bottom edge (852 - 34)', await js(`(() => { const r = ${q('[data-irc-input]')}.getBoundingClientRect(); return r.bottom <= 818 && r.bottom > 760; })()`));
    await js(`(() => { const el = ${q('[data-irc-input]')}; el.blur(); el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); })()`);
    await wait(400);
    c.ok('…and comes back after', await js(`!!${q('[data-live-bar]')}?.offsetParent`));
    // A tap from the composer to SEND on Android moves focus to SEND, and SEND
    // turns `disabled` after the send: no event says focus left a field. The
    // bar must come back anyway (it once stayed away until the next blur).
    await js(`(() => { const el = ${q('[data-irc-input]')}; el.focus(); el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); })()`);
    await wait(200);
    c.ok('typing again: the bar is away', !(await js(`!!${q('[data-live-bar]')}?.offsetParent`)));
    await type('[data-irc-input]', 'hello from the pager');
    await js(`(() => { const b = ${q('[data-irc-send]')}; b.focus(); b.click(); })()`);
    c.ok('SEND sends', await fakeGot((r) => r.includes('PRIVMSG #MMO :hello from the pager')));
    c.ok('…and the bar comes back with focus on a disabled SEND, though no focusout fired', await until(`!!${q('[data-live-bar]')}?.offsetParent`, 2000));


    // A turn to landscape crosses 640px into the two-pane layout and back. The
    // chat lives in a reverse portal, so neither tree's mount may leave.
    await send('Emulation.setDeviceMetricsOverride', { width: 852, height: 393, deviceScaleFactor: 3, mobile: true });
    await wait(800);
    c.ok('landscape: the two-pane layout, chat still joined', !(await js(`!!${q('[data-live-pager]')}`)) && await js(`!!${q('[data-irc-input]')}`));
    await send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 3, mobile: true });
    await wait(800);
    // The turn remounts the pager; it comes back on the page it was left on,
    // not on PLAYER, which is only where a show STARTS.
    c.ok('portrait again: the pager back on CHAT, where it was left, chat still joined', await js(`!!${q('[data-live-pager]')}`) && (await activeTab()) === 'chat' && await js(`!!${q('[data-irc-input]')}`));
    c.equal('…and still no QUIT, no second JOIN', [fake.received.filter((l) => l === 'QUIT :bye').length - mmoQuits0, fake.received.filter((l) => l === 'JOIN #MMO').length], [0, 1]);
    await send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });

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
        border: getComputedStyle(${q('[data-irc-chat]')}).borderTopWidth,
        sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
    })())`).then(JSON.parse);
    c.ok('the chat is in the right-hand pane, under the title', d.chatLeft >= d.mid && d.titleLeft >= d.mid, JSON.stringify(d));
    // 405px before the pane above it was tightened (Chad, 2026-11-22), 465px after.
    c.ok(`…and tall (${d.chatH}px)`, d.chatH >= 450, JSON.stringify(d));
    c.equal('…with no sideways overflow', d.sw, d.cw);
    c.ok('…in a frame, so it reads as a chat window', d.border !== '0px', JSON.stringify(d));

    // The hold service (docs/irc.md): the same port, now with a hold. The
    // panel is idle here, so no session is cut by the swap.
    console.log('\nBrowser: the hold service');
    await fake.close();
    fake = await createIrcFake({ port: GATEWAY_PORT, hold: 300 });
    await click('[data-irc-join]');
    await until(`!!${q('[data-irc-input]')}`, 8000);
    fake.say('dude', '#candr', 'before the drop');
    await chatHas('before the drop');
    await type('[data-irc-input]', 'half typed');
    fake.drop('e2efan');
    c.ok('a drop shows Reconnecting…', await until(`(${q('[data-irc-away]')}?.innerText ?? '').includes('Reconnecting')`, 3000));
    c.ok('…keeps the rows', await chatHas('before the drop', 500));
    c.ok('…keeps the draft while the composer waits', await js(`${q('[data-irc-input]')}?.disabled === true && ${q('[data-irc-input]')}.value === 'half typed'`));
    c.ok('…and offers no JOIN', !(await js(`!!${q('[data-irc-join]')}`)));
    fake.say('dude', '#candr', 'said while away');
    c.ok('it comes back by itself, with what was said while away', await chatHas('said while away', 8000));
    c.ok('…says so, and that nothing was missed', await chatHas('Reconnected; nothing was missed.'));
    c.ok('…and the composer works again', await until(`${q('[data-irc-input]')}?.disabled === false && !${q('[data-irc-away]')}`, 3000));
    c.equal('…on the same IRC session, with no QUIT in the channel', [fake.sessionsCreated, fake.quits], [1, []]);
    // This fake is TODAY's irc-hold: it drops HOLD LIVE, as the real one does,
    // so the page works against it before the new one deploys.
    c.equal('the panel sent HOLD LIVE once, after the HOLD TOKEN (none on the resume)', fake.holdLives, 1);
    c.ok('the held session is saved as soon as it is joined, on this device (localStorage), one key per channel',
      await until(`!!localStorage.getItem('bmb:irc_hold:#candr') && !sessionStorage.getItem('bmb:irc_hold')`, 3000));

    // The socket test when the page comes back (hold plan item 5): a phone
    // that slept or changed network keeps a socket with no close event, and
    // the chat shows nothing new. On `pageshow` and on visible the page sends
    // an IRC PING; no answer in 5 s and it drops the socket and resumes.
    const pings = () => fake.received.filter((l) => l === 'PING :bmb-check').length;
    const reconnects = () => js(`[...document.querySelectorAll('[data-irc-row]')].filter((r) => r.innerText.startsWith('Reconnected')).length`);
    const healthy = [await reconnects(), fake.resumes.length];
    await js(`window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))`);
    c.ok('a page shown again tests its socket with one IRC PING', await fakeGot(() => pings() === 1, 3000));
    await wait(6000);
    c.equal('…which is answered, so nothing reconnects', [await reconnects(), fake.resumes.length], healthy);
    fake.blackhole('e2efan');
    fake.say('dude', '#candr', 'said while the phone slept');
    await wait(300);
    c.ok('a line written into a socket that died quietly does not show', !(await chatHas('said while the phone slept', 100)));
    await js(`document.dispatchEvent(new Event('visibilitychange'))`);
    c.ok('the page becomes visible: PING, no PONG in 5 s, so it resumes', await fakeGot(() => pings() === 2, 3000) && await until(`${await reconnects()} < [...document.querySelectorAll('[data-irc-row]')].filter((r) => r.innerText.startsWith('Reconnected')).length`, 10000));
    c.ok('…and shows what was said while it slept', await chatHas('said while the phone slept', 3000));
    c.equal('…on the same IRC session, with no QUIT and no NICK', [fake.sessionsCreated, fake.quits, fake.received.filter((l) => /^NICK /.test(l)).length], [1, [], 1]);

    fake.drop('e2efan');
    fake.endSession('e2efan');
    c.ok('a session that ended while away says so, and offers JOIN',
      await until(`!!${q('[data-irc-join]')}`, 8000) && await chatHas('The chat connection ended while you were away.'));
    c.ok('…without "Disconnected (…)" around it', !(await chatHas('Disconnected (The chat', 300)));

    // A refresh is a drop (Chad, 2026-11-22: "if you refresh the page, you
    // should come back with your nick and chat"), and a live stream picks back
    // up ("if you're listening to a live stream and you hit refresh ... you
    // want it to pick back up"). The page saves the held session and the live
    // item in this tab; the reloaded page reads the item from its feed again,
    // opens the full-screen player it had open, plays, and resumes the chat.
    const regs = () => fake.received.filter((l) => /^(NICK|USER) /.test(l)).length;
    const playingCount = () => js(`[...document.querySelectorAll('audio,video')].filter((m) => !m.paused).length`);
    const fullOn = (title, ms = 15000) => until(`[...document.querySelectorAll('h1')].some((h) => h.textContent.includes(${JSON.stringify(title)}) && h.getBoundingClientRect().width > 0)`, ms);
    // The /live page has a "live now" heading of its own: read the player's close button.
    const fullOff = () => js(`!(document.querySelector('[aria-label="Close fullscreen player"]')?.getBoundingClientRect().width > 0)`);
    const reopen = async () => {
      await until(`document.body.innerText.includes('E2E Chad Show')`, 30000);
      await playCard('E2E Chad Show');
      await openPlayer('E2E Chad Show live now');
    };
    await click('[data-irc-join]');
    await until(`!!${q('[data-irc-input]')}`, 8000);
    if (await playingCount() === 0) await click('[aria-label="Play"]');
    c.ok('the live item plays before the refresh', await until(`[...document.querySelectorAll('audio,video')].some((m) => !m.paused)`, 8000));
    fake.say('dude', '#candr', 'before the refresh');
    await chatHas('before the refresh');
    const atRefresh = [fake.sessionsCreated, regs(), fake.quits.length];
    await send('Page.reload');
    fake.say('dude', '#candr', 'said during the refresh');
    c.ok('a refresh with the full-screen player open comes back to it, on the same live item, with no press', await fullOn('E2E Chad Show live now'));
    c.ok('…and the stream plays again by itself', await until(`[...document.querySelectorAll('audio,video')].some((m) => !m.paused)`, 10000));
    await wait(1000);
    c.equal('…one stream, not two', await playingCount(), 1);
    c.ok('…from the live edge, not an old place', await js(`[...document.querySelectorAll('audio,video')].find((m) => !m.paused).currentTime < 10`));
    c.ok('…with no TAP TO RESUME', !(await js(`!!document.querySelector('[data-live-resume]')`)));
    c.ok('the chat shows the rows again', await chatHas('before the refresh', 8000));
    c.ok('…resumes by itself, with what was said during the refresh', await chatHas('said during the refresh', 8000));
    c.ok('…says so', await chatHas('Reconnected; nothing was missed.'));
    c.ok('…offers no JOIN, and the composer works', await until(`${q('[data-irc-input]')}?.disabled === false && !${q('[data-irc-join]')}`, 5000));
    c.equal('…on the same IRC session: no NICK or USER, no QUIT', [fake.sessionsCreated, regs(), fake.quits.length], atRefresh);
    await type('[data-irc-input]', 'after the refresh');
    await click('[data-irc-send]');
    c.ok('…and what you type goes out on it', await fakeGot(() => fake.received.includes('PRIVMSG #candr :after the refresh')));
    c.equal('the saved session is on this device (localStorage, per channel); the live item stays in this tab (sessionStorage)',
      await js(`[!!localStorage.getItem('bmb:irc_hold:#candr'), !!sessionStorage.getItem('bmb:live_refresh'), Object.keys(sessionStorage).some((k) => /irc_hold/.test(k)), Object.keys(localStorage).some((k) => /live_refresh/.test(k))].join()`), 'true,true,false,false');

    // A browser that refuses sound with no click after a reload (Firefox and
    // Safari by default): play() rejects with NotAllowedError until a click,
    // as this patch makes it. The player says TAP TO RESUME, not a bare ▶.
    const { identifier: refuse } = (await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      let armed = true;
      addEventListener('click', () => { armed = false; }, true);
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () { return armed ? Promise.reject(new DOMException('no click yet', 'NotAllowedError')) : play.call(this); };
    })()` })).result;
    await send('Page.reload');
    c.ok('a refused start after a refresh: the full-screen player is back', await fullOn('E2E Chad Show live now'));
    c.ok('…and says TAP TO RESUME', await until(`(document.querySelector('[data-live-resume]')?.innerText ?? '').includes('TAP TO RESUME')`, 10000));
    c.equal('…over silence, with ▶ on the transport', [await playingCount(), await js(`!!document.querySelector('[aria-label="Play"]')`)], [0, true]);
    c.ok('…while the chat resumed anyway', await chatHas('Reconnected; nothing was missed.', 8000));
    // On a phone the full-screen player is the pager, and its bar says it too.
    // TAP TO RESUME is the widest thing that slot holds (GO LIVE is ~85px of its
    // 129px; e2e:livecatchup makes the lag GO LIVE needs), so it is the one to
    // fit beside ▶ and BOOST on Chad's screen, without growing the bar.
    const barH = () => js(`Math.round(document.querySelector('[data-live-bar]')?.getBoundingClientRect().height ?? 0)`);
    await send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 3, mobile: true });
    await send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 59, left: 0, bottom: 34, right: 0 } });
    const resumeFit = await until(`!!document.querySelector('[data-live-bar] [data-live-resume]')`, 5000) ? await barFit('[data-live-resume]') : null;
    c.ok('…in the phone pager\'s bar at 393 px: at least 24 x 24, clear of ▶ and BOOST, on screen', fits(resumeFit), JSON.stringify(resumeFit));
    c.equal('…and the bar is as tall as it is with "streaming now" (77px)', await barH(), 77);
    const resume393 = await barLayout();
    c.ok('…with ▶ still in the middle of the bar', centred(resume393), JSON.stringify(resume393));
    await shot('5-resume');
    await send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    // At 320 the label takes two lines (`wrapResume`): one line is 129px and a
    // side of the bar is ~108px.
    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 2, mobile: true });
    await wait(400);
    const resume320 = await barLayout();
    const resumeFit320 = await barFit('[data-live-resume]');
    console.log('   bar at 320 with TAP TO RESUME:', JSON.stringify(resume320), JSON.stringify(resumeFit320));
    await shot('5b-resume-320');
    c.ok('…at 320 px: TAP TO RESUME at least 24 x 24, clear of ▶ and BOOST, on screen', fits(resumeFit320), JSON.stringify(resumeFit320));
    c.ok('…with ▶ in the middle, and the bar no taller than 77px', centred(resume320) && resume320.h <= 77, JSON.stringify(resume320));
    // The mini-bar says it too, and on a 390 px phone the longer label must
    // fit beside ▶ without growing the bar (GO LIVE once ran under ▶ there).
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await closePlayer();
    const miniFit = () => js(`(() => {
      const bar = document.querySelector(${JSON.stringify(MINI_BAR)});
      const b = bar?.querySelector('[data-live-resume]');
      const p = bar?.querySelector('[aria-label="Play"],[aria-label="Pause"]');
      const de = document.documentElement;
      if (!bar || !p) return null;
      const r = b?.getBoundingClientRect(), q = p.getBoundingClientRect();
      return { barH: Math.round(bar.getBoundingClientRect().height), tap: !!b,
        h: r ? Math.round(r.height) : 0, w: r ? Math.round(r.width) : 0,
        clear: !r || !(r.right > q.left && r.left < q.right && r.bottom > q.top && r.top < q.bottom),
        inView: !r || r.right <= innerWidth, noScroll: de.scrollWidth <= de.clientWidth };
    })()`);
    await until(`!!document.querySelector(${JSON.stringify(MINI_BAR)} + ' [data-live-resume]')`, 5000);
    const blockedFit = await miniFit();
    c.ok('…in the mini-bar at 390 px: at least 24 x 24, clear of ▶, on screen, no sideways scroll',
      !!blockedFit && blockedFit.tap && blockedFit.h >= 24 && blockedFit.w >= 24 && blockedFit.clear && blockedFit.inView && blockedFit.noScroll, JSON.stringify(blockedFit));
    await click(`${MINI_BAR} [data-live-resume]`);
    c.ok('one press plays it', await until(`[...document.querySelectorAll('audio,video')].some((m) => !m.paused)`, 8000));
    c.ok('…and TAP TO RESUME goes', await until(`!document.querySelector('[data-live-resume]')`, 3000));
    const playingFit = await miniFit();
    c.equal('…and the mini-bar keeps its height', blockedFit?.barH, playingFit?.barH);
    await send('Emulation.clearDeviceMetricsOverride');
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: refuse });
    await openPlayer('E2E Chad Show live now');

    // Paused before the refresh stays paused, with no TAP TO RESUME.
    await click('[aria-label="Pause"]');
    await until(`[...document.querySelectorAll('audio,video')].every((m) => m.paused)`, 5000);
    await send('Page.reload');
    c.ok('paused before a refresh: the full-screen player is back', await fullOn('E2E Chad Show live now'));
    await wait(2500);
    c.equal('…still paused, and no TAP TO RESUME', [await playingCount(), await js(`!!document.querySelector('[data-live-resume]')`)], [0, false]);

    // With the full-screen player closed, it comes back closed, in the mini-bar.
    await click('[aria-label="Play"]');
    await until(`[...document.querySelectorAll('audio,video')].some((m) => !m.paused)`, 8000);
    await closePlayer();
    await send('Page.reload');
    c.ok('closed before a refresh: the live item is back in the mini-bar', await until(`(document.querySelector(${JSON.stringify(MINI_BAR)})?.innerText ?? '').includes('E2E Chad Show live now')`, 15000));
    c.ok('…playing', await until(`[...document.querySelectorAll('audio,video')].some((m) => !m.paused)`, 8000));
    c.ok('…with the full-screen player still closed', await fullOff());
    await openPlayer('E2E Chad Show live now');

    // Closing the full-screen player is not leaving: the show plays on in the
    // mini-bar, and Chad's goal is to "do other things" without losing the
    // chat. There is no "stop" that empties the player.
    const quitsOf = () => fake.quits.filter((n) => n === 'e2efan').length;
    const quitsAtClose = quitsOf();
    await closePlayer();
    await wait(1000);
    c.ok('closing the full-screen player keeps the chat: no QUIT, the hold still saved',
      quitsOf() === quitsAtClose && await js(`!!localStorage.getItem('bmb:irc_hold:#candr')`), JSON.stringify(fake.quits));
    // Leaving on purpose (another show) still quits, and forgets the session.
    await playCard('E2E Other Show');
    c.ok('another show still quits the channel', await fakeGot(() => quitsOf() > quitsAtClose), JSON.stringify(fake.quits));
    c.ok('…and forgets the saved session', await until(`!localStorage.getItem('bmb:irc_hold:#candr')`, 3000));
    // The other show is live and playing, but its feed now says it ended.
    feedLive = false;
    await send('Page.reload');
    await until(`document.body.innerText.includes('E2E Chad Show')`, 30000);
    await wait(2500);
    c.ok('a live item whose feed says it ended is not picked back up',
      !(await js(`(document.querySelector(${JSON.stringify(MINI_BAR)})?.innerText ?? '').includes('live now')`)) && await playingCount() === 0);
    feedLive = true;
    await reopen();
    c.ok('so a refresh after it offers JOIN, not a resume', await until(`!!${q('[data-irc-join]')}`, 8000) && !(await js(`!!${q('[data-irc-away]')}`)));

    // irc-hold image 5's nick take-back welcomes up to ~7 s late (t4r,
    // 2026-11-25). The 20 s register timeout covers it, and the line says why.
    fake.welcomeDelayMs = 7000;
    const joinAt = Date.now();
    await click('[data-irc-join]');
    c.ok('a slow welcome shows "Joining…"', await until(`(${q('[data-irc-joining]')}?.innerText ?? '').startsWith('Joining #candr')`, 3000));
    c.ok('…and after 5 s says why it may be slow', await until(`(${q('[data-irc-joining]')}?.innerText ?? '').includes('Still joining. A nick that was in use a moment ago can take a few more seconds.')`, 7000));
    c.ok('…and joins when the 001 comes 7 s late, with no error', await until(`!!${q('[data-irc-input]')}`, 12000) && !(await js(`!!${q('[data-irc-join]')}`)), String(Date.now() - joinAt));
    fake.welcomeDelayMs = 0;

    // Leaving the page is a drop too: the page cannot tell a refresh from a
    // closed tab, so the session stays held until the hold runs out.
    const quitsBeforeLeave = fake.quits.length;
    await send('Page.navigate', { url: 'about:blank' });
    await wait(1500);
    c.equal('leaving the page sends no QUIT: the hold keeps the session until it runs out', [fake.quits.length, fake.sessions], [quitsBeforeLeave, 1]);

    // A closed app (hold plan item 1). Chad, 7:32 PM on 2026-11-24: he joined
    // #MMO as BMB, closed the app, opened it, typed BMB, and got "That nick is
    // taken" — his own held chat had it, and the copy that could resume it
    // was in the closed app's sessionStorage. A new tab has none of the old
    // tab's sessionStorage, as a reopened app has none; the hold must come
    // back from localStorage, with no NICK.
    const atClose = [fake.sessionsCreated, regs(), fake.quits.length];
    fake.say('dude', '#candr', 'said while the app was closed');
    const tab2 = await browser.openTab();
    await setupTab(tab2);
    await page.close();
    ({ send, js, until } = tab2);
    await send('Page.navigate', { url: `${APP}/live` });
    c.ok('a new tab (a reopened app) starts with no sessionStorage of the old one',
      await until(`document.readyState !== 'loading' && !sessionStorage.getItem('bmb:live_refresh')`, 15000));
    await reopen();
    c.ok('on that show the chat resumes the held session by itself', await chatHas('said while the app was closed', 10000));
    c.ok('…shows the rows from before the close', await chatHas(HISTORY, 1000));
    c.ok('…offers no JOIN, and the composer works', await until(`${q('[data-irc-input]')}?.disabled === false && !${q('[data-irc-join]')}`, 5000));
    c.equal('…with no NICK or USER, no new IRC session and no QUIT: the nick was never "taken"', [fake.sessionsCreated, regs(), fake.quits.length], atClose);
    await type('[data-irc-input]', 'back after closing the app');
    await click('[data-irc-send]');
    c.ok('…and what you type goes out on the same session', await fakeGot(() => fake.received.includes('PRIVMSG #candr :back after closing the app')));

    if (process.argv.includes('--perf')) {
      // 2,000 rows on a phone (hold plan item 6): a resume after a long hold
      // brings ~1,500 lines at once, and the list then holds 2,000. An iPhone
      // 11's screen, with the CPU 4x slower than this Mac (DevTools' mobile
      // setting): the A13 is slower than the Mac, so the numbers lean high.
      // Run it against `next build && next start` for the numbers that count:
      // `next dev` renders everything twice (Strict Mode) and checks more.
      console.log('\nBrowser: 2,000 rows on an emulated iPhone 11 (414 x 896, CPU 4x slower)');
      await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
      await send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await wait(500);
      await pagerTo('chat');
      // In the page: when each frame arrived (a socket made from now on), and
      // when each marked row was painted (two frames after React put it in).
      await js(`(() => {
        const W = window.WebSocket;
        window.__msgAt = [];
        window.WebSocket = class extends W {
          constructor(...a) { super(...a); this.addEventListener('message', () => window.__msgAt.push(performance.now())); }
        };
        window.__rowAt = new Map();
        new MutationObserver((ms) => {
          const marks = [];
          for (const m of ms) for (const n of m.addedNodes) {
            const k = /(burst|tick) \\d+/.exec(n.textContent ?? '');
            if (k) marks.push(k[0]);
          }
          if (marks.length) requestAnimationFrame(() => requestAnimationFrame(() => { const t = performance.now(); for (const k of marks) window.__rowAt.set(k, t); }));
        }).observe(document.querySelector('[data-irc-list]'), { childList: true });
        window.__long = 0;
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long += e.duration; }).observe({ type: 'longtask' });
        return true;
      })()`);
      // The burst: 1,500 lines said while the socket was away, replayed by seq.
      fake.refuseResume = true;
      fake.drop('e2efan');
      await until(`!!document.querySelector('[data-irc-away]')`, 5000);
      for (let i = 0; i < 1500; i++) fake.say('flood', '#candr', `burst ${i}`);
      await js(`window.__msgAt = []; window.__long = 0; true`);
      fake.refuseResume = false;
      await js(`document.dispatchEvent(new Event('visibilitychange'))`);
      c.ok('a resume that brings 1,500 lines shows them all', await until(`window.__rowAt.has('burst 1499')`, 120000, 50));
      const burst = await js(`JSON.stringify({ ms: Math.round(window.__rowAt.get('burst 1499') - window.__msgAt[0]), frames: window.__msgAt.length, longTaskMs: Math.round(window.__long) })`).then(JSON.parse);
      console.log('   1,500-line resume:', JSON.stringify(burst));
      c.ok(`…painted ${burst.ms} ms after the first frame arrived (at most 3,000)`, burst.ms <= 3000, JSON.stringify(burst));
      // Fill to 2,000, then time single lines, as a busy chat sends them.
      for (let i = 0; i < 600; i++) fake.say('flood', '#candr', `fill ${i}`);
      await until(`document.querySelectorAll('[data-irc-list] [data-irc-row]').length === 2000 && (document.querySelector('[data-irc-list]').lastElementChild?.textContent ?? '').includes('fill 599')`, 60000, 100);
      c.equal('the list holds 2,000 rows', await rows(), 2000);
      const ticks = [];
      for (let i = 0; i < 20; i++) {
        await js(`window.__msgAt = []; true`);
        fake.say('dude', '#candr', `tick ${i}`);
        if (!(await until(`window.__rowAt.has('tick ${i}')`, 10000, 20))) { ticks.push(Infinity); continue; }
        ticks.push(await js(`Math.round(window.__rowAt.get('tick ${i}') - window.__msgAt[0])`));
        await wait(150);
      }
      const sorted = [...ticks].sort((x, y) => x - y);
      const median = sorted[Math.floor(sorted.length / 2)];
      console.log('   one line at 2,000 rows (ms, arrival to paint):', JSON.stringify(ticks));
      c.ok(`…one new line is painted in ${median} ms (median; at most 100), the slowest ${sorted.at(-1)} ms (at most 250)`, median <= 100 && sorted.at(-1) <= 250);
      const sticks = await js(`(() => { const el = document.querySelector('[data-irc-list]'); return el.scrollHeight - el.scrollTop - el.clientHeight < 80; })()`);
      c.ok('…and the list still follows the newest line', sticks);
      await send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await send('Emulation.clearDeviceMetricsOverride');
    }
  } finally {
    await fake.close();
  }
}

await nodeHalf();
await holdHalf();
await holdLiveHalf();
const bi = process.argv.indexOf('--browser');
if (bi !== -1) {
  const next = process.argv[bi + 1];
  await browserHalf(next && !next.startsWith('--') ? next : (process.env.APP_URL ?? 'http://127.0.0.1:3047'));
}
console.log(`\n${c.count - c.fails}/${c.count} passed`);
await exit(c.fails ? 1 : 0);
