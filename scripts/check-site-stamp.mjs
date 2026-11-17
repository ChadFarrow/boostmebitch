// `npm run check:sitestamp` — pins lib/site-stamp.ts: the note stamp that lets
// `/api/nostr/site-sign` sign ONLY a boost note whose stamp invoice was paid,
// its price (1% of the boost the note STATES), and the client ladder that pays
// it and falls back to a one-time key.
//
// WHAT BREAKS IF THIS GOES WRONG. The site key signs under the site's
// NIP-05-verified name. A gate that accepts a token it did not mint — a flipped
// MAC character, the other brand's key, a payload edited under an old MAC, an
// expired token, or a paid stamp moved onto a DIFFERENT note — puts any text on
// the wire under that name for free, which is the whole thing the stamp exists
// to stop. The opposite failure is just as real: a ladder that throws, waits
// forever, or pays twice loses a real boost's note or a second sat, and the
// note is the one part of a boost nothing else re-attempts.
//
// `naive()` is the obvious first version of the gate: "a missing stamp is the
// old path, so sign it" and "any stamp that decodes names its verify link".
// The Lightning address half has one too: trust whatever callback and verify
// link the address hands back, and read any `settled` that is not true as
// "unpaid". So does the price: round 1% to the nearest sat, and read the
// `amount` tag alone — never the sentence a person reads.
// Every refusal below must be one `naive()` gets wrong; the two inputs both
// must accept are exempted one at a time with `{ alsoNaive: true }`.
//
// The ladder half is plain assertions over recorded fake dependencies. It has
// no naive twin: what it pins is ORDER and COUNT — the stamp is asked for once,
// paid once, and never again on a retry.

import { createHmac } from 'node:crypto';
import { importFreeProblems, explainImportFree } from './import-free.mjs';
import { replayVectors } from './replay-vectors.mjs';

const LEAF = 'lib/site-stamp.ts';
const problems = importFreeProblems(LEAF);
if (problems.length) {
  explainImportFree(LEAF, problems);
  process.exit(1);
}

const {
  STAMP_MAX_FEE_SATS, STAMP_TTL_SECS, stampSats, stampDue,
  STAMP_PAY_TIMEOUT_MS, STAMP_RECHECK_DELAYS_MS, STAMP_NOT_PAID, STAMP_UNCONFIRMED, STAMP_FAILURE_TEXT,
  encodeStamp, readStamp, splitSignBody, stampGate, signSiteNote,
  stampAddress, readPayRequest, stampCallbackUrl, readCallbackAnswer, readVerifyAnswer,
} = await import('../lib/site-stamp.ts');
// The REAL sentence builders (pinned by check:vts), so a price vector reads
// exactly the sentence a note carries.
const { boostSentence, boostAllLines } = await import('../lib/util.ts');

let failures = 0;
const fail = (msg) => { failures += 1; console.error(`  FAIL  ${msg}`); };
const ok = (msg) => console.log(`  ok    ${msg}`);
const eq = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) ok(label); else fail(`${label}\n          got  ${g}\n          want ${w}`);
};

// ---------------------------------------------------------------------------
console.log('\n  the constants the spec fixes');
eq('Spark fee cap 10 sats (Chad, 2026-11-17)', STAMP_MAX_FEE_SATS, 10);
eq('token lifetime 24 h', STAMP_TTL_SECS, 86_400);
eq('wallet gets 30 s', STAMP_PAY_TIMEOUT_MS, 30_000);
// Four re-asks, ~17.5 s in all: Spark's payLightningInvoice answers when the
// send STARTS, and its service pays the invoice after (final review, 2026-11-17).
eq('four re-asks for a lagging settle', STAMP_RECHECK_DELAYS_MS, [1500, 3000, 5000, 8000]);

// ---------------------------------------------------------------------------
console.log('\n  the token and the sign gate');

const macWith = (key) => (data) => createHmac('sha256', key).update(data).digest('base64url');
const MAC = macWith('site-key-of-this-deploy');
const OTHER = macWith('site-key-of-the-other-brand');
const NOW = 1_790_000_000;
const ID = 'a'.repeat(64);
const VU = 'https://getalby.com/lnurlp/hello/verify/5Ae4FPNJjSYRjieUwgHDU1NN';
const claims = (over = {}) => ({ v: 1, id: ID, vu: VU, exp: NOW + 3600, ...over });
const VALID = encodeStamp(claims(), MAC);
const [VALID_PAYLOAD, VALID_SIG] = VALID.split('.');

eq('a token reads back to its claims', readStamp(VALID, MAC, NOW), { ok: true, claims: claims() });

const flip = (s) => s.slice(0, -1) + (s.at(-1) === 'A' ? 'B' : 'A');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const SWAPPED_VU = `${b64(claims({ vu: 'https://getalby.com/lnurlp/hello/verify/SOMEONE-ELSES' }))}.${VALID_SIG}`;

