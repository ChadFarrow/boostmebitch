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
 * frame, and only until the service says `HOLD GONE` (or 6 hours). Against a
 * gateway with no hold service there is no token, and a drop calls `onClose`
 * once, as before.
 */
import {
  ircStart, ircStep, ircSend, ircNick, ircRejoin, resumeWaitMs,
  HOLD_TOKEN_RE, MAX_HOLD_S, HOLD_MAX_AWAY_S, RESUME_DELAYS_MS,
  type IrcEvent, type IrcState, type IrcStepResult,
} from './protocol';

export { IRC_GATEWAY_URL } from './shows';

export interface IrcSession {
  send(text: string): void;
  nick(n: string): void;
  rejoin(): void;
  /**
   * Leave on purpose: `QUIT`, so the service ends the session at once. While
   * the socket is away it goes back only to say it (a held nick would
   * otherwise stay in the channel for the rest of the show).
   */
  quit(): void;
  /** What a page saves to resume this session after a refresh, or null when nothing holds it. */
  hold(): IrcHold | null;
  /**
   * The page came back (visible, `pageshow`, `online`): test a socket that
   * looks attached, or try a resume now. The session listens for those events
   * itself; this is the same entry for a caller with no `document` (e2e).
   */
  wake(): void;
}

/** A held session, as `HOLD RESUME` needs it. */
export interface IrcHold {
  token: string;
  /** The last IRC line received. */
  seq: number;
  /** The `<seconds>` of `HOLD TOKEN`: the shortest hold, not when it ends. */
  holdS: number;
}

/** The socket to the hold service went down, or came back with `missed` lines it no longer had. */
export type IrcLink = { kind: 'lost' } | { kind: 'back'; missed: number };

/** How a session ended, beside the reason the listener reads. */
export interface IrcEnd {
  /**
   * Another window resumed it (close 4001): the session goes on there, so the
   * hold it saved belongs to that window now and must not be cleared here.
   */
  elsewhere: boolean;
  /** The session's hold token, or null without a hold service: what a saved copy is matched by. */
  token: string | null;
}

export interface IrcSessionOptions {
  url: string;
  nick: string;
  channel: string;
  onEvent(e: IrcEvent): void;
  /** Once per session, whatever closed it. */
  onClose(reason: string, end: IrcEnd): void;
  /** A held session lost its socket, or got it back. Never called without a hold service. */
  onLink?(l: IrcLink): void;
  /**
   * Give up when the channel is not joined this long after the socket opens
   * (default 20 s): a gateway that accepts the socket and never welcomes would
   * otherwise leave "Joining…" on screen with no way out.
   */
  registerTimeoutMs?: number;
  /** The first waits between resume tries; the last one repeats until `resumeSlowAfterMs`. */
  resumeDelaysMs?: number[];
  /** Away this long, try every `resumeSlowEveryMs` instead (default 5 min, 60 s). */
  resumeSlowAfterMs?: number;
  resumeSlowEveryMs?: number;
  /** Stop trying after this long away with no answer (default 6 h); `HOLD GONE` ends it sooner. */
  resumeGiveUpMs?: number;
  /** A resume socket that has not answered `HOLD RESUMED` in this long is dropped and tried again. */
  resumeTimeoutMs?: number;
  /** The socket test on `wake`: no frame in this long and the socket is dropped and resumed (default 5 s). */
  probeTimeoutMs?: number;
  /**
   * Start by resuming a session an earlier page held (a refresh, docs/irc.md
   * "A refresh is a drop") instead of registering: `HOLD RESUME` first, never
   * NICK/USER. The panel starts as "away" and gets `onLink({ kind: 'back' })`.
   */
  resume?: IrcHold;
}

/** The default for `registerTimeoutMs`. */
export const IRC_REGISTER_TIMEOUT_MS = 20_000;
/** The default for `resumeDelaysMs`: 1 s, 2 s, 4 s, then every 15 s (every 60 s after 5 minutes). */
export const IRC_RESUME_DELAYS_MS = RESUME_DELAYS_MS;
/** The default for `resumeTimeoutMs`. */
export const IRC_RESUME_TIMEOUT_MS = 10_000;
/** The default for `probeTimeoutMs`. */
export const IRC_PROBE_TIMEOUT_MS = 5_000;

/** The close code of a socket whose session another socket resumed. */
const TAKEOVER = 4001;

const REASON_GONE = 'The chat connection ended while you were away.';
const REASON_ELSEWHERE = 'The chat went on in another window.';

const nowSec = () => Math.floor(Date.now() / 1000);

