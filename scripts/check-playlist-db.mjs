// Pins `dbValueBlock` and `dbRowToEpisode` (lib/playlist-db-map.ts) — the two
// functions that turn a row of ANOTHER APPLICATION'S database into a track this
// app renders and pays.
//
// `/api/playlist` resolves a playlist's tracks through Podcast Index, one
// `batchEpisodes` call per page. The StableKraft database already holds 13,783
// of those tracks with their value blocks, so it is used as an accelerator in
// front of PI: a hit skips the call, a miss falls through. That fall-through is
// the whole safety argument for this module, and it is what makes REFUSING the
// safe direction here — the opposite of everywhere else in this repo, where
// withholding a value block hides BOOST and costs an artist the payment.
//
// The danger is that the database's value blocks use the same field names ours
// do. A straight cast type-checks, renders correctly, and pays the wrong
// person. Measured over all 13,783 blocks it holds:
//
//   139  are the JSON value `null`. The column is `not null`, so SQL reports
//        them present and `SELECT ... WHERE "v4vValue" IS NOT NULL` returns
//        them. A cast hands `null.recipients` straight to the splitter.
//
//   225  recipients carry `split` as a string of digits ("100", "14", "5") out
//        of 25,477. Every other one is a proper number; no other spelling
//        occurs. `splitSats` reaches its weight through `Math.max(0, split||0)`
//        and Math.max COERCES, so these already pay correctly — measured, not
//        assumed. The repair is about the runtime value matching the `number`
//        our ValueRecipient promises.
//
//        The STRICT test around it is defensive rather than observed, and the
//        cross-check at the foot of this file is what keeps it honest: it
//        asserts against the real splitter that '0x64' is read as 100 and
//        '1e3' as 1000, so the loose forms have to be refused in the mapper or
//        they are never refused at all.
//
// FIXTURES COME FROM THE WIRE. Every block below was captured verbatim from
// that database on 2026-08-29, including the `customKey: null` spelling and the
// 6-recipient block with a `fee: true` payee. Real data carries the shapes
// nobody invents.
//
// Imports the REAL shipping module, never a copy — which is why
// lib/playlist-db-map.ts may hold only TYPE imports: a value import does not
// resolve under `node --experimental-strip-types` at all (Node's ESM loader
// wants the `.ts` extension TypeScript omits), so the pin rests on it.
import { dbValueBlock, dbRowToEpisode } from '../lib/playlist-db-map.ts';
import { fnvHash, splitSats } from '../lib/util.ts';

let failures = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failures++; };
const ok = (msg) => console.log('  ok    ' + msg);

// ── Captured blocks ────────────────────────────────────────────────────────
const KEYSEND_SINGLE = {
  type: 'lightning', method: 'keysend',
  recipients: [{
    fee: false, name: 'Cara Cormier via Wavlake', type: 'node', split: 100,
    address: '02682b7c86f474d082fa9d274c3751291225448468691784c6f112187de975a8c2',
    customKey: '16180339', customValue: '0c641fc5-4eee-47b9-aa66-8f0060374570',
  }],
};

const KEYSEND_MULTI = {
  type: 'lightning', method: 'keysend',
  recipients: [
    { fee: false, name: 'Music Side Project', type: 'node', split: 5, address: '030a58b8653d32b99200a2334cfe913e51dc7d155aa0116c176657a4f1722677a3', customKey: '696969', customValue: 'UzrnTK2oEHR55gw7Djmb' },
    { fee: false, name: 'Fountain Boostbot', type: 'node', split: 1, address: '03b6f613e88bd874177c28c6ad83b3baba43c4c656f56be1f8df84669556054b79', customKey: '906608', customValue: '01arpnAY9hHWR1ihl8YyUr' },
    { fee: false, name: 'IPFSPodcasting.net', type: 'node', split: 5, address: '028eb5be336f7fdf2a4e40c57ff55d3d5d71277bb4197ea14957f756bff249e623' },
    { fee: true, name: 'Podcastindex.org', type: 'lnaddress', split: 1, address: 'podcastindex@getalby.com' },
  ],
};

