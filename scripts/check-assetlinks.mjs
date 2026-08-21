// Pins the Digital Asset Links payload that authorizes the Android app.
//
// Usage:
//   npm run check:assetlinks
//
// Run it after ANY edit to lib/assetlinks.ts or
// app/.well-known/assetlinks.json/route.ts.
//
// Why this earns a check script: BOTH failure directions are invisible.
//
// Under-produce — a fingerprint with a stray space, the wrong case, one byte
// short — and Chrome's verification fails, so the Trusted Web Activity opens
// with a URL bar across the top. Nothing logs an error. The app is not broken,
// it just quietly stops looking like an app, and the only way to notice is to
// install a signed build and look at it.
//
// Over-produce and it is worse, because a statement is a GRANT. A target
// carrying an empty `sha256_cert_fingerprints` array names a package with the
// certificate check switched off; a package id we didn't validate is a package
// id someone else's build can match. What they'd be granted is the right to
// represent www.boostmebitch.com — an origin whose localStorage holds the NWC
// spending credential.
//
// So the arithmetic lives in an import-free module and this script imports the
// REAL one under `--experimental-strip-types`. A reimplemented copy here would
// stay green while the shipping code drifted, which is the exact failure the
// arrangement exists to prevent.
//
// EVERY VECTOR IS A RECORDED CALL, NOT A BARE ASSERTION, AND THAT IS LOAD
// BEARING. `naiveNormalize` and `naiveBuild` at the foot are the obvious wrong
// versions — they trust their input and split on commas — and the whole vector
// list is replayed against them, because a vector that passes the moment it is
// written has proved nothing. The first shape of this file declared that in its
// header and then hand-listed six of about thirty vectors in the comparison, so
// the entire normalizeFingerprint section sat green having never been tested
// against anything. Recording the ARGUMENTS is what makes the replay total: a
// vector cannot be added without also being proved.
//
// The exceptions are named, one at a time, by `alsoNaive: true`: the
// must-still-work half. `keytool` form in and the same string out is a real
// requirement AND something the wrong implementation gets right, which is a
// property of that input rather than a hole in the suite. Marking it beats
// dropping it — over-blocking a legitimate fingerprint is its own regression —
// but it has to be marked deliberately, one vector at a time, so the exemption
// can never be the default.

import { buildAssetLinks, normalizeFingerprint } from '../lib/assetlinks.ts';
import { importFreeProblems, explainImportFree } from './import-free.mjs';

let failures = 0;

/** Every recorded call, replayed against the wrong implementations below. */
const vectors = [];

function compare(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok    ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
}

/** A normalizeFingerprint vector. `alsoNaive` marks a must-still-work input. */
function checkFp(label, input, expected, { alsoNaive = false } = {}) {
  compare(label, normalizeFingerprint(input), expected);
  vectors.push({ label, kind: 'fp', args: [input], alsoNaive });
}

/** A buildAssetLinks vector. `alsoNaive` marks a must-still-work input. */
function checkLinks(label, pkg, fps, expected, { alsoNaive = false } = {}) {
  compare(label, buildAssetLinks(pkg, fps), expected);
  vectors.push({ label, kind: 'links', args: [pkg, fps], alsoNaive });
}

function section(name) {
  console.log(`\n${name}`);
}

// A real 32-byte fingerprint in the shape `keytool -list -v` prints. Not a
// production key — 32 arbitrary bytes, which is all the format is.
const FP = '9A:C1:0E:57:3B:44:F8:21:6D:90:5C:E3:07:B2:48:1F:AA:36:D5:69:C4:12:8E:70:5B:33:E9:07:1D:64:A2:FC';
const FP2 = '01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF';
const PKG = 'com.boostmebitch';
const RELATION = 'delegate_permission/common.handle_all_urls';

/** The exact object Chrome expects, written out longhand rather than built. */
const statementFor = (pkg, fps) => [{
  relation: [RELATION],
  target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: fps },
}];

// ---------------------------------------------------------------------------
section('A fingerprint normalizes to the one form Chrome compares against');
// ---------------------------------------------------------------------------
{
  // `keytool -list -v` prints uppercase colon-separated; this is the round trip.
  checkFp('keytool form is unchanged', FP, FP, { alsoNaive: true });
  // `apksigner` and most CI snippets print bare lowercase hex. Accepting it is
  // the difference between a working deploy and a silently empty file that
  // looks configured — the env var is set, and nothing says why it didn't take.
  checkFp('bare lowercase hex gains colons and case', FP.replace(/:/g, '').toLowerCase(), FP);
  checkFp('lowercase colon form is upcased', FP.toLowerCase(), FP, { alsoNaive: true });
  // Copy-paste out of a terminal or a YAML block brings whitespace with it.
  checkFp('surrounding whitespace and a newline are tolerated', `\n  ${FP} \t`, FP, { alsoNaive: true });
  // Whitespace INSIDE the value is the one a wrapped terminal paste produces,
  // and it is where trim-and-upcase stops being enough.
  checkFp('a line break inside the value is closed up', `${FP.slice(0, 47)}\n${FP.slice(47)}`, FP);
}

// ---------------------------------------------------------------------------
section('...and anything that is not one is null, never a shortened string');
// ---------------------------------------------------------------------------
{
  // 31 bytes: the shape a truncated paste has. It cannot match any
  // certificate, so serving it only makes the file look configured.
  checkFp('31 bytes', FP.slice(0, -3), null);
  checkFp('33 bytes', `${FP}:AB`, null);
  checkFp('non-hex', FP.replace('9A', 'ZZ'), null);
  checkFp('empty', '', null);
  checkFp('an npub pasted into the wrong variable', 'npub1abcdef', null);
}

