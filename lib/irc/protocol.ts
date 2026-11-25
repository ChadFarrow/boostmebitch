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
/** Ours, not ZeroNode's: IRC allows one character, but a one-letter nick reads as nobody (Chad, 2026-11-21). */
export const MIN_NICK_LENGTH = 2;

const NICK_RE = new RegExp(`^[A-Za-z[\\]\\\\\`_^{|}][A-Za-z0-9[\\]\\\\\`_^{|}-]{${MIN_NICK_LENGTH - 1},${MAX_NICK_LENGTH - 1}}$`);

/** 2–17 characters; a letter or `[]\`_^{|}` first; then also digits and `-`. */
export function isValidNick(nick: string): boolean {
  return NICK_RE.test(nick);
}

/** How many nick colors there are: `--nick-0` … `--nick-9` in app/globals.css, `text-nick-N` in the panel. */
export const NICK_COLORS = 10;

/**
 * The color of a nick, `0` … `NICK_COLORS - 1`, from the nick alone (Chad,
 * 2026-11-22: one color per person, as IRC clients do), so every listener sees
 * one nick in one color and a reload keeps it. Case-insensitive, as IRC nicks
 * are (ZeroNode: CASEMAPPING ascii). FNV-1a, 32 bit: changing it moves every
 * nick's color at once, which `check:irc` pins.
 */
export function nickColor(nick: string): number {
  const s = nick.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0) % NICK_COLORS;
}

/** A hold token as the service sends it: base64url, at least 128 bits. */
export const HOLD_TOKEN_RE = /^[A-Za-z0-9_-]{22,128}$/;
/**
 * The largest `<seconds>` a `HOLD TOKEN` line may name. It only checks that
 * line: `<seconds>` is the SHORTEST hold (300), and the page tries to come back
 * until `HOLD GONE`, not until `<seconds>` (`HOLD LIVE`, docs/irc.md).
 */
export const MAX_HOLD_S = 3600;
/**
 * How long a page tries to come back to a held session, and keeps it saved:
 * 6 hours, irc-hold's own limit for a hold that `HOLD LIVE` asked for (the
 * hold plan Chad approved on 2026-11-24). `HOLD GONE` ends it sooner: the
 * service alone knows when the hold is over.
 */
export const HOLD_MAX_AWAY_S = 6 * 3600;
/** The first waits between resume tries: 1 s, 2 s, 4 s, then every 15 s… */
export const RESUME_DELAYS_MS = [1_000, 2_000, 4_000, 15_000];
/** …until the page has been away this long… */
export const RESUME_SLOW_AFTER_MS = 5 * 60_000;
/** …and then every minute, until `HOLD GONE` or `HOLD_MAX_AWAY_S`. */
export const RESUME_SLOW_EVERY_MS = 60_000;

/** The knobs of `resumeWaitMs`; the defaults are the constants above. Tests shorten them. */
export interface ResumeSchedule {
  delaysMs?: number[];
  slowAfterMs?: number;
  slowEveryMs?: number;
  giveUpMs?: number;
}

/**
 * The wait before resume try `tries` (from 0) when the socket went `awayMs`
 * ago, or null to give up. A held session is tried until the service says
 * `HOLD GONE`, so the only end here is `HOLD_MAX_AWAY_S`; the last try is AT
 * that end, never past it. Not `<seconds>`: with `HOLD LIVE` the service holds
 * a live show's chat past it (Chad's 2026-11-24 goal: "come and go in the chat
 * while the show's live without missing anything").
 */
export function resumeWaitMs(tries: number, awayMs: number, s: ResumeSchedule = {}): number | null {
  const left = (s.giveUpMs ?? HOLD_MAX_AWAY_S * 1000) - awayMs;
  if (!(left > 0)) return null;
  const delays = s.delaysMs?.length ? s.delaysMs : RESUME_DELAYS_MS;
  const step = awayMs >= (s.slowAfterMs ?? RESUME_SLOW_AFTER_MS)
    ? s.slowEveryMs ?? RESUME_SLOW_EVERY_MS
    : delays[Math.min(Math.max(tries, 0), delays.length - 1)];
  return Math.min(step, left);
}

