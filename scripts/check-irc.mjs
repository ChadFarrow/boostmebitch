// Pins lib/irc/protocol.ts — the IRC line codec that sits between a listener's
// composer and ZeroNode. See docs/irc.md and
// docs/superpowers/specs/2026-11-21-irc-live-chat-design.md.
//
// THE FAILURE IT IS WRITTEN AGAINST. IRC is a line protocol: CR LF ends a
// command. A browser panel that builds `PRIVMSG #chan :${text}` from whatever
// was typed or pasted lets one message carry a SECOND command — a pasted
// "hi\r\nJOIN #elsewhere" joins a channel the listener never chose, and
// "\r\nQUIT" or "\r\nPRIVMSG NickServ :…" act on their connection with their
// own address behind it (WEBIRC hands ZeroNode the visitor's real IP, so a ban
// lands on them). Nothing on screen would show it: the panel echoes the text.
// The same codec must also cut a long message into lines a server accepts
// (512 bytes with the prefix the server adds), without splitting a UTF-8
// character, or the far end prints mojibake.
//
// `naive()` is the obvious build and it is wrong in exactly those places:
// `raw.split(' ')` to parse (a trailing parameter has spaces), and
// `PRIVMSG ${target} :${text}` to build (no CR/LF guard, no byte budget).
//
// FIXTURES COME FROM THE WIRE where the wire supplied them: the server prefix
// and `@time` tag shape are ZeroNode's own (`sparrow.zeronode.net`, InspIRCd 4,
// 2026-11-21); the formatting codes are mIRC's, as clients in those channels send.

import {
  parseLine, stripFormatting, ctcpAction, cleanOutgoing, splitText, buildPrivmsg, buildAction, isValidNick, MAX_NICK_LENGTH,
  nickColor, NICK_COLORS, readHoldSnapshot, MAX_SAVED_ROWS,
  resumeWaitMs, holdSnapshotFresh, HOLD_MAX_AWAY_S, MAX_HOLD_S,
  ircStart, ircStep, ircSend, ircNick, ircRejoin,
} from '../lib/irc/protocol.ts';
import { IRC_CHAT_SHOWS, ircChannelFor, ircGatewayOk } from '../lib/irc/shows.ts';
import { replayVectors } from './replay-vectors.mjs';
import { isDeepStrictEqual } from 'node:util';
import { importFreeProblems, explainImportFree } from './import-free.mjs';

let failures = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failures++; };
const ok = (msg) => console.log('  ok    ' + msg);
const bytes = (s) => Buffer.byteLength(s, 'utf8');

// ── naive(): the obvious, wrong codec ────────────────────────────────────────
function naiveParse(raw) {
  const p = raw.split(' ');
  const prefix = p[0].startsWith(':') ? p.shift().slice(1) : null;
  return { prefix, nick: prefix ? prefix.split('!')[0] : null, command: p.shift(), params: p };
}
const naive = {
  build: (t, text) => [`PRIVMSG ${t} :${text}`],
  parse: (raw) => naiveParse(raw),
  strip: (text) => text,
  action: (text) => text,
};

// A ~900-byte message of plain words, and 900 bytes of multi-byte characters
// with no space to break on.
const LONG = Array.from({ length: 113 }, (_, i) => `word${String(i).padStart(3, '0')}`).join(' ');
const EMOJI = 'é🎸'.repeat(150);
const textOf = (line) => line.slice(line.indexOf(' :') + 2);

