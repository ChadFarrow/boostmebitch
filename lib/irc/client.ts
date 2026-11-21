/**
 * The IRC chat's connection: one WebSocket to the gateway (docs/irc.md).
 *
 * BROWSER-ONLY in the app (it also runs under Node in `e2e:irc`, whose global
 * WebSocket is the same API). All IRC logic is in the pure reducer in
 * `./protocol`; this file only moves lines between it and the socket — one IRC
 * line per text frame each way, no CRLF, as webircgateway's websocket
 * transport speaks it.
 *
 * NEVER RECONNECTS, and opens exactly one socket per session. Every
 * connection is a slot in ZeroNode's limit of 3 per address, counted against
 * the gateway box at connect time, so a reconnect loop from one tab could
 * spend a slot that every other listener needs. A dropped connection calls
 * `onClose` once and the panel offers to join again on a press.
 */
import { ircStart, ircStep, ircSend, ircNick, ircRejoin, type IrcEvent, type IrcState, type IrcStepResult } from './protocol';

export { IRC_GATEWAY_URL } from './shows';

export interface IrcSession {
  send(text: string): void;
  nick(n: string): void;
  rejoin(): void;
  quit(): void;
}

export interface IrcSessionOptions {
  url: string;
  nick: string;
  channel: string;
  onEvent(e: IrcEvent): void;
  /** Once per session, whatever closed it. */
  onClose(reason: string): void;
  /**
   * Give up when the channel is not joined this long after the socket opens
   * (default 20 s): a gateway that accepts the socket and never welcomes would
   * otherwise leave "Joining…" on screen with no way out.
   */
  registerTimeoutMs?: number;
}

/** The default for `registerTimeoutMs`. */
export const IRC_REGISTER_TIMEOUT_MS = 20_000;

const nowSec = () => Math.floor(Date.now() / 1000);

export function openIrcSession(o: IrcSessionOptions): IrcSession {
  const ws = new WebSocket(o.url);
  const start = ircStart(o.nick, o.channel);
  let state: IrcState = start.state;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const apply = (r: IrcStepResult) => {
    state = r.state;
    if (ws.readyState === WebSocket.OPEN) for (const line of r.out) ws.send(line);
    if (state.phase === 'joined') clearTimer();
    for (const e of r.events) o.onEvent(e);
  };
  const finish = (reason: string) => {
    clearTimer();
    if (closed) return;
    closed = true;
    o.onClose(reason);
  };
  const quit = () => {
    clearTimer();
    if (ws.readyState === WebSocket.OPEN) ws.send('QUIT :bye');
    try { ws.close(1000); } catch { /* already closing */ }
  };
  timer = setTimeout(() => {
    // `finish` first, so the reason the listener reads is this one and not
    // the close that `quit` causes.
    finish('no answer from the chat server');
    quit();
  }, o.registerTimeoutMs ?? IRC_REGISTER_TIMEOUT_MS);

  ws.onopen = () => {
    for (const line of start.out) ws.send(line);
  };
  ws.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data !== 'string') return;
    for (const raw of ev.data.split(/\r?\n/)) {
      if (raw) apply(ircStep(state, raw, nowSec()));
    }
  };
  // An error is always followed by close; the close carries the report.
  ws.onerror = () => {};
  ws.onclose = (ev: CloseEvent) => finish(ev.reason || (ev.wasClean ? 'closed' : 'connection lost'));

  return {
    send: (text) => apply(ircSend(state, text, nowSec())),
    nick: (n) => apply(ircNick(state, n)),
    rejoin: () => apply(ircRejoin(state)),
    quit,
  };
}