// ---------------------------------------------------------------------------
section('The statement is exactly what Digital Asset Links specifies');
// ---------------------------------------------------------------------------
{
  checkLinks('single fingerprint', PKG, FP, statementFor(PKG, [FP]), { alsoNaive: true });
  // A rotation needs both keys live at once: the build already on people's
  // phones is signed by the outgoing one.
  checkLinks('two, comma separated, order preserved', PKG, `${FP},${FP2}`, statementFor(PKG, [FP, FP2]), { alsoNaive: true });
  checkLinks('an array is accepted too', PKG, [FP, FP2], statementFor(PKG, [FP, FP2]), { alsoNaive: true });
  checkLinks('whitespace around a comma', PKG, ` ${FP} , ${FP2} `, statementFor(PKG, [FP, FP2]));
  checkLinks('the same key twice in two spellings is one entry', PKG, `${FP},${FP.toLowerCase()}`, statementFor(PKG, [FP]));
  // Mid-rotation the list is edited by hand. Losing verification for the key
  // that IS valid because the second one was mistyped is the worse outcome.
  checkLinks('a mistyped second entry does not take the good one down', PKG, `${FP},nonsense`, statementFor(PKG, [FP]));
}

// ---------------------------------------------------------------------------
section('An unconfigured or malformed input grants NOTHING');
// ---------------------------------------------------------------------------
{
  // This is the case a fresh deploy is in, and it must be a well-formed
  // "nobody is authorized" rather than a half-filled grant.
  checkLinks('no fingerprint at all', PKG, undefined, []);
  checkLinks('empty string', PKG, '', []);
  checkLinks('only commas', PKG, ',,', []);
  checkLinks('every entry malformed', PKG, 'abc,def', []);
  checkLinks('no package id', undefined, FP, []);
  checkLinks('package id with no dot', 'boostmebitch', FP, []);
  checkLinks('trailing dot', 'com.boostmebitch.', FP, []);
  checkLinks('leading dot', '.com.boostmebitch', FP, []);
  checkLinks('a segment starting with a digit', 'com.1boost.app', FP, []);
  checkLinks('an embedded space', 'com.boost mebitch.app', FP, []);
  // The package id is interpolated into a JSON grant. A shape we didn't expect
  // produces no statement rather than a statement about something else.
  checkLinks('a quote', 'com.x".app', FP, []);
  checkLinks('a newline', 'com.x\n.app', FP, []);
  checkLinks('absurd length', `com.${'a'.repeat(300)}.app`, FP, []);
}

// ---------------------------------------------------------------------------
section('Every vector above is replayed against the obvious wrong implementations');
// ---------------------------------------------------------------------------
{
  // What someone writes when a fingerprint looks like a formatting problem:
  // tidy the whitespace, fix the case, ship it. Right on the three inputs that
  // were already in canonical form, wrong on every input that is not — and it
  // never returns null, so nothing malformed is ever refused.
  const naiveNormalize = (raw) => raw.trim().toUpperCase();

  // What someone writes when the statement looks like string formatting: trust
  // the input, split on commas, ship it. Green on the happy path and wrong on
  // every case that matters, including the one that grants a package id nobody
  // validated.
  const naiveBuild = (pkg, fps) => [{
    relation: [RELATION],
    target: {
      namespace: 'android_app',
      package_name: pkg,
      sha256_cert_fingerprints: typeof fps === 'string' ? fps.split(',') : (fps ?? []),
    },
  }];

  const call = (impl, v) => {
    try {
      return JSON.stringify(
        v.kind === 'fp'
          ? (impl === 'real' ? normalizeFingerprint(...v.args) : naiveNormalize(...v.args))
          : (impl === 'real' ? buildAssetLinks(...v.args) : naiveBuild(...v.args)),
      );
      // A wrong implementation is allowed to throw where the real one returns.
      // That still counts as differing — it is the loudest way to be wrong.
    } catch (e) {
      return `threw ${(e && e.message) || e}`;
    }
  };

  let exempt = 0;
  for (const v of vectors) {
    const differs = call('real', v) !== call('naive', v);
    if (v.alsoNaive) {
      exempt += 1;
      console.log(`  ok    "${v.label}" is must-still-work — naive() may get it right`);
      continue;
    }
    if (differs) {
      console.log(`  ok    naive() gets "${v.label}" wrong`);
      continue;
    }
    failures += 1;
    console.error(`  FAIL  "${v.label}" passes against naive() too — the vector proves nothing.`);
    console.error('          Either it is a must-still-work input (mark it { alsoNaive: true })');
    console.error('          or it does not exercise anything the real module adds.');
  }
  console.log(`  ${vectors.length} vector(s) replayed, ${exempt} exempt as must-still-work`);
}

// ---------------------------------------------------------------------------
console.log('\nassetlinks.ts stays loadable under plain Node');
// ---------------------------------------------------------------------------
{
  // The arrangement this whole script depends on: it imports the REAL module,
  // so the module must keep resolving under `node --experimental-strip-types`.
  // See scripts/import-free.mjs for why a type-only relative import counts.
  const problems = importFreeProblems('lib/assetlinks.ts');
  if (problems.length) { explainImportFree('lib/assetlinks.ts', problems); failures += problems.length; }
  else console.log('  ok    lib/assetlinks.ts has no imports that plain Node cannot resolve');
}

if (failures) {
  console.error(`\n${failures} assetlinks check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll assetlinks checks passed.');
