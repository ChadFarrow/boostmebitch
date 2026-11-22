/**
 * The IRC chat's connection: a WebSocket to the gateway (docs/irc.md).
 *
 * BROWSER-ONLY in the app (it also runs under Node in `e2e:irc`, whose global
 * WebSocket is the same API). All IRC logic is in the pure reducer in
 * `./protocol`; this file only moves lines between it and the socket — one IRC
 * line per text frame each way, no CRLF, as webircgateway's websocket
 * transport speaks it.
 *
 * NEVER REGISTERS ON IRC TWICE. Every IRC connection is a slot in ZeroNode's
 * limit of 3 per address, counted against the gateway box at connect time, so
 * a reconnect loop from one tab could spend a slot that every other listener
 * needs. What it may reopen is the SOCKET, to a session the hold service on
 * Chad's box still holds (docs/irc.md, "Holding a dropped connection"): only
 * after the service sent `HOLD TOKEN`, only with `HOLD RESUME` as the first
 * frame, and only until the hold runs out. Against a gateway with no hold
 * service there is no token, and a drop calls `onClose` once, as before.
 */
import { ircStart, ircStep, ircSend, ircNick, ircRejoin, type IrcEvent, type IrcState, type IrcStepResult } from './protocol';

export { IRC_GATEWAY_URL } from './shows';

export interface IrcSession {
  send(text: string): void;
  nick(n: string): void;
  rejoin(): void;
  quit(): void;
}

/** The socket to the hold service went down, or came back with `missed` lines it no longer had. */
export type IrcLink = { kind: 'lost' } | { kind: 'back'; missed: number };

export interface IrcSessionOptions {
  url: string;
  nick: string;
  channel: string;
  onEvent(e: IrcEvent): void;
  /** Once per session, whatever closed it. */
  onClose(reason: string): void;
  /** A held session lost its socket, or got it back. Never called without a hold service. */
  onLink?(l: IrcLink): void;
  /**
   * Give up when the channel is not joined this long after the socket opens
   * (default 20 s): a gateway that accepts the socket and never welcomes would
   * otherwise leave "Joining…" on screen with no way out.
   */
  registerTimeoutMs?: number;
  /** The waits between resume tries; the last one repeats until the hold runs out. */
  resumeDelaysMs?: number[];
  /** A resume socket that has not answered `HOLD RESUMED` in this long is closed and tried again. */
  resumeTimeoutMs?: number;
}

/** The default for `registerTimeoutMs`. */
export const IRC_REGISTER_TIMEOUT_MS = 20_000;
/** The default for `resumeDelaysMs`: 1 s, 2 s, 4 s, then every 15 s. */
export const IRC_RESUME_DELAYS_MS = [1_000, 2_000, 4_000, 15_000];
/** The default for `resumeTimeoutMs`. */
export const IRC_RESUME_TIMEOUT_MS = 10_000;

/** The close code of a socket whose session another socket resumed. */
const TAKEOVER = 4001;
/** A token the page will send back: base64url, at least 128 bits. */
const TOKEN_RE = /^[A-Za-z0-9_-]{22,128}$/;
/** The longest hold the page believes, whatever a gateway says. */
const MAX_HOLD_S = 3600;

const REASON_GONE = 'The chat connection ended while you were away.';
const REASON_ELSEWHERE = 'The chat went on in another window.';

const nowSec = () => Math.floor(Date.now() / 1000);

