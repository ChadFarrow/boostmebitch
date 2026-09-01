// Pins `probeThenBatch` and `PI_FANOUT` (lib/util.ts) — the bounded fan-out
// every server-side Podcast Index batch goes through.
//
// THE FAILURE THIS WAS WRITTEN AGAINST. It ended with a bare
// `Promise.allSettled(rest.map(resolve))`. One request carries up to
// `MAX_BATCH` (100) refs, so that fired up to 99 concurrent PI calls out of a
// single handler — three times over for a 231-track favorites list, since the
// client chunks at 100. PI rate-limits a burst like that.
//
// What made it permanent rather than merely slow is the rest of the chain,
// every link of which is individually right. A rejection leaves the key ABSENT,
// because "could not ask" is not an absence, so the client falls through to its
// per-item pass — which bursts again, 231 requests this time. A COULD_NOT_ASK
// (429/408) returns an UNCACHED null, deliberately, so a later load can retry.
// The next load therefore repeated the identical doomed sequence. Only a cached
// SUCCESS survived, in `storage.episodeMeta`. Measured on a real account: 4 of
// 228 tracks resolved, and the same 4 every session. The count could not move.
//
// WHY THE FUNCTION LIVES IN lib/util.ts. It was in `lib/pi-batch.ts`, which
// imports `lib/pi.ts` and therefore `process.env` — so it cannot load under
// plain Node, and a check could only ever have READ ITS SOURCE. A grep proves
// the current text and nothing about behaviour. Moving it here is what lets
// this script drive the shipping function and count what is actually in
// flight. `PI_FANOUT` is a constant rather than a parameter for the same
// reason: a caller that can pass a ceiling can pass `Infinity`, and then the
// pin below is on a number nobody uses.
//
// naive() is the SHIPPED version, verbatim — the unbounded allSettled. Every
// vector is replayed against it, and a vector both agree on is reported as
// proving nothing.
import { probeThenBatch, PI_FANOUT } from '../lib/util.ts';

let failures = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failures++; };
const ok = (msg) => console.log('  ok    ' + msg);

// ── The wrong version: unbounded ───────────────────────────────────────────
async function naive(items, resolve, key, out) {
  if (!items.length) return;
  const [first, ...rest] = items;
  try { out[key(first)] = await resolve(first); } catch { return; }
  const settled = await Promise.allSettled(rest.map(resolve));
  settled.forEach((r, i) => { if (r.status === 'fulfilled') out[key(rest[i])] = r.value; });
}

/**
 * One run, instrumented. Returns what the caller can assert on: the peak
 * concurrency observed, the output map, and the order calls started in.
 */
async function run(impl, { count, failAt = new Set(), throwProbe = false, delay = 1 }) {
  const items = Array.from({ length: count }, (_, i) => i);
  const out = {};
  let live = 0, peak = 0;
  const started = [];
  const resolve = async (i) => {
    if (i === 0 && throwProbe) throw new Error('PI unreachable');
    live += 1; peak = Math.max(peak, live); started.push(i);
    await new Promise((r) => setTimeout(r, delay));
    live -= 1;
    if (failAt.has(i)) throw new Error('rejected');
    return i === -1 ? null : `v${i}`;
  };
  await impl(items, resolve, (i) => `k${i}`, out);
  return { peak, out, started };
}