// The obvious wrong gate. See the header.
function naiveGate(stamp /* , legacy, eventId, o */) {
  if (stamp == null) return { kind: 'sign' };
  try {
    const c = JSON.parse(Buffer.from(String(stamp).split('.')[0], 'base64url').toString());
    if (!c || typeof c.vu !== 'string') throw new Error('no vu');
    return { kind: 'check', verifyUrl: c.vu };
  } catch {
    return { kind: 'refuse', status: 400, error: 'the note stamp is not valid' };
  }
}
const naiveSplit = (body) => ({ template: body, stamp: undefined, legacy: true });

const gate = (label, stamp, legacy, eventId, requireStamp, extra = {}) =>
  ({ label, kind: 'gate', args: [stamp, legacy, eventId, { requireStamp, mac: MAC, nowSecs: NOW }], ...extra });

const SHOW = { title: 'Homegrown Hits', author: 'Bowl After Bowl', medium: 'podcast', podcastGuid: 'f9d8a1b2-0000-4000-8000-000000000001' };
/** A note's content as formatContent lays it out (lib/nostr/boost-notes.ts), its sentence from the real builder. */
const noteContent = ({ message = '', sentence }) =>
  ['⚡ Boost ⚡', '', ...(message ? [message, ''] : []), sentence, '', 'https://homegrownhits.example/146'].join('\n');
const noteOf = (sats, { message = '', sentence, amount = String(sats * 1000) } = {}) => ({
  kind: 1,
  created_at: NOW,
  tags: [['amount', amount], ['t', 'boostagram'], ['t', 'value4value']],
  content: noteContent({ message, sentence: sentence ?? boostSentence({ sender: 'ChadF', sats, show: SHOW, via: 'BoostMeBitch' }) }),
});
const TEMPLATE = noteOf(100);

const VECTORS = [
  gate('a valid stamp for this event is checked at its verify link', VALID, false, ID, true, { alsoNaive: true }),
  gate('a legacy template with the switch off is signed (phase 1)', undefined, true, ID, false, { alsoNaive: true }),
  gate('a legacy template with the switch on is refused', undefined, true, ID, true),
  gate('the new shape with no stamp is refused even with the switch off', undefined, false, ID, false),
  gate('one MAC character flipped', flip(VALID), false, ID, true),
  gate("a token minted with the other brand's key", encodeStamp(claims(), OTHER), false, ID, true),
  gate('a verify link swapped under the old MAC', SWAPPED_VU, false, ID, true),
  gate('a correctly MACed token whose verify link is not http(s)', encodeStamp(claims({ vu: 'javascript:alert(1)' }), MAC), false, ID, true),
  gate('a token one second past its exp', encodeStamp(claims({ exp: NOW - 1 }), MAC), false, ID, true),
  gate('a paid stamp moved onto a different note', VALID, false, 'd'.repeat(64), true),
  gate('a correctly MACed token whose id is not hex', encodeStamp(claims({ id: 'not-hex' }), MAC), false, 'not-hex', true),
  gate('the payload alone, with no MAC', VALID_PAYLOAD, false, ID, true),
  gate('a number for a stamp', 42, false, ID, true, { alsoNaive: true }),
  { label: 'a {template, stamp} body is the new shape', kind: 'split', args: [{ template: TEMPLATE, stamp: VALID }] },
  { label: 'a bare template is the legacy shape', kind: 'split', args: [TEMPLATE], alsoNaive: true },
];

const WANT = {
  'a legacy template with the switch on is refused': { kind: 'refuse', status: 402, error: 'a note stamp is required' },
  'the new shape with no stamp is refused even with the switch off': { kind: 'refuse', status: 402, error: 'a note stamp is required' },
  'one MAC character flipped': { kind: 'refuse', status: 400, error: 'the note stamp is not valid' },
  "a token minted with the other brand's key": { kind: 'refuse', status: 400, error: 'the note stamp is not valid' },
  'a verify link swapped under the old MAC': { kind: 'refuse', status: 400, error: 'the note stamp is not valid' },
  'a correctly MACed token whose verify link is not http(s)': { kind: 'refuse', status: 400, error: 'the note stamp is not valid' },
  'a token one second past its exp': { kind: 'refuse', status: 400, error: 'the note stamp has expired' },
  'a paid stamp moved onto a different note': { kind: 'refuse', status: 400, error: 'the note stamp is for a different note' },
  'a correctly MACed token whose id is not hex': { kind: 'refuse', status: 400, error: 'the note stamp is not valid' },
  'the payload alone, with no MAC': { kind: 'refuse', status: 400, error: 'the note stamp is not valid' },
  'a number for a stamp': { kind: 'refuse', status: 400, error: 'the note stamp is not valid' },
  'a valid stamp for this event is checked at its verify link': { kind: 'check', verifyUrl: VU },
  'a legacy template with the switch off is signed (phase 1)': { kind: 'sign' },
};

