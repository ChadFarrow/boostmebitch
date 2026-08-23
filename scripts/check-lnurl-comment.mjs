// Pins how the LUD-21 comment is fitted into a recipient's commentAllowed.
//
// Usage:
//   npm run check:lnurl
//
// Run it after ANY edit to buildLnurlComment in lib/util.ts.
//
// Why this earns a check script: on an LNURL leg the comment is the ONLY
// metadata channel — keysend carries the boostagram inline in TLV 7629169, and
// an LNURL leg has nothing but this string. Within it, BoostBox's
// `rss::payment::<action> <url>` descriptor is the machine-readable half:
// Fountain authored that spec and parses it, which is the whole reason
// @fountain.fm addresses are routed to LNURL in the first place (see
// LNURL_ONLY_DOMAINS in keysend-lookup.ts).
//
// The failure this exists to prevent is the obvious implementation, which this
// repo shipped: join `${desc} — ${message}` and let the far end slice to
// commentAllowed. That cuts from the RIGHT with the fragile part on the LEFT,
// so a tight budget shortens the URL into a dead link while still spending the
// whole allowance on it. The recipient gets no metadata AND no message, the
// payment succeeds, and nothing on either side reports a problem. Services
// allowing 255 or 500 hide it completely; a service allowing 32 does not.
//
// `--experimental-strip-types` lets this .mjs import the real .ts module. That
// is the point: a reimplemented copy stays green while the shipping rule
// drifts.
//
// The rule lives in lib/util.ts rather than beside its caller in
// lib/v4v/lnaddr.ts for two reasons, and the second is load-bearing for this
// script. It is a wire-format product rule — the same reason resolveSenderName
// and DEFAULT_SENDER_NAME sit there, "the one place a field becomes a wire
// value" — and lnaddr.ts is not importable by plain Node: its `./bolt11` is
// extensionless, which Node ESM will not resolve, and the repo does not set
// allowImportingTsExtensions. lib/util.ts has type-only imports, so it loads.
// Keep it that way.

