// Pins `lib/brand.ts` — the table that decides which name this deploy wears.
//
// WHY THIS IS A CHECK AND NOT A CONSTANT SOMEBODY READS:
//
// The whole point of the second brand is that boostmebuddy.com is family
// friendly, so ONE leaked string from the other table is the feature failing —
// and it fails silently, on the deploy nobody is looking at. Every field here
// reaches somewhere a person or a recipient reads it: the page header, the
// `<title>`, a PWA icon label, the boostagram `app_name` an artist's aggregator
// prints, the `client` tag on a PUBLIC Nostr note, and the `sender_name`
// substituted onto an anonymous boost. A kind:1 cannot be edited and a
// boostagram cannot be recalled, so a wrong name is permanent per event.
//
// The other direction costs as much and is quieter still. `brandIdFrom` must
// fall back to `bmb` for anything it does not recognize: a deploy that forgets
// `NEXT_PUBLIC_BRAND`, or spells it wrong, has to keep behaving exactly as the
// original site did rather than serving a half-named page. There is no
// "unbranded" state to fall into, and a typo in a Vercel dashboard is not a
// build error.
//
// `naive()` at the foot is the implementation somebody would actually write —
// `raw === 'buddy' ? 'buddy' : 'bmb'`, with no trim and no case fold. It passes
// every ordinary vector and is the reason the replay is TOTAL: each vector is
// recorded as a call and asserted to fail against it, unless it is exempted one
// at a time with `alsoNaive: true` for a legitimate input the wrong version also
// handles.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { importFreeProblems, explainImportFree } from './import-free.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const MOD = 'lib/brand.ts';

const problems = importFreeProblems(MOD);
if (problems.length) {
  explainImportFree(MOD, problems);
  process.exit(1);
}

const { BRANDS, BRAND, brandIdFrom, siteTitle, DEFAULT_SENDER_NAME, resolveSenderName } =
  await import('../lib/brand.ts');

let failures = 0;
const fail = (what, got, want) => {
  failures++;
  console.error(`  FAIL  ${what}\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`);
};
const eq = (what, got, want) => {
  if (got === want) return true;
  fail(what, got, want);
  return false;
};
const ok = (what, cond, detail) => {
  if (cond) return true;
  failures++;
  console.error(`  FAIL  ${what}${detail ? `\n          ${detail}` : ''}`);
  return false;
};

// ---------------------------------------------------------------------------
// brandIdFrom — recorded as calls so the naive replay below is total.
// ---------------------------------------------------------------------------

const ID_VECTORS = [
  // The two values a deploy actually sets.
  { args: [undefined], expect: 'bmb', alsoNaive: true, why: 'unset falls back to the original site' },
  { args: ['buddy'], expect: 'buddy', alsoNaive: true, why: 'the buddy deploy' },
  { args: ['bmb'], expect: 'bmb', alsoNaive: true, why: 'the original, named explicitly' },

  // What a dashboard actually contains. Vercel keeps a trailing newline when a
  // value is pasted, and neither case nor whitespace is something a person
  // types reliably — each of these is a buddy deploy silently serving the other
  // brand's name in its header, its title and its boostagrams.
  { args: ['Buddy'], expect: 'buddy', why: 'capitalized in the dashboard' },
  { args: ['BUDDY'], expect: 'buddy', why: 'shouted' },
  { args: ['buddy\n'], expect: 'buddy', why: 'pasted with a trailing newline' },
  { args: ['  buddy  '], expect: 'buddy', why: 'pasted with padding' },

  // Fail CLOSED to the original site. An unrecognized value must never produce
  // a third state, and must never guess "buddy" from a partial match.
  { args: [''], expect: 'bmb', alsoNaive: true, why: 'empty is not a brand' },
  { args: ['   '], expect: 'bmb', alsoNaive: true, why: 'whitespace is not a brand' },
  { args: ['bud'], expect: 'bmb', alsoNaive: true, why: 'a prefix is not a match' },
  { args: ['buddies'], expect: 'bmb', alsoNaive: true, why: 'a longer word is not a match' },
  { args: ['notbuddy'], expect: 'bmb', alsoNaive: true, why: 'a suffix match must not count' },
  { args: ['true'], expect: 'bmb', alsoNaive: true, why: 'a boolean-ish value is not a brand' },
];

