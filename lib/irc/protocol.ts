/**
 * The IRC line codec, for the chat beside an RSS live stream (docs/irc.md).
 *
 * AN IMPORT-FREE LEAF, and it must stay one: `check:irc` loads it under plain
 * `node --experimental-strip-types`, and `scripts/import-free.mjs` rejects any
 * import, type-only included.
 *
 * Every string a listener types reaches ZeroNode through here, so two rules
 * are the reason this file exists:
 *
 * 1. CR and LF end an IRC command. `cleanOutgoing` turns every CR, LF and NUL
 *    into a space BEFORE a line is built, so a pasted "hi\r\nJOIN #x" is one
 *    PRIVMSG and never a second command sent with the listener's address.
 * 2. A server takes 512 bytes per line, prefix included, and the prefix is
 *    added by the server where we cannot measure it. A chunk of text is at most
 *    `MAX_TEXT_BYTES` UTF-8 bytes and is cut on a code-point boundary, so no
 *    character is split across two lines.
 */

/** One parsed IRC line. `nick` is null for a server prefix or no prefix. */
export interface IrcLine {
  tags: Record<string, string>;
  prefix: string | null;
  nick: string | null;
  command: string;
  params: string[];
}

/** The longest line we read: 8191 bytes is IRCv3's ceiling with message tags. */
const MAX_LINE_BYTES = 8191;

/**
 * Text bytes per PRIVMSG line. The server relays each line with our full
 * prefix in front, and cuts the text when the relayed line passes 512 bytes:
 * a 30-character nick (more than ZeroNode's 17), a 63-character WEBIRC host and a long channel name take
 * ~131 bytes of it (review, 2026-11-21). 350 leaves that room, so no message
 * loses its end on the way.
 */
export const MAX_TEXT_BYTES = 350;

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;

function unescapeTag(v: string): string {
  return v.replace(/\\(.?)/g, (_, c: string) =>
    c === ':' ? ';' : c === 's' ? ' ' : c === 'r' ? '\r' : c === 'n' ? '\n' : c);
}

/** Parse one line from the server. `null` for an empty or oversized line. */
export function parseLine(raw: string): IrcLine | null {
  const line = raw.replace(/[\r\n]+$/, '');
  if (!line || byteLength(line) > MAX_LINE_BYTES) return null;
  let rest = line;
  const tags: Record<string, string> = {};
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    if (sp === -1) return null;
    for (const pair of rest.slice(1, sp).split(';')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq === -1) tags[pair] = '';
      else tags[pair.slice(0, eq)] = unescapeTag(pair.slice(eq + 1));
    }
    rest = rest.slice(sp + 1).replace(/^ +/, '');
  }
  let prefix: string | null = null;
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    if (sp === -1) return null;
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1).replace(/^ +/, '');
  }
  const sp = rest.indexOf(' ');
  const command = (sp === -1 ? rest : rest.slice(0, sp)).toUpperCase();
  if (!command) return null;
  rest = sp === -1 ? '' : rest.slice(sp + 1);
  const params: string[] = [];
  while (rest) {
    if (rest.startsWith(' ')) { rest = rest.slice(1); continue; }
    if (rest.startsWith(':')) { params.push(rest.slice(1)); break; }
    const next = rest.indexOf(' ');
    if (next === -1) { params.push(rest); break; }
    params.push(rest.slice(0, next));
    rest = rest.slice(next + 1);
  }
  return { tags, prefix, nick: nickOf(prefix), command, params };
}

/** `dude!u@h` → `dude`; a server name (has a dot, no `!`/`@`) → null. */
function nickOf(prefix: string | null): string | null {
  if (!prefix) return null;
  const bang = prefix.search(/[!@]/);
  if (bang !== -1) return prefix.slice(0, bang) || null;
  return prefix.includes('.') ? null : prefix;
}

/** Remove mIRC formatting: colour (`\x03`, hex `\x04`), bold, italic, underline, strike, mono, reverse, reset. */
export function stripFormatting(text: string): string {
  return text
    .replace(/\x03(\d{1,2}(,\d{1,2})?)?/g, '')
    .replace(/\x04([0-9a-fA-F]{6}(,[0-9a-fA-F]{6})?)?/g, '')
    .replace(/[\x02\x0F\x11\x16\x1D\x1E\x1F]/g, '');
}

/** The text of a CTCP ACTION (`/me`); null for any other text or CTCP. */
export function ctcpAction(text: string): string | null {
  const m = /^\x01ACTION(?: ([\s\S]*?))?\x01?$/.exec(text);
  return m ? m[1] ?? '' : null;
}

/**
 * What a listener typed, made safe to put in ONE line: CR, LF, NUL → space;
 * `\x01` removed, because it opens a CTCP (a pasted `\x01VERSION\x01` makes
 * every client in the channel answer) and the composer cannot show it; trimmed.
 */