function invoke(which, v) {
  try {
    if (v.kind === 'gate') return JSON.stringify(which === 'real' ? stampGate(...v.args) : naiveGate(...v.args));
    if (v.kind === 'split') return JSON.stringify(which === 'real' ? splitSignBody(...v.args) : naiveSplit(...v.args));
    return `unknown kind ${v.kind}`;
  } catch (e) {
    return `threw ${e?.message ?? e}`;
  }
}

for (const v of VECTORS) {
  if (v.kind === 'gate' && WANT[v.label]) eq(`real gate: ${v.label}`, JSON.parse(invoke('real', v)), WANT[v.label]);
}
eq('split: new shape', JSON.parse(invoke('real', VECTORS.at(-2))), { template: TEMPLATE, stamp: VALID, legacy: false });
eq('split: legacy shape', JSON.parse(invoke('real', VECTORS.at(-1))), { template: TEMPLATE, legacy: true });
const { proved } = replayVectors({ vectors: VECTORS, invoke, fail });
if (proved === 0) fail('the replay proved nothing');

// ---------------------------------------------------------------------------
console.log('\n  the Lightning address wire (LUD-16, LUD-06, LUD-21)');

// RECORDED FROM THE WIRE, 2026-11-17: hello@getalby.com's pay request, its
// callback for 1000 msat with the stamp comment, and that invoice's verify link
// (UNPAID — no payment was made). Every other wire vector below is one of these
// with one field changed. The paid shape is LUD-21's `settled: true`, not seen.
const ALBY = 'https://getalby.com';
const PAYREQ = {"status":"OK","tag":"payRequest","commentAllowed":255,"callback":"https://getalby.com/lnurlp/hello/callback","metadata":"[[\"text/identifier\",\"hello@getalby.com\"],[\"text/plain\",\"Sats for Alby\"]]","minSendable":1000,"maxSendable":10000000000,"payerData":{"name":{"mandatory":false},"email":{"mandatory":false},"pubkey":{"mandatory":false}},"nostrPubkey":"79f00d3f5a19ec806189fcab03c1be4ff81d18ee4f653c88fac41fe03570f432","allowsNostr":true};
const CALLBACK = {"status":"OK","successAction":{"tag":"message","message":"Thanks, sats received!"},"verify":"https://getalby.com/lnurlp/hello/verify/gQVMzVFKcxsTe5FmxNf4nRc8","routes":[],"pr":"lnbc10n1p40cnhrdpggfhk7um5ypxk2gzzd96xx6pqdehhgefqwd6xzmtsnp4qdkt5m0tdusqvzv7ufx9nypz0aq3nt5ktpv3645cq9y6azkv3hw86pp5j6mvq9yegu2jtf03633erqc04z7h2lckw6vlufk7mqjg73g42gvssp5qh3ck2jd8jkmp8r520j8s5vc92wwsu7nevyga5xtjr0qajny798q9qyysgqcqzp2xqyz5vqrzjqwryaup9lh50kkranzgcdnn2fgvx390wgj5jd07rwr3vxeje0glc7qjcz5th34aysyqqqqlgqqqqqeqqjqrzjq26922n6s5n5undqrf78rjjhgpcczafws45tx8237y7pzx3fg8ww8apyqqqqqqqqv5qqqqqqqqqqqqqq2qrzjqw9fu4j39mycmg440ztkraa03u5qhtuc5zfgydsv6ml38qd4azymlapyqqqqqqqd0qqqqqlgqqqq86qqjq3wwkrskwnadpzks9tzat46ayd556j50f5c92h8mq9f36vj9f8vqs5ztlxn768fuwjd5aas5d8rtp0mmzf3muypffgvn9z0ef5eg04vcpqdgq2l"};
const VERIFY_UNPAID = {"status":"OK","settled":false,"preimage":null,"pr":"lnbc10n1p40cnhrdpggfhk7um5ypxk2gzzd96xx6pqdehhgefqwd6xzmtsnp4qdkt5m0tdusqvzv7ufx9nypz0aq3nt5ktpv3645cq9y6azkv3hw86pp5j6mvq9yegu2jtf03633erqc04z7h2lckw6vlufk7mqjg73g42gvssp5qh3ck2jd8jkmp8r520j8s5vc92wwsu7nevyga5xtjr0qajny798q9qyysgqcqzp2xqyz5vqrzjqwryaup9lh50kkranzgcdnn2fgvx390wgj5jd07rwr3vxeje0glc7qjcz5th34aysyqqqqlgqqqqqeqqjqrzjq26922n6s5n5undqrf78rjjhgpcczafws45tx8237y7pzx3fg8ww8apyqqqqqqqqv5qqqqqqqqqqqqqq2qrzjqw9fu4j39mycmg440ztkraa03u5qhtuc5zfgydsv6ml38qd4azymlapyqqqqqqqd0qqqqqlgqqqq86qqjq3wwkrskwnadpzks9tzat46ayd556j50f5c92h8mq9f36vj9f8vqs5ztlxn768fuwjd5aas5d8rtp0mmzf3muypffgvn9z0ef5eg04vcpqdgq2l"};
const VERIFY_PAID = { ...VERIFY_UNPAID, settled: true, preimage: 'e'.repeat(64) };

