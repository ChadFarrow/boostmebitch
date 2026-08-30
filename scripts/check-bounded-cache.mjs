// Pins `createBoundedCache` (lib/bounded-cache.ts) — the eviction shared by the
// two module caches that hold whole RSS bodies.
//
// THE FAILURE THIS WAS WRITTEN AGAINST. The module shipped with an age horizon
// and an ENTRY cap, and its own header called both bounds mandatory. An entry
// cap is not a memory bound. Both callers read bodies at `MAX_BODY_BYTES`
// (8 MB), so `rssXmlCache`'s 200 entries is 1.6 GB of ceiling in a function
// with about one gigabyte — and it is reachable in a single request rather than
// by drift: `/api/publisher` walks up to `MAX_PUBLISHER_ALBUMS` (100) children
// of a FEED-SUPPLIED publisher document, one `fetchFeedXml` each, so one call
// against a URL an attacker chose can retain 800 MB for the ten-minute horizon.
//
// Measured for scale on 2026-08-30, so the budget is sized against reality and
// not a guess: all ten of ChadF's playlist source feeds together are 9.5 MB
// decompressed, and the largest single one — mmmusic.show — is 2.5 MB. The
// working set is nowhere near the cap, which is exactly why the cap never
// bounded anything.
//
// WHY THIS IS A CALL SCRIPT RATHER THAN A VECTOR LIST. The unit under test is
// stateful, so a single (input, output) pair says nothing: eviction is a
// property of a SEQUENCE, and the three rules interact — expiry sweeps first,
// the count cap second, the byte budget third, and `set` deletes before it sets
// so a refreshed entry moves to the back of the queue. Each vector is therefore
// a script of operations and an assertion about the state it leaves.
//
// naive() is the SHIPPED implementation, verbatim: age plus count, no byte
// accounting at all. It is the version this replaces, which is the strongest
// thing to replay against — a vector the two agree on is one that proves
// nothing about the fix, and the runner says so.
//
// Imports the REAL module via `node --experimental-strip-types`. That is what
// `lib/bounded-cache.ts` having no imports buys, and the scan below keeps it.
import { createBoundedCache } from '../lib/bounded-cache.ts';
import { importFreeProblems, explainImportFree } from './import-free.mjs';

let failures = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failures++; };
const ok = (msg) => console.log('  ok    ' + msg);

// ── The wrong version: count and age, no bytes ─────────────────────────────
function naive(opts) {
  const { maxAgeMs, maxEntries } = opts;
  const map = new Map();
  return {
    get(key, now) {
      const hit = map.get(key);
      if (!hit) return undefined;
      const ageMs = now - hit.storedAt;
      if (ageMs >= maxAgeMs) { map.delete(key); return undefined; }
      return { value: hit.value, ageMs };
    },
    set(key, value, now) {
      for (const [k, v] of map) if (now - v.storedAt >= maxAgeMs) map.delete(k);
      map.delete(key);
      map.set(key, { value, storedAt: now });
      while (map.size > maxEntries) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }
    },
    get size() { return map.size; },
    get bytes() { return 0; },
    keys() { return [...map.keys()]; },
  };
}

// The real cache has no `keys()`, so drive it through `get` to observe which
// keys survived — the same door a caller has.
function survivors(cache, keys, now) {
  return keys.filter((k) => cache.get(k, now) !== undefined);
}

const vectors = [];
const vec = (label, opts, ops, expect, o = {}) =>
  vectors.push({ label, opts, ops, expect, ...o });

const B = (n) => 'x'.repeat(n);   // a body of exactly n "bytes" under sizeOf

// Every vector runs against a cache built from `opts`, applies `ops`, then
// reports which of the named keys are still readable, plus size and bytes.
const KEYS = ['a', 'b', 'c', 'd'];
const SIZED = { maxAgeMs: 1000, maxEntries: 10, maxBytes: 100, sizeOf: (v) => v.length };

// ── must still work: the two bounds that already existed ───────────────────
vec('an entry inside the horizon is served', SIZED,
  [['set', 'a', B(10), 0]], { keys: ['a'], size: 1, bytes: 10 }, { alsoNaive: true });
vec('an entry past the horizon is gone', { maxAgeMs: 1000, maxEntries: 10 },
  [['set', 'a', B(10), 0], ['at', 1000]], { keys: [], size: 0, bytes: 0 }, { alsoNaive: true });
vec('the entry cap still evicts oldest-first', { maxAgeMs: 1000, maxEntries: 2 },
  [['set', 'a', B(1), 0], ['set', 'b', B(1), 1], ['set', 'c', B(1), 2]],
  { keys: ['b', 'c'], size: 2, bytes: 0 }, { alsoNaive: true });
vec('a refreshed entry moves to the BACK of the queue', { maxAgeMs: 1000, maxEntries: 2 },
  [['set', 'a', B(1), 0], ['set', 'b', B(1), 1], ['set', 'a', B(1), 2], ['set', 'c', B(1), 3]],
  { keys: ['a', 'c'], size: 2, bytes: 0 }, { alsoNaive: true });

// ── the byte budget: what the entry cap could not do ───────────────────────
// Four bodies of 40 under a 100 budget. The count cap (10) never fires, so the
// naive version keeps all four and 160 bytes of them.
vec('the byte budget evicts where the entry cap never fires', SIZED,
  [['set', 'a', B(40), 0], ['set', 'b', B(40), 1], ['set', 'c', B(40), 2]],
  { keys: ['b', 'c'], size: 2, bytes: 80 });
