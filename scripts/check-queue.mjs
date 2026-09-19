// Pins the four pure decisions the listen queue rests on.
//
// Usage:
//   npm run check:queue
//
// Run it after ANY edit to the queue helpers in lib/util.ts.
//
// WHY THIS EARNS A CHECK SCRIPT. The queue is a list somebody assembled by
// hand, it persists per npub, and every one of these fails SILENTLY.
//
// `epKey` is the identity of a queued item. It decides which row a Remove press
// takes, which row `queueIndexOf` matches, and whether an add is a duplicate.
// It shipped as `e.guid ?? …`, and `??` falls through only on null and
// undefined — so a feed publishing `<guid></guid>` gave every one of its
// episodes the key `''`. `extractText` in lib/pi.ts returns undefined for a
// MISSING or self-closing tag and an empty string for an empty one, which it
// trims; PI's JSON carries `""` the same way. The failure is the queue removing
// or jumping to the wrong episode, on feeds this app already parses.
//
// `trimForQueue` is a DENYLIST, and that is the whole decision. The two large
// fields the queue never renders come out; everything else stays. An allowlist
// looks tidier and is wrong in one direction that matters: it drops whatever is
// added to `Episode` next, and the fields most likely to be added here are
// money. Losing prose costs a refetch. Losing `valueTimeSplits` streams a music
// show to the show instead of to each artist, invisibly, days after the queue
// was built.
//
// `queueShowFor` is the container rule. A `musicL` playlist lists tracks living
// in hundreds of other feeds, and `<EpisodeList>` renders those containers — so
// the feed you were looking at is not always the show you queued. It refuses
// NARROWLY, the same shape as `payableValue`: the item must declare its own
// `podcastGuid` and it must disagree.
//
// `nextPlayableIndexBy` is the walk `stepTo` and both halves of
// `<TransportControls>` share. If they disagree, ⏭ draws enabled over a step
// that refuses to move, or disabled over one that would — which is exactly the
// bug PR #132's own browser pass found on the last chapter of a queued episode.
//
// So all four live in lib/util.ts, whose only import is type-only, and this
// script imports the REAL module under `--experimental-strip-types`. A
// reimplemented copy here would stay green while the shipping code drifted.
// (It deliberately does NOT run `importFreeProblems`: that scan rejects
// type-only relative imports, and lib/util.ts has one. `check:vts` imports this
// same module on the same terms.)
//
// EVERY VECTOR IS A RECORDED CALL, NOT A BARE ASSERTION. The `naive*` functions
// at the foot are the obvious wrong versions, and the whole list is replayed
// against them, because a vector that passes the moment it is written has
// proved nothing. Three of the four naives are not inventions: `naiveKey` is
// the `??` that shipped, `naiveShow` is the pass-through that shipped, and
// `naiveTrim` is the allowlist the denylist comment argues against. Exemptions
// are named one at a time with `alsoNaive: true` — the must-still-work half,
// where over-blocking would be its own regression.

import {
  epKey,
  LISTEN_QUEUE_CAP,
  nextPlayableIndexBy,
  queueShowFor,
  trimForQueue,
} from '../lib/util.ts';

let failures = 0;
const vectors = [];

