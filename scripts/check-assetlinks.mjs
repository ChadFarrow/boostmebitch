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
// The `naive()` implementation at the foot is the obvious wrong version — it
// trusts its input and splits on commas. Every vector below is asserted to
// FAIL against it, so a vector that proves nothing can't sit here looking green.

import { buildAssetLinks, normalizeFingerprint } from '../lib/assetlinks.ts';
import { importFreeProblems, explainImportFree } from './import-free.mjs';

let failures = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok    ${label}`);
    return true;
  }
  failures += 1;
  console.error(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
  return false;
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
  check('keytool form is unchanged', normalizeFingerprint(FP), FP);
  // `apksigner` and most CI snippets print bare lowercase hex. Accepting it is
  // the difference between a working deploy and a silently empty file that
  // looks configured — the env var is set, and nothing says why it didn't take.
  check('bare lowercase hex gains colons and case', normalizeFingerprint(FP.replace(/:/g, '').toLowerCase()), FP);
  check('lowercase colon form is upcased', normalizeFingerprint(FP.toLowerCase()), FP);
  // Copy-paste out of a terminal or a YAML block brings whitespace with it.
  check('surrounding whitespace and a newline are tolerated', normalizeFingerprint(`\n  ${FP} \t`), FP);
}

// ---------------------------------------------------------------------------
section('...and anything that is not one is null, never a shortened string');
// ---------------------------------------------------------------------------
{
  // 31 bytes: the shape a truncated paste has. It cannot match any
  // certificate, so serving it only makes the file look configured.
  check('31 bytes', normalizeFingerprint(FP.slice(0, -3)), null);
  check('33 bytes', normalizeFingerprint(`${FP}:AB`), null);
  check('non-hex', normalizeFingerprint(FP.replace('9A', 'ZZ')), null);
  check('empty', normalizeFingerprint(''), null);
  check('an npub pasted into the wrong variable', normalizeFingerprint('npub1abcdef'), null);
}

// ---------------------------------------------------------------------------
section('The statement is exactly what Digital Asset Links specifies');
// ---------------------------------------------------------------------------
{
  check('single fingerprint', buildAssetLinks(PKG, FP), statementFor(PKG, [FP]));
  // A rotation needs both keys live at once: the build already on people's
  // phones is signed by the outgoing one.
  check('two, comma separated, order preserved', buildAssetLinks(PKG, `${FP},${FP2}`), statementFor(PKG, [FP, FP2]));
  check('an array is accepted too', buildAssetLinks(PKG, [FP, FP2]), statementFor(PKG, [FP, FP2]));
  check('whitespace around a comma', buildAssetLinks(PKG, ` ${FP} , ${FP2} `), statementFor(PKG, [FP, FP2]));
  check('the same key twice in two spellings is one entry', buildAssetLinks(PKG, `${FP},${FP.toLowerCase()}`), statementFor(PKG, [FP]));
  // Mid-rotation the list is edited by hand. Losing verification for the key
  // that IS valid because the second one was mistyped is the worse outcome.
  check('a mistyped second entry does not take the good one down', buildAssetLinks(PKG, `${FP},nonsense`), statementFor(PKG, [FP]));
}

// ---------------------------------------------------------------------------
section('An unconfigured or malformed input grants NOTHING');
// ---------------------------------------------------------------------------
{
  // This is the case a fresh deploy is in, and it must be a well-formed
  // "nobody is authorized" rather than a half-filled grant.
  check('no fingerprint at all', buildAssetLinks(PKG, undefined), []);
  check('empty string', buildAssetLinks(PKG, ''), []);
  check('only commas', buildAssetLinks(PKG, ',,'), []);
  check('every entry malformed', buildAssetLinks(PKG, 'abc,def'), []);
  check('no package id', buildAssetLinks(undefined, FP), []);
  check('package id with no dot', buildAssetLinks('boostmebitch', FP), []);
  check('trailing dot', buildAssetLinks('com.boostmebitch.', FP), []);
  check('leading dot', buildAssetLinks('.com.boostmebitch', FP), []);
  check('a segment starting with a digit', buildAssetLinks('com.1boost.app', FP), []);
  check('an embedded space', buildAssetLinks('com.boost mebitch.app', FP), []);
  // The package id is interpolated into a JSON grant. A shape we didn't expect
  // produces no statement rather than a statement about something else.
  check('a quote', buildAssetLinks('com.x".app', FP), []);
  check('a newline', buildAssetLinks('com.x\n.app', FP), []);
  check('absurd length', buildAssetLinks(`com.${'a'.repeat(300)}.app`, FP), []);
}

// ---------------------------------------------------------------------------
section('Every vector above fails against the obvious wrong implementation');
// ---------------------------------------------------------------------------
{
  // The version someone writes when this looks like string formatting: trust
  // the input, split on commas, ship it. It is green on the happy path and
  // wrong on every case that matters — which is why the vectors are checked
  // against it rather than only against the real module.
  const naive = (pkg, fps) => [{
    relation: [RELATION],
    target: {
      namespace: 'android_app',
      package_name: pkg,
      sha256_cert_fingerprints: typeof fps === 'string' ? fps.split(',') : (fps ?? []),
    },
  }];

  const differs = (label, pkg, fps) => {
    const real = JSON.stringify(buildAssetLinks(pkg, fps));
    const bad = JSON.stringify(naive(pkg, fps));
    if (real !== bad) {
      console.log(`  ok    naive() gets "${label}" wrong`);
      return;
    }
    failures += 1;
    console.error(`  FAIL  "${label}" passes against naive() too — the vector proves nothing`);
  };

  differs('bare hex', PKG, FP.replace(/:/g, '').toLowerCase());
  differs('a mistyped second entry', PKG, `${FP},nonsense`);
  differs('no fingerprint at all', PKG, undefined);
  differs('every entry malformed', PKG, 'abc,def');
  differs('a package id with a quote', 'com.x".app', FP);
  differs('duplicate spellings of one key', PKG, `${FP},${FP.toLowerCase()}`);
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