// `customKey: null` rather than absent — the spelling that would reach a TLV
// record as a literal null, because JSON.stringify keeps null and drops
// undefined.
const LNADDRESS_NULLS = {
  type: 'lightning', method: 'lnaddress',
  recipients: [
    { fee: false, name: 'Sovereign Feeds', type: 'lnaddress', split: 3, address: 'steven@getalby.com', customKey: null, customValue: null },
    { fee: false, name: 'To Setto Setto', type: 'lnaddress', split: 97, address: 'setto@basspistol.com', customKey: null, customValue: null },
  ],
};

const STRING_SPLIT = {
  type: 'lightning', method: 'keysend',
  recipients: [{
    name: 'Martin Grooms via Wavlake', type: 'node', split: '100',
    address: '02682b7c86f474d082fa9d274c3751291225448468691784c6f112187de975a8c2',
    customKey: '16180339', customValue: '199e4582-bb90-483a-9793-117cdb36238e',
  }],
};

const WITH_SUGGESTED = {
  type: 'lightning', method: 'keysend', suggested: '0.00000005000',
  recipients: [
    { fee: false, name: 'Music Side Project', type: 'node', split: 1, address: '035ad2c954e264004986da2d9499e1732e5175e1dcef2453c921c6cdcc3536e9d8' },
    { fee: true, name: 'Podcastindex.org', type: 'lnaddress', split: 1, address: 'podcastindex@getalby.com' },
  ],
};

/**
 * Every vector is recorded as a CALL and the replay walks the whole list, so a
 * vector cannot be added without being proved. CLAUDE.md's rule — a check that
 * names some of its vectors by hand leaves the rest green against nothing.
 */
const vectors = [];
const vec = (label, kind, args, expect, opts = {}) =>
  vectors.push({ label, kind, args, expect, ...opts });

// ── dbValueBlock: must still work ──────────────────────────────────────────
vec('keysend, one recipient, real customKey/customValue', 'value', [KEYSEND_SINGLE],
  KEYSEND_SINGLE, { alsoNaive: true });
vec('keysend, four recipients including a fee payee', 'value', [KEYSEND_MULTI],
  KEYSEND_MULTI, { alsoNaive: true });
vec('block carrying `suggested`', 'value', [WITH_SUGGESTED], WITH_SUGGESTED, { alsoNaive: true });

// ── dbValueBlock: the refusals and repairs a cast gets wrong ───────────────
// Both are `alsoNaive`: returning null for null is trivially right, so no
// implementation gets them wrong. They are kept because they document the
// hazard — SQL reports these rows as present — not because they discriminate.
vec('the JSON value null — 139 rows hold it, SQL calls them present', 'value', [null], null,
  { alsoNaive: true });
vec('undefined column', 'value', [undefined], null, { alsoNaive: true });
vec('a bare array is not a block', 'value', [[]], null);
vec('no recipients array', 'value', [{ type: 'lightning', method: 'keysend' }], null);
vec('empty recipients array pays nobody', 'value',
  [{ type: 'lightning', method: 'keysend', recipients: [] }], null);
vec('numeric-string split is REPAIRED, not refused', 'value', [STRING_SPLIT], {
  type: 'lightning', method: 'keysend',
  recipients: [{
    type: 'node', address: '02682b7c86f474d082fa9d274c3751291225448468691784c6f112187de975a8c2',
    split: 100, name: 'Martin Grooms via Wavlake',
    customKey: '16180339', customValue: '199e4582-bb90-483a-9793-117cdb36238e',
  }],
});
vec('customKey/customValue null become ABSENT, never a literal null', 'value', [LNADDRESS_NULLS], {
  type: 'lightning', method: 'lnaddress',
  recipients: [
    { type: 'lnaddress', address: 'steven@getalby.com', split: 3, name: 'Sovereign Feeds', fee: false },
    { type: 'lnaddress', address: 'setto@basspistol.com', split: 97, name: 'To Setto Setto', fee: false },
  ],
});
vec('a split that is not a number at all fails the whole block', 'value',
  [{ type: 'lightning', method: 'keysend', recipients: [{ type: 'node', address: '02aa', split: 'half' }] }], null);