console.log('\n  brandIdFrom');
for (const v of ID_VECTORS) {
  eq(`brandIdFrom(${JSON.stringify(v.args[0])}) — ${v.why}`, brandIdFrom(...v.args), v.expect);
}

// ---------------------------------------------------------------------------
// The table itself.
// ---------------------------------------------------------------------------

// The fields that must not go MISSING. It is not the list anything is scanned
// with — every loop below walks `Object.keys(brand)` instead, so a field added
// to the `Brand` interface is scanned the day it is added rather than the day
// somebody remembers this array. A hand-written second list is how
// check-assetlinks.mjs came to have a whole section asserted against nothing.
const REQUIRED = [
  'id', 'displayName', 'shortName', 'wireName', 'domain', 'origin', 'siteNpub',
  'senderName', 'boostSound', 'manifest', 'userAgent', 'description',
];

// ---------------------------------------------------------------------------
// The literal values, both brands.
//
// Everything else in this file tests a field's SHAPE. This is the only thing
// that pins its VALUE, and the value is the half a person reads: `wireName`
// goes into every boostagram an artist's aggregator prints, `origin` into the
// deep link and banner URL of a signed kind:1 that can never be edited, and
// `senderName` onto every anonymous boost. `wireName: 'BoostMebitch'` and an
// apex `origin` (which 307-redirects, so the note unfurls no card at all) each
// pass every shape test above and change what recipients see, silently and
// permanently.
//
// So the table is duplicated here on purpose: editing a brand string has to be
// a deliberate two-file change, and the diff on this file is the review.
// ---------------------------------------------------------------------------

const LITERALS = {
  bmb: {
    id: 'bmb',
    displayName: 'Boost Me Bitch',
    shortName: 'Boost Me',
    wireName: 'BoostMeBitch',
    domain: 'boostmebitch.com',
    origin: 'https://www.boostmebitch.com',
    siteNpub: 'npub18qs0flu9sa682vx8l6h7glq7tyhrec8a9y5mf7g8usr3f0fx7syq9kpq9l',
    senderName: 'boostmebitch.com user',
    boostSound: '/boost.mp3',
    manifest: '/manifest.json',
    userAgent: 'boostmebitch/0.1',
    description:
      'Search, listen, and boost Podcasting 2.0 shows over Lightning. Sign in with Nostr.',
  },
  buddy: {
    id: 'buddy',
    displayName: 'Boost Me Buddy',
    shortName: 'Boost Buddy',
    wireName: 'BoostMeBuddy',
    domain: 'boostmebuddy.com',
    origin: 'https://www.boostmebuddy.com',
    siteNpub: 'npub1payksynch9rkj3dt0ps093cqja8c0r8fhq244kyngcendqgh885qzjs08q',
    senderName: 'boostmebuddy.com user',
    boostSound: '/boost-buddy.mp3',
    manifest: '/manifest-buddy.json',
    userAgent: 'boostmebuddy/0.1',
    description:
      'Search, listen, and boost Podcasting 2.0 shows over Lightning. Sign in with Nostr.',
  },
};

console.log('\n  literal values');
for (const [key, want] of Object.entries(LITERALS)) {
  const got = BRANDS[key];
  // Both directions. Missing a field is caught by REQUIRED below; an EXTRA
  // field is caught here, because a new field must be pinned before it ships.
  const extra = Object.keys(got ?? {}).filter((f) => !(f in want));
  ok(`${key} has no field this check does not pin`, extra.length === 0,
    `unpinned: ${JSON.stringify(extra)} — add them to LITERALS`);
  for (const [f, v] of Object.entries(want)) eq(`${key}.${f}`, got?.[f], v);
}

console.log('\n  the table');
const ids = Object.keys(BRANDS);
ok('both brands are present', ids.length === 2 && ids.includes('bmb') && ids.includes('buddy'),
  `got ${JSON.stringify(ids)}`);

