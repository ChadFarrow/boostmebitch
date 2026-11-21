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
  parseLine, stripFormatting, ctcpAction, cleanOutgoing, splitText, buildPrivmsg, buildAction, isValidNick,
} from '../lib/irc/protocol.ts';
import { replayVectors } from './replay-vectors.mjs';
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
    label: 'a plain message is one PRIVMSG',
    kind: 'build', args: ['#candr', 'hello'], expect: ['PRIVMSG #candr :hello'], alsoNaive: true,
  },
  {
    label: 'a message of only whitespace and line breaks sends nothing',
    kind: 'build', args: ['#candr', '  \r\n '], expect: [],
  },
  {
    label: `a ${bytes(LONG)}-byte message is cut on spaces into lines of at most 400 bytes`,
    kind: 'build', args: ['#candr', LONG],
    check: (lines) => lines.length === 3
      && lines.every((l) => l.startsWith('PRIVMSG #candr :') && bytes(textOf(l)) <= 400)
      && lines.map(textOf).join(' ') === LONG,
  },
  {
    label: `${bytes(EMOJI)} bytes of é🎸 are cut on character boundaries, never inside one`,
    kind: 'build', args: ['#candr', EMOJI],
    check: (lines) => lines.length >= 3
      && lines.every((l) => { const t = textOf(l); return bytes(t) <= 400 && Buffer.from(t).toString() === t; })
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
  if (!(longAction.length > 1 && longAction.every((l) => bytes(l.slice(l.indexOf(' :') + 2)) <= 400))) {
    fail(`buildAction cuts a long /me into lines of at most 400 bytes — got ${longAction.length} line(s)`);
  } else ok('buildAction cuts a long /me into lines of at most 400 bytes');
}

console.log('\nThe nick rule:');
{
  const nicks = [
    ['candr_fan', true], ['[Dude]', true], ['a-b', true],
    ['9lives', false], ['has space', false], ['', false], ['-dash', false], ['x'.repeat(31), false], ['x'.repeat(30), true],
  ];
  for (const [nick, want] of nicks) {
    const got = isValidNick(nick);
    if (got !== want) fail(`isValidNick(${JSON.stringify(nick)}) is ${got}, expected ${want}`);
    else ok(`isValidNick(${JSON.stringify(nick.length > 12 ? nick.slice(0, 6) + '…' : nick)}) is ${want}`);
  }
}

console.log('\nImport-free leaves:');
for (const path of ['lib/irc/protocol.ts']) {
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
