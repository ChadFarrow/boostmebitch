// `npm run check:sitestamp` — pins lib/site-stamp.ts: the note stamp that lets
// `/api/nostr/site-sign` sign ONLY a boost note whose 1-sat invoice was paid,
// and the client ladder that pays it and falls back to a one-time key.
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
// old path, so sign it" and "any stamp that decodes names its payment hash".
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
  STAMP_SATS, STAMP_MAX_FEE_SATS, STAMP_INVOICE_EXPIRY_SECS, STAMP_TTL_SECS,
  STAMP_PAY_TIMEOUT_MS, STAMP_RECHECK_DELAYS_MS, STAMP_NOT_PAID, STAMP_UNCONFIRMED, STAMP_FAILURE_TEXT,
  encodeStamp, readStamp, splitSignBody, stampGate, signSiteNote,
} = await import('../lib/site-stamp.ts');

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
eq('1 sat a stamp', STAMP_SATS, 1);
eq('Spark fee cap 10 sats (Chad, 2026-11-17)', STAMP_MAX_FEE_SATS, 10);
eq('invoice expiry 10 min', STAMP_INVOICE_EXPIRY_SECS, 600);
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
const PH = 'b'.repeat(64);
const claims = (over = {}) => ({ v: 1, id: ID, ph: PH, exp: NOW + 3600, ...over });
const VALID = encodeStamp(claims(), MAC);
const [VALID_PAYLOAD, VALID_SIG] = VALID.split('.');

eq('a token reads back to its claims', readStamp(VALID, MAC, NOW), { ok: true, claims: claims() });

const flip = (s) => s.slice(0, -1) + (s.at(-1) === 'A' ? 'B' : 'A');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const SWAPPED_PH = `${b64(claims({ ph: 'c'.repeat(64) }))}.${VALID_SIG}`;

// The obvious wrong gate. See the header.
function naiveGate(stamp /* , legacy, eventId, o */) {
  if (stamp == null) return { kind: 'sign' };
  try {
    const c = JSON.parse(Buffer.from(String(stamp).split('.')[0], 'base64url').toString());
    if (!c || typeof c.ph !== 'string') throw new Error('no ph');
    return { kind: 'check', paymentHash: c.ph };
  } catch {
    return { kind: 'refuse', status: 400, error: 'the note stamp is not valid' };
  }
}
const naiveSplit = (body) => ({ template: body, stamp: undefined, legacy: true });

const gate = (label, stamp, legacy, eventId, requireStamp, extra = {}) =>
  ({ label, kind: 'gate', args: [stamp, legacy, eventId, { requireStamp, mac: MAC, nowSecs: NOW }], ...extra });

const TEMPLATE = { kind: 1, created_at: NOW, tags: [['t', 'boostagram'], ['t', 'value4value']], content: '⚡ Boost ⚡ hi' };

const VECTORS = [
  gate('a valid stamp for this event is checked against LNbits', VALID, false, ID, true, { alsoNaive: true }),
  gate('a legacy template with the switch off is signed (phase 1)', undefined, true, ID, false, { alsoNaive: true }),
  gate('a legacy template with the switch on is refused', undefined, true, ID, true),
  gate('the new shape with no stamp is refused even with the switch off', undefined, false, ID, false),
  gate('one MAC character flipped', flip(VALID), false, ID, true),
  gate("a token minted with the other brand's key", encodeStamp(claims(), OTHER), false, ID, true),
  gate('a payment hash swapped under the old MAC', SWAPPED_PH, false, ID, true),
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
  'a payment hash swapped under the old MAC': { kind: 'refuse', status: 400, error: 'the note stamp is not valid' },
  'a token one second past its exp': { kind: 'refuse', status: 400, error: 'the note stamp has expired' },
  'a paid stamp moved onto a different note': { kind: 'refuse', status: 400, error: 'the note stamp is for a different note' },
  'a correctly MACed token whose id is not hex': { kind: 'refuse', status: 400, error: 'the note stamp is not valid' },
  'the payload alone, with no MAC': { kind: 'refuse', status: 400, error: 'the note stamp is not valid' },
  'a number for a stamp': { kind: 'refuse', status: 400, error: 'the note stamp is not valid' },
  'a valid stamp for this event is checked against LNbits': { kind: 'check', paymentHash: PH },
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
console.log('\n  the client ladder');

const SITE_EVENT = { id: 'site-event', pubkey: 'site', sig: 's' };
const res = (status, body) => ({ status, body });

/** Fake dependencies that record every call. `stamp`/`sign` answer by call number. */
function harness({ stamp = [res(200, { invoice: 'lnbc10n1x', stamp: 'tok' })], sign = [res(200, { event: SITE_EVENT })], pay = 'ok' } = {}) {
  const h = { calls: [], sleeps: [], paid: [], oneTime: [], stampAsks: 0, signAsks: 0, stamped: 0 };
  h.deps = {
    post: async (path, body) => {
      h.calls.push({ path, body });
      if (path === '/api/nostr/site-stamp') return stamp[Math.min(h.stampAsks++, stamp.length - 1)];
      if (path === '/api/nostr/site-sign') return sign[Math.min(h.signAsks++, sign.length - 1)];
      return res(404, null);
    },
    payStamp: (bolt11) => {
      h.paid.push(bolt11);
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
    onStamp: () => { h.stamped += 1; },
  };
  return h;
}
const fresh = () => ({ template: { ...TEMPLATE, tags: TEMPLATE.tags.map((t) => [...t]) } });
const paths = (h) => h.calls.map((c) => c.path.replace('/api/nostr/', ''));

{
  const h = harness();
  const s = fresh();
  await signSiteNote(s, h.deps);
  eq('happy: stamp, then sign', paths(h), ['site-stamp', 'site-sign']);
  eq('happy: the stamp request carries the template', h.calls[0].body, { template: s.template });
  eq('happy: the sign request carries template + stamp', h.calls[1].body, { template: s.template, stamp: 'tok' });
  eq('happy: paid once, the invoice the site gave', h.paid, ['lnbc10n1x']);
  eq('happy: onStamp told the screen once', h.stamped, 1);
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
eq('every failure has its text', Object.keys(STAMP_FAILURE_TEXT).sort(), ['no-invoice', 'not-configured', 'not-signed', 'unconfirmed', 'wallet']);
eq('no failure text claims the sat stayed', Object.values(STAMP_FAILURE_TEXT).some((t) => /refund|not charged|still have|nothing was (paid|sent)/i.test(t)), false);

if (failures) {
  console.error(`\n  ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n  check:sitestamp ok');