export function openIrcSession(o: IrcSessionOptions): IrcSession {
  const start = ircStart(o.nick, o.channel);
  // A resumed session is past registration; HOLD RESUMED names its nick.
  let state: IrcState = o.resume ? { phase: 'joined', nick: o.nick, channel: o.channel, pendingNick: null } : start.state;
  let ws: WebSocket | null = null;
  /** The socket in `ws` carries IRC: open for a new session, or past `HOLD RESUMED`. */
  let attached = false;
  let closed = false;
  let quitting = false;
  let token: string | null = null;
  let holdS = 0;
  /** Waiting for the first `HOLD RESUMED` of a session an earlier page held. */
  let adopting = false;
  /** IRC lines received in this session: what `HOLD RESUME` asks to continue after. */
  let seq = 0;
  /** While a held session is away: when its socket went (ms). 0 while attached. */
  let lostAt = 0;
  let tries = 0;
  let registerTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attemptTimer: ReturnType<typeof setTimeout> | null = null;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;

  const clear = (t: ReturnType<typeof setTimeout> | null) => { if (t) clearTimeout(t); };
  const clearTimers = () => {
    clear(registerTimer); clear(retryTimer); clear(attemptTimer); clear(probeTimer);
    registerTimer = retryTimer = attemptTimer = probeTimer = null;
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

  const finish = (reason: string, elsewhere = false) => {
    clearTimers();
    if (closed) return;
    closed = true;
    unwatch();
    o.onClose(reason, { elsewhere, token });
  };
  const quit = () => {
    quitting = true;
    clear(registerTimer); clear(retryTimer); clear(probeTimer);
    registerTimer = retryTimer = probeTimer = null;
    if (attached && isOpen()) {
      ws!.send('QUIT :bye');
    } else if (token && lostAt && !adopting && !closed) {
      // Away from a held session: go back only to say QUIT (control's
      // RESUMED), or the service keeps the nick in the channel until the hold
      // ends — with HOLD LIVE, the rest of the show. A resume socket already
      // on its way carries it; its attempt timer still bounds it. A session
      // still being ADOPTED is not ended this way: React's development double
      // mount quits it at once, and the second mount resumes it.
      if (!ws) resume();
      return;
    }
    clear(attemptTimer); attemptTimer = null;
    if (ws) { try { ws.close(1000); } catch { /* already closing */ } }
    else finish('closed');
  };

  const control = (sock: WebSocket, line: string, resuming: boolean) => {
    const [, kind, a, b, c] = line.split(' ');
    if (kind === 'TOKEN' && !resuming && !token) {
      const s = Number(b);
      if (a && HOLD_TOKEN_RE.test(a) && Number.isInteger(s) && s > 0) {
        token = a;
        holdS = Math.min(s, MAX_HOLD_S);
        // "This page tries to come back until HOLD GONE" (docs/irc.md): once
        // per token, after it and never as a socket's FIRST frame (the
        // service reads a first HOLD frame as a resume). It says nothing
        // about the show: the service alone decides whether it is live. An
        // irc-hold that does not know it drops it, as it drops every HOLD line.
        try { sock.send('HOLD LIVE'); } catch { /* closing; the hold stays the short one */ }
      }
    } else if (kind === 'RESUMED' && resuming && !attached) {
      clear(attemptTimer); attemptTimer = null;
      if (quitting) {
        // Back only to leave (quit() while away).
        try { sock.send('QUIT :bye'); sock.close(1000); } catch { /* already closing */ }
        return;
      }
      attached = true;
      lostAt = 0;
      tries = 0;
      if (adopting) {
        // `<channel>` is `*` when the nick is in none (kicked while away).
        adopting = false;
        state = { phase: b === '*' ? 'parted' : 'joined', nick: a && a !== '*' ? a : state.nick, channel: o.channel, pendingNick: null };
      }
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
      // Any frame proves the socket alive: the test `wake` started passed.
      if (probeTimer) { clear(probeTimer); probeTimer = null; }
      for (const raw of ev.data.split(/\r?\n/)) {
        if (!raw) continue;
        if (raw.startsWith('HOLD ')) { control(sock, raw, resuming); continue; }
        // Before `HOLD RESUMED` a resume socket carries nothing the session may read.
        if (!attached) continue;
        // Every IRC line counts, the PONG to our own PING too: the service
        // numbers it, and a resume asks by this number.
        seq++;
        apply(ircStep(state, raw, nowSec()));
      }
    };
    // An error is always followed by close; the close carries the report.
    sock.onerror = () => {};
    sock.onclose = (ev: CloseEvent) => {
      if (ws !== sock) return;
      detach();
      if (closed) return;
      const plain = ev.reason || (ev.wasClean ? 'closed' : 'connection lost');
      if (quitting) { finish(plain); return; }
      if (ev.code === TAKEOVER) { finish(REASON_ELSEWHERE, true); return; }
      if (!token) { finish(plain); return; }
      away(false);
    };
    return sock;
  };

  const detach = () => {
    ws = null;
    attached = false;
    clear(attemptTimer); clear(probeTimer);
    attemptTimer = probeTimer = null;
  };
  /** The held session has no socket: say so once, then try to come back (now, or on the schedule). */
  const away = (now: boolean) => {
    if (!lostAt) {
      lostAt = Date.now();
      tries = 0;
      o.onLink?.({ kind: 'lost' });
    }
    if (now) resume();
    else schedule();
  };
  /**
   * A socket that stopped answering: drop it NOW. A dead network may deliver
   * its close event much later, or never, and until then nothing new shows.
   */
  const abandon = (sock: WebSocket, now: boolean) => {
    if (ws !== sock) return;
    detach();
    try { sock.close(); } catch { /* already closing */ }
    if (closed) return;
    if (quitting) { finish('connection lost'); return; }
    away(now);
  };

  const schedule = () => {
    if (closed) return;
    const wait = resumeWaitMs(tries, Date.now() - lostAt, {
      delaysMs: o.resumeDelaysMs,
      slowAfterMs: o.resumeSlowAfterMs,
      slowEveryMs: o.resumeSlowEveryMs,
      giveUpMs: o.resumeGiveUpMs ?? HOLD_MAX_AWAY_S * 1000,
    });
    if (wait === null) { finish('connection lost'); return; }
    tries++;
    retryTimer = setTimeout(resume, wait);
  };
  const resume = () => {
    retryTimer = null;
    if (closed || ws) return;
    const sock = connect(true);
    attemptTimer = setTimeout(() => {
      attemptTimer = null;
      if (ws === sock && !attached) abandon(sock, false);
    }, o.resumeTimeoutMs ?? IRC_RESUME_TIMEOUT_MS);
  };

  /**
   * Is the socket that looks attached still there? A phone that slept or
   * changed network keeps a socket with no close event, and the chat then
   * shows nothing new. Only with a hold service: without one, dropping a
   * socket ends the chat, so a slow answer must not do it.
   */
  const probe = () => {
    if (closed || quitting || !token || !attached || !isOpen() || probeTimer || state.phase === 'registering') return;
    const sock = ws!;
    sock.send('PING :bmb-check');
    probeTimer = setTimeout(() => {
      probeTimer = null;
      abandon(sock, true);
    }, o.probeTimeoutMs ?? IRC_PROBE_TIMEOUT_MS);
  };

  // The network or the page came back: test the socket, or try now rather
  // than at the next tick.
  const wake = () => {
    if (closed) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (attached) { probe(); return; }
    if (!lostAt || ws || quitting) return;
    clear(retryTimer);
    resume();
  };
  const watching = typeof window !== 'undefined' && typeof document !== 'undefined';
  if (watching) {
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);
    document.addEventListener('visibilitychange', wake);
  }
  function unwatch() {
    if (!watching) return;
    window.removeEventListener('online', wake);
    window.removeEventListener('pageshow', wake);
    document.removeEventListener('visibilitychange', wake);
  }

  if (o.resume && HOLD_TOKEN_RE.test(o.resume.token)) {
    token = o.resume.token;
    holdS = Math.min(Math.max(Math.floor(o.resume.holdS), 1), MAX_HOLD_S);
    seq = o.resume.seq;
    // Counted from now, not from the drop: the service's own clock decides,
    // and it answers HOLD GONE when the hold is over.
    lostAt = Date.now();
    adopting = true;
    resume();
  } else {
    registerTimer = setTimeout(() => {
      // `finish` first, so the reason the listener reads is this one and not
      // the close that `quit` causes.
      finish('no answer from the chat server');
      quit();
    }, o.registerTimeoutMs ?? IRC_REGISTER_TIMEOUT_MS);
    connect(false);
  }

  return {
    send: (text) => applyOwn(ircSend(state, text, nowSec())),
    nick: (n) => applyOwn(ircNick(state, n)),
    rejoin: () => applyOwn(ircRejoin(state)),
    quit,
    hold: () => (token && !closed && !adopting ? { token, seq, holdS } : null),
    wake,
  };
}