const naiveAddress = (raw) => {
  const [name, domain] = String(raw).split('@');
  return { origin: `https://${domain}`, wellKnown: `https://${domain}/.well-known/lnurlp/${name}` };
};
const naivePayRequest = (json) => ({ ok: true, callback: json?.callback, commentAllowed: json?.commentAllowed ?? 0 });
const naiveCallbackUrl = (cb, msat, comment) => `${cb}?${new URLSearchParams({ amount: String(msat), comment })}`;
const naiveCallback = (json) => ({ ok: true, pr: json?.pr, verify: json?.verify });
const naiveVerify = (json) => (json?.settled ? 'settled' : 'unsettled');

const W = (label, kind, args, extra = {}) => ({ label, kind, args, ...extra });
const WIRE = [
  W('a public address', 'address', ['hello@getalby.com'], { alsoNaive: true }),
  W('a loopback address is plain http (the e2e fake)', 'address', ['stamp@127.0.0.1:3418']),
  W('no @ at all', 'address', ['getalby.com']),
  W('two @', 'address', ['a@b@getalby.com']),
  W('a path after the domain', 'address', ['hello@getalby.com/evil']),
  W("Alby's pay request", 'payRequest', [PAYREQ, ALBY, 1000], { alsoNaive: true }),
  W('a callback on another domain', 'payRequest', [{ ...PAYREQ, callback: 'https://evil.example/cb' }, ALBY, 1000]),
  W('a minimum above 1 sat', 'payRequest', [{ ...PAYREQ, minSendable: 10_000 }, ALBY, 1000]),
  W('not a pay request', 'payRequest', [{ ...PAYREQ, tag: 'withdrawRequest' }, ALBY, 1000]),
  W('an ERROR for the address', 'payRequest', [{ status: 'ERROR', reason: 'user not found' }, ALBY, 1000]),
  W('the callback URL with the comment', 'callbackUrl', [PAYREQ.callback, 1000, 'Boost Me Bitch note stamp', 255], { alsoNaive: true }),
  W('no comment where the address allows fewer characters', 'callbackUrl', [PAYREQ.callback, 1000, 'Boost Me Bitch note stamp', 10]),
  W('a callback that already carries a query', 'callbackUrl', ['https://getalby.com/cb?k=1', 1000, 'x', 0]),
  W("Alby's callback answer", 'callback', [CALLBACK, ALBY], { alsoNaive: true }),
  W('no verify link (no LUD-21)', 'callback', [{ ...CALLBACK, verify: undefined }, ALBY]),
  W('a verify link on another domain', 'callback', [{ ...CALLBACK, verify: 'https://evil.example/v' }, ALBY]),
  W('an ERROR from the callback', 'callback', [{ status: 'ERROR', reason: 'node offline' }, ALBY]),
  W('an empty invoice', 'callback', [{ ...CALLBACK, pr: '' }, ALBY]),
  W("Alby's unpaid verify answer", 'verify', [VERIFY_UNPAID], { alsoNaive: true }),
  W('a settled verify answer', 'verify', [VERIFY_PAID], { alsoNaive: true }),
  W('an ERROR from the verify link', 'verify', [{ status: 'ERROR', reason: 'Not found' }]),
  W('settled as a string', 'verify', [{ ...VERIFY_UNPAID, settled: 'true' }]),
  W('no settled field', 'verify', [{ status: 'OK' }]),
];

function invokeWire(which, v) {
  const real = which === 'real';
  try {
    if (v.kind === 'address') return JSON.stringify(real ? stampAddress(...v.args) : naiveAddress(...v.args));
    if (v.kind === 'payRequest') return JSON.stringify(real ? readPayRequest(...v.args) : naivePayRequest(...v.args));
    if (v.kind === 'callbackUrl') return JSON.stringify(real ? stampCallbackUrl(...v.args) : naiveCallbackUrl(...v.args));
    if (v.kind === 'callback') return JSON.stringify(real ? readCallbackAnswer(...v.args) : naiveCallback(...v.args));
    if (v.kind === 'verify') return JSON.stringify(real ? readVerifyAnswer(...v.args) : naiveVerify(...v.args));
    return `unknown kind ${v.kind}`;
  } catch (e) {
    return `threw ${e?.message ?? e}`;
  }
}
const wire = (label) => JSON.parse(invokeWire('real', WIRE.find((v) => v.label === label)));