export function cleanOutgoing(text: string): string {
  return text.replace(/[\r\n\0]/g, ' ').replace(/\x01/g, '').trim();
}

/**
 * Cut text into chunks of at most `maxBytes` UTF-8 bytes. A chunk ends at its
 * last space when it has one (the space is dropped), else on a code-point
 * boundary. So `chunks.join(' ')` (cut on spaces) or `join('')` (no spaces)
 * gives the text back.
 */
export function splitText(text: string, maxBytes = MAX_TEXT_BYTES): string[] {
  const out: string[] = [];
  let rest = text;
  while (byteLength(rest) > maxBytes) {
    let used = 0;
    let end = 0; // index into `rest` (UTF-16 units) that still fits
    for (const ch of rest) {
      const b = byteLength(ch);
      if (used + b > maxBytes) break;
      used += b;
      end += ch.length;
    }
    const space = rest.lastIndexOf(' ', end);
    if (space > 0) {
      out.push(rest.slice(0, space));
      rest = rest.slice(space + 1);
    } else {
      out.push(rest.slice(0, end));
      rest = rest.slice(end);
    }
  }
  if (rest) out.push(rest);
  return out;
}

/** PRIVMSG lines (no CRLF) for one message; `[]` when nothing is left to send. */
export function buildPrivmsg(target: string, text: string): string[] {
  const clean = cleanOutgoing(text);
  if (!clean) return [];
  return splitText(clean).map((chunk) => `PRIVMSG ${target} :${chunk}`);
}

/** CTCP ACTION (`/me`) lines; the two `\x01` bytes come out of the budget. */
export function buildAction(target: string, text: string): string[] {
  const clean = cleanOutgoing(text);
  if (!clean) return [];
  return splitText(clean, MAX_TEXT_BYTES - '\x01ACTION \x01'.length)
    .map((chunk) => `PRIVMSG ${target} :\x01ACTION ${chunk}\x01`);
}

/**
 * ZeroNode's NICKLEN, from its 005 reply (seen live, 2026-11-21). A longer nick
 * is refused with 432, so the nick box and `/nick` stop it before it leaves.
 */
export const MAX_NICK_LENGTH = 17;

const NICK_RE = new RegExp(`^[A-Za-z[\\]\\\\\`_^{|}][A-Za-z0-9[\\]\\\\\`_^{|}-]{0,${MAX_NICK_LENGTH - 1}}$`);

/** 1–17 characters; a letter or `[]\`_^{|}` first; then also digits and `-`. */
export function isValidNick(nick: string): boolean {
  return NICK_RE.test(nick);
}

// ── The session ──────────────────────────────────────────────────────────────
//
// A PURE REDUCER, so `check:irc` can pin the whole conversation with the server
// without a socket: each call takes the state and one input and returns the new
// state, the lines to send and the events for the panel. `lib/irc/client.ts`
// only moves lines between this and a WebSocket.
//
// Deliberately small: one channel, no private messages, no user list, and no
// join/part/quit events (the panel does not show them). A KICK keeps the
// connection, so REJOIN costs no new connection; an ERROR ends it.

export type IrcPhase = 'registering' | 'joined' | 'parted' | 'closed';

export interface IrcState {
  phase: IrcPhase;
  nick: string;
  channel: string;
  /** The nick a typed `/nick` asked for, until the server's NICK echo. */
  pendingNick: string | null;
}

export type IrcEvent =
  | { type: 'joined'; channel: string; nick: string }
  | { type: 'message'; from: string; text: string; action: boolean; self: boolean; time: number }
  | { type: 'nickInUse'; nick: string }
  /** `requested`: the listener typed `/nick` for it; false when the network renamed them (services). */
  | { type: 'nickChanged'; to: string; requested: boolean }
  | { type: 'kicked'; by: string; reason: string }
  | { type: 'error'; text: string };

export interface IrcStepResult {
  state: IrcState;
  out: string[];
  events: IrcEvent[];
}

/** Shown when the listener types a command other than `/me` or `/nick`. */
export const ONLY_ME_AND_NICK = 'Only /me and /nick work here.';
const NICK_REFUSED = 'That nick is not allowed.';

/**
 * Numerics that refuse a JOIN (banned, full, invite only, key, registered
 * nicks only, TLS only). The panel shows the server's own text for each.
 */
const JOIN_REFUSALS = new Set(['471', '473', '474', '475', '477', '489']);

/**
 * Numerics that refuse a CHANNEL MESSAGE: 404 (quieted, banned without a kick,
 * `+m`) and 492 (no CTCP). The listener's own row is then the only copy, so the
 * panel shows the server's text rather than letting them talk to nobody.
 */
const SEND_REFUSALS = new Set(['404', '492']);