function compare(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${label}`); return; }
  failures += 1;
  console.error(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
}

function section(name) { console.log(`\n${name}`); }

/** An epKey vector. `alsoNaive` marks a must-still-work input. */
function checkKey(label, ep, expected, { alsoNaive = false } = {}) {
  compare(label, epKey(ep), expected);
  vectors.push({ label, kind: 'key', args: [ep], alsoNaive });
}

/** A trimForQueue vector: assert on the KEYS that survive, sorted. */
function checkTrim(label, ep, expected, { alsoNaive = false } = {}) {
  compare(label, Object.keys(trimForQueue(ep)).sort(), expected);
  vectors.push({ label, kind: 'trim', args: [ep], alsoNaive });
}

/** A queueShowFor vector: assert on the fields the container rule governs. */
function checkShow(label, args, expected, { alsoNaive = false } = {}) {
  const p = queueShowFor(...args);
  compare(label, { guid: p.podcastGuid, title: p.title, value: !!p.value }, expected);
  vectors.push({ label, kind: 'show', args, alsoNaive });
}

/** A nextPlayableIndexBy vector. */
function checkWalk(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, nextPlayableIndexBy(...args), expected);
  vectors.push({ label, kind: 'walk', args, alsoNaive });
}

// ---------------------------------------------------------------------------
section('epKey: the guid when there is one, and a feed-scoped id when there is not');
// ---------------------------------------------------------------------------
checkKey('a real guid is the key', { guid: 'ep-abc', feedId: 41504, id: 9 }, 'ep-abc', { alsoNaive: true });
checkKey('no guid falls back to feed:id', { feedId: 41504, id: 9 }, '41504:9', { alsoNaive: true });
checkKey('an explicit undefined guid falls back', { guid: undefined, feedId: 7, id: 1 }, '7:1', { alsoNaive: true });

// THE ONE THIS SCRIPT EXISTS FOR. `<guid></guid>` reaches Episode as '', and
// `??` keeps it — so two different episodes of the same feed collided on ''.
checkKey('an EMPTY guid falls back rather than becoming the key', { guid: '', feedId: 41504, id: 9 }, '41504:9');
checkKey('a second empty-guid episode gets a DIFFERENT key', { guid: '', feedId: 41504, id: 10 }, '41504:10');
checkKey('an empty guid on another feed does not collide either', { guid: '', feedId: 99, id: 9 }, '99:9');

// ---------------------------------------------------------------------------
section('trimForQueue: a denylist — the two big fields go, everything else stays');
// ---------------------------------------------------------------------------
const FULL = {
  guid: 'ep-1', id: 1, feedId: 41504, title: 'A track', enclosureUrl: 'https://x/1.mp3',
  description: 'a long description', contentEncoded: '<p>even longer</p>',
  value: { model: { type: 'lightning' }, recipients: [] },
  valueTimeSplits: [{ startTime: 10, duration: 5 }],
  image: 'https://x/a.png', duration: 120, datePublished: 1,
};
checkTrim('description and contentEncoded come out; both value fields stay', FULL, [
  'datePublished', 'duration', 'enclosureUrl', 'feedId', 'guid', 'id', 'image',
  'title', 'value', 'valueTimeSplits',
]);
checkTrim('an episode with neither big field is unchanged',
  { guid: 'ep-2', id: 2, feedId: 1, title: 'B', enclosureUrl: 'https://x/2.mp3' },
  ['enclosureUrl', 'feedId', 'guid', 'id', 'title'], { alsoNaive: true });

// THE DENYLIST PROPERTY. A field nobody has written yet must survive, because
// the next one added to `Episode` is as likely to be money as prose.
checkTrim('a field this script has never heard of SURVIVES', { ...FULL, someFutureMoneyField: 1 }, [
  'datePublished', 'duration', 'enclosureUrl', 'feedId', 'guid', 'id', 'image',
  'someFutureMoneyField', 'title', 'value', 'valueTimeSplits',
]);

// ---------------------------------------------------------------------------
section('queueShowFor: the container is not always the show');
// ---------------------------------------------------------------------------
const ALBUM = { id: 100, podcastGuid: 'album-guid', title: 'The Album', value: { model: {}, recipients: [] } };
const PLAYLIST = { id: 200, podcastGuid: 'playlist-guid', title: "Curator's Playlist", value: { model: {}, recipients: [] } };

checkShow('a feed that IS the parent is kept whole',
  [{ guid: 'e1', id: 1, feedId: 100, podcastGuid: 'album-guid' }, ALBUM],
  { guid: 'album-guid', title: 'The Album', value: true }, { alsoNaive: true });
checkShow('an item with no guid of its own keeps the container',
  [{ guid: 'e2', id: 2, feedId: 100 }, ALBUM],
  { guid: 'album-guid', title: 'The Album', value: true }, { alsoNaive: true });

// The refusal: both guids present and disagreeing.
checkShow('a playlist track records ITS OWN feed, not the curator\'s',
  [{ guid: 'e3', id: 3, feedId: 777, podcastGuid: 'track-album-guid', feedTitle: 'Real Album' }, PLAYLIST],
  { guid: 'track-album-guid', title: 'Real Album', value: false });
checkShow('with no feedTitle it falls back to the track title, never the playlist\'s',
  [{ guid: 'e4', id: 4, feedId: 778, podcastGuid: 'other-guid', title: 'Just The Track' }, PLAYLIST],
  { guid: 'other-guid', title: 'Just The Track', value: false });

// ---------------------------------------------------------------------------
section('nextPlayableIndexBy: the walk that skips rows which would play silence');
// ---------------------------------------------------------------------------
const row = (x) => x;
const Q = [
  { enclosureUrl: 'https://x/0.mp3' },
  { enclosureUrl: '' },                       // an unresolved <podcast:remoteItem>
  { enclosureUrl: 'https://x/2.mp3', unresolved: true },
  { enclosureUrl: 'https://x/3.mp3' },
];
checkWalk('forward from 0 skips both dead rows', [Q, 0, 1, row], 3);
checkWalk('back from 3 skips them too', [Q, 3, -1, row], 0);
// The three boundary answers below are must-still-work: plain arithmetic
// reaches -1 there too, and it must. Over-blocking an end-of-queue step would
// be its own regression — it is what draws ⏭ disabled over a move that works.
checkWalk('no playable row ahead answers -1, never the length', [Q, 3, 1, row], -1, { alsoNaive: true });
checkWalk('no playable row behind answers -1', [Q, 0, -1, row], -1, { alsoNaive: true });
checkWalk('a clean queue steps by one', [[Q[0], Q[3]], 0, 1, row], 1, { alsoNaive: true });
checkWalk('an empty queue answers -1', [[], 0, 1, row], -1, { alsoNaive: true });

// ---------------------------------------------------------------------------
section('The cap is a number this repo states, not one a caller passes');
// ---------------------------------------------------------------------------
compare('LISTEN_QUEUE_CAP is 50', LISTEN_QUEUE_CAP, 50);

// ---------------------------------------------------------------------------
section('Every vector above is replayed against the obvious wrong version');
// ---------------------------------------------------------------------------
{
  // NOT AN INVENTION: this is the operator that shipped. `??` keeps an empty
  // string, so it is right on every guid that exists and wrong on every one
  // that is present-but-empty.
  const naiveKey = (e) => e.guid ?? `${e.feedId}:${e.id}`;

  // The allowlist the denylist comment argues against: name what the queue
  // renders, ship it. Right on an episode carrying nothing else, and quietly
  // fatal the day a money field is added to `Episode`.
  const naiveTrim = (e) => {
    const keep = ['guid', 'id', 'feedId', 'title', 'enclosureUrl', 'image', 'duration', 'datePublished'];
    const out = {};
    for (const k of keep) if (e[k] !== undefined) out[k] = e[k];
    return out;
  };

  // Also not an invention: the pass-through that shipped. Right whenever the
  // container really is the parent, wrong for every playlist track.
  const naiveShow = (_episode, podcast) => podcast;

  // What someone writes when the step looks like arithmetic. It hands back a
  // dead row, which reports as playing and is silent.
  const naiveWalk = (queue, from, step) => {
    const to = from + step;
    return to >= 0 && to < queue.length ? to : -1;
  };

  const call = (impl, v) => {
    try {
      const real = impl === 'real';
      switch (v.kind) {
        case 'key':
          return JSON.stringify(real ? epKey(...v.args) : naiveKey(...v.args));
        case 'trim':
          return JSON.stringify(Object.keys(real ? trimForQueue(...v.args) : naiveTrim(...v.args)).sort());
        case 'show': {
          const p = real ? queueShowFor(...v.args) : naiveShow(...v.args);
          return JSON.stringify({ guid: p.podcastGuid, title: p.title, value: !!p.value });
        }
        case 'walk':
          return JSON.stringify(real ? nextPlayableIndexBy(...v.args) : naiveWalk(...v.args));
        default: throw new Error(`unknown vector kind ${v.kind}`);
      }
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
    if (differs) { console.log(`  ok    naive() gets "${v.label}" wrong`); continue; }
    failures += 1;
    console.error(`  FAIL  "${v.label}" passes against naive() too — the vector proves nothing.`);
    console.error('          Either it is a must-still-work input (mark it { alsoNaive: true })');
    console.error('          or it does not exercise anything the real module adds.');
  }
  console.log(`  ${vectors.length} vector(s) replayed, ${exempt} exempt as must-still-work`);
}

if (failures) {
  console.error(`\n${failures} queue check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll queue checks passed.');