eq('a public address reads at https', wire('a public address'), { origin: ALBY, wellKnown: `${ALBY}/.well-known/lnurlp/hello` });
eq('a loopback address reads at http', wire('a loopback address is plain http (the e2e fake)'),
  { origin: 'http://127.0.0.1:3418', wellKnown: 'http://127.0.0.1:3418/.well-known/lnurlp/stamp' });
eq('malformed addresses read as nothing', ['no @ at all', 'two @', 'a path after the domain'].map(wire), [null, null, null]);
eq("Alby's pay request: its callback and its comment limit", wire("Alby's pay request"),
  { ok: true, callback: `${ALBY}/lnurlp/hello/callback`, commentAllowed: 255 });
eq('every bad pay request is refused',
  ['a callback on another domain', 'a minimum above 1 sat', 'not a pay request', 'an ERROR for the address'].map((l) => wire(l).ok),
  [false, false, false, false]);
eq('the callback URL', wire('the callback URL with the comment'), `${ALBY}/lnurlp/hello/callback?amount=1000&comment=Boost+Me+Bitch+note+stamp`);
eq('...without a comment it may not carry', wire('no comment where the address allows fewer characters'), `${ALBY}/lnurlp/hello/callback?amount=1000`);
eq('...keeping a query the callback has', wire('a callback that already carries a query'), `${ALBY}/cb?k=1&amount=1000`);
eq("Alby's callback answer: the invoice and its verify link", wire("Alby's callback answer"), { ok: true, pr: CALLBACK.pr, verify: CALLBACK.verify });
eq('every bad callback answer is refused',
  ['no verify link (no LUD-21)', 'a verify link on another domain', 'an ERROR from the callback', 'an empty invoice'].map((l) => wire(l).ok),
  [false, false, false, false]);
eq('verify: unpaid, paid', [wire("Alby's unpaid verify answer"), wire('a settled verify answer')], ['unsettled', 'settled']);
eq('verify: an error or an odd shape is "unknown", never "unpaid"',
  ['an ERROR from the verify link', 'settled as a string', 'no settled field'].map(wire), ['unknown', 'unknown', 'unknown']);
{
  const { proved } = replayVectors({ vectors: WIRE, invoke: invokeWire, fail });
  if (proved === 0) fail('the wire replay proved nothing');
}

// ---------------------------------------------------------------------------
console.log('\n  the price: 1% of the boost the note states');

// Chad, 2026-11-17: "Let's do 1% instead with no maximum" — and he liked that a
// note claiming a LARGER boost then costs more to fake. So the price is read
// from the note, and the sentence a person reads must state the same number as
// the `amount` tag an app reads; otherwise a script pays 1% of a small tag under
// a large sentence. naive() is the obvious version: round to the nearest sat,
// read the tag, never the text.
const naiveSats = (msat) => Math.round(msat / 100_000);
const naiveDue = (t) => ({ ok: true, sats: naiveSats(Number(t.tags.find((x) => x[0] === 'amount')?.[1] ?? 0)) });