vec('one oversized body does not evict the whole cache to hold itself', SIZED,
  [['set', 'a', B(40), 0], ['set', 'b', B(101), 1]],
  { keys: ['a'], size: 1, bytes: 40 });
vec('an oversized body also drops the stale entry under its key', SIZED,
  [['set', 'a', B(40), 0], ['set', 'a', B(101), 1]],
  { keys: [], size: 0, bytes: 0 });
vec('bytes are RELEASED when an entry expires', SIZED,
  [['set', 'a', B(40), 0], ['set', 'b', B(40), 1], ['at', 1001], ['set', 'c', B(40), 1001]],
  { keys: ['c'], size: 1, bytes: 40 });
vec('bytes are RELEASED when a key is overwritten, not double-counted', SIZED,
  [['set', 'a', B(40), 0], ['set', 'a', B(10), 1]],
  { keys: ['a'], size: 1, bytes: 10 });
// A LIVE entry has to survive alongside the expired one, or the two
// implementations agree at zero and the vector proves nothing.
vec('bytes are RELEASED when a read finds an expired entry', SIZED,
  [['set', 'a', B(40), 0], ['set', 'b', B(40), 900], ['get', 'a', 1001]],
  { keys: ['b'], size: 1, bytes: 40 });
// The exact shape of the reported failure: a walk of same-sized bodies well
// under the entry cap, whose total is not.
vec('a 100-child publisher walk is bounded by bytes, not by the entry cap',
  { maxAgeMs: 600_000, maxEntries: 200, maxBytes: 100, sizeOf: (v) => v.length },
  Array.from({ length: 100 }, (_, i) => ['set', `k${i}`, B(8), i]),
  { size: 12, bytes: 96 });

// ── configuration ──────────────────────────────────────────────────────────
// A budget with no way to measure is a cache that silently stops bounding, so
// it throws at construction — module load — rather than at some later write.
vec('maxBytes without sizeOf is refused at construction',
  { maxAgeMs: 1000, maxEntries: 10, maxBytes: 100 }, [], { threw: true });
vec('no budget configured means no measuring, and bytes stays 0',
  { maxAgeMs: 1000, maxEntries: 10 },
  [['set', 'a', B(40), 0]], { keys: ['a'], size: 1, bytes: 0 }, { alsoNaive: true });

// ── run ────────────────────────────────────────────────────────────────────
function run(build, v) {
  let cache;
  try { cache = build(v.opts); } catch { return JSON.stringify({ threw: true }); }
  let now = 0;
  for (const op of v.ops) {
    if (op[0] === 'set') { cache.set(op[1], op[2], op[3]); now = op[3]; }
    else if (op[0] === 'get') { cache.get(op[1], op[2]); now = op[2]; }
    else if (op[0] === 'at') { now = op[1]; }
  }
  // **Survivors FIRST, then size and bytes.** Expiry is lazy by design — an
  // entry past the horizon stays in the map until a read or the next write's
  // sweep touches it — so reading `size` before looking reports a number no
  // caller can observe, and an "is it gone" assertion made that way passes on
  // an implementation that never sweeps at all.
  //
  // Observed through `get`, the same door a caller has: the real cache exposes
  // no key list, and asserting on one would assert on a detail this module
  // deliberately does not publish.
  const keys = v.expect.keys ? survivors(cache, KEYS, now) : undefined;
  const out = { size: cache.size, bytes: cache.bytes };
  if (keys) out.keys = keys;
  return JSON.stringify(out);
}

console.log('\n  bounded cache eviction\n');
for (const v of vectors) {
  const got = run(createBoundedCache, v);
  const want = JSON.stringify(
    v.expect.threw ? { threw: true }
      : v.expect.keys ? { size: v.expect.size, bytes: v.expect.bytes, keys: v.expect.keys }
        : { size: v.expect.size, bytes: v.expect.bytes },
  );
  if (got !== want) {
    fail(`${v.label}\n          got  ${got}\n          want ${want}`);
    continue;
  }
  if (v.alsoNaive) { ok(`${v.label} (must-still-work — naive() may agree)`); continue; }
  if (run(naive, v) === got) {
    fail(`"${v.label}" passes against naive() too — the vector proves nothing.\n`
      + '          Either it is a must-still-work input (mark it { alsoNaive: true })\n'
      + '          or it does not exercise the byte budget.');
    continue;
  }
  ok(`${v.label} — and naive() gets it wrong`);
}
console.log(`\n  ${vectors.length} vector(s) replayed, `
  + `${vectors.filter((v) => v.alsoNaive).length} exempt as must-still-work\n`);

// ── the module must stay loadable under plain Node ─────────────────────────
console.log('  bounded-cache.ts stays loadable under plain Node\n');
const problems = importFreeProblems('lib/bounded-cache.ts');
if (problems.length) {
  explainImportFree('lib/bounded-cache.ts', problems);
  failures += problems.length;
} else {
  ok('lib/bounded-cache.ts has no imports that plain Node cannot resolve');
}

console.log(failures
  ? `\n${failures} bounded-cache check(s) FAILED.\n`
  : '\nAll bounded-cache checks passed.\n');
process.exit(failures ? 1 : 0);
