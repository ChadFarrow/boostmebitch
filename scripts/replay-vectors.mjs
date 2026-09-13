// The `naive()` replay, in ONE place.
//
// WHAT IT IS FOR. Every `check:*` script records its inputs as vectors and
// replays each one against a deliberately wrong implementation, so a vector
// cannot be added without being proved to discriminate. `check-assetlinks.mjs`
// is why that rule exists: it claimed every vector was asserted against `naive()`
// while naming six of twenty-nine, so a whole section sat green against nothing.
//
// TWO FAULTS IT FIXES, and the second is the one that matters.
//
// 1. ELEVEN BYTE-IDENTICAL COPIES of this loop. CLAUDE.md's "one place per thing"
//    table exists for exactly this, and its reasoning — "a second copy drifts, and
//    the drift shows up on a screen you weren't looking at" — had already happened
//    here: three formatting variants across the eleven, and `check-downloads.mjs`
//    reached 62 vectors on its own subtly different replay.
//
// 2. AN `{ alsoNaive: true }` VECTOR WAS ASSERTED AGAINST NOTHING. Every copy
//    computed `differs` and then threw it away for an exempt vector:
//
//        const differs = call('real', v) !== call('naive', v);
//        if (v.alsoNaive) { exempt += 1; continue; }   // <- `differs` discarded
//
//    `alsoNaive` is a CLAIM, not a skip: it says "the naive version gets this
//    right, and it MUST" — a must-still-work input. So if the real implementation
//    later moves on that input, real and naive diverge, the claim is broken, and
//    every one of those loops printed `ok`. Over-blocking is the regression these
//    exemptions exist to catch, and nothing was catching it. 330 vectors across 25
//    scripts were exempt on those terms.
//
//    `check-brand.mjs` is the one script that already got this right, asserting
//    `naive(...) === v.expect` for its exempt vectors. It keeps its own loop
//    because it compares against an EXPECTED value rather than against the real
//    function, which is a stronger assertion this shared shape cannot express.
//
// A `.mjs` extension on the import, deliberately: several callers run under
// `node --experimental-strip-types`, which cannot resolve an extensionless
// relative import. This file therefore has no imports of its own either.

/**
 * Replay every vector against `naive()` and report what each one proved.
 *
 * @param vectors  the recorded `{ label, kind, args, alsoNaive }` calls
 * @param invoke   `(which: 'real'|'naive', vector) => comparable` — the caller's
 *                 own dispatcher, which is what keeps the per-script `kind`
 *                 switch where it belongs. It must return a value `!==` can
 *                 compare, and it must report a throw as a value rather than
 *                 letting it escape: throwing IS a way to be wrong, and the
 *                 loudest one.
 * @param fail     called once per failing vector with a message
 * @param log      defaults to console.log
 * @returns `{ proved, exempt }`
 */
export function replayVectors({ vectors, invoke, fail, log = console.log }) {
  let proved = 0;
  let exempt = 0;
  for (const v of vectors) {
    const differs = invoke('real', v) !== invoke('naive', v);
    if (v.alsoNaive) {
      exempt += 1;
      if (differs) {
        fail(`"${v.label}" is { alsoNaive: true }, but real and naive now DISAGREE.\n`
          + '          That marks a MUST-STILL-WORK input, so the real module has moved on one.\n'
          + '          Fix the module — or drop the exemption if the vector now proves something.');
        continue;
      }
      log(`  ok    "${v.label}" is must-still-work — naive() still agrees`);
      continue;
    }
    if (differs) {
      proved += 1;
      log(`  ok    naive() gets "${v.label}" wrong`);
      continue;
    }
    fail(`"${v.label}" passes against naive() too — the vector proves nothing.\n`
      + '          Either it is a must-still-work input (mark it { alsoNaive: true })\n'
      + '          or it does not exercise anything the real module adds.');
  }
  log(`  ${vectors.length} vector(s) replayed, ${proved} proved, ${exempt} exempt as must-still-work`);
  return { proved, exempt };
}