const allNote = boostAllLines({ sender: 'ChadF', sats: 300, count: 3, showTitle: 'Two For Tunestr', each: ' (100 each)', tracks: ['Sing For You', 'Copenhagen', 'Kurtis'], via: 'BoostMeBitch' });
const P = (label, kind, args, extra = {}) => ({ label, kind, args, ...extra });
const PRICE = [
  P('a 100-sat boost pays 1 sat', 'sats', [100_000], { alsoNaive: true }),
  P('a 1000-sat boost pays 10', 'sats', [1_000_000], { alsoNaive: true }),
  P('a 50,000-sat boost pays 500 — no maximum', 'sats', [50_000_000], { alsoNaive: true }),
  P('a 120-sat boost rounds UP to 2', 'sats', [120_000]),
  P('a 40-sat boost still pays the 1-sat minimum', 'sats', [40_000]),
  P('a boost note as the modal writes it', 'due', [noteOf(1000)], { alsoNaive: true }),
  P('...with a message that claims nothing', 'due', [noteOf(1000, { message: 'Great show!' })], { alsoNaive: true }),
  P('...with no sender ("Boosted 100 sats")', 'due', [noteOf(100, { sentence: boostSentence({ sats: 100, show: SHOW, via: 'BoostMeBitch' }) })], { alsoNaive: true }),
  P('...to a show whose title names sats', 'due', [noteOf(100, { sentence: boostSentence({ sender: 'ChadF', sats: 100, show: { ...SHOW, title: 'Stacking 5000000 sats' }, via: 'BoostMeBitch' }) })], { alsoNaive: true }),
  P('a BOOST ALL summary', 'due', [noteOf(300, { sentence: allNote.join('\n') })], { alsoNaive: true }),
  P('the sentence claims more than the tag', 'due', [noteOf(100, { sentence: boostSentence({ sender: 'ChadF', sats: 10_000, show: SHOW, via: 'BoostMeBitch' }) })]),
  P('the message claims a bigger boost above a true sentence', 'due', [noteOf(100, { message: 'Satoshi boosted 1000000 sats to the moon' })]),
  P('...written with separators', 'due', [noteOf(100, { message: 'boosted 1,000,000 sats' })]),
  P('...written in full-width digits', 'due', [noteOf(100, { message: 'boosted １０００００ sats' })]),
  P('no amount tag', 'due', [{ ...noteOf(100), tags: [['t', 'boostagram'], ['t', 'value4value']] }]),
  P('two amount tags', 'due', [{ ...noteOf(100), tags: [['amount', '100000'], ['amount', '100000000'], ['t', 'boostagram']] }]),
  P('an amount that is not whole sats', 'due', [noteOf(100, { amount: '100500' })]),
  P('an amount that is not a plain number', 'due', [noteOf(100, { amount: '1e8' })]),
  P('no sentence at all', 'due', [{ ...noteOf(100), content: '⚡ Boost ⚡\n\nbuy my thing' }]),
];

function invokePrice(which, v) {
  const real = which === 'real';
  try {
    if (v.kind === 'sats') return JSON.stringify(real ? stampSats(...v.args) : naiveSats(...v.args));
    if (v.kind === 'due') return JSON.stringify(real ? stampDue(...v.args) : naiveDue(...v.args));
    return `unknown kind ${v.kind}`;
  } catch (e) {
    return `threw ${e?.message ?? e}`;
  }
}
const price = (label) => JSON.parse(invokePrice('real', PRICE.find((v) => v.label === label)));

eq('1% of the boost, rounded up, at least 1, no maximum',
  ['a 100-sat boost pays 1 sat', 'a 1000-sat boost pays 10', 'a 50,000-sat boost pays 500 — no maximum', 'a 120-sat boost rounds UP to 2', 'a 40-sat boost still pays the 1-sat minimum'].map(price),
  [1, 10, 500, 2, 1]);
eq('real notes are priced at 1% of their stated boost',
  ['a boost note as the modal writes it', '...with a message that claims nothing', '...with no sender ("Boosted 100 sats")', '...to a show whose title names sats', 'a BOOST ALL summary'].map(price),
  [{ ok: true, sats: 10 }, { ok: true, sats: 10 }, { ok: true, sats: 1 }, { ok: true, sats: 1 }, { ok: true, sats: 3 }]);
eq('a claim the tag does not back is refused',
  ['the sentence claims more than the tag', 'the message claims a bigger boost above a true sentence', '...written with separators', '...written in full-width digits'].map((l) => price(l).why),
  Array(4).fill('the note claims a different amount than its amount tag'));
eq('a note with no readable amount is refused',
  ['no amount tag', 'two amount tags', 'an amount that is not whole sats', 'an amount that is not a plain number', 'no sentence at all'].map((l) => price(l).why),
  ['a site note needs exactly one amount tag', 'a site note needs exactly one amount tag',
    'the amount tag is not a whole number of sats', 'the amount tag is not a whole number of sats',
    'the note does not say how many sats it boosted']);
{
  const { proved } = replayVectors({ vectors: PRICE, invoke: invokePrice, fail });
  if (proved === 0) fail('the price replay proved nothing');
}
{
  // The site-stamp route has no login, so the claim scan must stay LINEAR: a
  // pattern whose digit group and trailing \s* can share the same spaces takes
  // the square of a run of whitespace. The route caps a body at 5,500
  // characters; 50,000 makes the growth plain (the quadratic one took 1.2 s).
  for (const [label, run] of [['spaces', ' '], ['newlines', '\n']]) {
    const t = { content: `⚡ Boost ⚡\n\nboosted 1${run.repeat(50_000)}`, tags: [['amount', '100000']] };
    const started = performance.now();
    const r = stampDue(t);
    const ms = Math.round(performance.now() - started);
    eq(`a 50,000-character run of ${label} after "boosted 1" is read in under 100 ms (${ms} ms)`, [r.ok, ms < 100], [false, true]);
  }
}

// ---------------------------------------------------------------------------
console.log('\n  the client ladder');

const SITE_EVENT = { id: 'site-event', pubkey: 'site', sig: 's' };
const res = (status, body) => ({ status, body });

