// A small local IRC server over WebSocket, for `e2e:irc` ONLY.
//
// It stands where Chad's webircgateway stands in production (docs/irc.md):
// one IRC line per WebSocket text frame, both ways, no CRLF. It speaks just
// enough IRC for the panel — registration, JOIN, PRIVMSG, PING, NICK, KICK,
// QUIT — so a test can drive every branch of `lib/irc/protocol.ts` through the
// real `lib/irc/client.ts` and a real browser, with no ZeroNode and no network.
//
// With `hold` it also plays the hold service (docs/irc.md, "Holding a dropped
// connection"): a SESSION outlives its socket for `hold` seconds, numbers every
// line it sends (`seq`), keeps them tagged `@time=`, and answers the `HOLD`
// lines of the contract. Without `hold` a session ends with its socket, as
// webircgateway alone does.
//
// Two irc-holds, because either side may deploy first (the hold plan,
// 2026-11-24). With `liveHold` it is the NEW one: a session whose page sent
// `HOLD LIVE` outlives its socket for `liveHold` seconds instead (irc-hold
// holds a live show's chat until it ends). Without it, TODAY's: `HOLD LIVE`
// is dropped like every other HOLD line, and the hold stays `hold`.
//
// It never listens beyond 127.0.0.1.
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';

const SERVER = 'fake.irc';

/**
 * @param {{ port?: number, taken?: string[], stall?: string[], hold?: number, liveHold?: number }} [opts]
 *   `taken`: nicks the server answers with 433, as if someone held them.
 *   `stall`: nicks it never welcomes, as a gateway that accepted the socket
 *   and then lost its upstream would.
 *   `hold`: seconds a session outlives a dropped socket (the hold service),
 *   and the `<seconds>` of its `HOLD TOKEN`.
 *   `liveHold`: seconds a session whose page sent `HOLD LIVE` outlives it (the
 *   new irc-hold). 0: `HOLD LIVE` changes nothing (today's irc-hold).
 */
