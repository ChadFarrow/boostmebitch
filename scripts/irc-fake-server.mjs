// A small local IRC server over WebSocket, for `e2e:irc` ONLY.
//
// It stands where Chad's webircgateway stands in production (docs/irc.md):
// one IRC line per WebSocket text frame, both ways, no CRLF. It speaks just
// enough IRC for the panel — registration, JOIN, PRIVMSG, PING, NICK, KICK,
// QUIT — so a test can drive every branch of `lib/irc/protocol.ts` through the
// real `lib/irc/client.ts` and a real browser, with no ZeroNode and no network.
//
// It never listens beyond 127.0.0.1.
import { WebSocketServer } from 'ws';

const SERVER = 'fake.irc';

/**
 * @param {{ port?: number, taken?: string[] }} [opts]
 *   `taken`: nicks the server answers with 433, as if someone held them.
 */
export async function createIrcFake({ port = 0, taken = [] } = {}) {
  const takenNicks = new Set(taken.map((n) => n.toLowerCase()));
  const received = [];
  const origins = [];
  const clients = new Set();
  let connections = 0;

  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  const actualPort = wss.address().port;

  const send = (c, line) => { if (c.ws.readyState === c.ws.OPEN) c.ws.send(line); };
  const prefixOf = (c) => `${c.nick}!webchat@fake`;
  const inChannel = (channel) => [...clients].filter((c) => c.channels.has(channel.toLowerCase()));

  wss.on('connection', (ws, req) => {
    connections++;
    origins.push(req.headers.origin ?? '');
    const c = { ws, nick: null, user: false, registered: false, channels: new Set() };
    clients.add(c);
    const welcome = () => {
      if (c.registered || !c.nick || !c.user) return;
      c.registered = true;
      send(c, `:${SERVER} 001 ${c.nick} :Welcome to the fake IRC network ${c.nick}`);
    };
    ws.on('message', (data) => {
      for (const line of String(data).split(/\r?\n/)) {
        if (!line) continue;
        received.push(line);
        const [cmd, ...rest] = line.split(' ');
        const arg = rest.join(' ');
        switch (cmd.toUpperCase()) {
          case 'NICK': {
            const nick = rest[0]?.replace(/^:/, '');
            if (!nick) break;
            if (takenNicks.has(nick.toLowerCase())) {
              send(c, `:${SERVER} 433 ${c.nick ?? '*'} ${nick} :Nickname is already in use`);
              break;
            }
            if (c.registered) {
              const old = prefixOf(c);
              for (const other of clients) if (other === c || [...c.channels].some((ch) => other.channels.has(ch))) send(other, `:${old} NICK :${nick}`);
            }
            c.nick = nick;
            welcome();
            break;
          }
          case 'USER':
            c.user = true;
            welcome();
            break;
          case 'PING':
            send(c, `:${SERVER} PONG ${SERVER} ${arg}`);
            break;
          case 'JOIN': {
            const channel = rest[0];
            if (!c.registered || !channel) break;
            c.channels.add(channel.toLowerCase());
            for (const other of inChannel(channel)) send(other, `:${prefixOf(c)} JOIN ${channel}`);
            break;
          }
          case 'PRIVMSG': {
            const target = rest[0];
            if (!c.registered || !target) break;
            for (const other of inChannel(target)) if (other !== c) send(other, `:${prefixOf(c)} ${line}`);
            break;
          }
          case 'QUIT':
            ws.close(1000);
            break;
          default:
            break;
        }
      }
    });
    ws.on('close', () => clients.delete(c));
  });

  return {
    url: `ws://127.0.0.1:${actualPort}/`,
    port: actualPort,
    received,
    origins,
    get connections() { return connections; },
    /** A channel message from another user, to everyone in the channel. */
    say(from, channel, text) {
      for (const c of inChannel(channel)) send(c, `:${from}!u@elsewhere PRIVMSG ${channel} :${text}`);
    },
    /** Any line, to every client, as the server sent it. */
    sayRaw(line) {
      for (const c of clients) send(c, line);
    },
    /** An operator kicks `nick` from every channel it is in. */
    kick(nick, reason) {
      for (const target of [...clients].filter((c) => c.nick?.toLowerCase() === nick.toLowerCase())) {
        for (const channel of [...target.channels]) {
          for (const c of inChannel(channel)) send(c, `:op!op@fake KICK ${channel} ${target.nick} :${reason}`);
          target.channels.delete(channel);
        }
      }
    },
    /** Cut every connection with no goodbye, as a crashed gateway would. */
    dropAll() {
      for (const c of clients) c.ws.terminate();
    },
    close() {
      for (const c of clients) c.ws.terminate();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