const vectors = [
  {
    label: 'a pasted CR LF cannot start a second command',
    kind: 'build', args: ['#candr', 'hi\r\nJOIN #evil'], expect: ['PRIVMSG #candr :hi  JOIN #evil'],
  },
  {
    // \x01 opens a CTCP: a pasted "\x01VERSION\x01" makes every client in the
    // channel answer, and "\x01DCC SEND…" offers a file as the listener. The
    // composer cannot show the character, so it is removed, not sent.
    label: 'a pasted \\x01 cannot start a CTCP',
    kind: 'build', args: ['#candr', '\x01VERSION\x01'], expect: ['PRIVMSG #candr :VERSION'],
  },
  {
    label: 'a plain message is one PRIVMSG',
    kind: 'build', args: ['#candr', 'hello'], expect: ['PRIVMSG #candr :hello'], alsoNaive: true,
  },
  {
    label: 'a message of only whitespace and line breaks sends nothing',
    kind: 'build', args: ['#candr', '  \r\n '], expect: [],
  },
  {
    label: `a ${bytes(LONG)}-byte message is cut on spaces into lines of at most 350 bytes`,
    kind: 'build', args: ['#candr', LONG],
    check: (lines) => lines.length === 3
      && lines.every((l) => l.startsWith('PRIVMSG #candr :') && bytes(textOf(l)) <= 350)
      && lines.map(textOf).join(' ') === LONG,
  },
  {
    label: `${bytes(EMOJI)} bytes of é🎸 are cut on character boundaries, never inside one`,
    kind: 'build', args: ['#candr', EMOJI],
    check: (lines) => lines.length >= 3
      && lines.every((l) => { const t = textOf(l); return bytes(t) <= 350 && Buffer.from(t).toString() === t; })
      && lines.map(textOf).join('') === EMOJI,
  },
  {
    label: 'a trailing parameter keeps its spaces',
    kind: 'parse', args: [':dude!u@h PRIVMSG #candr :hi there'],
    expect: { tags: {}, prefix: 'dude!u@h', nick: 'dude', command: 'PRIVMSG', params: ['#candr', 'hi there'] },
  },
  {
    label: 'ZeroNode\'s @time tag and server prefix (no nick in a server prefix)',
    kind: 'parse', args: ['@time=2026-11-21T20:00:00.000Z :sparrow.zeronode.net 001 bmb :Welcome'],
    expect: {
      tags: { time: '2026-11-21T20:00:00.000Z' }, prefix: 'sparrow.zeronode.net', nick: null, command: '001', params: ['bmb', 'Welcome'],
    },
  },
  {
    label: 'a PING with no prefix',
    kind: 'parse', args: ['PING :sparrow.zeronode.net'],
    expect: { tags: {}, prefix: null, nick: null, command: 'PING', params: ['sparrow.zeronode.net'] },
  },
  {
    label: 'mIRC colour, bold and italic codes are removed',
    kind: 'strip', args: ['\x0304,01red\x03 \x02bold\x02 \x1Dit\x1D'], expect: 'red bold it',
  },
  {
    label: 'a CTCP ACTION is read as /me',
    kind: 'action', args: ['\x01ACTION waves\x01'], expect: 'waves',
  },
  {
    label: 'another CTCP (VERSION) is not a message',
    kind: 'action', args: ['\x01VERSION\x01'], expect: null,
  },
];

const call = (impl, v) => {
  try {
    if (impl === 'naive') return JSON.stringify(naive[v.kind](...v.args));
    switch (v.kind) {
      case 'build': return JSON.stringify(buildPrivmsg(...v.args));
      case 'parse': return JSON.stringify(parseLine(...v.args));
      case 'strip': return JSON.stringify(stripFormatting(...v.args));
      case 'action': return JSON.stringify(ctcpAction(...v.args));
      default: return `unknown kind ${v.kind}`;
    }
  } catch (e) {
    return `threw ${(e && e.message) || e}`;
  }
};

console.log('The IRC line codec — the shipping answer:');
for (const v of vectors) {
  const got = call('real', v);
  if (v.check) {
    let passed = false;
    try { passed = v.check(JSON.parse(got)); } catch { passed = false; }
    if (!passed) fail(`"${v.label}" — got ${got.slice(0, 300)}`);
    else ok(v.label);
  } else if (got !== JSON.stringify(v.expect)) {
    fail(`"${v.label}" — expected ${JSON.stringify(v.expect)}, got ${got}`);
  } else ok(v.label);
}

console.log('\nThe replay against naive():');
replayVectors({ vectors, invoke: call, fail });