export async function createIrcFake({ port = 0, taken = [], stall = [], hold = 0, liveHold = 0 } = {}) {
  const takenNicks = new Set(taken.map((n) => n.toLowerCase()));
  const stallNicks = new Set(stall.map((n) => n.toLowerCase()));
  /** Nicks whose JOIN is refused with 474, as a channel ban would. Mutable. */
  const banned = new Set();
  const received = [];
  const origins = [];
  /** Every `HOLD RESUME` the fake was sent, as `{ token, seq }`. */
  const resumes = [];
  /** Nicks whose session ended, in order — what the channel saw as a QUIT. */
  const quits = [];
  const sessions = new Set();
  const sockets = new Set();
  let connections = 0;
  let sessionsCreated = 0;
  /** While true, a `HOLD RESUME` gets its socket cut with no answer (a network still down). */
  let refuseResume = false;
  /** Ms between a complete NICK + USER and the 001, as irc-hold's nick take-back adds (~7 s). Mutable. */
  let welcomeDelayMs = 0;

  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  const actualPort = wss.address().port;

  const prefixOf = (s) => `${s.nick}!webchat@fake`;
  const inChannel = (channel) => [...sessions].filter((s) => s.channels.has(channel.toLowerCase()));
  const byNick = (nick) => [...sessions].find((s) => s.nick?.toLowerCase() === nick.toLowerCase());

  /** One IRC line toward the session's page: numbered and kept when holding. */
  const send = (s, line) => {
    if (hold) {
      s.seq++;
      s.ring.push({ seq: s.seq, line: line.startsWith('@') ? line : `@time=${new Date().toISOString()} ${line}` });
      // irc-hold keeps 2,000 lines per chat (the hold plan); a little more
      // here, so a test of the panel's 2,000 rows is not cut by the fake.
      if (s.ring.length > 2500) s.ring.shift();
    }
    if (s.ws && !s.blackhole && s.ws.readyState === s.ws.OPEN) s.ws.send(line);
  };

  const end = (s, reason) => {
    if (s.ended) return;
    s.ended = true;
    if (s.holdTimer) clearTimeout(s.holdTimer);
    sessions.delete(s);
    if (s.nick) quits.push(s.nick);
    for (const ch of s.channels) for (const o of inChannel(ch)) send(o, `:${prefixOf(s)} QUIT :${reason}`);
  };

  const newSession = () => {
    sessionsCreated++;
    const s = { ws: null, nick: null, user: false, registered: false, channels: new Set(), seq: 0, ring: [], token: null, holdTimer: null, blackhole: false, ended: false, live: false };
    if (hold) s.token = randomBytes(16).toString('base64url');
    sessions.add(s);
    return s;
  };

  const attach = (s, ws) => {
    if (s.holdTimer) clearTimeout(s.holdTimer);
    s.holdTimer = null;
    s.blackhole = false;
    s.ws = ws;
  };

  const ircLine = (s, line) => {
    received.push(line);
    const [cmd, ...rest] = line.split(' ');
    const arg = rest.join(' ');
    const welcome = () => {
      if (s.registered || !s.nick || !s.user || stallNicks.has(s.nick.toLowerCase())) return;
      s.registered = true;
      const say001 = () => { if (sessions.has(s)) send(s, `:${SERVER} 001 ${s.nick} :Welcome to the fake IRC network ${s.nick}`); };
      if (welcomeDelayMs > 0) setTimeout(say001, welcomeDelayMs);
      else say001();
    };
    switch (cmd.toUpperCase()) {
      case 'NICK': {
        const nick = rest[0]?.replace(/^:/, '');
        if (!nick) break;
        if (takenNicks.has(nick.toLowerCase())) {
          send(s, `:${SERVER} 433 ${s.nick ?? '*'} ${nick} :Nickname is already in use`);
          break;
        }
        if (s.registered) {
          const old = prefixOf(s);
          for (const o of sessions) if (o === s || [...s.channels].some((ch) => o.channels.has(ch))) send(o, `:${old} NICK :${nick}`);
        }
        s.nick = nick;
        welcome();
        break;
      }
      case 'USER':
        s.user = true;
        welcome();
        break;
      case 'PING':
        send(s, `:${SERVER} PONG ${SERVER} ${arg}`);
        break;
      case 'JOIN': {
        const channel = rest[0];
        if (!s.registered || !channel) break;
        if (banned.has(s.nick.toLowerCase())) {
          send(s, `:${SERVER} 474 ${s.nick} ${channel} :Cannot join channel (+b)`);
          break;
        }
        s.channels.add(channel.toLowerCase());
        for (const o of inChannel(channel)) send(o, `:${prefixOf(s)} JOIN ${channel}`);
        break;
      }
      case 'PRIVMSG': {
        const target = rest[0];
        if (!s.registered || !target) break;
        for (const o of inChannel(target)) if (o !== s) send(o, `:${prefixOf(s)} ${line}`);
        break;
      }
      case 'QUIT':
        // A QUIT ends the session at once, with no hold (the contract).
        end(s, 'Quit: bye');
        s.ws?.close(1000);
        break;
      default:
        break;
    }
  };

  wss.on('connection', (ws, req) => {
    connections++;
    sockets.add(ws);
    origins.push(req.headers.origin ?? '');
    /** @type {any} */
    let s = null;
    ws.on('message', (data) => {
      for (const line of String(data).split(/\r?\n/)) {
        if (!line) continue;
        if (!s && hold && line.startsWith('HOLD RESUME ')) {
          received.push(line);
          const [, , token, seqText] = line.split(' ');
          const seq = Number(seqText);
          resumes.push({ token, seq });
          if (refuseResume) { ws.terminate(); return; }
          const held = [...sessions].find((x) => x.token === token);
          if (!held) {
            ws.send('HOLD GONE :expired');
            ws.close(1000);
            return;
          }
          if (held.ws && held.ws !== ws) held.ws.close(4001, 'resumed elsewhere');
          attach(held, ws);
          s = held;
          const kept = held.ring.filter((r) => r.seq > seq);
          const oldest = held.ring[0]?.seq ?? held.seq + 1;
          const missed = Math.max(0, Math.min(oldest - 1, held.seq) - seq);
          const channel = [...held.channels][0] ?? '*';
          ws.send(`HOLD RESUMED ${held.nick} ${channel} ${missed}`);
          for (const r of kept) ws.send(r.line);
          continue;
        }
        if (!s) {
          s = newSession();
          attach(s, ws);
          if (hold) ws.send(`HOLD TOKEN ${s.token} ${hold}`);
        }
        if (line.startsWith('HOLD ')) {
          received.push(line);
          if (line === 'HOLD LIVE' && liveHold) s.live = true;
          continue;
        }
        ircLine(s, line);
      }
    });
    ws.on('close', () => {
      sockets.delete(ws);
      if (!s || s.ws !== ws) return;
      s.ws = null;
      if (s.ended) return;
      if (!hold) { end(s, 'Web chat closed'); return; }
      s.holdTimer = setTimeout(() => end(s, 'Web chat closed'), (s.live ? liveHold : hold) * 1000);
    });
  });

  return {
    url: `ws://127.0.0.1:${actualPort}/`,
    port: actualPort,
    received,
    origins,
    resumes,
    quits,
    /** How many `HOLD LIVE` lines pages sent, whatever the fake did with them. */
    get holdLives() { return received.filter((l) => l === 'HOLD LIVE').length; },
    /** Sockets ever opened. */
    get connections() { return connections; },
    /** IRC sessions ever started: what ZeroNode would count. */
    get sessionsCreated() { return sessionsCreated; },
    /** Sockets open right now. */
    get live() { return sockets.size; },
    /** Sessions alive right now, held ones included. */
    get sessions() { return sessions.size; },
    set refuseResume(v) { refuseResume = v; },
    set welcomeDelayMs(v) { welcomeDelayMs = v; },
    banned,
    /** A channel message from another user, to everyone in the channel. */
    say(from, channel, text) {
      for (const s of inChannel(channel)) send(s, `:${from}!u@elsewhere PRIVMSG ${channel} :${text}`);
    },
    /** Any line, to every session, as the server sent it. */
    sayRaw(line) {
      for (const s of sessions) send(s, line);
    },
    /** An operator kicks `nick` from every channel it is in. */
    kick(nick, reason) {
      const target = byNick(nick);
      if (!target) return;
      for (const channel of [...target.channels]) {
        for (const s of inChannel(channel)) send(s, `:op!op@fake KICK ${channel} ${target.nick} :${reason}`);
        target.channels.delete(channel);
      }
    },
    /** From now on, lines to `nick` are written into a socket that delivers nothing (half-open). */
    blackhole(nick) {
      const s = byNick(nick);
      if (s) s.blackhole = true;
    },
    /** Cut `nick`'s socket with no goodbye, as a dead network would. */
    drop(nick) {
      byNick(nick)?.ws?.terminate();
    },
    /** Close `nick`'s socket with a close code, as the hold service does on a takeover. */
    closeWith(nick, code, reason) {
      byNick(nick)?.ws?.close(code, reason);
    },
    /** End `nick`'s session on the server side, as ZeroNode closing a held connection would. */
    endSession(nick) {
      const s = byNick(nick);
      if (!s) return;
      const ws = s.ws;
      // An attached page gets the server's ERROR, then HOLD GONE on the live
      // socket, then close 1000 (the thelounge-candr agent, 2026-11-21).
      if (ws && ws.readyState === ws.OPEN) send(s, 'ERROR :Closing link: (webchat@fake) [Closed by the server]');
      end(s, 'Closed by the server');
      if (hold && ws && ws.readyState === ws.OPEN) { ws.send('HOLD GONE :connection closed'); ws.close(1000); }
    },
    /** Cut every connection with no goodbye, as a crashed gateway would. */
    dropAll() {
      for (const ws of sockets) ws.terminate();
    },
    close() {
      for (const s of sessions) if (s.holdTimer) clearTimeout(s.holdTimer);
      for (const ws of sockets) ws.terminate();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
