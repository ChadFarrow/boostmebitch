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

// A real BoostBox descriptor, the shape boostbox.clj returns. 44 chars.
const DESC = 'rss::payment::boost https://tardbox.com/b/aG9t';
const MSG = 'great episode, thanks for the show';

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
  for (let budget = 0; budget <= 120; budget++) {
    const out = buildLnurlComment({ desc: DESC, message: MSG }, budget);
    if (out != null && out.length > budget) { over = { budget, len: out.length }; break; }
  }
  check('output never exceeds commentAllowed, for any budget 0..120', over, null);

  // And whenever a descriptor IS emitted it is the complete one — the property
  // the whole function exists for, asserted independently of the cases above.
  let clipped = null;
  for (let budget = 0; budget <= 120; budget++) {
    const out = buildLnurlComment({ desc: DESC, message: MSG }, budget);
    if (out?.startsWith('rss::payment') && !out.startsWith(DESC)) { clipped = { budget, out }; break; }
  }
  check('a descriptor is never emitted truncated', clipped, null);
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
    buildLnurlComment({ desc: DESC, message: MSG }, 30) !== naive(DESC, MSG, 30),
    true,
  );
  check(
    '(naive) really did emit a clipped descriptor',
    naive(DESC, MSG, 30).startsWith(DESC),
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