for (const [key, b] of Object.entries(BRANDS)) {
  eq(`${key}.id matches its table key`, b.id, key);
  const fields = Object.keys(b);
  for (const f of REQUIRED) {
    ok(`${key}.${f} is still present`, fields.includes(f), `keys: ${JSON.stringify(fields)}`);
  }
  for (const f of fields) {
    ok(`${key}.${f} is a non-empty string`, typeof b[f] === 'string' && b[f].length > 0,
      `got ${JSON.stringify(b[f])}`);
  }
  // The `www` form is load-bearing: the apex 307-redirects to it, and this
  // origin is written into signed, immutable kind:1 notes. An unfollowed
  // redirect is a note with no card at all, forever.
  ok(`${key}.origin is https://www.<domain>`, b.origin === `https://www.${b.domain}`,
    `origin ${JSON.stringify(b.origin)} vs domain ${JSON.stringify(b.domain)}`);
  ok(`${key}.senderName is "<domain> user"`, b.senderName === `${b.domain} user`,
    `got ${JSON.stringify(b.senderName)}`);
  // CamelCase, no spaces — the Helipad-aggregator convention Fountain and
  // StableKraft follow. A space here is what a recipient's tooling splits on.
  ok(`${key}.wireName has no spaces`, !/\s/.test(b.wireName), `got ${JSON.stringify(b.wireName)}`);
  // The npub is the PUBLIC half of this deploy's SITE_NOSTR_SK, and the publish
  // script refuses a key that does not derive it. So a malformed value here does
  // not fail loudly — it makes the guard unsatisfiable, and the only tool that
  // writes the site's kind:0 stops working for that brand with no way to comply.
  // bech32 has no `b`, `i`, `o` or `1` in its data part, which is also why the
  // FORBIDDEN check below can never trip on an npub.
  ok(`${key}.siteNpub is a bech32 npub`, /^npub1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/.test(b.siteNpub),
    `got ${JSON.stringify(b.siteNpub)}`);
  ok(`${key}.boostSound is a root-relative asset`, b.boostSound.startsWith('/'),
    `got ${JSON.stringify(b.boostSound)}`);
  ok(`${key}.manifest is a root-relative asset`, b.manifest.startsWith('/'),
    `got ${JSON.stringify(b.manifest)}`);
  // Shape is not enough: BOTH deploys build from this one repo, so `public/`
  // has to hold BOTH assets and the table only chooses. A path naming a file
  // that isn't there fails silently at runtime in each case — `playBoostSound`
  // swallows the rejected `play()`, so a buddy boost is just quiet, and a
  // missing manifest is a PWA that will not install. `/boost-buddy.mp3` shipped
  // in this table while `public/` held only `boost.mp3`.
  for (const f of ['boostSound', 'manifest']) {
    ok(`${key}.${f} names a file that exists in public/`, existsSync(join(REPO, 'public', b[f])),
      `public${b[f]} is not in the repo`);
  }
}

// ---------------------------------------------------------------------------
// The family-friendly property. This is the reason the second brand exists, so
// it is asserted rather than trusted: no user-visible or wire-visible field of
// the buddy brand may carry the original brand's word.
//
// The test is on the SUBSTRING, not on equality, because the leak that matters
// is a field built from the other brand's domain — a sender name, a
// User-Agent, an origin — not a field somebody pasted wholesale.
// ---------------------------------------------------------------------------

console.log('\n  buddy carries nothing from the other brand');
const FORBIDDEN = 'bitch';
// `Object.keys`, never REQUIRED: the field nobody remembered to list is exactly
// the field that ships the leak.
for (const f of Object.keys(BRANDS.buddy)) {
  const v = String(BRANDS.buddy[f]).toLowerCase();
  ok(`buddy.${f} does not contain ${JSON.stringify(FORBIDDEN)}`, !v.includes(FORBIDDEN),
    `got ${JSON.stringify(BRANDS.buddy[f])}`);
}
ok('buddy.displayName is not the original', BRANDS.buddy.displayName !== BRANDS.bmb.displayName);
ok('buddy.wireName is not the original', BRANDS.buddy.wireName !== BRANDS.bmb.wireName);
// Both deploys build from ONE repo, so both assets sit in `public/` and the
// table is the only thing choosing between them. Sharing a path would give the
// buddy site the other brand's ping with nothing on screen saying so.
ok('the two brands name different sound files', BRANDS.buddy.boostSound !== BRANDS.bmb.boostSound);
ok('the two brands name different manifests', BRANDS.buddy.manifest !== BRANDS.bmb.manifest);
// The whole reason the second identity exists. Sharing one key would sign every
// family-friendly site note with the original brand's npub, so a reader
// resolving the author gets the other brand's name, avatar and nip05 — on a
// kind:1 that cannot be edited afterwards.
ok('the two brands have different Nostr identities', BRANDS.buddy.siteNpub !== BRANDS.bmb.siteNpub);

