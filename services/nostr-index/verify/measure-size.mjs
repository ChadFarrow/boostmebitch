// Load a realistic corpus through the REAL ingest path and measure what
// Postgres actually stores. Not arithmetic on estimates — the tables, the
// indexes and the TOAST overhead as the database reports them.
//
// Corpus size is taken from ReedBTC/onlyboosts, which publishes a measurement
// of the same network-wide podcast boost stream this indexes.

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { getPool, closePool } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import { ingestEvent, emptyStats } from '../src/store.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const SCALE = Number(process.env.SCALE || 1);

// --- corpus, from onlyboosts' published numbers -----------------------------
const N_BOOSTS   = Math.round(22400 * SCALE);
const N_REPLIES  = Math.round(2200  * SCALE);   // ~10% of boosts draw a reply
const N_ZAPS     = Math.round(8000  * SCALE);   // kind:9735 for tracked pubkeys
const N_REPOSTS  = Math.round(1500  * SCALE);
const N_PROFILES = Math.round(2000  * SCALE);
const N_SHOWS    = Math.round(1300  * SCALE);
const N_EPISODES = Math.round(6700  * SCALE);

const db = getPool(DATABASE_URL);
await migrate(DATABASE_URL);
await db.query('truncate events, event_tags, profiles, tracked_pubkeys, pi_queue, pi_podcasts, pi_episodes, indexer_state cascade');

// A pool of authors, so tracked_pubkeys and profiles are realistically sized
// rather than one key per note.
const authors = Array.from({ length: N_PROFILES }, () => generateSecretKey());
const authorPks = authors.map(getPublicKey);
const pick = (i) => authors[i % authors.length];
const hex = (n) => n.toString(16).padStart(64, '0');
// A UUID-shaped guid that actually VARIES with n. The obvious version —
// slicing hex(n) — pads to 64 zeros, so every small n produced the identical
// string and the pi_podcasts table came out with one row instead of 1,300.
const uuid = (n) => {
  const a = (n + 0x1000000).toString(16).padStart(8, '0');
  const b = ((n * 2654435761) >>> 0).toString(16).padStart(8, '0');
  return `${a}-${b.slice(0, 4)}-4${b.slice(4, 7)}-a${a.slice(0, 3)}-${b}${a.slice(0, 4)}`;
};

const BASE = 1750000000;

// A boost note as THIS APP publishes it (lib/nostr/boost-notes.ts): two i tags,
// two k tags, r links, p tags for the feed's npubs, an imeta carrying the OG
// banner URL, amount, client, and two t tags.
function boostNote(i) {
  const sk = pick(i);
  const feed = uuid(i % N_SHOWS);
  const item = `https://example.com/podcast/episode-${i % N_EPISODES}-permalink`;
  const og = `https://www.boostmebitch.com/api/og/boost.png?art=${encodeURIComponent(`https://feeds.example.com/artwork/${i % N_SHOWS}-3000x3000.jpg`)}&sats=${100 + (i % 5000)}&show=${encodeURIComponent('An Example Podcast Name')}&ep=${encodeURIComponent('Episode ' + (i % 400) + ' - A Reasonably Long Episode Title')}`;
  const content =
    `Crimson Rook boosted ${100 + (i % 5000)} sats on An Example Podcast Name - Episode ${i % 400}\n\n` +
    `"${'great track, thanks for the show '.repeat(1 + (i % 3))}"\n\n` +
    `https://www.boostmebitch.com/?podcast=${feed}\n\n${og}`;
  const tags = [
    ['i', `podcast:guid:${feed}`],
    ['k', 'podcast:guid'],
    ['i', `podcast:item:guid:${item}`],
    ['k', 'podcast:item:guid'],
    ['r', `https://feeds.example.com/show-${i % N_SHOWS}/rss.xml`],
    ['r', `https://www.boostmebitch.com/?podcast=${feed}`],
    ['imeta', `url ${og}`, 'm image/png', 'dim 1200x300'],
    ['amount', String((100 + (i % 5000)) * 1000)],
    ['client', 'BoostMeBitch'],
    ['t', 'boostagram'],
    ['t', 'value4value'],
  ];
  // Feeds carry 0-3 npubs to p-tag.
  for (let p = 0; p < i % 4; p++) tags.push(['p', authorPks[(i + p) % authorPks.length]]);
  return finalizeEvent({ kind: 1, created_at: BASE - i * 60, content, tags }, sk);
}