vec('hex-looking split is refused, never Number()d into 100', 'value',
  [{ type: 'lightning', method: 'keysend', recipients: [{ type: 'node', address: '02aa', split: '0x64' }] }], null);
vec('exponent-looking split is refused, never Number()d into 1000', 'value',
  [{ type: 'lightning', method: 'keysend', recipients: [{ type: 'node', address: '02aa', split: '1e3' }] }], null);
vec('a fractional weight is a document we do not understand', 'value',
  [{ type: 'lightning', method: 'keysend', recipients: [{ type: 'node', address: '02aa', split: 1.5 }] }], null);
vec('a negative weight is refused', 'value',
  [{ type: 'lightning', method: 'keysend', recipients: [{ type: 'node', address: '02aa', split: -1 }] }], null);
vec('an addressless recipient fails the block, never silently dropped', 'value',
  [{ type: 'lightning', method: 'keysend', recipients: [
    { type: 'node', address: '02aa', split: 50 }, { type: 'node', address: '', split: 50 }] }], null);
vec('all weights zero can pay nobody', 'value',
  [{ type: 'lightning', method: 'keysend', recipients: [{ type: 'node', address: '02aa', split: 0 }] }], null);
vec('a zero-weight recipient is KEPT beside a positive one', 'value',
  [{ type: 'lightning', method: 'keysend', recipients: [
    { type: 'node', address: '02aa', split: 0 }, { type: 'node', address: '02bb', split: 100 }] }],
  { type: 'lightning', method: 'keysend', recipients: [
    { type: 'node', address: '02aa', split: 0 }, { type: 'node', address: '02bb', split: 100 }] },
  { alsoNaive: true });

// ── dbRowToEpisode ─────────────────────────────────────────────────────────
const ROW = {
  itemGuid: '0c641fc5-4eee-47b9-aa66-8f0060374570',
  feedGuid: '637a34ed-b594-541c-9b1e-ce453f35a0be',
  title: 'Red-Nose Rendezvous',
  audioUrl: 'https://op3.dev/e,pg=637a34ed/https://d12wklypp119aj.cloudfront.net/track/0c641fc5.mp3',
  duration: 264,
  image: null,
  publishedAt: '2025-11-23T08:24:25.000Z',
  value: KEYSEND_SINGLE,
};
const ID = -fnvHash(`${ROW.feedGuid}:${ROW.itemGuid}`);

vec('a full row becomes an Episode', 'row', [ROW, { id: ID, feedId: 7, playlistGroup: 'Cycles' }], {
  id: ID, guid: ROW.itemGuid, title: 'Red-Nose Rendezvous', enclosureUrl: ROW.audioUrl,
  feedId: 7, podcastGuid: ROW.feedGuid, duration: 264,
  datePublished: Math.round(Date.parse(ROW.publishedAt) / 1000),
  value: KEYSEND_SINGLE, playlistGroup: 'Cycles',
}, { alsoNaive: true });
vec('no audio url is not a playable row', 'row',
  [{ ...ROW, audioUrl: '' }, { id: ID, feedId: 7 }], null);
vec('whitespace-only audio url is not a playable row', 'row',
  [{ ...ROW, audioUrl: '   ' }, { id: ID, feedId: 7 }], null);
vec('no item guid is not a row', 'row', [{ ...ROW, itemGuid: null }, { id: ID, feedId: 7 }], null);
vec('an unpayable value block leaves the row payable-by-fallthrough, not broken', 'row',
  [{ ...ROW, value: null }, { id: ID, feedId: 7 }], {
    id: ID, guid: ROW.itemGuid, title: 'Red-Nose Rendezvous', enclosureUrl: ROW.audioUrl,
    feedId: 7, podcastGuid: ROW.feedGuid, duration: 264,
    datePublished: Math.round(Date.parse(ROW.publishedAt) / 1000),
  });