// ---------------------------------------------------------------------------
// The buddy brand's FILES, not just its table row.
//
// `lib/brand.ts` is not the only place the family-friendly name is written
// down, and the table being clean says nothing about the files. Three of them
// are read by something outside this repo, which is what makes a leak here
// expensive and quiet:
//
//   public/manifest-buddy.json   the PWA install dialogue, and Bubblewrap on a
//                                re-`init` — a home-screen label is permanent
//                                until the user reinstalls.
//   android/twa-manifest-buddy.json  the Android app's launcher name and its
//                                package id. Zapstore keys a listing on the
//                                package id, so this is not editable after a
//                                first publish.
//   zapstore-buddy.yaml          the store listing itself.
//
// TWO EXCEPTIONS ARE LEGITIMATE AND BOTH ARE NARROW. `signingKey.alias` is a
// keystore-internal name for an entry inside a .jks that both apps share; it
// reaches no user and renaming it would orphan the key. `repository:` is the
// real GitHub URL, and the repo keeps the original name on purpose (CLAUDE.md
// says so) — a store listing that links to a repository that does not exist is
// worse than one that links to an honestly-named one. Everything else is a
// failure. They are exempted by exact path, never by a substring rule, so a
// third leak cannot arrive by resembling one of these.
// ---------------------------------------------------------------------------

console.log('\n  the buddy brand carries nothing from the other brand ON DISK');

/** JSON pointer-ish paths whose value may legitimately hold the other word. */
const ALLOWED = {
  'public/manifest-buddy.json': [],
  'android/twa-manifest-buddy.json': ['signingKey.alias'],
  'zapstore-buddy.yaml': ['repository'],
};

/** Every scalar in a parsed JSON doc, as [dottedPath, value]. */
function scalars(node, path = '') {
  if (node === null || typeof node !== 'object') return [[path, node]];
  if (Array.isArray(node)) return node.flatMap((v, i) => scalars(v, `${path}[${i}]`));
  return Object.entries(node).flatMap(([k, v]) => scalars(v, path ? `${path}.${k}` : k));
}

for (const [rel, allowed] of Object.entries(ALLOWED)) {
  const abs = join(REPO, rel);
  ok(`${rel} exists`, existsSync(abs), 'the buddy brand has no file at that path');
  if (!existsSync(abs)) continue;
  const text = readFileSync(abs, 'utf8');

  if (rel.endsWith('.json')) {
    let doc;
    try { doc = JSON.parse(text); } catch (e) {
      ok(`${rel} parses as JSON`, false, String(e && e.message));
      continue;
    }
    for (const [p, v] of scalars(doc)) {
      if (typeof v !== 'string') continue;
      if (!v.toLowerCase().includes(FORBIDDEN)) continue;
      ok(`${rel} → ${p} does not contain ${JSON.stringify(FORBIDDEN)}`,
        allowed.includes(p), `got ${JSON.stringify(v)}`);
    }
  } else {
    // The zapstore config is YAML and this script has no YAML parser, by the
    // same import-free rule everything else here follows. Scan it by LINE and
    // exempt by leading key, which is enough: every value that could carry a
    // name is a top-level scalar or a list item under one.
    let key = '';
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (!line || line.trimStart().startsWith('#')) continue;
      const m = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
      if (m) key = m[1];
      if (!line.toLowerCase().includes(FORBIDDEN)) continue;
      ok(`${rel} → ${key} does not contain ${JSON.stringify(FORBIDDEN)}`,
        allowed.includes(key), `got ${JSON.stringify(line.trim())}`);
    }
  }
}

