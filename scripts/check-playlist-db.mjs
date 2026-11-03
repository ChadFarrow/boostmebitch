// Pins `dbRowToEpisode` (lib/playlist-db-map.ts), the function that turns a row of
// ANOTHER APPLICATION'S database into a track this app renders.
//
// `/api/playlist` resolves a playlist's tracks through Podcast Index, one
// `batchEpisodes` call per page. The StableKraft database already holds 13,783
// of those tracks, so it is used as an accelerator in front of PI: a hit skips
// the call, a miss falls through. That fall-through is the whole safety argument
// for this module, and it is what makes REFUSING the safe direction here.
//
// A row carries NO PAYEE. The database has a value column under the same field
// names ours uses, and it is a crawl, months behind, so only a track's own feed
// names who it pays. A mapped column would type-check, render correctly, and pay
// the wrong person, which is why a stray column is one of the vectors below.
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
import { dbRowToEpisode } from '../lib/playlist-db-map.ts';
import { fnvHash } from '../lib/util.ts';

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

/**
 * Every vector is recorded as a CALL and the replay walks the whole list, so a
 * vector cannot be added without being proved. CLAUDE.md's rule — a check that
 * names some of its vectors by hand leaves the rest green against nothing.
 */
const vectors = [];
const vec = (label, kind, args, expect, opts = {}) =>
  vectors.push({ label, kind, args, expect, ...opts });

// ── dbRowToEpisode ─────────────────────────────────────────────────────────
const ROW = {
  itemGuid: '0c641fc5-4eee-47b9-aa66-8f0060374570',
  feedGuid: '637a34ed-b594-541c-9b1e-ce453f35a0be',
  title: 'Red-Nose Rendezvous',
  audioUrl: 'https://op3.dev/e,pg=637a34ed/https://d12wklypp119aj.cloudfront.net/track/0c641fc5.mp3',
  duration: 264,
  image: null,
  publishedAt: '2025-11-23T08:24:25.000Z',
};
const ID = -fnvHash(`${ROW.feedGuid}:${ROW.itemGuid}`);

vec('a full row becomes an Episode', 'row',
  [ROW, { id: ID, feedId: 7, playlistGroup: 'Cycles', playlistPlays: 24 }], {
    id: ID, guid: ROW.itemGuid, title: 'Red-Nose Rendezvous', enclosureUrl: ROW.audioUrl,
    feedId: 7, podcastGuid: ROW.feedGuid, duration: 264,
    datePublished: Math.round(Date.parse(ROW.publishedAt) / 1000),
    playlistGroup: 'Cycles', playlistPlays: 24,
  }, { alsoNaive: true });
vec('no audio url is not a playable row', 'row',
  [{ ...ROW, audioUrl: '' }, { id: ID, feedId: 7 }], null);
vec('whitespace-only audio url is not a playable row', 'row',
  [{ ...ROW, audioUrl: '   ' }, { id: ID, feedId: 7 }], null);
vec('no item guid is not a row', 'row', [{ ...ROW, itemGuid: null }, { id: ID, feedId: 7 }], null);
vec('a stray value column never reaches the row: the database names no payee', 'row',
  [{ ...ROW, value: KEYSEND_SINGLE }, { id: ID, feedId: 7 }], {
    id: ID, guid: ROW.itemGuid, title: 'Red-Nose Rendezvous', enclosureUrl: ROW.audioUrl,
    feedId: 7, podcastGuid: ROW.feedGuid, duration: 264,
    datePublished: Math.round(Date.parse(ROW.publishedAt) / 1000),
  });
