// Pins profile name search — the half that backs the @-mention picker.
//
// Needs a database:
//   DATABASE_URL=... node --experimental-strip-types verify/check-search.mjs
//
// Two halves, and they guard different failures.
//
// HALF ONE is the pure normaliser, replayed against `naive()` in the total
// `{ fn, args }` shape check-ingest.mjs uses: a vector cannot be added without
// being proved to discriminate. What it guards is a LIKE pattern built out of
// text a user typed. `%` and `_` are metacharacters, so an unescaped "50%"
// matches every profile in the table — that is a full scan on a per-keystroke
// query — and "a_b" quietly matches "axb".
//
// HALF TWO drives the SHIPPING API against a real Postgres, because the
// ranking, the caps and the never-4xx rule are properties of the SQL and the
// route, not of any function this file could import. The most important
// assertion in it is the status code: this route must answer 200 with an empty
// envelope for a query it cannot use, NEVER a 4xx. askIndex returns null for
// any !res.ok, the proxy turns that into 503, and ask() in index-client.ts
// latches indexOffUntil for the whole tab — so one 400 here switches the index
// off for the global feed, every podcast feed, live streams and zaps until the
// page reloads.
//
// Fixtures are signed with real keys through nostr-tools' own finalizeEvent and
// seeded through the SHIPPING ingest path, so nothing here reimplements a
// query or fakes a signature.

import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';
import { getPool, closePool } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import { ingestEvent, emptyStats } from '../src/store.ts';
import { buildApi } from '../src/api.ts';
import {
  normalizeSearchQuery, clampSearchLimit,
  DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS, MAX_SEARCH_QUERY,
} from '../src/queries.ts';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const API_KEY = 'test-key';
let failures = 0;
let checks = 0;