/** Fake dependencies that record every call. `stamp`/`sign` answer by call number. */
function harness({ stamp = [res(200, { invoice: 'lnbc10n1x', stamp: 'tok' })], sign = [res(200, { event: SITE_EVENT })], pay = 'ok' } = {}) {
  const h = { calls: [], sleeps: [], paid: [], oneTime: [], stampAsks: 0, signAsks: 0, stamped: 0, stampedSats: [] };
  h.deps = {
    post: async (path, body) => {
      h.calls.push({ path, body });
      if (path === '/api/nostr/site-stamp') return stamp[Math.min(h.stampAsks++, stamp.length - 1)];
      if (path === '/api/nostr/site-sign') return sign[Math.min(h.signAsks++, sign.length - 1)];
      return res(404, null);
    },
    payStamp: (bolt11, sats) => {
      h.paid.push([bolt11, sats]);
      if (pay === 'throw') return Promise.reject(new Error('user rejected'));
      if (pay === 'hang') return new Promise(() => {});
      return Promise.resolve();
    },
    signOneTime: (t) => { h.oneTime.push(t); return { ...t, id: 'one-time-event', pubkey: 'one-time' }; },
    // The pay timeout fires only when the wallet hangs; every other sleep is instant.
    sleep: (ms) => {
      h.sleeps.push(ms);
      if (ms === STAMP_PAY_TIMEOUT_MS) return pay === 'hang' ? Promise.resolve() : new Promise(() => {});
      return Promise.resolve();
    },
    onStamp: (sats) => { h.stamped += 1; h.stampedSats.push(sats); },
  };
  return h;
}
const fresh = (t = TEMPLATE) => ({ template: { ...t, tags: t.tags.map((x) => [...x]) } });
const paths = (h) => h.calls.map((c) => c.path.replace('/api/nostr/', ''));