// The two Android apps must not collide. One package id would make them the
// same app to Android and to Zapstore, so the second would overwrite the first
// — and a package id cannot be changed after a listing exists.
{
  const a = JSON.parse(readFileSync(join(REPO, 'android/twa-manifest.json'), 'utf8'));
  const b = JSON.parse(readFileSync(join(REPO, 'android/twa-manifest-buddy.json'), 'utf8'));
  ok('the two Android apps have different package ids', a.packageId !== b.packageId,
    `both are ${JSON.stringify(a.packageId)}`);
  ok('the two Android apps wrap different origins', a.host !== b.host,
    `both are ${JSON.stringify(a.host)}`);
  // Same keystore on purpose: a shared certificate is normal for one
  // developer's apps, and the differing package ids are what separate them.
  ok('the two Android apps share one signing key',
    a.signingKey?.alias === b.signingKey?.alias,
    `${JSON.stringify(a.signingKey?.alias)} vs ${JSON.stringify(b.signingKey?.alias)}`);
}

// ---------------------------------------------------------------------------
// Derived values follow the ACTIVE brand.
// ---------------------------------------------------------------------------

console.log('\n  derived values');
// `BRAND` must be whatever `brandIdFrom` says, never a hard-coded member: the
// whole fallback argument above is worthless if the wiring reads `BRANDS.bmb`.
eq('BRAND follows brandIdFrom(NEXT_PUBLIC_BRAND)',
  BRAND, BRANDS[brandIdFrom(process.env.NEXT_PUBLIC_BRAND)]);
// NOT `eq(DEFAULT_SENDER_NAME, BRAND.senderName)`. That is how it is DEFINED,
// so the assertion is `x === x` and cannot fail. The vectors below carry the
// literal instead.
eq('DEFAULT_SENDER_NAME is the active brand\'s literal',
  DEFAULT_SENDER_NAME, LITERALS[BRAND.id].senderName);
eq('siteTitle() names the active brand', siteTitle(), `${BRAND.displayName} — Podcast Boost Station`);
eq('siteTitle(brand) names the brand it is given', siteTitle(BRANDS.buddy),
  `${BRANDS.buddy.displayName} — Podcast Boost Station`);

// resolveSenderName: anonymity covers the PAYMENT, not just the note, so the
// typed name is discarded outright rather than trimmed.
eq('a typed name is used', resolveSenderName('  Alice  ', false), 'Alice');
eq('an empty name falls back', resolveSenderName('   ', false), DEFAULT_SENDER_NAME);
eq('anonymous DISCARDS the typed name', resolveSenderName('Alice', true), DEFAULT_SENDER_NAME);
eq('anonymous with no name', resolveSenderName('', true), DEFAULT_SENDER_NAME);

// ---------------------------------------------------------------------------
// TOTAL naive replay. Every ID_VECTORS entry must fail against the obvious
// implementation, unless exempted one at a time.
// ---------------------------------------------------------------------------

/** What somebody would actually write: no trim, no case fold. */
function naive(raw) {
  return raw === 'buddy' ? 'buddy' : 'bmb';
}

console.log('\n  naive replay (each vector must fail against the obvious version)');
let proved = 0;
let exempt = 0;
for (const v of ID_VECTORS) {
  const naiveGot = naive(...v.args);
  if (v.alsoNaive) {
    exempt++;
    if (naiveGot !== v.expect) {
      failures++;
      console.error(`  FAIL  ${JSON.stringify(v.args[0])} is marked alsoNaive but the naive version gets it WRONG`
        + `\n          drop the exemption — this vector does prove something`);
    }
    continue;
  }
  if (naiveGot === v.expect) {
    failures++;
    console.error(`  FAIL  ${JSON.stringify(v.args[0])} passes against naive() too — it proves nothing`
      + `\n          either the vector is redundant or naive() is not naive enough`);
  } else {
    proved++;
  }
}
console.log(`        ${proved} vector(s) proved, ${exempt} exempted as must-still-work`);
ok('the replay proved something', proved > 0);

if (failures) {
  console.error(`\n  ${failures} failure(s) in check:brand\n`);
  process.exit(1);
}
console.log('\n  check:brand OK\n');