import { buildLnurlComment } from '../lib/util.ts';

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) console.log(`       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// A REAL BoostBox descriptor, lifted verbatim from a live boost receipt —
// `/boost/<26-char ULID>`, 72 characters. Do not shorten it and do not invent
// one: the first version of this file used a made-up `https://tardbox.com/b/…`
// at 46 chars, which is 26 short, and every boundary case below is measured in
// characters against a recipient's commentAllowed. A fixture guessed at the
// wrong length makes the arithmetic look right while testing budgets no real
// payment ever sees — 46 fits inside a 64-char allowance and 72 does not, so
// the invented value hid the exact case the drop-the-descriptor rule exists
// for. Same rule as everywhere else in this repo: build the fixture from the
// wire.
const DESC = 'rss::payment::boost https://tardbox.com/boost/01M005ZZ2JE2J9BPVYVN2F3K0K';
// Streaming settlements carry the longer verb (boostbox.ts downgrades 'auto' →
// 'stream'), so the worst case is one character more. Pinned separately because
// the streaming path is the one that runs unattended.
const DESC_STREAM = 'rss::payment::stream https://tardbox.com/boost/01M005ZZ2JE2J9BPVYVN2F3K0K';
const MSG = 'great episode, thanks for the show';
// What BoostBox ACTUALLY returns, measured against the live service on
// 2026-08-23: the descriptor with the typed message already appended, separated
// by a plain space. Lifted from a real receipt — the wire read
// `…X90JV helipad test — helipad test`, and the plain space before the first
// copy against the ` — ` before the second is what proves which side added
// which. Do not "correct" this fixture to a bare descriptor: the bare form is
// DESC above, and this file needs both.
const PADDED = `${DESC} ${MSG}`;

console.log('buildLnurlComment — the descriptor survives whole or not at all');
{
  // The generous case every mainstream service actually presents.
  check(
    'both fit: descriptor first, message after',
    buildLnurlComment({ desc: DESC, message: MSG }, 255),
    `${DESC} — ${MSG}`,
  );

  // THE regression. Budget holds the descriptor and nothing more. The old
  // join-then-slice returned `${DESC} — grea`; the point is not that the prose
  // is short, it is that the descriptor must not be the thing that gets cut.
  check(
    'exactly enough for the descriptor: message dropped, URL intact',
    buildLnurlComment({ desc: DESC, message: MSG }, DESC.length),
    DESC,
  );

  // One char past the descriptor: not enough for ' — ' plus a character, so a
  // dangling separator is the only other option. Don't emit one.
  check(
    'no room for separator + prose: descriptor alone, no dangling dash',
    buildLnurlComment({ desc: DESC, message: MSG }, DESC.length + 2),
    DESC,
  );

  check(
    'room for exactly one character of prose',
    buildLnurlComment({ desc: DESC, message: MSG }, DESC.length + 4),
    `${DESC} — g`,
  );

  // Budget below the descriptor. Sending a clipped URL is strictly worse than
  // sending none: it 404s AND consumes the allowance the prose could have used.
  check(
    'descriptor does not fit: dropped entirely, message takes the budget',
    buildLnurlComment({ desc: DESC, message: MSG }, 20),
    MSG.slice(0, 20),
  );

  // The case the invented 46-char fixture could not express. A real descriptor
  // is 72 characters, so a 64-char allowance — a perfectly ordinary LNURL
  // setting — cannot hold it. This is the live scenario the whole rule exists
  // for, and with the old fixture it silently tested the opposite branch.
  check(
    'a real 72-char descriptor does not fit a 64-char allowance',
    buildLnurlComment({ desc: DESC, message: MSG }, 64),
    MSG.slice(0, 64),
  );
  check(
    'a real descriptor DOES fit the common 255-char allowance',
    buildLnurlComment({ desc: DESC, message: MSG }, 255),
    `${DESC} — ${MSG}`,
  );

  // Streaming settlements are one character longer and run unattended, so the
  // boundary is checked on the exact wire string that path emits.
  check(
    'a stream descriptor survives whole at its own exact length',
    buildLnurlComment({ desc: DESC_STREAM, message: MSG }, DESC_STREAM.length),
    DESC_STREAM,
  );
  check(
    'a stream descriptor one char short of fitting is dropped, not clipped',
    buildLnurlComment({ desc: DESC_STREAM, message: MSG }, DESC_STREAM.length - 1),
    MSG.slice(0, DESC_STREAM.length - 1),
  );
  check(
    'descriptor does not fit and there is no message: nothing rather than a broken URL',
    buildLnurlComment({ desc: DESC }, 20),
    undefined,
  );
}

console.log('\nbuildLnurlComment — the must-still-work half');
{
  // BoostBox failure is non-fatal by design; the plain message path is what
  // every non-BoostBox leg has always used and must not regress.
  check('no descriptor: message clipped as before', buildLnurlComment({ message: MSG }, 10), MSG.slice(0, 10));
  check('no descriptor, generous budget: message verbatim', buildLnurlComment({ message: MSG }, 255), MSG);
  check('descriptor alone when there is no message', buildLnurlComment({ desc: DESC }, 255), DESC);

  // commentAllowed absent or 0 means the service takes no comment. Sending one
  // anyway is a spec violation and some servers reject the whole callback.
  check('commentAllowed 0: no comment', buildLnurlComment({ desc: DESC, message: MSG }, 0), undefined);
  check('commentAllowed absent: no comment', buildLnurlComment({ desc: DESC, message: MSG }, undefined), undefined);

  // Empty and whitespace-only inputs must not become a stray separator or a
  // comment made of spaces.
  check('empty message is not a dangling separator', buildLnurlComment({ desc: DESC, message: '' }, 255), DESC);
  check('whitespace-only message is dropped', buildLnurlComment({ desc: DESC, message: '   ' }, 255), DESC);
  check('nothing at all', buildLnurlComment({}, 255), undefined);
  check('whitespace-only everything', buildLnurlComment({ desc: '  ', message: '  ' }, 255), undefined);
}

console.log('\nbuildLnurlComment — never exceeds the budget');
{
  // The one property a recipient's server enforces. Sweep every budget across
  // the interesting range rather than trusting the arithmetic above.
  let over = null;
  for (let budget = 0; budget <= 200; budget++) {
    const out = buildLnurlComment({ desc: DESC, message: MSG }, budget);
    if (out != null && out.length > budget) { over = { budget, len: out.length }; break; }
  }
  check('output never exceeds commentAllowed, for any budget 0..200', over, null);

  // And whenever a descriptor IS emitted it is the complete one — the property
  // the whole function exists for, asserted independently of the cases above.
  let clipped = null;
  for (let budget = 0; budget <= 200; budget++) {
    const out = buildLnurlComment({ desc: DESC, message: MSG }, budget);
    if (out?.startsWith('rss::payment') && !out.startsWith(DESC)) { clipped = { budget, out }; break; }
  }
  check('a descriptor is never emitted truncated', clipped, null);
}

console.log('\nthe descriptor is normalised — a padded desc must not duplicate the message');
{
  // The bug: BoostBox pads `desc` with the message, this appended it again, and
  // the recipient read the prose twice.
  check(
    'a padded descriptor emits the message exactly once',
    buildLnurlComment({ desc: PADDED, message: MSG }, 255),
    `${DESC} — ${MSG}`,
  );
  check(
    'and matches what a bare descriptor would have produced',
    buildLnurlComment({ desc: PADDED, message: MSG }, 255),
    buildLnurlComment({ desc: DESC, message: MSG }, 255),
  );

  // THE expensive half, and the reason this is a check and not a tidy-up. A
  // padded desc is longer than the descriptor, so it crosses the budget early,
  // hits the drop-it-entirely branch, and the leg goes out with NO
  // machine-readable metadata — precisely the failure this file exists for,
  // arriving from the far side.
  const LONG = 'x'.repeat(200);
  const withGuard = buildLnurlComment({ desc: `${DESC} ${LONG}`, message: LONG }, 255);
  check(
    'a long message no longer destroys the descriptor',
    withGuard.startsWith(DESC),
    true,
  );
  check('...and the descriptor is still whole', withGuard.includes(DESC), true);

  // Must-still-work: the bare form, the streaming verb, and anything we do not
  // recognise. An unknown descriptor format belongs to a writer newer than us
  // and rides through untouched — mangling it would be a dead URL, which is
  // strictly worse than the duplication being fixed here.
  check('a bare descriptor is unchanged', buildLnurlComment({ desc: DESC }, 255), DESC);
  check('the streaming verb normalises too',
    buildLnurlComment({ desc: `${DESC_STREAM} ${MSG}`, message: MSG }, 255),
    `${DESC_STREAM} — ${MSG}`);
  check('an unrecognised descriptor is carried verbatim',
    buildLnurlComment({ desc: 'something-else-entirely' }, 255), 'something-else-entirely');
  check('a descriptor with no URL is carried verbatim',
    buildLnurlComment({ desc: 'rss::payment::boost' }, 255), 'rss::payment::boost');

  // The tempting wrong implementation: strip by detecting the message. It works
  // on the vector above and breaks the moment the service truncates its copy,
  // emitting a clipped duplicate beside a whole one.
  const naiveStrip = (desc, message) =>
    message && desc.endsWith(message) ? desc.slice(0, -message.length).trimEnd() : desc;
  const TRUNCATED = `${DESC} ${MSG.slice(0, 10)}`;
  check(
    '(naive endsWith) disagrees when the service truncated its copy',
    naiveStrip(TRUNCATED, MSG) !== DESC,
    true,
  );
  check(
    '...while the shipping rule still recovers the descriptor',
    buildLnurlComment({ desc: TRUNCATED, message: MSG }, 255),
    `${DESC} — ${MSG}`,
  );
}

console.log('\n(naive) the join-then-slice this replaced');
{
  // No prior export to run these against — the function is new — so run them
  // against the implementation that shipped, which is the one that cut the URL.
  const naive = (desc, message, budget) => {
    const userMsg = message?.trim() || undefined;
    const comment = desc ? (userMsg ? `${desc} — ${userMsg}` : desc) : userMsg;
    if (!comment || (budget ?? 0) <= 0) return undefined;
    return comment.slice(0, budget);
  };
  // At a tight budget the old code emits a truncated URL; ours must not agree.
  check(
    '(naive) disagrees where it truncated the descriptor',
    buildLnurlComment({ desc: DESC, message: MSG }, 50) !== naive(DESC, MSG, 50),
    true,
  );
  check(
    '(naive) really did emit a clipped descriptor',
    naive(DESC, MSG, 50).startsWith(DESC),
    false,
  );
  // …and agrees on the generous budget, so the divergence is specific to the
  // bug rather than this being a wholly different function.
  check(
    '(naive) agrees when everything fits',
    buildLnurlComment({ desc: DESC, message: MSG }, 255) === naive(DESC, MSG, 255),
    true,
  );
}

if (failures) {
  console.error(`\n${failures} LNURL comment check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll LNURL comment checks passed.');