console.log('\nThe smaller helpers:');
{
  const cases = [
    ['cleanOutgoing turns CR, LF and NUL into spaces and trims', cleanOutgoing(' a\rb\nc\0d '), 'a b c d'],
    ['cleanOutgoing removes \\x01', cleanOutgoing('\x01x\x01'), 'x'],
    ['parseLine returns null for an empty line', parseLine(''), null],
    ['parseLine returns null for a line over 8191 bytes', parseLine('PRIVMSG #c :' + 'x'.repeat(8200)), null],
    ['parseLine upper-cases the command', parseLine(':a!b@c privmsg #c :x')?.command, 'PRIVMSG'],
    ['splitText keeps a short text whole', JSON.stringify(splitText('short')), JSON.stringify(['short'])],
    ['buildAction wraps /me in CTCP', JSON.stringify(buildAction('#candr', 'waves')), JSON.stringify(['PRIVMSG #candr :\x01ACTION waves\x01'])],
    ['buildAction cleans CR/LF too', JSON.stringify(buildAction('#candr', 'a\nQUIT')), JSON.stringify(['PRIVMSG #candr :\x01ACTION a QUIT\x01'])],
  ];
  for (const [label, got, want] of cases) {
    if (got !== want) fail(`${label} — expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    else ok(label);
  }
  const longAction = buildAction('#candr', LONG);
  if (!(longAction.length > 1 && longAction.every((l) => bytes(l.slice(l.indexOf(' :') + 2)) <= 350))) {
    fail(`buildAction cuts a long /me into lines of at most 350 bytes — got ${longAction.length} line(s)`);
  } else ok('buildAction cuts a long /me into lines of at most 350 bytes');
}

console.log('\nThe nick rule:');
{
  // ZeroNode answers NICKLEN=17 in its 005 (seen live by the gateway agent,
  // 2026-11-21): an 18-character nick is refused with 432, which the panel
  // would show as "taken". The box and the rule stop it before it leaves.
  if (MAX_NICK_LENGTH !== 17) fail(`MAX_NICK_LENGTH is ${MAX_NICK_LENGTH}, expected ZeroNode's NICKLEN 17`);
  else ok('MAX_NICK_LENGTH is ZeroNode\'s NICKLEN, 17');
  const nicks = [
    ['candr_fan', true], ['[Dude]', true], ['a-b', true],
    ['9lives', false], ['has space', false], ['', false], ['-dash', false], ['x'.repeat(18), false], ['x'.repeat(17), true],
    // Chad, 2026-11-21: a listener types a name; no generated guest names. IRC
    // allows one character, but a one-letter nick reads as nobody in the list.
    ['a', false], ['_', false], ['Al', true],
  ];
  for (const [nick, want] of nicks) {
    const got = isValidNick(nick);
    if (got !== want) fail(`isValidNick(${JSON.stringify(nick)}) is ${got}, expected ${want}`);
    else ok(`isValidNick(${JSON.stringify(nick.length > 12 ? nick.slice(0, 6) + '…' : nick)}) is ${want}`);
  }
}

console.log('\nThe nick color:');
{
  // Chad, 2026-11-22: "each user has like their own color to their name … it
  // helps make following the chat better." The color is picked from the nick
  // alone, so every listener sees one nick in one color, and a reload keeps it.
  // IRC nicks are case-insensitive (ZeroNode is InspIRCd 4, CASEMAPPING
  // ascii), so `Doug` and `doug` are one person and one color.
  const inRange = (k) => Number.isInteger(k) && k >= 0 && k < NICK_COLORS;
  if (NICK_COLORS !== 10) fail(`NICK_COLORS is ${NICK_COLORS}, expected 10 (one --nick-N token each in app/globals.css)`);
  else ok('NICK_COLORS is 10, one --nick-N token each');
  const same = ['Doug', 'doug', 'DOUG'].map(nickColor);
  if (!same.every(inRange) || new Set(same).size !== 1) fail(`Doug/doug/DOUG get ${JSON.stringify(same)}, expected one color`);
  else ok('Doug, doug and DOUG get one color');
  // Pinned from the shipping hash: a change here moves every listener's color
  // for every nick at once. Change the hash only on purpose.
  const pinned = { notChadF: nickColor('notChadF'), phifer: nickColor('phifer'), ppwatch: nickColor('ppwatch') };
  const want = { notChadF: 0, phifer: 1, ppwatch: 8 };
  if (JSON.stringify(pinned) !== JSON.stringify(want)) fail(`pinned colors moved: ${JSON.stringify(pinned)}, expected ${JSON.stringify(want)}`);
  else ok('the pinned nicks keep their colors');
  // A spread over nicks that differ in one place only. The obvious wrong pick,
  // `nick.length % N`, gives all 200 one color.
  const counts = Array(NICK_COLORS).fill(0);
  for (let i = 0; i < 200; i++) counts[nickColor(`user${String(i).padStart(3, '0')}`)]++;
  if (counts.some((n) => n === 0) || Math.max(...counts) > 40) fail(`200 nicks spread as ${JSON.stringify(counts)}; expected every color used, none above 40`);
  else ok(`200 nicks use every color, none above 40 (${counts.join(' ')})`);
  if (!inRange(nickColor(''))) fail('an empty nick is out of range');
  else ok('an empty nick still gets a color in range');
}

console.log('\nThe saved hold (a refresh is a drop):');
{
  // Chad, 2026-11-22: "if you lose connection or if you refresh the page, you
  // should come back with your nick and chat." The tab saves its held session
  // in localStorage (`bmb:irc_hold:<channel>`) and the next page reads it back. What
  // comes back from storage is input, not ours: the page sends the token to the
  // gateway and renders the rows, so it is read field by field.
  // `naiveRead` is the obvious reader, `JSON.parse` and trust.
  const naiveRead = (raw) => (raw && typeof raw === 'object' ? raw : null);
  const TOKEN = 'k3Jx9QwErTyUiOpAsDfGhJ';
  const row = (text, extra = {}) => ({ kind: 'message', from: 'dude', text, time: 1700000000, ...extra });
  const good = { channel: '#VoidZero', nick: 'notChadF', token: TOKEN, holdS: 300, seq: 41, at: 1700000000000, phase: 'joined',
    rows: [{ kind: 'notice', text: 'You joined #VoidZero.', time: 1700000000 }, row('toast', { self: true, from: 'notChadF' }), row('waves', { action: true })] };
  const wire = (v) => JSON.parse(JSON.stringify(v));
  const cases = [
    ['a saved hold comes back whole', wire(good), good],
    ['a short token is refused', wire({ ...good, token: 'abc' }), null],
    ['a token with URL characters is refused', wire({ ...good, token: TOKEN + '/../x' }), null],
    ['a hold of 0 s is refused', wire({ ...good, holdS: 0 }), null],
    ['a hold over an hour is refused', wire({ ...good, holdS: 99999 }), null],
    ['a negative seq is refused', wire({ ...good, seq: -1 }), null],
    ['a channel without # is refused', wire({ ...good, channel: 'VoidZero' }), null],
    ['a bad nick is refused', wire({ ...good, nick: '9 lives' }), null],
    ['a phase other than joined or kicked is refused', wire({ ...good, phase: 'connecting' }), null],
    ['an array is refused', wire([good]), null],
    ['a row of the wrong shape is dropped, the others kept', wire({ ...good, rows: [row('a'), { kind: 'message', from: 'x', text: 5, time: 1 }, row('b')] }), { ...good, rows: [row('a'), row('b')] }],
    ['a field the panel does not know is not carried', wire({ ...good, rows: [{ ...row('a'), html: '<img src=x onerror=alert(1)>' }] }), { ...good, rows: [row('a')] }],
  ];
  for (const [label, raw, want] of cases) {
    const got = readHoldSnapshot(raw);
    if (!isDeepStrictEqual(got, want)) fail(`${label}: got ${JSON.stringify(got)?.slice(0, 160)}`);
    else if (want === null && naiveRead(raw) === null) fail(`${label}: naiveRead agrees, so the vector cannot fail`);
    else ok(label);
  }
  const many = wire({ ...good, rows: Array.from({ length: 250 }, (_, i) => row(`line ${i}`)) });
  const kept = readHoldSnapshot(many)?.rows ?? [];
  if (kept.length !== MAX_SAVED_ROWS || kept[0].text !== 'line 50') fail(`250 rows keep ${kept.length}, first ${kept[0]?.text}; expected the newest ${MAX_SAVED_ROWS}`);
  else ok(`250 saved rows come back as the newest ${MAX_SAVED_ROWS}`);
  for (const raw of [null, undefined, 'x', 7]) {
    if (readHoldSnapshot(raw) !== null) fail(`${JSON.stringify(raw)} is not refused`);
  }
  ok('null, undefined, a string and a number are refused');
}

console.log('\nHold while live: how long the page tries, and keeps its copy:');
{
  // The hold plan (Chad, 2026-11-24): "you can do other things on your phone
  // or just lock your phone without being disconnected from the chat." With
  // `HOLD LIVE` the service holds a live show's chat past the token's
  // `<seconds>` (300), until 10 minutes after the show, at most 6 hours. So
  // the page must not stop at `<seconds>`: it tries until HOLD GONE, and keeps
  // its saved copy 6 hours. `naive*` is the page before the plan: a deadline
  // of `<seconds>` after the drop, and a copy stale at `at + holdS`.
  const HOLD_S = 300;
  const naiveWait = (tries, awayMs) => {
    const left = HOLD_S * 1000 - awayMs;
    if (left <= 0) return null;
    return Math.min([1000, 2000, 4000, 15000][Math.min(tries, 3)], left);
  };
  const naiveFresh = (saved, now) => now <= saved.at + HOLD_S * 1000;
  const MIN = 60_000;
  const H6 = HOLD_MAX_AWAY_S * 1000;
  const waits = [
    // [label, tries, awayMs, want, alsoNaive]
    ['the first try comes after 1 s', 0, 0, 1000, true],
    ['then 2 s, then 4 s', 2, 3000, 4000, true],
    ['then every 15 s', 9, 2 * MIN, 15000, true],
    ['301 s away it still tries (the old page gave up at <seconds>)', 30, 301_000, 60_000, false],
    ['after 5 minutes, every minute', 40, 30 * MIN, 60_000, false],
    ['the last try is AT 6 hours, never past it', 400, H6 - 10_000, 10_000, false],
    ['6 hours away it stops', 400, H6, null, true],
    ['past 6 hours it stops', 400, H6 + 1, null, true],
  ];
  for (const [label, tries, away, want, alsoNaive] of waits) {
    const got = resumeWaitMs(tries, away);
    if (got !== want) fail(`${label}: resumeWaitMs(${tries}, ${away}) is ${got}, expected ${want}`);
    else if (!alsoNaive && naiveWait(tries, away) === want) fail(`${label}: naive agrees, so the vector cannot fail`);
    else ok(label);
  }
  const quick = { delaysMs: [50, 100], slowAfterMs: 1000, slowEveryMs: 300, giveUpMs: 5000 };
  const knobs = [[0, 0, 50], [5, 500, 100], [5, 1000, 300], [5, 4900, 100], [5, 5000, null]];
  if (knobs.every(([t, a, w]) => resumeWaitMs(t, a, quick) === w)) ok('the test knobs shorten every step (e2e uses them)');
  else fail(`the knobs: ${JSON.stringify(knobs.map(([t, a]) => resumeWaitMs(t, a, quick)))}`);

  const now = 1_764_000_000_000;
  const fresh = [
    ['a copy saved a minute ago is fresh', now - MIN, true, true],
    ['a copy saved 10 minutes ago is fresh (the old page threw it away at 5)', now - 10 * MIN, true, false],
    ['a copy saved 5 hours 59 minutes ago is fresh', now - H6 + MIN, true, false],
    ['a copy saved over 6 hours ago is stale', now - H6 - 1, false, true],
    ['a copy dated a day ahead is stale (a wrong clock, or written by hand)', now + 24 * 60 * MIN, false, false],
  ];
  for (const [label, at, want, alsoNaive] of fresh) {
    const got = holdSnapshotFresh({ at }, now);
    if (got !== want) fail(`${label}: got ${got}`);
    else if (!alsoNaive && naiveFresh({ at }, now) === want) fail(`${label}: naive agrees, so the vector cannot fail`);
    else ok(label);
  }
  if (MAX_HOLD_S < HOLD_S) fail(`MAX_HOLD_S ${MAX_HOLD_S} refuses the service's own HOLD TOKEN of ${HOLD_S}`);
  else ok(`MAX_HOLD_S still takes HOLD TOKEN <token> ${HOLD_S}`);
}

// ── The session: what the panel does with each server line ──────────────────
// A vector is a script of steps run after `ircStart('bmbfan', '#candr')`:
// `{ line }` a server line, `{ nick }`, `{ rejoin: true }`, `{ send }`. The
// result is every `out` line and event after the start, and the last phase.
//
// `naiveSession` is the obvious reducer and it is wrong where a listener would
// notice: it ignores PING (the server drops the connection after its timeout),
// compares channel names case-sensitively (ZeroNode echoes `#CandR` as typed by
// the sender, so the room goes silent), treats every KICK as the listener's own,
// shows private messages in the channel panel, sends `/join` raw, and stamps
// every line with the local clock instead of the server's `@time`.
const NOW = 1000;
function runSession(steps) {
  let { state } = ircStart('bmbfan', '#candr');
  const out = [];
  const events = [];
  for (const s of steps) {
    const r = 'line' in s ? ircStep(state, s.line, NOW)
      : 'nick' in s ? ircNick(state, s.nick)
      : 'rejoin' in s ? ircRejoin(state)
      : ircSend(state, s.send, NOW);
    state = r.state;
    out.push(...r.out);
    events.push(...r.events);
  }
  return { out, events, phase: state.phase };
}
function naiveSession(steps) {
  const state = { phase: 'registering', nick: 'bmbfan', channel: '#candr' };
  const out = [];
  const events = [];
  for (const s of steps) {
    if ('nick' in s) { out.push(`NICK ${s.nick}`); state.nick = s.nick; continue; }
    if ('rejoin' in s) { out.push(`JOIN ${state.channel}`); continue; }
    if ('send' in s) {
      if (s.send.startsWith('/')) out.push(s.send.slice(1));
      else { out.push(`PRIVMSG ${state.channel} :${s.send}`); events.push({ type: 'message', from: state.nick, text: s.send, action: false, self: true, time: NOW }); }
      continue;
    }
    const m = naiveParse(s.line);
    const text = m.params.slice(1).join(' ').replace(/^:/, '');
    if (m.command === '001') out.push(`JOIN ${state.channel}`);
    else if (m.command === '433') events.push({ type: 'nickInUse', nick: m.params[1] });
    else if (m.command === 'JOIN' && m.params[0] === state.channel) { state.phase = 'joined'; events.push({ type: 'joined', channel: state.channel, nick: m.nick }); }
    else if (m.command === 'PRIVMSG') events.push({ type: 'message', from: m.nick, text, action: false, self: false, time: NOW });
    else if (m.command === 'KICK') { state.phase = 'parted'; events.push({ type: 'kicked', by: m.nick, reason: m.params.slice(2).join(' ').replace(/^:/, '') }); }
    else if (m.command === 'ERROR') { state.phase = 'closed'; events.push({ type: 'error', text: m.params.join(' ').replace(/^:/, '') }); }
  }
  return { out, events, phase: state.phase };
}

const WELCOME = { line: ':sparrow.zeronode.net 001 bmbfan :Welcome to the ZeroNode IRC Network' };
const JOINED = { line: ':bmbfan!webchat@cloaked JOIN #candr' };
const joinedEvent = { type: 'joined', channel: '#candr', nick: 'bmbfan' };
const msg = (from, text, extra = {}) => ({ type: 'message', from, text, action: false, self: false, time: NOW, ...extra });

const sessionVectors = [
  {
    label: 'a PING is answered, or the server drops the listener',
    args: [[{ line: 'PING :sparrow.zeronode.net' }]],
    expect: { out: ['PONG :sparrow.zeronode.net'], events: [], phase: 'registering' },
  },
  {
    label: 'welcome joins the show channel; the echo of our JOIN says we are in',
    args: [[WELCOME, JOINED]],
    expect: { out: ['JOIN #candr'], events: [joinedEvent], phase: 'joined' }, alsoNaive: true,
  },
  {
    // ZeroNode answers with the channel's own case: LIST showed `#homegrownhits`
    // for the `#HomegrownHits` the list names (2026-11-21).
    label: 'the server\'s own channel case still counts, for our JOIN and for messages',
    args: [[WELCOME, { line: ':bmbfan!webchat@cloaked JOIN #CandR' }, { line: ':dude!u@h PRIVMSG #CandR :yo' }]],
    expect: { out: ['JOIN #candr'], events: [joinedEvent, msg('dude', 'yo')], phase: 'joined' },
  },
  {
    label: 'a private message is not shown in the channel panel',
    args: [[WELCOME, JOINED, { line: ':dude!u@h PRIVMSG bmbfan :psst' }]],
    expect: { out: ['JOIN #candr'], events: [joinedEvent], phase: 'joined' },
  },
  {
    label: 'a /me from someone else reads as an action, with formatting stripped',
    args: [[WELCOME, JOINED, { line: ':dude!u@h PRIVMSG #candr :\x01ACTION \x02waves\x02\x01' }]],
    expect: { out: ['JOIN #candr'], events: [joinedEvent, msg('dude', 'waves', { action: true })], phase: 'joined' },
  },
  {
    label: 'a nick in use is retried on the SAME connection',
    args: [[{ line: ':sparrow.zeronode.net 433 * bmbfan :Nickname is already in use' }, { nick: 'bmbfan2' },
      { line: ':sparrow.zeronode.net 001 bmbfan2 :Welcome' }]],
    expect: { out: ['NICK bmbfan2', 'JOIN #candr'], events: [{ type: 'nickInUse', nick: 'bmbfan' }], phase: 'registering' },
    alsoNaive: true,
  },
  {
    label: 'someone else\'s kick is not ours; our own kick parts us and REJOIN joins again',
    args: [[WELCOME, JOINED, { line: ':op!u@h KICK #candr dude :bye' }, { line: ':op!u@h KICK #candr bmbfan :spam' }, { rejoin: true }]],
    expect: { out: ['JOIN #candr', 'JOIN #candr'], events: [joinedEvent, { type: 'kicked', by: 'op', reason: 'spam' }], phase: 'parted' },
  },
  {
    label: 'a refused JOIN shows the server\'s own reason',
    args: [[WELCOME, { line: ':sparrow.zeronode.net 474 bmbfan #candr :Cannot join channel (+b)' }]],
    expect: { out: ['JOIN #candr'], events: [{ type: 'error', text: 'Cannot join channel (+b)' }], phase: 'registering' },
  },
  {
    // A quiet, a ban with no kick, or +m: the server refuses the line and the
    // listener's own row is the only copy. They must be told.
    label: 'a refused channel message (404) is shown, not dropped',
    args: [[WELCOME, JOINED, { line: ':sparrow.zeronode.net 404 bmbfan #candr :Cannot send to channel (+m)' }]],
    expect: { out: ['JOIN #candr'], events: [joinedEvent, { type: 'error', text: 'Cannot send to channel (+m)' }], phase: 'joined' },
  },
  {
    // NickServ renames a guest on a registered nick. The panel must not store
    // `Guest4821` as the listener's choice.
    label: 'a nick change the listener did not ask for is marked as such',
    args: [[WELCOME, JOINED, { line: ':bmbfan!webchat@cloaked NICK :Guest4821' }]],
    expect: { out: ['JOIN #candr'], events: [joinedEvent, { type: 'nickChanged', to: 'Guest4821', requested: false }], phase: 'joined' },
  },
  {
    label: 'a /nick the listener typed is marked as asked for',
    args: [[WELCOME, JOINED, { send: '/nick bmbfan_' }, { line: ':bmbfan!webchat@cloaked NICK :bmbfan_' }]],
    expect: { out: ['JOIN #candr', 'NICK bmbfan_'], events: [joinedEvent, { type: 'nickChanged', to: 'bmbfan_', requested: true }], phase: 'joined' },
  },
  {
    label: 'ERROR closes the session',
    args: [[WELCOME, { line: 'ERROR :Closing link: (bmbfan@1.2.3.4) [Ping timeout]' }]],
    expect: { out: ['JOIN #candr'], events: [{ type: 'error', text: 'Closing link: (bmbfan@1.2.3.4) [Ping timeout]' }], phase: 'closed' },
    alsoNaive: true,
  },
  {
    label: 'a line stamped with @time keeps the server\'s time',
    args: [[WELCOME, JOINED, { line: '@time=2026-11-21T20:00:00.000Z :dude!u@h PRIVMSG #candr :t' }]],
    expect: { out: ['JOIN #candr'], events: [joinedEvent, msg('dude', 't', { time: 1795291200 })], phase: 'joined' },
  },
  {
    label: 'a multi-line paste leaves as ONE PRIVMSG',
    args: [[WELCOME, JOINED, { send: 'a\nb' }]],
    expect: { out: ['JOIN #candr', 'PRIVMSG #candr :a b'], events: [joinedEvent, msg('bmbfan', 'a b', { self: true })], phase: 'joined' },
  },
  {
    label: '/join is not sent; the panel says which commands work',
    args: [[WELCOME, JOINED, { send: '/join #evil' }]],
    expect: { out: ['JOIN #candr'], events: [joinedEvent, { type: 'error', text: 'Only /me and /nick work here.' }], phase: 'joined' },
  },
  {
    label: '/me and /nick are sent',
    args: [[WELCOME, JOINED, { send: '/me waves' }, { send: '/nick bmbfan_' }]],
    expect: {
      out: ['JOIN #candr', 'PRIVMSG #candr :\x01ACTION waves\x01', 'NICK bmbfan_'],
      events: [joinedEvent, msg('bmbfan', 'waves', { action: true, self: true })], phase: 'joined',
    },
  },
];

const callSession = (impl, v) => {
  try {
    return JSON.stringify(impl === 'real' ? runSession(...v.args) : naiveSession(...v.args));
  } catch (e) {
    return `threw ${(e && e.message) || e}`;
  }
};

console.log('\nThe session — the shipping answer:');
for (const v of sessionVectors) {
  const got = callSession('real', v);
  if (got !== JSON.stringify(v.expect)) fail(`"${v.label}"\n          expected ${JSON.stringify(v.expect)}\n          got      ${got}`);
  else ok(v.label);
}
console.log('\nThe session replay against naiveSession():');
replayVectors({ vectors: sessionVectors, invoke: callSession, fail });

console.log('\nThe session, smaller cases:');
{
  const nickChange = runSession([WELCOME, JOINED, { line: ':bmbfan!u@h NICK :bmbfan_' }, { send: 'hi' }]);
  if (JSON.stringify(nickChange.out.at(-1)) !== JSON.stringify('PRIVMSG #candr :hi')
    || !nickChange.events.some((e) => e.type === 'nickChanged' && e.to === 'bmbfan_')
    || nickChange.events.at(-1).from !== 'bmbfan_') fail(`our own NICK change is followed — got ${JSON.stringify(nickChange)}`);
  else ok('our own NICK change is followed, and later lines carry the new nick');
  const badNick = runSession([WELCOME, JOINED, { send: '/nick 9bad' }]);
  if (badNick.out.length !== 1 || badNick.events.at(-1).type !== 'error') fail(`an invalid /nick is refused — got ${JSON.stringify(badNick)}`);
  else ok('an invalid /nick is refused, nothing sent');
  const beforeJoin = runSession([{ send: 'too early' }]);
  if (beforeJoin.out.length !== 0) fail(`nothing is sent before the JOIN — got ${JSON.stringify(beforeJoin)}`);
  else ok('nothing is sent before the JOIN');
}

// ── The opt-in list (Chad, 2026-11-21) and the gateway switch ───────────────
// The 11 shows Chad chose, each channel seen in a ZeroNode LIST on 2026-11-21.
// A show off this list gets no chat, even when its feed names a channel.
// Lightning Thrashes (#SirLibre) left it on 2026-11-25, a 24/7 replay stream:
// Chad, "thats a 24/7 replay stream so dont show a chat there".
console.log('\nThe opt-in show list:');
{
  const LIST = {
    'ac746d09-7c3b-5bcd-b28a-f12d6456ca8f': '#HomegrownHits',
    '917393e3-1b1e-5cef-ace4-edaa54e1f810': '#Podcasting20',
    'e0ac9365-689c-5043-8804-15b9dfcc545a': '#greenroom',
    '31740861-81e8-5dda-8801-a2abb2634271': '#MMO',
    '7c6f7875-2b73-491e-b32c-e2c8d6e91d53': '#candr',
    'c1959795-28f1-502d-ad3e-70abf5a034a9': '#v4vmusicShow',
    '45b899bb-cbef-57b5-ab14-04aaf49e3ac3': '#VoidZero',
    'c42a0900-c20e-59a2-a13b-c23b5c04e11f': '#HyperSpaceOut',
    '2d418249-453a-5714-8abc-5b657570b641': '#BowlAfterBowl',
    '41aace28-8679-5ef1-9958-75cf76c2b5f0': '#DoerfelVerse',
    '89bf141a-f4cf-575c-b09a-75dbce16332c': '#OffTopic',
  };
  for (const [guid, channel] of Object.entries(LIST)) {
    if (ircChannelFor(guid) !== channel) fail(`${guid} → ${ircChannelFor(guid)}, expected ${channel}`);
    else ok(`${IRC_CHAT_SHOWS[guid]?.title ?? guid} → ${channel}`);
  }
  if (Object.keys(IRC_CHAT_SHOWS).length !== 11) fail(`the list has ${Object.keys(IRC_CHAT_SHOWS).length} shows, not 11`);
  else ok('the list has exactly the 11 shows');
  const cases = [
    ['an upper-case guid finds its show', ircChannelFor('7C6F7875-2B73-491E-B32C-E2C8D6E91D53'), '#candr'],
    ['Nick the Rat Radio (no live item) is not on the list', ircChannelFor('23cd2e78-6042-5834-9ca8-34feca4d02b9'), null],
    ['Lightning Thrashes (a 24/7 replay stream) is not on the list', ircChannelFor('d5e73072-64a2-56a3-9dcd-4a00bfe561d5'), null],
    ['no guid → no chat', ircChannelFor(undefined), null],
    ['an empty guid → no chat', ircChannelFor(''), null],
  ];
  for (const [label, got, want] of cases) {
    if (got !== want) fail(`${label} — got ${JSON.stringify(got)}`);
    else ok(label);
  }
  const bad = Object.values(IRC_CHAT_SHOWS).filter((s) => !/^#[^\s,\x07]{1,49}$/.test(s.channel));
  if (bad.length) fail(`channel names that are not valid: ${JSON.stringify(bad)}`);
  else ok('every channel name is a valid IRC channel');
}

console.log('\nThe gateway switch:');
{
  const urls = [
    ['wss://irc-ws.candr.space/webirc/websocket/', true],
    ['', false],
    [undefined, false],
    ['ws://irc-ws.candr.space/', false],
    ['ws://127.0.0.1:6790/', true],
    ['ws://localhost:6790/', true],
    ['https://irc-ws.candr.space/', false],
    ['wss://', false],
  ];
  for (const [url, want] of urls) {
    const got = ircGatewayOk(url);
    if (got !== want) fail(`ircGatewayOk(${JSON.stringify(url)}) is ${got}, expected ${want}`);
    else ok(`ircGatewayOk(${JSON.stringify(url)}) is ${want}`);
  }
}

console.log('\nImport-free leaves:');
for (const path of ['lib/irc/protocol.ts', 'lib/irc/shows.ts']) {
  const problems = importFreeProblems(path);
  if (problems.length) {
    explainImportFree(path, problems);
    failures++;
  } else ok(`${path} is import-free`);
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall ok');