{
  const h = harness();
  const s = fresh();
  await signSiteNote(s, h.deps);
  eq('happy: stamp, then sign', paths(h), ['site-stamp', 'site-sign']);
  eq('happy: the stamp request carries the template', h.calls[0].body, { template: s.template });
  eq('happy: the sign request carries template + stamp', h.calls[1].body, { template: s.template, stamp: 'tok' });
  eq('happy: paid once, the invoice the site gave, for 1% of a 100-sat boost', h.paid, [['lnbc10n1x', 1]]);
  eq('happy: onStamp told the screen once, with the price', [h.stamped, h.stampedSats], [1, [1]]);
  eq('happy: signed by the site', [s.signer, s.signed, s.why], ['site', SITE_EVENT, undefined]);
  eq('happy: no one-time key', h.oneTime.length, 0);

  const before = h.calls.length;
  await signSiteNote(s, h.deps);
  eq('RETRY NOTE on a signed state asks nothing and pays nothing', [h.calls.length - before, h.paid.length], [0, 1]);
}
{
  const notPaid = res(402, { error: STAMP_NOT_PAID });
  const h = harness({ sign: [notPaid, notPaid, res(200, { event: SITE_EVENT })] });
  const s = fresh();
  await signSiteNote(s, h.deps);
  eq('lagging settle: signed on the third ask', [s.signer, h.signAsks], ['site', 3]);
  eq('lagging settle: waited 1.5 s then 3 s', h.sleeps.filter((ms) => ms !== STAMP_PAY_TIMEOUT_MS), [1500, 3000]);
  eq('lagging settle: still paid once', h.paid.length, 1);
}
{
  // A Spark send settles after its call returns: the fifth ask, ~17.5 s on.
  const notPaid = res(402, { error: STAMP_NOT_PAID });
  const h = harness({ sign: [notPaid, notPaid, notPaid, notPaid, res(200, { event: SITE_EVENT })] });
  const s = fresh();
  await signSiteNote(s, h.deps);
  eq('a slow (Spark) settle: signed by the site on the fifth ask', [s.signer, h.signAsks, h.paid.length], ['site', 5, 1]);
  eq('lagging settle: still paid once', h.paid.length, 1);
}
{
  const notPaid = res(402, { error: STAMP_NOT_PAID });
  const h = harness({ sign: [notPaid] });
  const s = fresh();
  await signSiteNote(s, h.deps);
  eq('never settles: one-time key, "unconfirmed"', [s.signer, s.why, h.signAsks, h.paid.length], ['one-time', 'unconfirmed', 5, 1]);
}
{
  // The route could not ASK LNbits (it failed or hung): the sat may well have
  // landed, so the screen says "could not confirm", never "did not sign". Not
  // re-asked — each ask of a hung LNbits costs the route's whole timeout.
  const h = harness({ sign: [res(502, { error: STAMP_UNCONFIRMED })] });
  const s = fresh();
  await signSiteNote(s, h.deps);
  eq('502 "could not confirm" on sign: one-time "unconfirmed", asked once', [s.signer, s.why, h.signAsks, h.paid.length], ['one-time', 'unconfirmed', 1, 1]);
}
{
  const h = harness({ stamp: [res(503, { error: 'note stamps are not configured' })] });
  const s = fresh();
  await signSiteNote(s, h.deps);
  eq('503 on stamp: one-time, "not-configured", wallet never asked', [s.signer, s.why, h.paid.length, h.signAsks], ['one-time', 'not-configured', 0, 0]);
}
for (const [label, answer] of [
  ['400', res(400, { error: 'content too long' })],
  ['502', res(502, { error: 'could not create the stamp invoice' })],
  ['network error (status 0)', res(0, null)],
  ['200 without an invoice', res(200, { stamp: 'tok' })],
]) {
  const h = harness({ stamp: [answer] });
  const s = fresh();
  await signSiteNote(s, h.deps);
  eq(`${label} on stamp: one-time, "no-invoice", wallet never asked`, [s.signer, s.why, h.paid.length], ['one-time', 'no-invoice', 0]);
}
{
  const h = harness({ pay: 'throw' });
  const s = fresh();
  await signSiteNote(s, h.deps);
  eq('wallet refuses: one-time, "wallet", site-sign never asked', [s.signer, s.why, h.signAsks], ['one-time', 'wallet', 0]);
}
{
  const h = harness({ pay: 'hang' });
  const s = fresh();
  await signSiteNote(s, h.deps);
  eq('wallet never answers: one-time "wallet" once the 30 s timer wins', [s.signer, s.why, h.sleeps.includes(STAMP_PAY_TIMEOUT_MS)], ['one-time', 'wallet', true]);
}
for (const [label, answer] of [
  ['400', res(400, { error: 'the note stamp is for a different note' })],
  ['500', res(500, { error: 'site-sign failed' })],
  ['network error (status 0)', res(0, null)],
  ['200 without an event', res(200, {})],
]) {
  const h = harness({ sign: [answer] });
  const s = fresh();
  await signSiteNote(s, h.deps);
  eq(`${label} on sign after a paid stamp: one-time "not-signed", no second payment`, [s.signer, s.why, h.paid.length, h.signAsks], ['one-time', 'not-signed', 1, 1]);
}
{
  const h = harness({ pay: 'throw' });
  const s = fresh();
  const snapshot = JSON.stringify(s.template);
  await signSiteNote(s, h.deps);
  eq('the one-time key signs the SAME template object', h.oneTime[0] === s.template, true);
  eq('...unchanged in content, tags and created_at', JSON.stringify(h.oneTime[0]), snapshot);
  const before = h.calls.length;
  await signSiteNote(s, h.deps);
  eq('RETRY NOTE after a one-time fallback asks nothing and pays nothing', [h.calls.length - before, h.paid.length, h.oneTime.length], [0, 1, 1]);
}
{
  // A dependency that breaks its "never throws" contract must not escape.
  const h = harness();
  h.deps.post = async () => { throw new Error('fetch exploded'); };
  const s = fresh();
  let threw = null;
  try { await signSiteNote(s, h.deps); } catch (e) { threw = e; }
  eq('a throwing post is read as status 0, never thrown', [threw, s.signer, s.why], [null, 'one-time', 'no-invoice']);
}
{
  const h = harness({ stamp: [res(200, { invoice: 'lnbc100n1x', stamp: 'tok' })] });
  const s = fresh(noteOf(1000));
  await signSiteNote(s, h.deps);
  eq('a 1000-sat boost: the wallet is asked for 10 sats', [h.paid, h.stampedSats, s.signer], [[['lnbc100n1x', 10]], [10], 'site']);
}
{
  // The page checks the claim before it asks: a note whose text names another
  // amount would be refused by the route anyway, so nothing is asked, minted
  // or paid, and the screen says why.
  const h = harness();
  const s = fresh(noteOf(100, { message: 'I boosted 5000 sats last week too' }));
  await signSiteNote(s, h.deps);
  eq('a note whose text claims another amount: one-time "amount", nothing asked or paid',
    [s.signer, s.why, h.calls.length, h.paid.length], ['one-time', 'amount', 0, 0]);
}
eq('every failure has its text', Object.keys(STAMP_FAILURE_TEXT).sort(), ['amount', 'no-invoice', 'not-configured', 'not-signed', 'unconfirmed', 'wallet']);
eq('no failure text names a fixed price', Object.values(STAMP_FAILURE_TEXT).some((t) => /1-sat|1 sat/.test(t)), false);
eq('no failure text claims the sat stayed', Object.values(STAMP_FAILURE_TEXT).some((t) => /refund|not charged|still have|nothing was (paid|sent)/i.test(t)), false);

if (failures) {
  console.error(`\n  ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n  check:sitestamp ok');