const vectors = [
  {
    label: 'a 231-item batch never exceeds PI_FANOUT in flight',
    input: { count: 231 },
    assert: (r) => r.peak <= PI_FANOUT,
    describe: (r) => `peak ${r.peak}, ceiling ${PI_FANOUT}`,
  },
  {
    label: 'the probe runs ALONE before the rest',
    input: { count: 20 },
    // The probe must have finished before anything else started, or a PI
    // outage costs a burst before it is noticed.
    assert: (r) => r.started[0] === 0 && r.started.slice(1, 1 + PI_FANOUT).every((i) => i !== 0),
    describe: (r) => `first started ${r.started[0]}`,
    alsoNaive: true,
  },
  {
    label: 'a probe that THROWS bails without asking for the rest',
    input: { count: 50, throwProbe: true },
    assert: (r) => r.started.length === 0 && Object.keys(r.out).length === 0,
    describe: (r) => `${r.started.length} started, ${Object.keys(r.out).length} keys`,
    alsoNaive: true,
  },
  {
    label: 'a rejection leaves its key ABSENT, never null',
    input: { count: 10, failAt: new Set([3, 7]) },
    assert: (r) => !('k3' in r.out) && !('k7' in r.out) && r.out.k4 === 'v4',
    describe: (r) => `${Object.keys(r.out).length} of 10 keys present`,
    alsoNaive: true,
  },
  {
    label: 'every non-rejecting item still lands, at the ceiling',
    input: { count: 120, failAt: new Set([5]) },
    assert: (r) => Object.keys(r.out).length === 119 && r.peak <= PI_FANOUT,
    describe: (r) => `${Object.keys(r.out).length} keys, peak ${r.peak}`,
  },
  {
    label: 'an empty list asks nothing',
    input: { count: 0 },
    assert: (r) => r.started.length === 0 && Object.keys(r.out).length === 0,
    describe: () => 'no calls',
    alsoNaive: true,
  },
];

console.log('\n  probeThenBatch — the bounded fan-out\n');
for (const v of vectors) {
  const got = await run(probeThenBatch, v.input);
  if (!v.assert(got)) { fail(`${v.label} — ${v.describe(got)}`); continue; }
  if (v.alsoNaive) { ok(`${v.label} (must-still-work)`); continue; }
  const naiveGot = await run(naive, v.input);
  if (v.assert(naiveGot)) {
    fail(`"${v.label}" passes against naive() too — the vector proves nothing.\n`
      + '          Either it is a must-still-work input (mark it { alsoNaive: true })\n'
      + '          or it does not exercise the concurrency ceiling.');
    continue;
  }
  ok(`${v.label} — ${v.describe(got)}, and naive() gets it wrong `
    + `(${v.describe(naiveGot)})`);
}
console.log(`\n  ${vectors.length} vector(s) replayed, `
  + `${vectors.filter((v) => v.alsoNaive).length} exempt as must-still-work\n`);

// ── the ceiling must stay a small number ───────────────────────────────────
if (!Number.isInteger(PI_FANOUT) || PI_FANOUT < 1 || PI_FANOUT > 12) {
  fail(`PI_FANOUT is ${PI_FANOUT}. The point of a batch door is one REQUEST, `
    + 'not one burst; a large ceiling is the bug this file pins.');
} else {
  ok(`PI_FANOUT is ${PI_FANOUT}`);
}

// ── and lib/pi-batch.ts must still go THROUGH it ───────────────────────────
// The one thing a behavioural pin cannot see: a future edit that stops calling
// this function. Cheap, and it is the exact regression that shipped.
const src = await (await import('node:fs/promises')).readFile('lib/pi-batch.ts', 'utf8');
if (!src.includes('probeThenBatch')) {
  fail('lib/pi-batch.ts no longer calls probeThenBatch — the fan-out is unbounded again.');
} else {
  ok('lib/pi-batch.ts still routes its PI fan-out through probeThenBatch');
}

// EVERY fan-out in that file must be bounded, and there are two legitimate ways
// to do it: bound the CONCURRENCY (probeThenBatch) or bound the COUNT (slice to
// a MAX_ constant first). The value-block pass does the second — 16 album feeds,
// deliberately, with its own note — so a blanket "no Promise.all over a map"
// rule is wrong and was reported as a failure the first time this ran. The rule
// that holds for both is: a fan-out is over a list something already capped.
for (const m of src.matchAll(/Promise\.all(?:Settled)?\s*\(\s*([A-Za-z_$][\w$]*)\.map\(/g)) {
  const list = m[1];
  const bounded = new RegExp(`\\b${list}\\b[^\\n]*\\.slice\\(\\s*0\\s*,\\s*MAX_`).test(src);
  if (bounded) ok(`\`${list}\` is sliced to a MAX_ constant before its fan-out`);
  else {
    fail(`lib/pi-batch.ts fans out over \`${list}\` with neither a concurrency\n`
      + '          ceiling nor a count cap. One request must never become an\n'
      + '          unbounded burst — that is what resolved 4 of 228 tracks.');
  }
}

console.log(failures
  ? `\n${failures} fan-out check(s) FAILED.\n`
  : '\nAll fan-out checks passed.\n');
process.exit(failures ? 1 : 0);