function reply(i, parentId) {
  return finalizeEvent({
    kind: 1, created_at: BASE - i * 60 + 30,
    content: 'Nice one, this is a reply of fairly ordinary length for a Nostr thread.',
    tags: [['e', parentId, '', 'root'], ['p', authorPks[i % authorPks.length]], ['i', `podcast:guid:${uuid(i % N_SHOWS)}`], ['k', 'podcast:guid']],
  }, pick(i + 7));
}

// A zap receipt carries the whole kind:9734 request JSON in a description tag,
// plus a bolt11. These are the heaviest events on the wire.
function zapReceipt(i) {
  const request = JSON.stringify({
    kind: 9734, pubkey: authorPks[i % authorPks.length], created_at: BASE - i * 90,
    content: 'thanks for the tune', id: hex(i), sig: hex(i).repeat(2),
    tags: [['p', authorPks[(i + 1) % authorPks.length]], ['relays', 'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'], ['amount', '21000']],
  });
  return finalizeEvent({
    kind: 9735, created_at: BASE - i * 90, content: '',
    tags: [
      ['p', authorPks[(i + 1) % authorPks.length]],
      ['P', authorPks[i % authorPks.length]],
      ['bolt11', 'lnbc210n1' + 'p'.repeat(180)],
      ['description', request],
      ['preimage', hex(i)],
    ],
  }, pick(i + 13));
}

function repost(i, targetId) {
  return finalizeEvent({
    kind: 6, created_at: BASE - i * 120, content: '',
    tags: [['e', targetId], ['p', authorPks[i % authorPks.length]]],
  }, pick(i + 3));
}

function profile(i) {
  return finalizeEvent({
    kind: 0, created_at: BASE,
    content: JSON.stringify({
      name: `booster${i}`, display_name: `Booster Number ${i}`,
      about: 'Bitcoiner, podcaster, value4value enjoyer. '.repeat(3),
      picture: `https://image.nostr.build/${hex(i).slice(0, 40)}.jpg`,
      banner: `https://image.nostr.build/${hex(i + 1).slice(0, 40)}.jpg`,
      nip05: `booster${i}@example.com`, lud16: `booster${i}@getalby.com`,
      website: 'https://example.com',
    }),
    tags: [],
  }, authors[i % authors.length]);
}

const t0 = Date.now();
const stats = emptyStats();
const boostIds = [];