/** A saved hold with an `at` this far in the future came from a wrong clock, or was written by hand. */
const SAVED_SKEW_MS = 5 * 60_000;

/**
 * Whether a saved hold is still worth a resume at `nowMs`: saved less than
 * `HOLD_MAX_AWAY_S` ago. Not `at + holdS`: the service may hold it past
 * `<seconds>`, and it answers `HOLD GONE` when it does not.
 */
export function holdSnapshotFresh(saved: { at: number }, nowMs: number): boolean {
  return saved.at <= nowMs + SAVED_SKEW_MS && nowMs - saved.at <= HOLD_MAX_AWAY_S * 1000;
}

/** The rows a page saves with its held session. The panel shows more (2,000); the resume brings the rest by `seq`. */
export const MAX_SAVED_ROWS = 200;
const MAX_SAVED_TEXT = 4000;

/** A row of the panel, as a tab saves it with its held session. */
export interface IrcSavedRow {
  kind: 'message' | 'notice';
  from?: string;
  text: string;
  action?: boolean;
  self?: boolean;
  time: number;
}

/**
 * What a page keeps of its held session across a refresh or a closed app, in
 * localStorage (`bmb:irc_hold:<channel>`, docs/irc.md "A refresh is a drop"):
 * enough to send `HOLD RESUME <token> <seq>` and to show the rows again while
 * it does.
 */
export interface IrcHoldSnapshot {
  channel: string;
  nick: string;
  token: string;
  /** The `<seconds>` of the `HOLD TOKEN` line: the shortest hold. */
  holdS: number;
  /** The last IRC line the saved rows include. */
  seq: number;
  /** When it was saved (ms). Worth a resume until `holdSnapshotFresh` says no (6 h). */
  at: number;
  phase: 'joined' | 'kicked';
  rows: IrcSavedRow[];
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

function readSavedRow(raw: unknown): IrcSavedRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== 'message' && r.kind !== 'notice') return null;
  if (typeof r.text !== 'string' || r.text.length > MAX_SAVED_TEXT) return null;
  if (typeof r.time !== 'number' || !Number.isFinite(r.time)) return null;
  if (r.from !== undefined && (typeof r.from !== 'string' || r.from.length > 64)) return null;
  if (r.action !== undefined && typeof r.action !== 'boolean') return null;
  if (r.self !== undefined && typeof r.self !== 'boolean') return null;
  const row: IrcSavedRow = { kind: r.kind, text: r.text, time: r.time };
  if (r.from !== undefined) row.from = r.from as string;
  if (r.action !== undefined) row.action = r.action as boolean;
  if (r.self !== undefined) row.self = r.self as boolean;
  return row;
}

/**
 * A saved hold read back, field by field, or null. The token goes to the
 * gateway and the rows to the screen, so nothing is trusted because it was
 * ours once: a field of the wrong shape refuses the hold, a row of the wrong
 * shape is dropped, and a field the panel does not know is not carried.
 */
export function readHoldSnapshot(raw: unknown): IrcHoldSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.channel !== 'string' || !/^#[^\s,\x07]{1,49}$/.test(v.channel)) return null;
  if (typeof v.nick !== 'string' || !isValidNick(v.nick)) return null;
  if (typeof v.token !== 'string' || !HOLD_TOKEN_RE.test(v.token)) return null;
  if (!isInt(v.holdS, 1, MAX_HOLD_S)) return null;
  if (!isInt(v.seq, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (typeof v.at !== 'number' || !Number.isFinite(v.at) || v.at <= 0) return null;
  if (v.phase !== 'joined' && v.phase !== 'kicked') return null;
  if (!Array.isArray(v.rows)) return null;
  const rows = v.rows.map(readSavedRow).filter((r): r is IrcSavedRow => r !== null).slice(-MAX_SAVED_ROWS);
  return { channel: v.channel, nick: v.nick, token: v.token, holdS: v.holdS, seq: v.seq, at: v.at, phase: v.phase, rows };
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