vec('a null value column leaves NO value key, so the row reads as not read', 'row',
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

// ── The seconds-vs-milliseconds branch ─────────────────────────────────────
// `publishedAt` arrives as a STRING today and as a Date under some drivers, so
// the NUMBER branch had no vector at all — and it shipped with its threshold
// five orders of magnitude low (`< 1e6`), which sent a genuine seconds value
// down the millisecond branch and divided it a second time. Every such track
// dated to January 1970, on the row AND inside `FavoriteEpisode.datePublished`,
// i.e. inside the shared kind:10333 event that has no undo.
//
// `datePublished` is the ONLY field that can separate these from naive().
const PUB_MS = Date.parse('2025-11-23T08:24:25.000Z');
const PUB_S = Math.round(PUB_MS / 1000);
vec('a numeric publishedAt ALREADY in seconds is left alone', 'row',
  [{ ...ROW, publishedAt: PUB_S }, { id: ID, feedId: 7 }], {
    id: ID, guid: ROW.itemGuid, title: 'Red-Nose Rendezvous', enclosureUrl: ROW.audioUrl,
    feedId: 7, podcastGuid: ROW.feedGuid, duration: 264, datePublished: PUB_S,
  });
vec('a numeric publishedAt in milliseconds is converted exactly once', 'row',
  [{ ...ROW, publishedAt: PUB_MS }, { id: ID, feedId: 7 }], {
    id: ID, guid: ROW.itemGuid, title: 'Red-Nose Rendezvous', enclosureUrl: ROW.audioUrl,
    feedId: 7, podcastGuid: ROW.feedGuid, duration: 264, datePublished: PUB_S,
  });

// ── The refusal tests SHAPE, not "is this a non-empty array" ───────────────
// `pg` decodes a Json column into a JS array today, so the guard shipped as
// `Array.isArray(raw) && raw.length > 0` and every OTHER shape read as "no
// data", skipping the refusal it exists to perform. The shapes below are the
// ones a Prisma schema change produces without touching this repo: Json → String
// hands the array back as text, and an app writing an object map hands back an
// object. A row accepted without its valueTimeSplits pays the track owner
// instead of the featured artist, with every leg reporting ✓.
vec('valueTimeSplits as a JSON STRING still refuses the row', 'row',
  [{ ...ROW, valueTimeSplits: '[{"startTime":8,"remoteItem":{"feedGuid":"x"}}]' },
   { id: ID, feedId: 7 }], null);
vec('valueTimeSplits as an object map still refuses the row', 'row',
  [{ ...ROW, valueTimeSplits: { 0: { startTime: 8 } } }, { id: ID, feedId: 7 }], null);
vec('alternateEnclosures as a JSON string still refuses the row', 'row',
  [{ ...ROW, alternateEnclosures: '[{"type":"audio/mpeg"}]' }, { id: ID, feedId: 7 }], null);

// `ROW.image` is null, so no other vector reaches the image mapping at all.
vec('a row image is carried onto the Episode', 'row',
  [{ ...ROW, image: 'https://example.test/art.jpg' }, { id: ID, feedId: 7 }], {
    id: ID, guid: ROW.itemGuid, title: 'Red-Nose Rendezvous', enclosureUrl: ROW.audioUrl,
    feedId: 7, podcastGuid: ROW.feedGuid, duration: 264, datePublished: PUB_S,
    image: 'https://example.test/art.jpg',
  });

/**
 * The obvious implementation: trust the database, because the field names
 * match. It renders every one of the must-still-work vectors identically —
 * which is the point. It is the vectors above it that separate them.
 */
const naive = {
  row: (row, opts) => ({
    id: opts.id, guid: row.itemGuid, title: row.title, enclosureUrl: row.audioUrl,
    feedId: opts.feedId, podcastGuid: row.feedGuid, duration: row.duration,
    datePublished: Math.round(Date.parse(row.publishedAt) / 1000),
    value: row.value, playlistGroup: opts.playlistGroup, playlistPlays: opts.playlistPlays,
    chaptersUrl: row.chaptersUrl,
  }),
};
const real = { row: dbRowToEpisode };

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

if (failures) {
  console.error(`\n${failures} playlist-db check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll playlist-db checks passed.');