process.stdout.write(`seeding ${N_BOOSTS} boosts`);
for (let i = 0; i < N_BOOSTS; i++) {
  const e = boostNote(i);
  boostIds.push(e.id);
  await ingestEvent(db, e, stats);
  if (i % 2000 === 0) process.stdout.write('.');
}
process.stdout.write(`\nseeding ${N_REPLIES} replies, ${N_ZAPS} zaps, ${N_REPOSTS} reposts, ${N_PROFILES} profiles`);
for (let i = 0; i < N_REPLIES; i++) await ingestEvent(db, reply(i, boostIds[i % boostIds.length]), stats);
for (let i = 0; i < N_ZAPS; i++) await ingestEvent(db, zapReceipt(i), stats);
for (let i = 0; i < N_REPOSTS; i++) await ingestEvent(db, repost(i, boostIds[i % boostIds.length]), stats);
for (let i = 0; i < N_PROFILES; i++) await ingestEvent(db, profile(i), stats);
console.log(`\ningest: ${JSON.stringify(stats)} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// --- the Podcast Index cache ------------------------------------------------
// PI's episode record carries full shownotes, which onlyboosts calls "the one
// heavier column". Sized at a realistic 2 KB of HTML.
const shownotes = '<p>In this episode we talk about a great many things, and here are the links.</p>'.repeat(25);
for (let i = 0; i < N_SHOWS; i++) {
  await db.query(
    `insert into pi_podcasts (guid, data, miss) values ($1, $2::jsonb, false) on conflict do nothing`,
    [uuid(i), JSON.stringify({
      id: i, podcastGuid: uuid(i), title: `An Example Podcast Name ${i}`,
      url: `https://feeds.example.com/show-${i}/rss.xml`, originalUrl: `https://feeds.example.com/show-${i}/rss.xml`,
      author: 'An Example Author', ownerName: 'An Example Author',
      image: `https://feeds.example.com/artwork/${i}-3000x3000.jpg`,
      artwork: `https://feeds.example.com/artwork/${i}-3000x3000.jpg`,
      description: 'A description of the show that runs to a paragraph or so. '.repeat(6),
      medium: i % 5 === 0 ? 'music' : 'podcast', language: 'en', categories: { 1: 'Technology', 2: 'News' },
      value: { model: { type: 'lightning', method: 'keysend' }, destinations: Array.from({ length: 4 }, (_, d) => ({ name: `Recipient ${d}`, type: 'node', address: hex(d), split: 25 })) },
    })],
  );
}
for (let i = 0; i < N_EPISODES; i++) {
  await db.query(
    `insert into pi_episodes (feed_guid, item_guid, data, miss) values ($1, $2, $3::jsonb, false) on conflict do nothing`,
    [uuid(i % N_SHOWS), `https://example.com/podcast/episode-${i}-permalink`, JSON.stringify({
      id: i, title: `Episode ${i} - A Reasonably Long Episode Title`,
      guid: `https://example.com/podcast/episode-${i}-permalink`,
      link: `https://example.com/podcast/episode-${i}`,
      description: shownotes, datePublished: BASE - i * 86400, duration: 3600 + i,
      enclosureUrl: `https://cdn.example.com/audio/episode-${i}.mp3`, enclosureLength: 90000000,
      image: `https://feeds.example.com/artwork/ep-${i}.jpg`, feedImage: `https://feeds.example.com/artwork/${i % N_SHOWS}-3000x3000.jpg`,
      feedId: i % N_SHOWS, podcastGuid: uuid(i % N_SHOWS), feedTitle: `An Example Podcast Name ${i % N_SHOWS}`,
    })],
  );
}

await db.query('analyze');

// --- what Postgres actually holds -------------------------------------------
const { rows } = await db.query(`
  select relname as table,
         to_char((select count(*) from pg_class c2 where false), 'FM9') as _ignore,
         pg_total_relation_size(c.oid)            as total,
         pg_table_size(c.oid)                     as heap_plus_toast,
         pg_indexes_size(c.oid)                   as indexes
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
   order by pg_total_relation_size(c.oid) desc`);

const counts = {};
for (const t of ['events', 'event_tags', 'profiles', 'pi_podcasts', 'pi_episodes', 'tracked_pubkeys', 'pi_queue']) {
  counts[t] = Number((await db.query(`select count(*)::int as n from ${t}`)).rows[0].n);
}

const mb = (b) => (Number(b) / 1024 / 1024).toFixed(1);
let total = 0;
console.log('\n' + 'table'.padEnd(18) + 'rows'.padStart(10) + 'data'.padStart(10) + 'indexes'.padStart(10) + 'total'.padStart(10));
console.log('-'.repeat(58));
for (const r of rows) {
  if (!counts[r.table] && !Number(r.total)) continue;
  total += Number(r.total);
  console.log(
    r.table.padEnd(18) +
    String(counts[r.table] ?? '').padStart(10) +
    (mb(r.heap_plus_toast) + 'M').padStart(10) +
    (mb(r.indexes) + 'M').padStart(10) +
    (mb(r.total) + 'M').padStart(10),
  );
}
console.log('-'.repeat(58));
console.log('TOTAL'.padEnd(18) + ''.padStart(10) + ''.padStart(10) + ''.padStart(10) + (mb(total) + 'M').padStart(10));
const dbSize = (await db.query(`select pg_database_size(current_database()) as n`)).rows[0].n;
console.log(`\npg_database_size (includes catalogs): ${mb(dbSize)} MB`);
console.log(`scale factor: ${SCALE}x`);

await closePool();
