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

/** Text bytes per PRIVMSG line — room left for `:nick!user@host PRIVMSG #chan :`. */
export const MAX_TEXT_BYTES = 400;

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

/** What a listener typed, made safe to put in ONE line: CR, LF, NUL → space; trimmed. */
export function cleanOutgoing(text: string): string {
  return text.replace(/[\r\n\0]/g, ' ').trim();
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

/** 1–30 characters; a letter or `[]\`_^{|}` first; then also digits and `-`. */
export function isValidNick(nick: string): boolean {
  return /^[A-Za-z[\]\\`_^{|}][A-Za-z0-9[\]\\`_^{|}-]{0,29}$/.test(nick);
}