export function openIrcSession(o: IrcSessionOptions): IrcSession {
  const start = ircStart(o.nick, o.channel);
  let state: IrcState = start.state;
  let ws: WebSocket | null = null;
  /** The socket in `ws` carries IRC: open for a new session, or past `HOLD RESUMED`. */
  let attached = false;
  let closed = false;
  let quitting = false;
  let token: string | null = null;
  let holdMs = 0;
  /** IRC lines received in this session: what `HOLD RESUME` asks to continue after. */
  let seq = 0;
  /** While a held session is away: when its hold runs out. 0 while attached. */
  let deadline = 0;
  let tries = 0;
  let registerTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attemptTimer: ReturnType<typeof setTimeout> | null = null;

  const clear = (t: ReturnType<typeof setTimeout> | null) => { if (t) clearTimeout(t); };
  const clearTimers = () => {
    clear(registerTimer); clear(retryTimer); clear(attemptTimer);
    registerTimer = retryTimer = attemptTimer = null;
  };
  const isOpen = () => !!ws && ws.readyState === WebSocket.OPEN;

  const apply = (r: IrcStepResult) => {
    state = r.state;
    if (attached && isOpen()) for (const line of r.out) ws!.send(line);
    if (state.phase === 'joined') { clear(registerTimer); registerTimer = null; }
    for (const e of r.events) o.onEvent(e);
  };
  /** From the panel: nothing to send while the socket is away (the composer waits). */
  const applyOwn = (r: IrcStepResult) => { if (attached) apply(r); };

  const finish = (reason: string) => {
    clearTimers();
    if (closed) return;
    closed = true;
    unwatch();
    o.onClose(reason);
  };
  const quit = () => {
    quitting = true;
    clearTimers();
    if (attached && isOpen()) ws!.send('QUIT :bye');
    if (ws) { try { ws.close(1000); } catch { /* already closing */ } }
    else finish('closed');
  };

  const control = (sock: WebSocket, line: string, resuming: boolean) => {
    const [, kind, a, b, c] = line.split(' ');
    if (kind === 'TOKEN' && !resuming && !token) {
      const s = Number(b);
      if (a && TOKEN_RE.test(a) && Number.isFinite(s) && s > 0) {
        token = a;
        holdMs = Math.min(s, MAX_HOLD_S) * 1000;
      }
    } else if (kind === 'RESUMED' && resuming && !attached) {
      clear(attemptTimer); attemptTimer = null;
      attached = true;
      deadline = 0;
      tries = 0;
      const missed = Number(c);
      o.onLink?.({ kind: 'back', missed: Number.isFinite(missed) && missed > 0 ? missed : 0 });
    } else if (kind === 'GONE') {
      // On a live socket it is the end of the IRC connection, said as the
      // service says it (the server's ERROR came first); on a resume, the hold
      // is over. Neither is resumed.
      const said = line.slice(line.indexOf(':') + 1).trim();
      finish(attached ? said || 'connection closed' : REASON_GONE);
      try { sock.close(1000); } catch { /* already closing */ }
    }
  };

  const connect = (resuming: boolean): WebSocket => {
    const sock = new WebSocket(o.url);
    ws = sock;
    attached = false;
    sock.onopen = () => {
      if (ws !== sock) return;
      if (resuming) { sock.send(`HOLD RESUME ${token} ${seq}`); return; }
      attached = true;
      for (const line of start.out) sock.send(line);
    };
    sock.onmessage = (ev: MessageEvent) => {
      if (ws !== sock || typeof ev.data !== 'string') return;
      for (const raw of ev.data.split(/\r?\n/)) {
        if (!raw) continue;
        if (raw.startsWith('HOLD ')) { control(sock, raw, resuming); continue; }
        // Before `HOLD RESUMED` a resume socket carries nothing the session may read.
        if (!attached) continue;
        seq++;
        apply(ircStep(state, raw, nowSec()));
      }
    };
    // An error is always followed by close; the close carries the report.
    sock.onerror = () => {};
    sock.onclose = (ev: CloseEvent) => {
      if (ws !== sock) return;
      ws = null;
      attached = false;
      clear(attemptTimer); attemptTimer = null;
      if (closed) return;
      const plain = ev.reason || (ev.wasClean ? 'closed' : 'connection lost');
      if (quitting) { finish(plain); return; }
      if (ev.code === TAKEOVER) { finish(REASON_ELSEWHERE); return; }
      if (!token) { finish(plain); return; }
      if (!deadline) {
        deadline = Date.now() + holdMs;
        tries = 0;
        o.onLink?.({ kind: 'lost' });
      }
      schedule();
    };
    return sock;
  };

  const schedule = () => {
    if (closed) return;
    const left = deadline - Date.now();
    if (left <= 0) { finish('connection lost'); return; }
    const delays = o.resumeDelaysMs?.length ? o.resumeDelaysMs : IRC_RESUME_DELAYS_MS;
    // The last try is AT the deadline, never past it: the service starts its
    // clock when IT sees the drop, which for a half-open socket is later.
    const wait = Math.min(delays[Math.min(tries, delays.length - 1)], left);
    tries++;
    retryTimer = setTimeout(resume, wait);
  };
  const resume = () => {
    retryTimer = null;
    if (closed || ws) return;
    const sock = connect(true);
    attemptTimer = setTimeout(() => {
      attemptTimer = null;
      if (ws === sock && !attached) { try { sock.close(); } catch { /* already closing */ } }
    }, o.resumeTimeoutMs ?? IRC_RESUME_TIMEOUT_MS);
  };

  // The network or the tab came back: try now rather than at the next tick.
  const nudge = () => {
    if (closed || !deadline || ws) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    clear(retryTimer);
    resume();
  };
  const watching = typeof window !== 'undefined' && typeof document !== 'undefined';
  if (watching) {
    window.addEventListener('online', nudge);
    document.addEventListener('visibilitychange', nudge);
  }
  function unwatch() {
    if (!watching) return;
    window.removeEventListener('online', nudge);
    document.removeEventListener('visibilitychange', nudge);
  }

  registerTimer = setTimeout(() => {
    // `finish` first, so the reason the listener reads is this one and not
    // the close that `quit` causes.
    finish('no answer from the chat server');
    quit();
  }, o.registerTimeoutMs ?? IRC_REGISTER_TIMEOUT_MS);

  connect(false);

  return {
    send: (text) => applyOwn(ircSend(state, text, nowSec())),
    nick: (n) => applyOwn(ircNick(state, n)),
    rejoin: () => applyOwn(ircRejoin(state)),
    quit,
  };
}