function ok(cond, what) {
  checks++;
  if (!cond) { failures++; console.error(`FAIL ${what}`); }
}
function eq(actual, expected, what) {
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${what}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`,
  );
}

// ===========================================================================
console.log('\nnormalizeSearchQuery / clampSearchLimit');
// ===========================================================================

/** Every recorded call, replayed against naive() below. */
const vectors = [];

function checkNorm(label, input, expected, { alsoNaive = false } = {}) {
  eq(normalizeSearchQuery(input), expected, label);
  vectors.push({ label, fn: 'norm', args: [input], alsoNaive });
}

const pat = (exact, pattern) => ({ exact, pattern: pattern ?? `${exact}%` });

// An ordinary prefix. naive() gets this right — that is a property of the
// input, not a hole, so it is exempted explicitly rather than dropped.
checkNorm('an ordinary prefix', 'ali', pat('ali'), { alsoNaive: true });
// The picker hands over what the user typed, and they typed the '@' too.
checkNorm('a leading @ is stripped', '@ali', pat('ali'));
checkNorm('surrounding whitespace goes', '  ali  ', pat('ali'), { alsoNaive: true });
// The metacharacters. Unescaped, the first is a full table scan and the second
// silently matches a character the user did not type.
checkNorm('% is escaped, not a wildcard', '50%', pat('50%', '50\\%%'));
checkNorm('_ is escaped', 'a_b', pat('a_b', 'a\\_b%'));
// Backslash must be escaped FIRST or the escaping escapes its own escapes.
checkNorm('a backslash is escaped before the others', 'a\\b', pat('a\\b', 'a\\\\b%'));
checkNorm('all three together', 'a\\b%c_d', pat('a\\b%c_d', 'a\\\\b\\%c\\_d%'));
// Below the floor we must not ask at all: any non-2xx from this route latches
// the index off for the tab.
checkNorm('one character is not a query', 'a', null);
// naive() also returns null for these four: there is nothing to normalise, so
// both implementations agree. Marked rather than dropped — "no query" must keep
// meaning null, and that is worth a vector even where the wrong version has it.
checkNorm('empty', '', null, { alsoNaive: true });
checkNorm('whitespace only', '   ', null, { alsoNaive: true });
checkNorm('a bare @', '@', null);
checkNorm('not a string', 42, null, { alsoNaive: true });
checkNorm('undefined', undefined, null, { alsoNaive: true });
// Truncated, never rejected — rejecting would be the 4xx we must not send.
checkNorm(
  'an overlong query is truncated, not refused',
  'x'.repeat(500),
  pat('x'.repeat(MAX_SEARCH_QUERY)),
);
// Control characters cannot appear in a name anyone can type.
checkNorm('a null byte', 'a\u0000b', null);
checkNorm('a newline', 'a\nb', null);
// NOT lowercased here. The generated columns were built with Postgres lower(),
// and JS toLowerCase() disagrees with it on some scripts, so the needle must be
// lowered by the same function as the haystack — which happens in the query.
checkNorm('case is preserved for SQL to fold', 'ALI', pat('ALI'));

eq(clampSearchLimit(undefined), DEFAULT_SEARCH_RESULTS, 'no limit means the default');
eq(clampSearchLimit('5'), 5, 'a sane limit passes through');
eq(clampSearchLimit('99999'), MAX_SEARCH_RESULTS, 'an absurd limit is clamped');
eq(clampSearchLimit('0'), DEFAULT_SEARCH_RESULTS, 'zero falls back to the default');
eq(clampSearchLimit('-3'), DEFAULT_SEARCH_RESULTS, 'a negative limit falls back');
eq(clampSearchLimit('abc'), DEFAULT_SEARCH_RESULTS, 'garbage falls back');

// ---------------------------------------------------------------------------
console.log('\n...every vector replayed against the obvious wrong version');
// ---------------------------------------------------------------------------
{
  // What somebody writes when the escaping looks like a formality: trim, lower,
  // append the wildcard, ask no questions. It gets plain prefixes right, which
  // is exactly why the rest is easy to lose.
  const naive = (raw) =>
    typeof raw === 'string' && raw.trim()
      ? { exact: raw.trim().toLowerCase(), pattern: `${raw.trim().toLowerCase()}%` }
      : null;

  const call = (impl, v) => {
    try {
      return JSON.stringify(impl === 'real' ? normalizeSearchQuery(...v.args) : naive(...v.args));
      // A wrong implementation may throw where the real one returns. That still
      // counts as differing — it is the loudest way to be wrong.
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
    checks += 1;
    console.error(`  FAIL  "${v.label}" passes against naive() too — the vector proves nothing.`);
    console.error('          Either it is a must-still-work input (mark it { alsoNaive: true })');
    console.error('          or it does not exercise anything the real module adds.');
  }
  console.log(`  ${vectors.length} vector(s) replayed, ${exempt} exempt as must-still-work`);
}

// ===========================================================================
console.log('\nGET /profiles/search against a real database');
// ===========================================================================

const db = getPool(DATABASE_URL);
await migrate(DATABASE_URL);
// Fresh every run: a check that depends on leftovers from the last one is not
// a check.
await db.query('truncate events, event_tags, profiles, tracked_pubkeys, pi_queue, pi_podcasts, pi_episodes, indexer_state cascade');

const NOW = 1_750_000_000;
const keys = {};
/** A signed kind:0 for `who`, with whatever metadata. */
function profile(who, meta) {
  keys[who] ??= generateSecretKey();
  return finalizeEvent(
    { kind: 0, created_at: NOW, tags: [], content: JSON.stringify(meta) },
    keys[who],
  );
}
const pk = (who) => getPublicKey(keys[who]);

const seeds = [
  profile('alice', { name: 'Alice', about: 'the short one' }),
  profile('alice2', { name: 'alice2' }),
  profile('dj', { name: 'DJ Alice' }),                       // INFIX, must not match 'ali'
  profile('alistair', { name: 'Alistair Longname' }),
  profile('bob', { name: 'Bob', nip05: 'alice@example.com' }), // nip05 only
  profile('display', { display_name: 'Alicorn' }),            // display_name only
  // coerceProfileMetadata exists because these are real: a name that is not a
  // string must not crash the query or the column.
  profile('weird', { name: 12345 }),
  profile('percent', { name: '50% Off' }),                    // the LIKE metacharacter
  profile('nameless', { about: 'no name at all' }),
];

const stats = emptyStats();
for (const e of seeds) await ingestEvent(db, e, stats);
console.log(`seed: ${JSON.stringify(stats)}`);

const app = buildApi(db, { apiKey: API_KEY, piTtlHours: 24 });
const get = async (url) => {
  const res = await app.inject({ method: 'GET', url, headers: { 'x-index-key': API_KEY } });
  return { status: res.statusCode, body: res.json() };
};
const names = (body) => body.profiles.map((p) => JSON.parse(p.content).name ?? JSON.parse(p.content).display_name);

// --- what it finds ---------------------------------------------------------
{
  const r = await get('/profiles/search?q=ali');
  eq(r.status, 200, 'a normal search is 200');
  const found = names(r.body);
  ok(found.includes('Alice'), 'the exact name is found');
  ok(found.includes('alice2'), 'a longer name with the same prefix is found');
  ok(found.includes('Alistair Longname'), 'another prefix match is found');
  ok(found.includes('Alicorn'), 'a display_name-only profile is found');
  // Prefix, not infix. Asserted so the limitation is a decision on the record
  // rather than a surprise in a bug report.
  ok(!found.includes('DJ Alice'), 'an INFIX match is NOT found — this is prefix search');
  ok(!found.includes('Bob'), 'a nip05 PREFIX does not match; nip05 is equality only');
  // Shortest name first inside a tier: "Alice" must beat "Alistair Longname".
  ok(
    found.indexOf('Alice') < found.indexOf('Alistair Longname'),
    'the shorter name ranks first',
  );
  eq(r.body.query, 'ali', 'the normalised query is echoed back');
}

// --- the signature, which is the whole payload -----------------------------
{
  const r = await get('/profiles/search?q=ali');
  ok(r.body.profiles.length > 0, 'there is something to verify');
  // The client (verifyAll) runs exactly this and DROPS what fails, so a search
  // whose rows do not verify returns nothing usable however good the ranking.
  // The JSON round trip strips nostr-tools' memoization Symbol — without it a
  // row can inherit a `true` for content it never checked.
  const allVerify = r.body.profiles.every((p) => verifyEvent(JSON.parse(JSON.stringify(p))));
  ok(allVerify, 'every searched profile VERIFIES as a signed kind:0');
  eq(r.body.profiles[0].kind, 0, 'rows are kind:0 events, not parsed metadata');
  ok(r.body.profiles.every((p) => typeof p.sig === 'string' && p.sig.length === 128), 'each carries its signature');
}

// --- nip05 is exact, never a prefix ----------------------------------------
{
  const hit = await get('/profiles/search?q=alice@example.com');
  ok(names(hit.body).includes('Bob'), 'a full nip05 finds its owner');
  const miss = await get('/profiles/search?q=alice@ex');
  ok(!names(miss.body).includes('Bob'), 'a nip05 PREFIX does not — unverified strings must not compete for short prefixes');
}

// --- the empty answer is an ANSWER, and never a 4xx ------------------------
{
  // The assertion the client's null-vs-[] distinction rests on.
  const r = await get('/profiles/search?q=zzzznobody');
  eq(r.status, 200, 'no matches is 200, not 404');
  eq(r.body.profiles, [], 'no matches is an empty array');
  eq(r.body.query, 'zzzznobody', 'and the echo still says we answered');
}
{
  // THE one that matters most. A 4xx here becomes a proxy 503, and ask() latches
  // indexOffUntil for the whole tab — killing the index for the global feed,
  // podcast feeds, live streams and zaps until reload.
  for (const url of ['/profiles/search?q=a', '/profiles/search?q=', '/profiles/search']) {
    const r = await get(url);
    eq(r.status, 200, `${url} is 200, NEVER a 4xx (a 4xx latches the index off for the tab)`);
    eq(r.body.profiles, [], `${url} answers an empty envelope`);
    eq(r.body.query, '', `${url} echoes an empty query, so the client can tell it was not asked`);
  }
}

// --- a metacharacter is a character ----------------------------------------
{
  const r = await get('/profiles/search?q=50%25');   // '50%' url-encoded
  eq(r.status, 200, 'a percent sign is 200');
  ok(names(r.body).includes('50% Off'), 'a literal % matches the profile that contains it');
  ok(r.body.profiles.length < seeds.length, 'and does NOT match every profile in the table');
}

// --- caps and determinism --------------------------------------------------
{
  const r = await get('/profiles/search?q=ali&limit=99999');
  ok(r.body.profiles.length <= MAX_SEARCH_RESULTS, 'an absurd limit is clamped');
  const a = await get('/profiles/search?q=ali');
  const b = await get('/profiles/search?q=ali');
  eq(
    a.body.profiles.map((p) => p.pubkey),
    b.body.profiles.map((p) => p.pubkey),
    'the same query returns the same order twice — the pubkey tie-break',
  );
}

// --- a profile with no name is not a match ---------------------------------
{
  const r = await get('/profiles/search?q=no');
  ok(!r.body.profiles.some((p) => p.pubkey === pk('nameless')), 'a nameless profile matches nothing');
}

await app.close();
await closePool();

console.log(`\n${checks} checks`);
if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
console.log('ok');