vec('a zero duration is omitted rather than rendered as 0:00', 'row',
  [{ ...ROW, duration: 0, value: null }, { id: ID, feedId: 7 }], {
    id: ID, guid: ROW.itemGuid, title: 'Red-Nose Rendezvous', enclosureUrl: ROW.audioUrl,
    feedId: 7, podcastGuid: ROW.feedGuid,
    datePublished: Math.round(Date.parse(ROW.publishedAt) / 1000),
  });
// The accelerator must never answer with LESS than the call it replaces.
// Measured over the 8,807 playlist rows: 8 carry valueTimeSplits and 33 carry
// alternateEnclosures. Dropping the first moves money from a featured artist to
// the track owner mid-track, with every leg still reporting ✓.
vec('a row with valueTimeSplits falls through to PI rather than losing them', 'row',
  [{ ...ROW, valueTimeSplits: [{ startTime: 8, remoteItem: { feedGuid: 'x', itemGuid: 'y' } }] },
   { id: ID, feedId: 7 }], null);
vec('a row with alternateEnclosures falls through too', 'row',
  [{ ...ROW, alternateEnclosures: [{ type: 'audio/mpeg' }] }, { id: ID, feedId: 7 }], null);
vec('an EMPTY valueTimeSplits array is not a reason to refuse', 'row',
  [{ ...ROW, valueTimeSplits: [], alternateEnclosures: [], value: null }, { id: ID, feedId: 7 }], {
    id: ID, guid: ROW.itemGuid, title: 'Red-Nose Rendezvous', enclosureUrl: ROW.audioUrl,
    feedId: 7, podcastGuid: ROW.feedGuid, duration: 264,
    datePublished: Math.round(Date.parse(ROW.publishedAt) / 1000),
  });
vec('chaptersUrl is carried — 381 rows have one', 'row',
  [{ ...ROW, chaptersUrl: 'https://example.test/ch.json', value: null }, { id: ID, feedId: 7 }], {
    id: ID, guid: ROW.itemGuid, title: 'Red-Nose Rendezvous', enclosureUrl: ROW.audioUrl,
    feedId: 7, podcastGuid: ROW.feedGuid, duration: 264,
    datePublished: Math.round(Date.parse(ROW.publishedAt) / 1000),
    chaptersUrl: 'https://example.test/ch.json',
  });
vec('a non-http chaptersUrl is dropped, never handed to the chapters proxy', 'row',
  [{ ...ROW, chaptersUrl: 'javascript:alert(1)', value: null }, { id: ID, feedId: 7 }], {
    id: ID, guid: ROW.itemGuid, title: 'Red-Nose Rendezvous', enclosureUrl: ROW.audioUrl,
    feedId: 7, podcastGuid: ROW.feedGuid, duration: 264,
    datePublished: Math.round(Date.parse(ROW.publishedAt) / 1000),
  });
vec('a Date object publishedAt lands in SECONDS, not milliseconds', 'row',
  [{ ...ROW, publishedAt: new Date('2025-11-23T08:24:25.000Z'), value: null }, { id: ID, feedId: 7 }], {
    id: ID, guid: ROW.itemGuid, title: 'Red-Nose Rendezvous', enclosureUrl: ROW.audioUrl,
    feedId: 7, podcastGuid: ROW.feedGuid, duration: 264,
    datePublished: Math.round(Date.parse('2025-11-23T08:24:25.000Z') / 1000),
  });

/**
 * The obvious implementation: trust the database, because the field names
 * match. It renders every one of the must-still-work vectors identically —
 * which is the point. It is the vectors above it that separate them.
 */
const naive = {
  value: (raw) => (raw && typeof raw === 'object' ? raw : null),
  row: (row, opts) => ({
    id: opts.id, guid: row.itemGuid, title: row.title, enclosureUrl: row.audioUrl,
    feedId: opts.feedId, podcastGuid: row.feedGuid, duration: row.duration,
    datePublished: Math.round(Date.parse(row.publishedAt) / 1000),
    value: row.value, playlistGroup: opts.playlistGroup, chaptersUrl: row.chaptersUrl,
  }),
};
const real = { value: dbValueBlock, row: dbRowToEpisode };

const stable = (v) => {
  if (v === null || v === undefined) return String(v);
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val);
};
const call = (which, v) => {
  try { return stable((which === 'real' ? real : naive)[v.kind](...v.args)); }
  catch (e) { return `THREW ${e.message}`; }
};