const same = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
const result = (state: IrcState, out: string[] = [], events: IrcEvent[] = []): IrcStepResult => ({ state, out, events });

/** Register on a new connection. The gateway may replace USER's fields. */
export function ircStart(nick: string, channel: string): IrcStepResult {
  return result({ phase: 'registering', nick, channel, pendingNick: null }, [`NICK ${nick}`, 'USER webchat 0 * :webchat']);
}

function timeOf(line: IrcLine, nowSec: number): number {
  const t = line.tags.time ? Date.parse(line.tags.time) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : nowSec;
}

/** One line from the server. */
export function ircStep(state: IrcState, raw: string, nowSec: number): IrcStepResult {
  const line = parseLine(raw);
  if (!line) return result(state);
  const p = line.params;
  switch (line.command) {
    case 'PING':
      return result(state, [`PONG :${p[0] ?? ''}`]);
    case '001':
      if (state.phase !== 'registering') return result(state);
      return result({ ...state, nick: p[0] || state.nick }, [`JOIN ${state.channel}`]);
    case '432':
    case '433':
      return result(state, [], [{ type: 'nickInUse', nick: p[1] ?? state.nick }]);
    case 'JOIN':
      if (!same(line.nick, state.nick) || !same(p[0], state.channel)) return result(state);
      return result({ ...state, phase: 'joined' }, [], [{ type: 'joined', channel: state.channel, nick: state.nick }]);
    case 'NICK':
      if (!same(line.nick, state.nick) || !p[0]) return result(state);
      return result({ ...state, nick: p[0], pendingNick: null }, [], [{ type: 'nickChanged', to: p[0], requested: same(state.pendingNick, p[0]) }]);
    case 'PRIVMSG':
    case 'NOTICE': {
      if (!same(p[0], state.channel) || p[1] == null) return result(state);
      const action = ctcpAction(p[1]);
      if (action == null && p[1].startsWith('\x01')) return result(state); // another CTCP
      const text = stripFormatting(action ?? p[1]);
      return result(state, [], [{
        type: 'message', from: line.nick ?? line.prefix ?? '', text, action: action != null, self: false, time: timeOf(line, nowSec),
      }]);
    }
    case 'KICK':
      if (!same(p[0], state.channel) || !same(p[1], state.nick)) return result(state);
      return result({ ...state, phase: 'parted' }, [], [{ type: 'kicked', by: line.nick ?? line.prefix ?? '', reason: p[2] ?? '' }]);
    case 'ERROR':
      return result({ ...state, phase: 'closed' }, [], [{ type: 'error', text: p[0] ?? '' }]);
    default:
      if (JOIN_REFUSALS.has(line.command) || SEND_REFUSALS.has(line.command)) {
        return result(state, [], [{ type: 'error', text: p.at(-1) ?? line.command }]);
      }
      return result(state);
  }
}

/** What the listener typed. Nothing leaves before the JOIN. */
export function ircSend(state: IrcState, text: string, nowSec: number): IrcStepResult {
  if (state.phase !== 'joined') return result(state);
  const self = (t: string, action: boolean): IrcEvent =>
    ({ type: 'message', from: state.nick, text: t, action, self: true, time: nowSec });
  const trimmed = text.trimStart();
  if (trimmed.startsWith('/')) {
    const m = /^\/(\S+)\s*([\s\S]*)$/.exec(trimmed);
    const cmd = m?.[1].toLowerCase();
    const arg = m?.[2] ?? '';
    if (cmd === 'me') {
      const chunks = splitText(cleanOutgoing(arg), MAX_TEXT_BYTES - '\x01ACTION \x01'.length);
      return result(state, buildAction(state.channel, arg), chunks.map((c) => self(c, true)));
    }
    if (cmd === 'nick') {
      const nick = cleanOutgoing(arg);
      if (!isValidNick(nick)) return result(state, [], [{ type: 'error', text: NICK_REFUSED }]);
      return result({ ...state, pendingNick: nick }, [`NICK ${nick}`]);
    }
    return result(state, [], [{ type: 'error', text: ONLY_ME_AND_NICK }]);
  }
  const chunks = splitText(cleanOutgoing(text));
  return result(state, buildPrivmsg(state.channel, text), chunks.filter(Boolean).map((c) => self(c, false)));
}

/** A new nick on the same connection, after 432/433. */
export function ircNick(state: IrcState, nick: string): IrcStepResult {
  if (!isValidNick(nick)) return result(state, [], [{ type: 'error', text: NICK_REFUSED }]);
  return result(state.phase === 'registering' ? { ...state, nick } : state, [`NICK ${nick}`]);
}

/** JOIN the channel again after a KICK, on the same connection. */
export function ircRejoin(state: IrcState): IrcStepResult {
  if (state.phase === 'closed') return result(state);
  return result(state, [`JOIN ${state.channel}`]);
}