console.log('\n  playlist database mapping\n');
for (const v of vectors) {
  if (!real[v.kind] || !naive[v.kind]) { fail(`no implementation for kind "${v.kind}"`); continue; }
  const got = call('real', v);
  const want = stable(v.expect);
  if (got !== want) {
    fail(`${v.label}\n          got  ${got}\n          want ${want}`);
    continue;
  }
  if (v.alsoNaive) { ok(`${v.label} (must-still-work — naive() may agree)`); continue; }
  if (got !== call('naive', v)) ok(`${v.label} — and naive() gets it wrong`);
  else {
    fail(`"${v.label}" passes against naive() too — the vector proves nothing.\n`
      + '          Mark it { alsoNaive: true } if it is a must-still-work input.');
  }
}
console.log(`  ${vectors.length} vector(s) replayed, ${vectors.filter((v) => v.alsoNaive).length} exempt as must-still-work`);

// ── The two cross-checks a vector list cannot make ─────────────────────────
console.log('\n  arithmetic and identity\n');

// The repaired weight must be one `splitSats` divides by correctly, and the
// forms the mapper REFUSES must be ones the splitter would silently misread —
// otherwise the strictness is cost with no benefit. Asserted against the real
// splitter rather than against a number.
{
  const block = dbValueBlock(STRING_SPLIT);
  const sats = splitSats(100, block.recipients);
  if (sats.length === 1 && sats[0] === 100) ok('a repaired "100" split allocates 100 sats');
  else fail(`repaired split allocated ${JSON.stringify(sats)}`);

  // The digit-string form is already safe in the splitter — say so, so nobody
  // "fixes" this module believing it prevents a live money bug.
  const raw = splitSats(100, STRING_SPLIT.recipients);
  if (raw.length === 1 && raw[0] === 100) {
    ok('and the RAW digit string was already safe — Math.max coerces it (the repair is about type, not payment)');
  } else fail(`a digit-string split no longer allocates as expected: ${JSON.stringify(raw)}`);

  // These are why the digits test is strict. None occurs in the data today.
  const two = (split) => [{ type: 'node', address: '02aa', split }, { type: 'node', address: '02bb', split: 50 }];
  const hex = splitSats(100, two('0x64'));
  const exp = splitSats(100, two('1e3'));
  if (hex[0] === 67 && exp[0] === 95) {
    ok("'0x64' reads as 100 and '1e3' as 1000 inside splitSats — so the mapper must refuse them");
  } else {
    fail(`splitSats no longer misreads the loose forms (${JSON.stringify(hex)}, ${JSON.stringify(exp)});`
      + ' the strict digits test may no longer be earning its cost');
  }
  if (dbValueBlock({ type: 'lightning', method: 'keysend', recipients: two('0x64') }) === null
    && dbValueBlock({ type: 'lightning', method: 'keysend', recipients: two('1e3') }) === null) {
    ok('and the mapper refuses both, so they fall through to Podcast Index');
  } else fail('the mapper accepted a loose numeric-string split');
}

// The id must equal what the route's `placeholder` builds for the same ref, or
// one track resolved two ways becomes two rows with two React keys.
{
  const ep = dbRowToEpisode(ROW, { id: -fnvHash(`${ROW.feedGuid}:${ROW.itemGuid}`), feedId: 7 });
  if (ep.id === -fnvHash(`${ROW.feedGuid}:${ROW.itemGuid}`)) {
    ok('row id matches the placeholder id for the same (feedGuid, itemGuid)');
  } else fail('row id does not match the placeholder id');
}

// Every recipient a block yields must survive a JSON round trip with no null
// fields — that is what reaches the TLV record.
{
  const block = dbValueBlock(LNADDRESS_NULLS);
  const json = JSON.stringify(block);
  if (!json.includes('null')) ok('no literal null survives into a boostagram recipient');
  else fail(`a null reached the serialized block: ${json}`);
}

if (failures) {
  console.error(`\n${failures} playlist-db check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll playlist-db checks passed.');
