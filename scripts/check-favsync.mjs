// Pins the cross-app favorites wire format and merge — kind 10333.
//
// Usage:
//   npm run check:favsync
//
// Run it after ANY edit to lib/nostr/favorites-list.ts.
//
// Why this earns a check script: the event is SHARED with other podcast apps
// and is REPLACEABLE, so every writer can destroy every other writer's data
// with one publish. There is no partial update and no undo. A bug here doesn't
// degrade the feature — it deletes favorites the user made in another app, on
// another device, silently, and the device that caused it shows nothing wrong.
//
// The format's whole difficulty is in one sentence: TAG ORDER IS THE DATA. An
// `i` tag is bare, so an item's parent feed is "the most recently opened feed
// group" and its medium is "the last ['medium', …] tag above it". Both are
// carried by position and by nothing on the entry. So the obvious
// implementation — parse into structs, merge the structs, rebuild the array —
// silently reattaches every item to the wrong feed and re-labels everything
// after a medium boundary. Nothing else in the format recovers the association,
// and nothing about it looks wrong on screen.
//
// FIXTURES ARE BUILT FROM LITERAL WIRE TAG ARRAYS, never from the struct they
// parse into. This is not style. The predecessor of this script shipped a
// vector literally named "lossless" that was green for the entire life of the
// feature while every publish truncated the tag it was meant to protect —
// because its input was constructed from the same fields it asserted on, so the
// comparison was vacuously true. A round trip whose input you built out of your
// own struct cannot fail. Every `parse(...)` below takes tags a relay could
// actually have sent.
//
// Several fixtures below are REAL, lifted verbatim from the live kind:10333
// event on relays (`npm run probe:favorites -- <npub> --dump f.json`). Real wire
// data is worth more than invented data precisely because it contains the
// shapes nobody thinks to invent — the non-UUID item guid
// `thenogs-donkey-01-porky-piggin-it` below is one, and a UUID-gated item parser
// would have looked correct forever without it.
//
// ON "A NEW VECTOR MUST BE SEEN TO FAIL FIRST": this replaced a different wire
// format outright, so running these against the predecessor proves nothing —
// the exports don't exist. The meaningful control is the OBVIOUS WRONG
// implementation, so `naive()` at the bottom is exactly that: parse to structs,
// merge by map, rebuild the array. The vectors marked (naive) are asserted to
// FAIL against it, which is what stops this file from being a set of assertions
// that were true the moment they were written.
//
// `--experimental-strip-types` lets this .mjs import the real .ts module. That
// is the whole point: a reimplemented copy stays green while the shipping format
// drifts. favorites-list.ts is importable by plain Node because it has NO
// imports at all — keep it that way.

import {
  EMPTY_BASELINE,
  EMPTY_LOCAL,
  EMPTY_PARSED,
  LIST_ALT,
  PRIVATE_PLAINTEXT_MAX,
  baselineForHalves,
  baselineFrom,
  baselineOfList,
  looseIdsWePublished,
  correctedModeFromWire,
  mayAdoptRefusedRead,
  baselineHalf,
  decodePrivateFavorites,
  encodePrivateFavorites,
  plaintextBytes,
  entriesFromList,
  groupLocalFavorites,
  identifierKind,
  itemId,
  mergeFavoritesList,
  parseFavoritesList,
  parseItemGuid,
  parseShowGuid,
  partitionList,
  claimedByBaseline,
  seedModeFromWire,
  baselineIsTrustworthy,
  planFavoritesPublish,
  showId,
  tagsFromList,
} from '../lib/nostr/favorites-list.ts';
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

// Real guids from the live event, so the fixtures carry real shapes.
const F_MUSIC = 'fce40d63-ef30-5c85-af07-d99b3c759807';
const F_MUSIC2 = '5d5be024-321d-5342-838e-988d1653296b';
const F_UNKNOWN = '791338e2-77bc-579e-8c7c-4c996cf73305';
const F_POD = 'fafd2bfc-98ac-5010-9fcb-7403abfd420a';
const I_A = 'fb279ed1-10ec-4060-967d-9af45c19505f';
const I_B = 'f4cc32b4-0e1e-45a1-a6fb-64e7f8d0e0a2';
const I_C = '19670162-a9cd-43f2-bc95-6354f218852a';
const I_ODD = 'thenogs-donkey-01-porky-piggin-it'; // real, and not a UUID
const I_URL = 'https://example.com/ep/42';

const NO_LOCAL = { groups: [], loose: [] };
const emit = (read, local = NO_LOCAL, baseline = EMPTY_BASELINE) =>
  tagsFromList(mergeFavoritesList({ read, local, baseline }));

// ---------------------------------------------------------------------------
section('Spec vector 1 — a foreign entry survives your republish');
// ---------------------------------------------------------------------------
{
  // Verbatim from the live event: the unknown-medium head group, then the music
  // block. Nothing local at all, so everything here is "foreign".
  const wire = [
    ['alt', 'PC 2.0 Favorites'],
    ['i', `podcast:guid:${F_UNKNOWN}`],
    ['i', `podcast:item:guid:${I_B}`],
    ['i', `podcast:item:guid:${I_C}`],
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', `podcast:guid:${F_MUSIC2}`],
    ['i', `podcast:item:guid:${I_A}`],
    ['k', 'podcast:guid'],
    ['k', 'podcast:item:guid'],
  ];
  check('a list we contribute nothing to is republished byte-identically',
    emit(parseFavoritesList(wire)), wire);

  // The hard half, and the one that costs another app's data if you get it
  // wrong: the feed IS in our baseline (we opened the group) and we no longer
  // hold it, but a foreign item still sits under it. Dropping the group here
  // deletes the only thing naming that item's parent.
  const baseline = { feeds: [showId(F_MUSIC2)], items: [] };
  const kept = emit(parseFavoritesList(wire), NO_LOCAL, baseline);
  check('a group we published survives while a foreign item remains under it',
    kept.some((t) => t[1] === `podcast:guid:${F_MUSIC2}`), true);
  check('...and so does that item',
    kept.some((t) => t[1] === `podcast:item:guid:${I_A}`), true);

  // Same baseline, but now the group is empty — that IS a removal.
  const emptyWire = [
    ['alt', 'PC 2.0 Favorites'],
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC2}`],
  ];
  check('a group we published with nothing left under it is dropped',
    emit(parseFavoritesList(emptyWire), NO_LOCAL, baseline),
    [['alt', LIST_ALT]]);
}

// ---------------------------------------------------------------------------
section('Spec vector 2 — an empty list is distinguishable from a read that never happened');
// ---------------------------------------------------------------------------
{
  const merged = parseFavoritesList([['i', `podcast:guid:${F_POD}`]]);
  const local = groupLocalFavorites([{ id: showId(F_POD) }]);

  // The FLAG decides, never the emptiness of readTags. A refactor that
  // populated readTags from a cache would otherwise turn a degraded read into a
  // confident "the list is empty" and republish over it.
  check('a degraded read publishes nothing even with content in hand',
    planFavoritesPublish({ merged, readTags: [], exists: false, trustworthy: false, local }).reason,
    'degraded');
  check('a trustworthy read of a genuinely absent event publishes',
    planFavoritesPublish({ merged, readTags: [], exists: false, trustworthy: true, local }).publish,
    true);
  check('a signed-in user with no favorites does not mint an empty event',
    planFavoritesPublish({
      merged: parseFavoritesList([]), readTags: [], exists: false, trustworthy: true, local: NO_LOCAL,
    }).reason,
    'nothing-to-create');

  // The baseline must be recorded even when nothing is published, or the first
  // unfavorite on this device has nothing to diff against and never propagates.
  const unchanged = planFavoritesPublish({
    merged, readTags: tagsFromList(merged), exists: true, trustworthy: true, local,
  });
  check('an unchanged list still yields a baseline', unchanged.reason === 'unchanged'
    && unchanged.baseline.feeds.length > 0, true);
}

// ---------------------------------------------------------------------------
section('Spec vector 2b — an unhydrated store must not read as "remove everything"');
// ---------------------------------------------------------------------------
{
  // THE REGRESSION THIS SECTION EXISTS FOR. On 2026-08-21 a live account lost
  // 213 groups and 232 items in one publish. The read was healthy, so
  // `trustworthy` was true and the degraded branch never fired.
  //
  // Wire shape lifted from the live event: a group, its items, a second group.
  const wire = [
    ['alt', 'PC 2.0 Favorites'],
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', `podcast:item:guid:${I_A}`],
    ['i', `podcast:item:guid:${I_B}`],
    ['i', `podcast:guid:${F_MUSIC2}`],
  ];
  const read = parseFavoritesList(wire);

  // The baseline says THIS device published every one of them, which is true —
  // it did, on a previous load. `local` is empty because the store is rebuilt
  // from scratch on every page load and has not hydrated yet.
  const baseline = {
    feeds: [showId(F_MUSIC), showId(F_MUSIC2)],
    items: [itemId(I_A), itemId(I_B)],
  };
  const merged = mergeFavoritesList({ read, local: NO_LOCAL, baseline });

  // The precondition, asserted rather than assumed: the merge really does come
  // out empty. `mergeFavoritesList` is not wrong here — "ours, and we no longer
  // hold it" is satisfied by every entry at once.
  check('an empty store against a full baseline merges to nothing',
    merged.nodes.length, 0);

  const plan = planFavoritesPublish({
    merged, readTags: wire, exists: true, trustworthy: true, local: NO_LOCAL,
  });
  check('...and that is REFUSED, not published', plan.publish, false);
  check('...with a reason that is not "degraded"', plan.reason, 'wholesale-delete');

  // Proof the vector is not vacuous. The implementation this replaced had no
  // such branch, so with `exists` true and the bytes differing it fell straight
  // through to `publish: true`. Assert those conditions hold, or the vector
  // above would pass against the broken code too.
  const wouldHavePublishedBefore =
    merged.nodes.length === 0
    && JSON.stringify(tagsFromList(merged)) !== JSON.stringify(wire);
  check('the pre-fix implementation would have published this', wouldHavePublishedBefore, true);

  // MUST STILL WORK — over-blocking here means unfavoriting stops propagating,
  // which is its own silent data bug.
  const oneLeft = groupLocalFavorites([{ id: showId(F_MUSIC2) }]);
  const partial = planFavoritesPublish({
    merged: mergeFavoritesList({ read, local: oneLeft, baseline }),
    readTags: wire,
    exists: true,
    trustworthy: true,
    local: oneLeft,
  });
  check('removing all but one still publishes', partial.publish, true);
  check('...as an ordinary publish', partial.reason, 'publish');

  // The guard keys on the RELAY holding real entries, so a list that never had
  // any is untouched by it — that case still belongs to `nothing-to-create`.
  check('an absent event with nothing local is still nothing-to-create',
    planFavoritesPublish({
      merged: parseFavoritesList([]), readTags: [], exists: false, trustworthy: true, local: NO_LOCAL,
    }).reason,
    'nothing-to-create');

  // An event carrying only its `alt` tag has nothing to lose, so refusing there
  // would strand a user whose list is legitimately empty.
  const altOnly = [['alt', 'PC 2.0 Favorites']];
  check('an alt-only event is not treated as a wholesale delete',
    planFavoritesPublish({
      merged: parseFavoritesList(altOnly), readTags: altOnly, exists: true, trustworthy: true, local: NO_LOCAL,
    }).reason !== 'wholesale-delete',
    true);
}

// ---------------------------------------------------------------------------
section('Spec vector 2c — a baseline the local cache cannot back is not believed');
// ---------------------------------------------------------------------------
{
  // The baseline and the favourites it speaks for are separate localStorage
  // keys of wildly different size — bare ids against hundreds of KB of titles
  // and artwork URLs. `safeSet` mirrors a write it cannot land into memory, and
  // that mirror does not survive a reload. So the small one persists and the
  // large one does not, and the next load reads a baseline naming everything
  // beside a cache holding nothing.
  check('a baseline claiming ids with nothing cached is NOT trusted',
    baselineIsTrustworthy({ feeds: [showId(F_MUSIC)], items: [itemId(I_A)] }, false), false);

  // MUST STILL WORK — all three of these are ordinary states, and refusing any
  // of them stops unfavouriting propagating, which is its own silent data bug.
  check('...but it is trusted the moment this device caches anything',
    baselineIsTrustworthy({ feeds: [showId(F_MUSIC)], items: [itemId(I_A)] }, true), true);
  check('an empty baseline on a device with favourites is fine (first sign-in)',
    baselineIsTrustworthy({ feeds: [], items: [] }, true), true);
  check('an empty baseline on an empty device is fine (fresh install)',
    baselineIsTrustworthy({ feeds: [], items: [] }, false), true);

  // Non-vacuity: the implementation this replaces read the baseline straight
  // off disk and believed it unconditionally.
  const alwaysTrust = () => true;
  check('the pre-fix implementation trusted the dangerous case',
    alwaysTrust() !== baselineIsTrustworthy({ feeds: [showId(F_MUSIC)], items: [] }, false), true);

  // And the point of refusing: with the baseline dropped, nothing on the wire
  // reads as our removal, so the list survives the cycle intact.
  const wire = [
    ['alt', 'PC 2.0 Favorites'],
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', `podcast:item:guid:${I_A}`],
  ];
  const read = parseFavoritesList(wire);
  const fullBaseline = { feeds: [showId(F_MUSIC)], items: [itemId(I_A)] };
  check('believing it empties the list',
    mergeFavoritesList({ read, local: NO_LOCAL, baseline: fullBaseline }).nodes.length, 0);
  // Compared on the ENTRIES, not byte-for-byte: `tagsFromList` also appends the
  // `k` tags that declare which identifier kinds the list uses, and those are
  // emitter output rather than anything the merge decided.
  const keptTags = tagsFromList(mergeFavoritesList({ read, local: NO_LOCAL, baseline: EMPTY_BASELINE }));
  check('refusing it keeps every entry',
    keptTags.filter((t) => t[0] === 'i'), wire.filter((t) => t[0] === 'i'));
  check('...and their order and medium block with them',
    keptTags.slice(0, wire.length), wire);
}

// ---------------------------------------------------------------------------
section('Spec vector 2d — "I deleted them all" is not "the store never loaded"');
// ---------------------------------------------------------------------------
{
  // The two are the SAME BYTES — an empty local set beside a baseline that
  // claims ids — and two separate guards refused both, which made deleting a
  // whole list impossible: the removal never published, the cycle recorded an
  // empty baseline over the real one, and the next reload re-adopted every
  // entry off the relay. Reported from a real account, and reproduced with the
  // private half switched off entirely, so it predates it.
  //
  // Only the moment of the action can tell them apart. `storage.favCleared` is
  // written by the store's removers and by nothing else.
  const mine = groupLocalFavorites([
    { id: showId(F_MUSIC), medium: 'music' },
    { id: showId(F_POD), medium: 'podcast' },
  ]);
  const wire = tagsFromList(mergeFavoritesList({ read: EMPTY_PARSED, local: mine, baseline: EMPTY_BASELINE }));
  const baseline = baselineForHalves(mine, EMPTY_LOCAL);

  // -- the baseline guard ---------------------------------------------------
  check('an unhydrated store must NOT be believed', baselineIsTrustworthy(baseline, false), false);
  check('...and a deliberate clear MUST be', baselineIsTrustworthy(baseline, false, true), true);
  check('a device that still holds entries is believed either way',
    [baselineIsTrustworthy(baseline, true), baselineIsTrustworthy(baseline, true, true)], [true, true]);
  check('an empty baseline needs no excuse', baselineIsTrustworthy(EMPTY_BASELINE, false), true);

  // -- the planner guard ----------------------------------------------------
  const emptied = mergeFavoritesList({
    read: parseFavoritesList(wire), local: EMPTY_LOCAL, baseline: baselineHalf(baseline, 'public'),
  });
  check('the merge really does come out empty', emptied.nodes.length, 0);

  const plan = (intentional) => planFavoritesPublish({
    merged: emptied, readTags: wire, exists: true, trustworthy: true, local: EMPTY_LOCAL,
    privateMerged: EMPTY_PARSED, readPrivateTags: [], readContent: '', privateLocal: EMPTY_LOCAL,
    emptyIsIntentional: intentional,
  });
  check('(naive) with no record of intent the delete is refused', plan(false).reason, 'wholesale-delete');
  check('...which is what made "delete everything" impossible', plan(false).publish, false);
  check('with intent recorded it goes out', plan(true).reason, 'publish');
  check('...and the event it writes holds nothing of ours', plan(true).tags, [['alt', LIST_ALT]]);

  // MUST STILL WORK: intent is not a licence to delete another writer's
  // entries. Only what this device's baseline claims may go.
  const shared = [
    ['alt', LIST_ALT], ['medium', 'music'],
    ['i', showId(F_MUSIC)], ['i', showId(F_MUSIC2)],
    ['k', 'podcast:guid'],
  ];
  const onlyOurs = baselineForHalves(groupLocalFavorites([{ id: showId(F_MUSIC), medium: 'music' }]), EMPTY_LOCAL);
  const after = tagsFromList(mergeFavoritesList({
    read: parseFavoritesList(shared), local: EMPTY_LOCAL, baseline: baselineHalf(onlyOurs, 'public'),
  }));
  check('ours goes', after.some((t) => t[1] === showId(F_MUSIC)), false);
  check('theirs stays', after.some((t) => t[1] === showId(F_MUSIC2)), true);
}

// ---------------------------------------------------------------------------
section('Spec vector 3 — idempotence');
// ---------------------------------------------------------------------------
{
  // Everything at once: unknown medium, two media blocks, an orphan, an
  // unrecognized identifier kind, a foreign `k`, and a foreign tag type. A
  // flip-flopping emitter is invisible to any single-pass assertion.
  const wire = [
    ['alt', 'PC 2.0 Favorites'],
    ['zzz', 'a tag type from a newer writer'],
    ['i', `podcast:item:guid:${I_ODD}`],
    ['i', `podcast:guid:${F_UNKNOWN}`],
    ['i', `podcast:item:guid:${I_B}`],
    ['medium', 'music'],
    ['i', 'podcast:publisher:guid:9b0f1c4e-1111-2222-3333-444455556666'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', `podcast:item:guid:${I_A}`],
    ['medium', 'podcast'],
    ['i', `podcast:guid:${F_POD}`],
    ['k', 'podcast:guid'],
    ['k', 'podcast:item:guid'],
    ['k', 'future:kind'],
  ];
  const once = emit(parseFavoritesList(wire));
  const twice = emit(parseFavoritesList(once));
  check('merge(parse(output)) === output', twice, once);

  // Stated as a fixed point, NOT as output === input. Where the read was
  // interleaved, contiguity legitimately rewrites the first pass; a vector
  // written the naive way fails correctly and gets "fixed" wrongly.
  const interleaved = [
    ['alt', 'PC 2.0 Favorites'],
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['medium', 'podcast'],
    ['i', `podcast:guid:${F_POD}`],
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC2}`],
  ];
  const first = emit(parseFavoritesList(interleaved));
  check('an interleaved read is repaired into contiguous medium blocks', first, [
    ['alt', LIST_ALT],
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', `podcast:guid:${F_MUSIC2}`],
    ['medium', 'podcast'],
    ['i', `podcast:guid:${F_POD}`],
    ['k', 'podcast:guid'],
  ]);
  check('and the repair is itself a fixed point', emit(parseFavoritesList(first)), first);
}

// ---------------------------------------------------------------------------
section('Spec vector 4 — an unrecognized tag or identifier kind survives');
// ---------------------------------------------------------------------------
{
  const wire = [
    ['alt', 'PC 2.0 Favorites'],
    ['zzz', 'payload', 'second element'],
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', 'something:else:entirely', 'wss://relay.example'],
    ['i', `podcast:item:guid:${I_A}`],
    ['k', 'podcast:guid'],
    ['k', 'future:kind'],
  ];
  const out = emit(parseFavoritesList(wire));

  check('an unknown tag type survives, whole',
    out.some((t) => JSON.stringify(t) === JSON.stringify(['zzz', 'payload', 'second element'])), true);
  check('an unknown identifier kind survives with its third element',
    out.some((t) => JSON.stringify(t) === JSON.stringify(['i', 'something:else:entirely', 'wss://relay.example'])), true);
  check('a foreign k survives', out.some((t) => t[0] === 'k' && t[1] === 'future:kind'), true);

  // The one that matters most: an unrecognized `i` must not re-parent the
  // entries after it. The item below belongs to F_MUSIC, not to nothing.
  const parsed = parseFavoritesList(out);
  const group = parsed.nodes.find((n) => n.t === 'group');
  check('an unrecognized i between a feed and its item does not re-parent the item',
    group.group.itemGuids, [I_A]);
  check('...and it stays inside the music block, in position',
    out.findIndex((t) => t[1] === 'something:else:entirely')
      > out.findIndex((t) => t[0] === 'medium' && t[1] === 'music'), true);
}

// ---------------------------------------------------------------------------
section('Spec vector 5 — placement');
// ---------------------------------------------------------------------------
{
  const parsed = parseFavoritesList([
    ['i', `podcast:guid:${F_UNKNOWN}`],
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', `podcast:guid:${F_MUSIC2}`],
    ['i', `podcast:item:guid:${I_A}`],
  ]);
  const groups = parsed.nodes.filter((n) => n.t === 'group').map((n) => n.group);
  check('an item attaches to the MOST RECENTLY opened group, not the first',
    groups.map((g) => g.itemGuids), [[], [], [I_A]]);
  check('a group before any medium tag reads as unknown', groups[0].medium, undefined);
  // Asserted explicitly rather than as `=== undefined` alone: defaulting to
  // podcast is wrong for exactly the half of the list the hint exists to
  // separate, and it is the mistake the spec calls out by name.
  check('...and specifically NOT podcast', groups[0].medium === 'podcast', false);
  check('the running medium applies to every entry after it',
    [groups[1].medium, groups[2].medium], ['music', 'music']);
}

// ---------------------------------------------------------------------------
section('Spec vector 6 — a URL-shaped item guid does not corrupt its k tag');
// ---------------------------------------------------------------------------
{
  // "Everything before the last colon" would yield `podcast:item:guid:https` —
  // a k value no relay filter matches, breaking #k discovery with nothing
  // visibly wrong.
  check('the kind comes from the table, not a colon scan',
    identifierKind(itemId(I_URL)), 'podcast:item:guid');
  const out = emit(parseFavoritesList([
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', `podcast:item:guid:${I_URL}`],
  ]));
  check('and the emitted k set contains no scanned fragment',
    out.filter((t) => t[0] === 'k').map((t) => t[1]), ['podcast:guid', 'podcast:item:guid']);
  check('a non-UUID item guid is still an item', parseItemGuid(itemId(I_ODD)), I_ODD);
}

// ---------------------------------------------------------------------------
section('Spec vector 7 — both k layouts parse identically');
// ---------------------------------------------------------------------------
{
  const entries = [
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', `podcast:item:guid:${I_A}`],
  ];
  const paired = parseFavoritesList([
    ['alt', 'PC 2.0 Favorites'],
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['k', 'podcast:guid'],
    ['i', `podcast:item:guid:${I_A}`],
    ['k', 'podcast:item:guid'],
  ]);
  const trailing = parseFavoritesList([['alt', 'PC 2.0 Favorites'], ...entries,
    ['k', 'podcast:guid'], ['k', 'podcast:item:guid']]);
  // A reader that walks i/k in pairs reads the current form as an EMPTY LIBRARY
  // rather than as an error, which is the worst failure the format allows.
  check('the paired and one-per-kind layouts describe the same list',
    JSON.stringify(paired), JSON.stringify(trailing));
}

// ---------------------------------------------------------------------------
section('Emission layout');
// ---------------------------------------------------------------------------
{
  const out = emit(parseFavoritesList([
    ['alt', 'Someone else’s label'],
    ['medium', 'podcast'],
    ['i', `podcast:guid:${F_POD}`],
    ['i', `podcast:guid:${F_UNKNOWN}`], // no medium above it? no — inherits podcast
  ]));
  check('alt is first and ours', out[0], ['alt', LIST_ALT]);
  check('alt appears exactly once', out.filter((t) => t[0] === 'alt').length, 1);

  const withUnknown = emit(parseFavoritesList([
    ['i', `podcast:guid:${F_UNKNOWN}`],
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
  ]));
  check('unknown-medium groups are emitted BEFORE the first medium tag',
    withUnknown.findIndex((t) => t[1] === `podcast:guid:${F_UNKNOWN}`)
      < withUnknown.findIndex((t) => t[0] === 'medium'), true);
  check('no ["medium","unknown"] is ever invented',
    withUnknown.some((t) => t[0] === 'medium' && t[1] === 'unknown'), false);

  const ks = withUnknown.filter((t) => t[0] === 'k');
  check('k tags are trailing', withUnknown.slice(-ks.length).every((t) => t[0] === 'k'), true);
  check('k is one per distinct kind, not one per entry', ks.length, 1);
}

// ---------------------------------------------------------------------------
section('The baseline — foreign entry vs. one we removed');
// ---------------------------------------------------------------------------
{
  const wire = [
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', `podcast:item:guid:${I_A}`],
    ['i', `podcast:item:guid:${I_B}`],
  ];

  // We published both items; we still hold I_A. I_B is a removal.
  const local = groupLocalFavorites([{ id: itemId(I_A), feedRef: F_MUSIC, medium: 'music' }]);
  const baseline = { feeds: [showId(F_MUSIC)], items: [itemId(I_A), itemId(I_B)] };
  const out = emit(parseFavoritesList(wire), local, baseline);
  check('an item we published and no longer hold is removed',
    out.some((t) => t[1] === `podcast:item:guid:${I_B}`), false);
  check('an item we still hold stays',
    out.some((t) => t[1] === `podcast:item:guid:${I_A}`), true);

  // An item we never published, sitting under a feed we hold, is another app's.
  const out2 = emit(parseFavoritesList(wire), local, { feeds: [showId(F_MUSIC)], items: [itemId(I_A)] });
  check('an item we never published is not ours to delete',
    out2.some((t) => t[1] === `podcast:item:guid:${I_B}`), true);

  // An empty baseline must delete nothing — a device that has never synced
  // holds no opinion about what anyone else added.
  check('an empty baseline deletes nothing',
    emit(parseFavoritesList(wire), NO_LOCAL, EMPTY_BASELINE), tagsFromList(parseFavoritesList(wire)));

  // The shape of a real deletion, kept here because the merge is only ever as
  // truthful as the baseline it is handed. An itemless group we never wrote
  // survives on an empty baseline and is DESTROYED by one that falsely names
  // it — which is what a baseline carried over from a different address is. The
  // rule the merge implements is right; the input was a lie. See
  // `storage.favBaseline`, which starts empty for exactly this reason.
  const foreignAlbum = [['medium', 'music'], ['i', `podcast:guid:${F_MUSIC}`]];
  check('an itemless group we never published survives',
    emit(parseFavoritesList(foreignAlbum), NO_LOCAL, EMPTY_BASELINE)
      .some((t) => t[1] === `podcast:guid:${F_MUSIC}`), true);
  check('...and a baseline that falsely claims it is what deletes it',
    emit(parseFavoritesList(foreignAlbum), NO_LOCAL, { feeds: [showId(F_MUSIC)], items: [] })
      .some((t) => t[1] === `podcast:guid:${F_MUSIC}`), false);

  // Removal must propagate even when the parent group is no longer ours.
  const orphanedRemoval = emit(parseFavoritesList(wire), NO_LOCAL,
    { feeds: [], items: [itemId(I_B)] });
  check('an item removal propagates under a group we do not hold',
    orphanedRemoval.some((t) => t[1] === `podcast:item:guid:${I_B}`), false);

  // A feed another writer removed must not come back just because we still
  // have a local row for it — that is the resurrection loop.
  const localOnly = groupLocalFavorites([{ id: showId(F_MUSIC), medium: 'music' }]);
  check('a feed another app removed is not resurrected by this device',
    emit(parseFavoritesList([]), localOnly, { feeds: [showId(F_MUSIC)], items: [] }),
    [['alt', LIST_ALT]]);
  check('but a genuinely new local favorite IS published',
    emit(parseFavoritesList([]), localOnly, EMPTY_BASELINE).some((t) => t[1] === `podcast:guid:${F_MUSIC}`),
    true);

  // The case that "don't resurrect" gets wrong if it stops at the group: the
  // album is gone from the relay and we published it, but the user has since
  // favorited a track from it HERE. The track is new, so it must go up — and it
  // cannot be placed without reopening the group that names its parent.
  const newTrackUnderRemovedFeed = groupLocalFavorites([
    { id: showId(F_MUSIC), medium: 'music' },
    { id: itemId(I_A), feedRef: F_MUSIC, medium: 'music' },
  ]);
  const revived = emit(parseFavoritesList([]), newTrackUnderRemovedFeed,
    { feeds: [showId(F_MUSIC)], items: [] });
  check('a new track under a feed another app removed is still published',
    revived.some((t) => t[1] === `podcast:item:guid:${I_A}`), true);
  check('...and its parent group is reopened to place it',
    revived.some((t) => t[1] === `podcast:guid:${F_MUSIC}`), true);
  // The group comes back ONLY to carry the track — it is not a revived feed
  // favorite, and an itemless revival would be exactly the resurrection loop.
  check('...but a removed feed with nothing new under it still stays gone',
    emit(parseFavoritesList([]), localOnly, { feeds: [showId(F_MUSIC)], items: [] })
      .some((t) => t[1] === `podcast:guid:${F_MUSIC}`), false);

  // The SAME rule one level in, and the half that shipped missing: an item
  // another writer removed, under a group that SURVIVED because other tracks
  // are still on it. The absent-group branch above filters these; the
  // present-group branch appended every local item it did not already see, so
  // whether a removal stuck depended on whether its album happened to have a
  // second track on the list. Two writers is enough to see it — a phone and a
  // laptop, or this app and StableKraft — and the loser is whoever pressed the
  // heart last: their unfavorite is undone silently, on someone else's device.
  const survivingGroup = [
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', itemId(I_C)],            // a sibling track keeps the group alive
  ];
  const stillHoldsRemoved = groupLocalFavorites([
    { id: showId(F_MUSIC), medium: 'music' },
    { id: itemId(I_A), feedRef: F_MUSIC, medium: 'music' },   // published, then removed elsewhere
    { id: itemId(I_C), feedRef: F_MUSIC, medium: 'music' },
  ]);
  check('an item another app removed is not resurrected under a surviving group',
    emit(parseFavoritesList(survivingGroup), stillHoldsRemoved,
      { feeds: [showId(F_MUSIC)], items: [itemId(I_A), itemId(I_C)] })
      .some((t) => t[1] === itemId(I_A)), false);

  // The mirror, and the reason the test is the BASELINE and not mere absence
  // from the read: a track the user has just favorited here has never been
  // published, so it is not a removal and must go up.
  check('...but a genuinely new track under that group IS published',
    emit(parseFavoritesList(survivingGroup), stillHoldsRemoved,
      { feeds: [showId(F_MUSIC)], items: [itemId(I_C)] })
      .some((t) => t[1] === itemId(I_A)), true);
}

// ---------------------------------------------------------------------------
section('Medium is sticky');
// ---------------------------------------------------------------------------
{
  const wire = [['medium', 'music'], ['i', `podcast:guid:${F_MUSIC}`]];
  const local = groupLocalFavorites([{ id: showId(F_MUSIC), medium: 'podcast' }]);
  const out = emit(parseFavoritesList(wire), local, EMPTY_BASELINE);
  // "Prefer my own resolved value" does not converge: two apps holding
  // different values rewrite the event at each other forever, each publish
  // locally reasonable, the only symptom being that it never stops.
  check('a local value never overwrites a medium another writer set',
    out.find((t) => t[0] === 'medium')[1], 'music');

  const gap = emit(parseFavoritesList([['i', `podcast:guid:${F_MUSIC}`]]), local, EMPTY_BASELINE);
  check('but it does fill a gap', gap.find((t) => t[0] === 'medium')[1], 'podcast');
}

// ---------------------------------------------------------------------------
section('Malformed and unplaceable entries');
// ---------------------------------------------------------------------------
{
  // Old versions of this app wrote feed IDs rather than guids. They are not
  // feeds we can open a group for, but "this app can't read it" is not the same
  // claim as "this is junk" — they are preserved, and removable only through
  // the explicit cleanup hook.
  const parsed = parseFavoritesList([['i', 'podcast:guid:920666']]);
  check('a malformed feed guid becomes a loose entry, not a group',
    parsed.nodes.map((n) => n.t), ['loose']);
  check('...and is carried through a republish',
    emit(parsed), [['alt', LIST_ALT], ['i', 'podcast:guid:920666'], ['k', 'podcast:guid']]);
  check('...and is reported as malformed', partitionList(parsed).malformed, ['podcast:guid:920666']);
  check('parseShowGuid rejects it outright', parseShowGuid('podcast:guid:920666'), null);

  // A favorited item whose parent we never learned rides as an orphan rather
  // than being dropped: losing a track because we can't name its album is a
  // worse trade than an unplaceable entry.
  const orphanLocal = groupLocalFavorites([{ id: itemId(I_A), medium: 'music' }]);
  check('an item with no parent is kept as an orphan, not dropped',
    orphanLocal.loose.map((l) => l.tag), [['i', `podcast:item:guid:${I_A}`]]);
  check('an item whose parent is not a UUID is also an orphan',
    groupLocalFavorites([{ id: itemId(I_A), feedRef: '920666' }]).groups.length, 0);

  // And it must be removable, or the user has a favorite they can never undo.
  const orphanWire = [['i', `podcast:item:guid:${I_A}`]];
  check('an orphan we published and no longer hold is removed',
    emit(parseFavoritesList(orphanWire), NO_LOCAL, { feeds: [], items: [itemId(I_A)] }),
    [['alt', LIST_ALT]]);
  check('an orphan we never published is not ours to delete',
    emit(parseFavoritesList(orphanWire), NO_LOCAL, EMPTY_BASELINE)
      .some((t) => t[1] === `podcast:item:guid:${I_A}`), true);
  check('baselineFrom records orphans, or the above could never fire',
    baselineFrom(orphanLocal).items, [`podcast:item:guid:${I_A}`]);
}

// ---------------------------------------------------------------------------
section('A feed group is not always a favorite');
// ---------------------------------------------------------------------------
{
  // Opening a group is the only way to name an item's parent, so a group
  // appears whether or not the feed was favorited. Reading every group as a
  // favorite manufactures albums the user never chose — measured at 159 of 197
  // groups on the live list this was built against.
  const p = partitionList(parseFavoritesList([
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', `podcast:item:guid:${I_A}`],
    ['i', `podcast:guid:${F_MUSIC2}`],
  ]));
  check('a group with items is not an unambiguous favorite',
    p.feeds.map((f) => [f.feedGuid, f.itemless]), [[F_MUSIC, false], [F_MUSIC2, true]]);
  check('an item takes its group medium — PC2.0 has no per-item medium',
    p.items, [{ itemGuid: I_A, feedGuid: F_MUSIC, medium: 'music' }]);
}

// ---------------------------------------------------------------------------
section('The store projection is a fixed point');
// ---------------------------------------------------------------------------
{
  // What we render is what we would republish. Without this, a rendering pass
  // can quietly change the wire on the next publish.
  const wire = [
    ['alt', 'PC 2.0 Favorites'],
    ['i', `podcast:guid:${F_UNKNOWN}`],
    ['i', `podcast:item:guid:${I_B}`],
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', `podcast:item:guid:${I_A}`],
    ['i', `podcast:guid:${F_MUSIC2}`],
    ['medium', 'podcast'],
    ['i', `podcast:guid:${F_POD}`],
    ['k', 'podcast:guid'],
    ['k', 'podcast:item:guid'],
  ];
  const read = parseFavoritesList(wire);
  const local = groupLocalFavorites(entriesFromList(read));
  check('render → regroup → merge reproduces the wire',
    tagsFromList(mergeFavoritesList({ read, local, baseline: baselineFrom(local) })), wire);
}

// ---------------------------------------------------------------------------
section('Spec vector 4b — an opaque `content` survives a republish');
// ---------------------------------------------------------------------------
{
  // The spec's sibling to vector 4, and the reason the carry rule ships ahead
  // of the private half: rule 4 covers TAGS and says nothing about `content`,
  // so a writer following the document to the letter republishes the empty
  // string the format has specified from the start — and erases every private
  // entry another app wrote, silently, with no undo.
  const wire = [['alt', LIST_ALT], ['i', showId(F_MUSIC)]];
  const local = groupLocalFavorites([{ id: showId(F_POD) }]);
  const CIPHER = 'AkVn3xQ==someoneElsesPrivateFavorites';

  const p = planFavoritesPublish({
    merged: mergeFavoritesList({ read: parseFavoritesList(wire), local, baseline: EMPTY_BASELINE }),
    readTags: wire,
    exists: true,
    trustworthy: true,
    local,
    readContent: CIPHER,
    privateMerged: null,
    privateUnreadable: true,
  });

  check('a public-half change still publishes over an unreadable private half', p.publish, true);
  check('...and the ciphertext is carried byte for byte', p.content, CIPHER);
  check('...and nothing is re-encrypted', p.encryptPrivate, false);

  // The control is the shipping behaviour of every writer that has never heard
  // of a private half — including this app until now.
  const naiveContent = () => '';
  check('(naive) blanking `content` on republish destroys it', naiveContent() !== p.content, true);

  // And a change we cannot express is refused rather than guessed at.
  const priv = planFavoritesPublish({
    merged: mergeFavoritesList({ read: parseFavoritesList(wire), local, baseline: EMPTY_BASELINE }),
    readTags: wire,
    exists: true,
    trustworthy: true,
    local: EMPTY_LOCAL,
    mode: 'private',
    privateLocal: local,
    readContent: CIPHER,
    privateMerged: null,
    privateUnreadable: true,
  });
  check('a PRIVATE-half change over a blob we cannot read is refused', priv.publish, false);
  check('...and says so', priv.reason, 'private-unreadable');
}

// ---------------------------------------------------------------------------
section('The private half — idempotence is on the DECRYPTED array');
// ---------------------------------------------------------------------------
{
  // NIP-44 draws a fresh nonce per encryption, so the same entries produce
  // different bytes every time. Compare ciphertext and the byte test can never
  // report 'unchanged': every page load republishes and two apps rewrite the
  // event at each other forever, this time self-inflicted.
  const privLocal = groupLocalFavorites([
    { id: itemId(I_A), feedRef: F_MUSIC, medium: 'music' },
  ]);
  // What this device would have written the first time.
  const onWire = tagsFromList(
    mergeFavoritesList({ read: EMPTY_PARSED, local: privLocal, baseline: EMPTY_BASELINE }),
  );
  const baseline = baselineForHalves(EMPTY_LOCAL, privLocal);
  const pubWire = [['alt', LIST_ALT]];

  const p = planFavoritesPublish({
    merged: mergeFavoritesList({
      read: parseFavoritesList(pubWire), local: EMPTY_LOCAL, baseline: baselineHalf(baseline, 'public'),
    }),
    readTags: pubWire,
    exists: true,
    trustworthy: true,
    local: EMPTY_LOCAL,
    mode: 'private',
    privateMerged: mergeFavoritesList({
      read: parseFavoritesList(onWire), local: privLocal, baseline: baselineHalf(baseline, 'private'),
    }),
    readPrivateTags: onWire,
    readContent: 'nip44:nonce-from-last-time:…',
    privateLocal: privLocal,
  });

  check('reading our own private half back publishes nothing', p.reason, 'unchanged');
  check('...and does not spend an encryption to find that out', p.encryptPrivate, false);
  check('...and leaves `content` exactly as it was', p.content, 'nip44:nonce-from-last-time:…');

  // The control: encrypt first, compare the result.
  const naiveEncrypt = (plaintext, nonce) => `nip44:${nonce}:${plaintext}`;
  const pt = encodePrivateFavorites(onWire);
  check(
    '(naive) comparing ciphertext republishes an unchanged list',
    naiveEncrypt(pt, 'a') !== naiveEncrypt(pt, 'b'),
    true,
  );
}

// ---------------------------------------------------------------------------
section('The private half — the SECOND publish is the one that breaks');
// ---------------------------------------------------------------------------
{
  // A regression pin for a real bug on this branch: `cycleOptionsFor` passed a
  // bare `purpose`, undefined on every background cycle, so `syncFavorites`
  // read with `decryptPrivate: false`. The FIRST private publish worked — an
  // empty `content` needs no decrypt — and every one after it silently refused,
  // because the planner (correctly) will not write over a blob it cannot read.
  //
  // Hearts fill, nothing propagates, one console warn. This is what that looks
  // like as a sequence, and it is why "did we decrypt" is not a performance
  // question in private mode.
  const one = groupLocalFavorites([{ id: showId(F_MUSIC), medium: 'music' }]);
  const two = groupLocalFavorites([
    { id: showId(F_MUSIC), medium: 'music' },
    { id: showId(F_POD), medium: 'podcast' },
  ]);
  const pubWire = [['alt', LIST_ALT]];

  // Publish 1: nothing encrypted yet, so there is nothing to decrypt.
  const first = planFavoritesPublish({
    merged: mergeFavoritesList({ read: parseFavoritesList(pubWire), local: EMPTY_LOCAL, baseline: EMPTY_BASELINE }),
    readTags: pubWire,
    exists: true,
    trustworthy: true,
    local: EMPTY_LOCAL,
    mode: 'private',
    privateMerged: mergeFavoritesList({ read: EMPTY_PARSED, local: one, baseline: EMPTY_BASELINE }),
    readPrivateTags: [],
    readContent: '',
    privateUnreadable: false,
    privateLocal: one,
  });
  check('the first private publish goes out', first.reason, 'publish');
  check('...and encrypts', first.encryptPrivate, true);

  const onWire = first.privateTags;
  const baseline = baselineForHalves(EMPTY_LOCAL, one);

  // Publish 2, THE BUG: `content` is now a ciphertext, and this cycle did not
  // decrypt it.
  const blind = planFavoritesPublish({
    merged: mergeFavoritesList({ read: parseFavoritesList(pubWire), local: EMPTY_LOCAL, baseline: baselineHalf(baseline, 'public') }),
    readTags: pubWire,
    exists: true,
    trustworthy: true,
    local: EMPTY_LOCAL,
    mode: 'private',
    privateMerged: null,          // <- did not decrypt
    readPrivateTags: [],
    readContent: 'nip44:…',
    privateUnreadable: true,
    privateLocal: two,            // the user just favorited a second thing
  });
  check('a private cycle that did NOT decrypt refuses the second publish', blind.reason, 'private-unreadable');
  check('...so the new favorite never reaches a relay', blind.publish, false);

  // Publish 2, FIXED: the same cycle, having decrypted.
  const seeing = planFavoritesPublish({
    merged: mergeFavoritesList({ read: parseFavoritesList(pubWire), local: EMPTY_LOCAL, baseline: baselineHalf(baseline, 'public') }),
    readTags: pubWire,
    exists: true,
    trustworthy: true,
    local: EMPTY_LOCAL,
    mode: 'private',
    privateMerged: mergeFavoritesList({
      read: parseFavoritesList(onWire), local: two, baseline: baselineHalf(baseline, 'private'),
    }),
    readPrivateTags: onWire,
    readContent: 'nip44:…',
    privateUnreadable: false,
    privateLocal: two,
  });
  check('having decrypted, the same cycle publishes', seeing.reason, 'publish');
  check('...and the new favorite is in the tags it will encrypt',
    seeing.privateTags.some((t) => t[1] === showId(F_POD)), true);
  check('...and the one already there survived',
    seeing.privateTags.some((t) => t[1] === showId(F_MUSIC)), true);
}

// ---------------------------------------------------------------------------
section('The private half — a move is a removal AND an addition');
// ---------------------------------------------------------------------------
{
  // This is the spec's "the baseline gains a job too". Against ONE shared
  // baseline the two steps of a move cancel destructively and the entry is
  // deleted outright, with every other guard satisfied.
  const mine = groupLocalFavorites([{ id: showId(F_MUSIC), medium: 'music' }]);
  const wire = tagsFromList(
    mergeFavoritesList({ read: EMPTY_PARSED, local: mine, baseline: EMPTY_BASELINE }),
  );
  // We published it, publicly. Now the user switches to private.
  const split = baselineForHalves(mine, EMPTY_LOCAL);

  const movedOut = tagsFromList(mergeFavoritesList({
    read: parseFavoritesList(wire), local: EMPTY_LOCAL, baseline: baselineHalf(split, 'public'),
  }));
  const movedIn = tagsFromList(mergeFavoritesList({
    read: EMPTY_PARSED, local: mine, baseline: baselineHalf(split, 'private'),
  }));

  check('the public half drops it', movedOut, [['alt', LIST_ALT]]);
  check('the private half gains it', movedIn, [
    ['alt', LIST_ALT], ['medium', 'music'], ['i', showId(F_MUSIC)], ['k', 'podcast:guid'],
  ]);

  // THE CONTROL. One baseline, no halves — which is what this app shipped
  // before, and what the spec warns costs the entry.
  const shared = baselineFrom(mine);
  const movedInShared = tagsFromList(mergeFavoritesList({
    read: EMPTY_PARSED, local: mine, baseline: shared,
  }));
  check('(naive) one shared baseline eats the entry it was moving', movedInShared, [['alt', LIST_ALT]]);

  // And the round trip survives a SECOND cycle: the new baseline names it on
  // the private side only, so the next read does not read it back as a removal.
  const after = baselineForHalves(EMPTY_LOCAL, mine);
  const second = tagsFromList(mergeFavoritesList({
    read: parseFavoritesList(movedIn), local: mine, baseline: baselineHalf(after, 'private'),
  }));
  check('...and the next cycle is a fixed point', second, movedIn);
}

// ---------------------------------------------------------------------------
section('The private half — an ADOPTED list must enter the baseline');
// ---------------------------------------------------------------------------
{
  // Reported from a real account, on a device seeing it for the first time:
  // switching to Private left all 12 favorites in the public tags AND wrote an
  // encrypted copy beside them. Both halves, at once — the opposite of what the
  // switch promises, and a leak rather than a display bug.
  //
  // The cause is a baseline that names nothing. `runHydrate` plans BEFORE it
  // paints (deliberately), so its `local` is what the device held on the way in
  // — nothing, on a fresh device. The list it then adopts off the relay was
  // recorded as "I published none of this".
  //
  // That is harmless with one half: an empty baseline yields no removals, so
  // the next publish is a pure union, and the spec says so outright. With two
  // halves it is a leak, because a MOVE is expressed as a removal from one half
  // plus an addition to the other, and a baseline naming nothing cannot remove.
  const wire = [
    ['alt', LIST_ALT],
    ['medium', 'music'],
    ['i', showId(F_MUSIC)],
    ['i', showId(F_MUSIC2)],
    ['k', 'podcast:guid'],
  ];
  const read = parseFavoritesList(wire);
  // The device adopted the wire, so this is exactly what it now holds.
  const adopted = groupLocalFavorites(entriesFromList(read));
  check('the adopted list round-trips to the same wire', tagsFromList(
    mergeFavoritesList({ read: EMPTY_PARSED, local: adopted, baseline: EMPTY_BASELINE }),
  ), wire);

  const switchTo = (baseline) => ({
    pub: tagsFromList(mergeFavoritesList({
      read: parseFavoritesList(wire), local: EMPTY_LOCAL, baseline: baselineHalf(baseline, 'public'),
    })),
    priv: tagsFromList(mergeFavoritesList({
      read: EMPTY_PARSED, local: adopted, baseline: baselineHalf(baseline, 'private'),
    })),
  });

  // THE BUG, stated as a vector: nothing recorded ⇒ the entries end up in BOTH.
  const blind = switchTo(EMPTY_BASELINE);
  check('(naive) an empty baseline leaves them in the public half', blind.pub.filter((t) => t[0] === 'i').length, 2);
  check('(naive) ...while also writing them into the private half', blind.priv.filter((t) => t[0] === 'i').length, 2);

  // THE FIX: record what the device adopted, then the switch is a move.
  const recorded = baselineForHalves(adopted, EMPTY_LOCAL);
  check('an adopted list names every entry it took on', recorded.feeds.length, 2);
  const moved = switchTo(recorded);
  check('the public half empties', moved.pub.filter((t) => t[0] === 'i').length, 0);
  check('...and the private half holds them', moved.priv.filter((t) => t[0] === 'i').length, 2);

  // MUST STILL WORK: adopting does not claim another writer's entries as ours
  // to delete — only what `entriesFromList` says this device can represent.
  const withForeign = parseFavoritesList([
    ...wire.slice(0, 3),
    ['i', 'something:else:entirely'],
    ['i', showId(F_MUSIC2)],
    ['k', 'podcast:guid'],
  ]);
  const adoptedForeign = groupLocalFavorites(entriesFromList(withForeign));
  const b2 = baselineForHalves(adoptedForeign, EMPTY_LOCAL);
  check('an unreadable entry is never entered into the baseline',
    b2.feeds.concat(b2.items).some((x) => x === 'something:else:entirely'), false);
  check('...and it survives the switch untouched',
    tagsFromList(mergeFavoritesList({
      read: withForeign, local: EMPTY_LOCAL, baseline: baselineHalf(b2, 'public'),
    })).some((t) => t[1] === 'something:else:entirely'), true);
}

// ---------------------------------------------------------------------------
section('The private half — an ambiguous wire is a QUESTION, never a guess');
// ---------------------------------------------------------------------------
{
  // Found by a security review of this branch. `seedFavoritesMode` decides
  // which half an account keeps its favorites in when this device has no
  // recorded choice, and it tested the PUBLIC half first — which fails OPEN.
  //
  // kind:10333 is one shared, multi-writer event, so a single plaintext `i`
  // tag from any other writer sits happily beside an encrypted half. Nothing
  // makes them exclusive. A device seeded 'public' over a private account
  // paints the decrypted entries into its store (the app renders the union),
  // and the next publish emits every one of them as a plaintext `i` tag —
  // relay-indexed, reverse-searchable by `#i`, on a replaceable event that
  // keeps no history. No retraction, nothing on screen.
  check('only a private half ⇒ private', seedModeFromWire(false, true), 'private');
  check('only a public half ⇒ public', seedModeFromWire(true, false), 'public');
  check('nothing at all ⇒ ask', seedModeFromWire(false, false), null);
  check('BOTH ⇒ ask, never guess', seedModeFromWire(true, true), null);

  // (naive) the ordering that shipped, and the one a reader will reach for
  // again because it looks like a harmless preference for the common case.
  const naivePublicFirst = (pub, priv) => (pub ? 'public' : priv ? 'private' : null);
  check('(naive) public-first hands a private account to plaintext',
    naivePublicFirst(true, true), 'public');
  check('...where the real rule refuses to answer', seedModeFromWire(true, true), null);

  // AND NOT SIMPLY REVERSED. Private-first is safe against disclosure and
  // unsafe against a different thing: an account that is genuinely public,
  // beside another app's private half, would be moved INTO `content` — no
  // leak, but a real edit to a shared event that an app without NIP-44 then
  // reads as an empty list. Each half answers only for itself.
  const naivePrivateFirst = (pub, priv) => (priv ? 'private' : pub ? 'public' : null);
  check('(naive) private-first moves a public account into content',
    naivePrivateFirst(true, true), 'private');
}

// ---------------------------------------------------------------------------
section('The private half — the baseline describes BOTH halves, every cycle');
// ---------------------------------------------------------------------------
{
  // Reported as "I unfavorited 2 and they came back", off an event holding 9
  // public entries AND an encrypted copy. The baseline was one local list split
  // by mode — `baselineForHalves(local, privateLocal)` — which BLANKED the
  // claims on whichever half this device was not currently using. Unclaimed,
  // those entries read as another writer's and are carried forever, while the
  // app still renders them and offers a heart that does nothing.
  //
  // THE REPAIR IS TO CARRY THE INACTIVE HALF'S CLAIMS, NOT TO RECOMPUTE THEM
  // FROM ITS MERGE. The two look equivalent on one cycle and are not:
  // recomputing claims every entry in that half, a writer we are only carrying
  // for included, and `syncFavorites` hands that half `EMPTY_LOCAL` every
  // cycle — so the next one reads a claim it cannot back as a removal and
  // deletes the lot. That shipped, and it is pinned in "TWO CYCLES" below.
  // Carrying is what fixes the report, because the claims exist: this device
  // made them while that half WAS the active one.
  const pubWire = [
    ['alt', LIST_ALT], ['medium', 'music'], ['i', showId(F_MUSIC)], ['k', 'podcast:guid'],
  ];
  const privWire = [
    ['alt', LIST_ALT], ['medium', 'music'], ['i', showId(F_MUSIC2)], ['k', 'podcast:guid'],
  ];
  const readPub = parseFavoritesList(pubWire);
  const readPriv = parseFavoritesList(privWire);
  // Public mode: this device owns the public half and merely carries the other.
  const mine = groupLocalFavorites([{ id: showId(F_MUSIC), medium: 'music' }]);
  // This device wrote the encrypted copy while it was in private mode, so the
  // claim is on record. Switching to public must not throw it away.
  const before = { feeds: [], items: [], privateFeeds: [showId(F_MUSIC2)], privateItems: [] };
  const plan = planFavoritesPublish({
    merged: mergeFavoritesList({ read: readPub, local: mine, baseline: EMPTY_BASELINE }),
    readTags: pubWire, exists: true, trustworthy: true, local: mine,
    mode: 'public',
    privateMerged: mergeFavoritesList({ read: readPriv, local: EMPTY_LOCAL, baseline: EMPTY_BASELINE }),
    readPrivateTags: privWire, readContent: 'nip44:…', privateLocal: EMPTY_LOCAL,
    previousBaseline: before,
  });
  check('the public half is claimed', plan.baseline.feeds, [showId(F_MUSIC)]);
  check('...and the private half KEEPS the claims we already made',
    plan.baseline.privateFeeds, [showId(F_MUSIC2)]);

  // (naive) the version that shipped: one local list split by mode.
  const naive = baselineForHalves(mine, EMPTY_LOCAL);
  check('(naive) splitting one local list by mode disowns the other half', naive.privateFeeds, []);
  // ...and disowned is unremovable: the merge carries what the baseline
  // does not claim, so the entry survives every republish.
  const stuck = tagsFromList(mergeFavoritesList({
    read: readPriv, local: EMPTY_LOCAL, baseline: baselineHalf(naive, 'private'),
  }));
  check('(naive) ...so it comes back on every cycle', stuck.some((t) => t[1] === showId(F_MUSIC2)), true);
  // With it claimed, dropping it locally actually removes it.
  const gone = tagsFromList(mergeFavoritesList({
    read: readPriv, local: EMPTY_LOCAL, baseline: baselineHalf(plan.baseline, 'private'),
  }));
  check('claimed, it can finally be removed', gone.some((t) => t[1] === showId(F_MUSIC2)), false);

  // MUST STILL WORK, AND IT IS THE OTHER HALF OF THE SAME RULE: a writer we are
  // only carrying for is never claimed. Claim it and the next cycle — with
  // `EMPTY_LOCAL` on this half again — reads our own claim back as a removal.
  const carrying = planFavoritesPublish({
    merged: mergeFavoritesList({ read: readPub, local: mine, baseline: EMPTY_BASELINE }),
    readTags: pubWire, exists: true, trustworthy: true, local: mine,
    mode: 'public',
    privateMerged: mergeFavoritesList({ read: readPriv, local: EMPTY_LOCAL, baseline: EMPTY_BASELINE }),
    readPrivateTags: privWire, readContent: 'nip44:…', privateLocal: EMPTY_LOCAL,
    previousBaseline: EMPTY_BASELINE,
  });
  check('a half we have never claimed stays unclaimed', carrying.baseline.privateFeeds, []);

  // MUST STILL WORK: a half we could not READ keeps the claims we already had,
  // rather than disowning every entry in it.
  const kept = planFavoritesPublish({
    merged: mergeFavoritesList({ read: readPub, local: mine, baseline: EMPTY_BASELINE }),
    readTags: pubWire, exists: true, trustworthy: true, local: mine,
    mode: 'public', privateMerged: null, privateUnreadable: true,
    readPrivateTags: [], readContent: 'nip44:…', privateLocal: EMPTY_LOCAL,
    previousBaseline: { feeds: [], items: [], privateFeeds: [showId(F_MUSIC2)], privateItems: [] },
  });
  check('an unreadable private half keeps its claims', kept.baseline.privateFeeds, [showId(F_MUSIC2)]);

  // MUST STILL WORK: what we cannot represent is never claimed.
  const foreign = parseFavoritesList([
    ['alt', LIST_ALT], ['i', 'something:else:entirely'], ['i', showId(F_POD)],
  ]);
  const b = baselineOfList(foreign);
  check('an unreadable identifier stays unclaimed',
    b.feeds.concat(b.items).includes('something:else:entirely'), false);
  check('...while the one beside it is claimed', b.feeds, [showId(F_POD)]);
}

// ---------------------------------------------------------------------------
section('The private half — wholesale-delete spans BOTH halves');
// ---------------------------------------------------------------------------
{
  const mine = groupLocalFavorites([{ id: showId(F_MUSIC), medium: 'music' }]);
  const wire = tagsFromList(
    mergeFavoritesList({ read: EMPTY_PARSED, local: mine, baseline: EMPTY_BASELINE }),
  );
  const split = baselineForHalves(mine, EMPTY_LOCAL);

  const emptiedPublic = mergeFavoritesList({
    read: parseFavoritesList(wire), local: EMPTY_LOCAL, baseline: baselineHalf(split, 'public'),
  });
  const filledPrivate = mergeFavoritesList({
    read: EMPTY_PARSED, local: mine, baseline: baselineHalf(split, 'private'),
  });

  // MUST STILL WORK: a switch to private empties the public merge over a
  // non-empty read — the exact shape the guard refuses — and must go through,
  // because the entry moved rather than vanished.
  const move = planFavoritesPublish({
    merged: emptiedPublic,
    readTags: wire,
    exists: true,
    trustworthy: true,
    local: EMPTY_LOCAL,
    mode: 'private',
    privateMerged: filledPrivate,
    readPrivateTags: [],
    readContent: '',
    privateLocal: mine,
  });
  check('switching to private is not a wholesale delete', move.reason, 'publish');
  check('...and it does encrypt, because the private half genuinely changed', move.encryptPrivate, true);

  // The naive fix is a per-half test, and it refuses the feature it protects.
  const perHalf = emptiedPublic.nodes.length === 0 && wire.some((t) => t[0] === 'i');
  check('(naive) a per-half test refuses a legitimate switch', perHalf, true);

  // AND THE REAL THING IS STILL CAUGHT: an unhydrated store empties both halves
  // at once, because both are fed from one local list.
  const bothEmpty = planFavoritesPublish({
    merged: emptiedPublic,
    readTags: wire,
    exists: true,
    trustworthy: true,
    local: EMPTY_LOCAL,
    mode: 'private',
    privateMerged: mergeFavoritesList({
      read: EMPTY_PARSED, local: EMPTY_LOCAL, baseline: baselineHalf(split, 'private'),
    }),
    readPrivateTags: [],
    readContent: '',
    privateLocal: EMPTY_LOCAL,
  });
  check('both halves empty over a list that is not is still refused', bothEmpty.reason, 'wholesale-delete');
  check('...and publishes nothing', bothEmpty.publish, false);

  // ...unless the user asked for exactly that, in as many words.
  const withdrawn = planFavoritesPublish({
    merged: emptiedPublic,
    readTags: wire,
    exists: true,
    trustworthy: true,
    local: EMPTY_LOCAL,
    privateMerged: EMPTY_PARSED,
    readPrivateTags: [],
    readContent: '',
    privateLocal: EMPTY_LOCAL,
    emptyIsIntentional: true,
  });
  check('a confirmed withdrawal is allowed past it', withdrawn.reason, 'publish');
  check('...and records an empty baseline once it lands', withdrawn.baseline, {
    feeds: [], items: [], privateFeeds: [], privateItems: [],
  });
}

// ---------------------------------------------------------------------------
section('The private half — a withdrawal takes ONLY our own entries');
// ---------------------------------------------------------------------------
{
  // A group of ours with another app's track under it. Dropping the group takes
  // their track with it, because the group is the only thing naming its parent.
  const wire = [
    ['alt', LIST_ALT],
    ['medium', 'music'],
    ['i', showId(F_MUSIC)],
    ['i', itemId(I_A)],   // ours
    ['i', itemId(I_ODD)], // theirs
    ['i', showId(F_POD)], // theirs entirely
    ['k', 'podcast:guid'],
    ['k', 'podcast:item:guid'],
  ];
  const mine = groupLocalFavorites([{ id: itemId(I_A), feedRef: F_MUSIC, medium: 'music' }]);
  const split = baselineForHalves(mine, EMPTY_LOCAL);

  const after = tagsFromList(mergeFavoritesList({
    read: parseFavoritesList(wire), local: EMPTY_LOCAL, baseline: baselineHalf(split, 'public'),
  }));

  check('our track goes', after.some((t) => t[1] === itemId(I_A)), false);
  check('their track stays', after.some((t) => t[1] === itemId(I_ODD)), true);
  check('the group naming its parent stays with it', after.some((t) => t[1] === showId(F_MUSIC)), true);
  check('and their own feed is untouched', after.some((t) => t[1] === showId(F_POD)), true);
}

// ---------------------------------------------------------------------------
section('The private half — the plaintext survives an external signer');
// ---------------------------------------------------------------------------
{
  // Amber URL-decodes the WHOLE `nostrsigner:` URI and only then splits it on
  // `?`, so a plaintext carrying one is silently truncated there. Item guids
  // are routinely permalink URLs — which is why `parseItemGuid` is not
  // UUID-gated — so this payload is full of candidates.
  const tags = [
    ['alt', LIST_ALT],
    ['i', itemId('https://example.com/ep?id=42&utm=x')],
    ['i', itemId(I_URL)],
    ['k', 'podcast:item:guid'],
  ];
  const pt = encodePrivateFavorites(tags);

  check('no "?" reaches the signer', pt.includes('?'), false);
  check('and it is still JSON any app can read', decodePrivateFavorites(pt), tags);

  // The control is the obvious implementation.
  check('(naive) bare JSON.stringify hands Amber a "?"', JSON.stringify(tags).includes('?'), true);

  // MUST STILL WORK: nothing else is touched.
  const plain = [['i', showId(F_MUSIC)]];
  check('a payload with no "?" is unchanged', encodePrivateFavorites(plain), JSON.stringify(plain));

  // Not a tag array ⇒ null, so the caller parks the blob instead of rewriting
  // `content` from empty lists. This is the hole lib/nostr/mutes.ts still has.
  check('a decrypted non-array is refused', decodePrivateFavorites('{"a":1}'), null);
  check('a decrypted non-string element is refused', decodePrivateFavorites('[["i",7]]'), null);
  check('garbage is refused', decodePrivateFavorites('not json'), null);
}

// ---------------------------------------------------------------------------
section('The private half — the NIP-44 size cliff');
// ---------------------------------------------------------------------------
{
  // A payload past the older NIP-44 plaintext cap reads back as EMPTY on a
  // signer built to that text, not as an error. Refusing costs one favorite;
  // publishing costs the whole list on that device.
  const many = [];
  for (let i = 0; i < 1200; i += 1) {
    many.push({ id: itemId(`${I_A}-${i}-padded-out-to-a-realistic-permalink-length`), feedRef: F_MUSIC });
  }
  const huge = groupLocalFavorites(many);
  const hugeMerged = mergeFavoritesList({ read: EMPTY_PARSED, local: huge, baseline: EMPTY_BASELINE });
  check(
    'the fixture is genuinely over the ceiling',
    plaintextBytes(encodePrivateFavorites(tagsFromList(hugeMerged))) > PRIVATE_PLAINTEXT_MAX,
    true,
  );

  const over = planFavoritesPublish({
    merged: EMPTY_PARSED,
    readTags: [],
    exists: true,
    trustworthy: true,
    local: EMPTY_LOCAL,
    mode: 'private',
    privateMerged: hugeMerged,
    readPrivateTags: [],
    readContent: '',
    privateLocal: huge,
  });
  check('an oversized private half is refused', over.reason, 'private-too-large');
  check('...and publishes nothing', over.publish, false);

  // MUST STILL WORK.
  const few = groupLocalFavorites([{ id: itemId(I_A), feedRef: F_MUSIC }]);
  const fewMerged = mergeFavoritesList({ read: EMPTY_PARSED, local: few, baseline: EMPTY_BASELINE });
  const under = planFavoritesPublish({
    merged: EMPTY_PARSED,
    readTags: [],
    exists: true,
    trustworthy: true,
    local: EMPTY_LOCAL,
    mode: 'private',
    privateMerged: fewMerged,
    readPrivateTags: [],
    readContent: '',
    privateLocal: few,
  });
  check('an ordinary private half is not', under.reason, 'publish');
}

// ---------------------------------------------------------------------------
section('The private half — TWO CYCLES, because one cycle cannot see this');
// ---------------------------------------------------------------------------
{
  // EVERY OTHER VECTOR IN THIS FILE IS SINGLE-CYCLE, AND THAT IS THE HOLE.
  //
  // A plan is judged on the bytes it emits, so a plan that emits the right
  // bytes passes — even when the BASELINE it records alongside them is a claim
  // this device cannot keep. The damage lands on the next cycle, when that
  // baseline comes back as an input and `mergeFavoritesList`'s removal test
  // (ours, and we no longer hold it) fires on entries we never owned.
  //
  // That shipped. `planFavoritesPublish` derived BOTH halves from their merges
  // — `baselineOfList(input.merged)` and `baselineOfList(input.privateMerged)`
  // — on the reasoning that this app renders the union of both halves and so
  // must claim what it renders. True of the ACTIVE half, whose merge is painted
  // into the store and returns as `local`. False of the other one:
  // `syncFavorites` hands it `EMPTY_LOCAL` on every cycle, so nothing backs the
  // claim next time round and the whole half is read as a removal.
  //
  // Measured both ways: a public-mode device published `content: ''` over a
  // foreign private half, and a private-mode device published `[]` over a
  // foreign public one. Cycle 1 need not even publish — the hydrator records a
  // baseline on 'unchanged' too.
  //
  // So these run the planner TWICE, feeding cycle 1's baseline back in.

  // One cycle of the real pipeline, in the shape `syncFavorites` builds it.
  const cycle = (mode, publicWire, privateWire, store, baseline) => {
    const all = groupLocalFavorites(store);
    const publicLocal = mode === 'private' ? EMPTY_LOCAL : all;
    const privateLocal = mode === 'private' ? all : EMPTY_LOCAL;
    const merged = mergeFavoritesList({
      read: parseFavoritesList(publicWire), local: publicLocal, baseline: baselineHalf(baseline, 'public'),
    });
    const privateMerged = mergeFavoritesList({
      read: parseFavoritesList(privateWire), local: privateLocal, baseline: baselineHalf(baseline, 'private'),
    });
    const plan = planFavoritesPublish({
      merged,
      readTags: publicWire,
      exists: true,
      trustworthy: true,
      local: publicLocal,
      mode,
      privateMerged,
      readPrivateTags: privateWire,
      readContent: privateWire.length > 0 ? 'nip44:…' : '',
      privateUnreadable: false,
      privateLocal,
      previousBaseline: baseline,
    });
    // What the relay holds afterwards.
    const nextPublic = plan.publish ? plan.tags : publicWire;
    let nextPrivate = privateWire;
    if (plan.publish) {
      if (plan.encryptPrivate) nextPrivate = plan.privateTags;
      else if (plan.content === '') nextPrivate = [];
    }
    // What the hydrator paints: the active half whole, the inactive half
    // filtered to what this device's baseline claims.
    const pubPart = partitionList(merged);
    const privPart = partitionList(privateMerged);
    const painted = mode === 'private'
      ? [...claimedByBaseline(pubPart, plan.baseline, 'public').feeds, ...privPart.feeds]
      : [...pubPart.feeds, ...claimedByBaseline(privPart, plan.baseline, 'private').feeds];
    return {
      plan,
      publicWire: nextPublic,
      privateWire: nextPrivate,
      baseline: plan.baseline,
      store: painted.map((f) => ({ id: showId(f.feedGuid), medium: f.medium })),
    };
  };

  const entries = (tags) => tags.filter((t) => t[0] === 'i').map((t) => t[1]);
  const wireOf = (...guids) => tagsFromList(parseFavoritesList([
    ['alt', LIST_ALT], ...guids.map((g) => ['i', showId(g)]),
  ]));

  // -- public mode, another writer's PRIVATE half ---------------------------
  {
    const ours = [{ id: showId(F_MUSIC) }];
    let st = { publicWire: wireOf(F_MUSIC), privateWire: wireOf(F_UNKNOWN), store: ours, baseline: EMPTY_BASELINE };

    st = cycle('public', st.publicWire, st.privateWire, st.store, st.baseline);
    check(
      'public mode, cycle 1: the foreign private half is carried',
      entries(st.privateWire), [showId(F_UNKNOWN)],
    );
    check(
      'public mode, cycle 1: this device claims only its OWN half',
      st.baseline.privateFeeds, [],
    );

    st = cycle('public', st.publicWire, st.privateWire, st.store, st.baseline);
    check(
      'public mode, cycle 2: the foreign private half is STILL there',
      entries(st.privateWire), [showId(F_UNKNOWN)],
    );
    check(
      'public mode, cycle 2: and was not migrated into the indexed public half',
      entries(st.publicWire), [showId(F_MUSIC)],
    );
    check('public mode, cycle 2: nothing to say', st.plan.reason, 'unchanged');
  }

  // -- private mode, another writer's PUBLIC half ---------------------------
  {
    const ours = [{ id: showId(F_MUSIC) }];
    let st = { publicWire: wireOf(F_UNKNOWN), privateWire: wireOf(F_MUSIC), store: ours, baseline: EMPTY_BASELINE };

    st = cycle('private', st.publicWire, st.privateWire, st.store, st.baseline);
    check('private mode, cycle 1: the foreign public half is carried', entries(st.publicWire), [showId(F_UNKNOWN)]);
    check('private mode, cycle 1: this device claims only its OWN half', st.baseline.feeds, []);

    st = cycle('private', st.publicWire, st.privateWire, st.store, st.baseline);
    check('private mode, cycle 2: the foreign public half is STILL there', entries(st.publicWire), [showId(F_UNKNOWN)]);
    check('private mode, cycle 2: ours stays private', entries(st.privateWire), [showId(F_MUSIC)]);
  }

  // -- the property this must NOT cost: a switch still MOVES ----------------
  {
    // A fresh device adopts a public list off the relay, then switches. The
    // adopted entries have to enter the ACTIVE half's baseline or the switch
    // copies instead of moving — the bug the merge-derived baseline fixed, and
    // the one a naive "carry both halves" repair would bring straight back.
    let st = { publicWire: wireOf(F_MUSIC, F_MUSIC2), privateWire: [], store: [], baseline: EMPTY_BASELINE };

    st = cycle('public', st.publicWire, st.privateWire, st.store, st.baseline);
    check('a fresh device adopts the relay list', st.store.map((e) => e.id), [showId(F_MUSIC), showId(F_MUSIC2)]);
    check('...and claims it, so a later switch can remove it',
      st.baseline.feeds, [showId(F_MUSIC), showId(F_MUSIC2)]);

    st = cycle('private', st.publicWire, st.privateWire, st.store, st.baseline);
    check('the switch empties the public half', entries(st.publicWire), []);
    check('...and the private half gains exactly those entries',
      entries(st.privateWire), [showId(F_MUSIC), showId(F_MUSIC2)]);

    st = cycle('private', st.publicWire, st.privateWire, st.store, st.baseline);
    check('and it settles — no republish on the next cycle', st.plan.reason, 'unchanged');
  }

  // -- a withdrawal claims nothing afterwards -------------------------------
  {
    // Both halves get an empty local list, so neither may be recomputed from
    // its merge. Nor may the old claims be carried: a claim naming an entry
    // that is now gone makes `mergeFavoritesList`'s `fresh` filter suppress it
    // if the user ever favorites it again.
    const ours = groupLocalFavorites([{ id: showId(F_MUSIC) }]);
    const publicWire = wireOf(F_MUSIC, F_UNKNOWN);
    const baseline = baselineForHalves(ours, EMPTY_LOCAL);
    const plan = planFavoritesPublish({
      merged: mergeFavoritesList({
        read: parseFavoritesList(publicWire), local: EMPTY_LOCAL, baseline: baselineHalf(baseline, 'public'),
      }),
      readTags: publicWire,
      exists: true,
      trustworthy: true,
      local: EMPTY_LOCAL,
      mode: 'public',
      privateMerged: EMPTY_PARSED,
      readPrivateTags: [],
      readContent: '',
      privateUnreadable: false,
      privateLocal: EMPTY_LOCAL,
      emptyIsIntentional: true,
      withdraw: true,
      previousBaseline: baseline,
    });
    check('a withdrawal removes only our own entry', entries(plan.tags), [showId(F_UNKNOWN)]);
    check('...and claims nothing afterwards, in either half',
      [plan.baseline.feeds, plan.baseline.privateFeeds], [[], []]);
  }
}

// ---------------------------------------------------------------------------
section('Control — the obvious wrong implementation must fail these');
// ---------------------------------------------------------------------------
{
  // Parse to structs, merge by map, rebuild the array. This is what someone
  // writes when they have not been bitten yet, and it is the reason the vectors
  // above are not merely assertions that were true when written.
  const naive = (tags) => {
    const byGuid = new Map();
    let cur = null;
    for (const t of tags) {
      if (t[0] !== 'i' || !t[1]) continue;
      const f = parseShowGuid(t[1]);
      if (f !== null) { cur = { feedGuid: f, items: [] }; byGuid.set(f, cur); continue; }
      const i = parseItemGuid(t[1]);
      if (i !== null && cur) cur.items.push(i);
      // an unrecognized kind is dropped, and so is every non-i tag
    }
    const out = [['alt', LIST_ALT]];
    for (const g of [...byGuid.values()].sort((a, b) => a.feedGuid.localeCompare(b.feedGuid))) {
      out.push(['i', showId(g.feedGuid)]);
      for (const i of g.items) out.push(['i', itemId(i)]);
    }
    return out;
  };

  const mustFail = [
    ['it drops an unknown identifier kind',
      [['i', `podcast:guid:${F_MUSIC}`], ['i', 'something:else:entirely']]],
    ['it drops an unknown tag type',
      [['zzz', 'payload'], ['i', `podcast:guid:${F_MUSIC}`]]],
    ['it loses the medium entirely',
      [['medium', 'music'], ['i', `podcast:guid:${F_MUSIC}`]]],
    ['it reorders groups and re-labels the blocks',
      [['medium', 'music'], ['i', `podcast:guid:${F_POD}`], ['i', `podcast:guid:${F_MUSIC}`]]],
  ];

  for (const [label, wire] of mustFail) {
    const ours = emit(parseFavoritesList(wire));
    const theirs = naive(wire);
    const differs = JSON.stringify(ours) !== JSON.stringify(theirs);
    check(`(naive) ${label}`, differs, true);
  }
}

// ---------------------------------------------------------------------------
section('A CARRIED entry is not evidence that this device holds anything');
// ---------------------------------------------------------------------------
{
  // The third path to the 2026-08-21 wipe, and it hid inside the fix for the
  // first two. The guard asks "did both halves come out empty over a read that
  // was not?", and it asked it of `merged.nodes.length` — with a comment
  // justifying the union on the grounds that "both halves are fed from ONE
  // local list". That is false for the half that matters. `mergeFavoritesList`
  // ALSO carries another writer's entries through untouched, and those are fed
  // by no local state at all.
  //
  // So: an unhydrated store (empty local, exactly what a page load looks like
  // before hydration), a public half this device published, and ONE foreign
  // entry sitting in the private half. `privateMerged.nodes.length` is 1, the
  // union is not zero, the guard does not fire, and the public half publishes
  // as `[['alt', LIST_ALT]]` — every favorite gone, on every device, no undo.
  const pubWire = [
    ['alt', LIST_ALT], ['medium', 'music'], ['i', showId(F_MUSIC)], ['k', 'podcast:guid'],
  ];
  // Never fed by this device: no baseline claim names it, so the merge carries it.
  const privWire = [
    ['alt', LIST_ALT], ['medium', 'music'], ['i', showId(F_MUSIC2)], ['k', 'podcast:guid'],
  ];
  const readPub = parseFavoritesList(pubWire);
  const readPriv = parseFavoritesList(privWire);
  const baselineNamesPublic = { feeds: [showId(F_MUSIC)], items: [], privateFeeds: [], privateItems: [] };

  const merged = mergeFavoritesList({
    read: readPub, local: EMPTY_LOCAL, baseline: baselineHalf(baselineNamesPublic, 'public'),
  });
  const privateMerged = mergeFavoritesList({
    read: readPriv, local: EMPTY_LOCAL, baseline: baselineHalf(baselineNamesPublic, 'private'),
  });

  // The shape that makes this dangerous, asserted so the vector cannot rot into
  // one where the guard would have fired anyway.
  check('the public merge really is empty', merged.nodes.length, 0);
  check('...while the private merge carries the foreign entry', privateMerged.nodes.length, 1);
  check('...and none of it came from local state', privateMerged.localFed, 0);

  const plan = planFavoritesPublish({
    merged, readTags: pubWire, exists: true, trustworthy: true, local: EMPTY_LOCAL,
    mode: 'public',
    privateMerged, readPrivateTags: privWire, readContent: 'nip44:…', privateLocal: EMPTY_LOCAL,
    previousBaseline: baselineNamesPublic,
  });
  check('a foreign private entry does NOT license an empty public publish',
    plan.reason, 'wholesale-delete');
  check('...and nothing is published', plan.publish, false);

  // (naive) the version this replaced: count merged nodes, not provenance.
  const naiveUnion = merged.nodes.length + privateMerged.nodes.length;
  check('(naive) counting merged nodes sees a non-empty union', naiveUnion > 0, true);
  // ...which is the alt-only wipe, spelled out.
  check('(naive) ...and the tags it would have published are alt-only',
    tagsFromList(merged), [['alt', LIST_ALT]]);

  // MUST STILL WORK: a mode switch legitimately empties one half, and the guard
  // must not refuse it. Same empty public merge — but the entries are in the
  // private half BECAUSE THIS DEVICE PUT THEM THERE, so `localFed` is not zero.
  const movedLocal = groupLocalFavorites([{ id: showId(F_MUSIC), medium: 'music' }]);
  const switchPlan = planFavoritesPublish({
    merged: mergeFavoritesList({
      read: readPub, local: EMPTY_LOCAL, baseline: baselineHalf(baselineNamesPublic, 'public'),
    }),
    readTags: pubWire, exists: true, trustworthy: true, local: EMPTY_LOCAL,
    mode: 'private',
    privateMerged: mergeFavoritesList({ read: EMPTY_PARSED, local: movedLocal, baseline: EMPTY_BASELINE }),
    readPrivateTags: [], readContent: '', privateLocal: movedLocal,
    previousBaseline: baselineNamesPublic,
  });
  check('a public→private switch is still allowed', switchPlan.reason === 'wholesale-delete', false);
}

// ---------------------------------------------------------------------------
section('A loose entry we published must be claimable, or it is unremovable');
// ---------------------------------------------------------------------------
{
  // `baselineOfList` walks `entriesFromList`, whose first line is
  // `if (node.t !== 'group') continue`. Every LOOSE node is skipped — and a
  // loose node is a favorite whose parent feed we never learned, published as a
  // bare `i` tag. Recorded nowhere, `mergeFavoritesList`'s loose-removal test
  // can never fire for it, so it is re-emitted on every republish and re-adopted
  // on every hydrate: the heart empties locally and the tag never leaves.
  //
  // The other half of the rule is that a CARRIED loose entry must stay
  // unclaimed, or this device gains permission to delete another app's. So the
  // ids come from the local list and the survivors from the merge.
  const ours = groupLocalFavorites([{ id: itemId(I_ODD), feedRef: '920666' }]);
  check('an item with a non-UUID parent lands loose', ours.loose.length, 1);

  const merged = mergeFavoritesList({ read: EMPTY_PARSED, local: ours, baseline: EMPTY_BASELINE });
  const plan = planFavoritesPublish({
    merged, readTags: [], exists: false, trustworthy: true, local: ours, mode: 'public',
    privateMerged: null, readPrivateTags: [], readContent: '', privateLocal: EMPTY_LOCAL,
    previousBaseline: EMPTY_BASELINE,
  });
  check('a loose entry we published IS claimed', plan.baseline.items, [itemId(I_ODD)]);

  // (naive) groups only — the shape that shipped.
  check('(naive) groups-only records nothing for it', baselineOfList(merged).items, []);

  // And claimed, the unfavorite finally sticks: local no longer holds it, the
  // baseline says we put it there, so the merge drops it.
  const after = mergeFavoritesList({
    read: parseFavoritesList(tagsFromList(merged)),
    local: EMPTY_LOCAL,
    baseline: baselineHalf(plan.baseline, 'public'),
  });
  check('claimed, unfavoriting it removes it', after.nodes.length, 0);
  // (naive) unclaimed, it survives forever.
  const stuck = mergeFavoritesList({
    read: parseFavoritesList(tagsFromList(merged)),
    local: EMPTY_LOCAL,
    baseline: baselineHalf(baselineOfList(merged), 'public'),
  });
  check('(naive) unclaimed, it comes back on every cycle', stuck.nodes.length, 1);

  // MUST STILL WORK: an identifier kind we cannot read belongs to another
  // writer and is never claimed, whichever list it appears in.
  const foreignWire = [['alt', LIST_ALT], ['i', 'something:else:entirely']];
  const foreignMerged = mergeFavoritesList({
    read: parseFavoritesList(foreignWire), local: EMPTY_LOCAL, baseline: EMPTY_BASELINE,
  });
  check('a carried loose entry stays unclaimed',
    looseIdsWePublished(foreignMerged, EMPTY_LOCAL), []);
}

// ---------------------------------------------------------------------------
section('A claim that has stopped being true is worse than no claim');
// ---------------------------------------------------------------------------
{
  // Carrying the inactive half's claims is what fixed "I unfavorited 2 and they
  // came back" (see above). Carrying them FOREVER is the mirror bug. A
  // private→public switch moves entries out of `content`, but the recorded
  // baseline kept naming them, and every later public-mode cycle copied the
  // claim again. When another app — or the user's second device — later
  // favorites one of those same ids privately, this device matches the stale
  // claim, reads it as ours-and-removed, and drops it. A cross-app deletion
  // with no undo, from an assertion that expired at the switch.
  const pubWire = [['alt', LIST_ALT], ['medium', 'music'], ['i', showId(F_MUSIC)], ['k', 'podcast:guid']];
  const mine = groupLocalFavorites([{ id: showId(F_MUSIC), medium: 'music' }]);
  // The switch has already happened: the private half is empty on the wire, and
  // the previous baseline still names what used to be in it.
  const staleClaim = { feeds: [], items: [], privateFeeds: [showId(F_MUSIC2)], privateItems: [] };
  const plan = planFavoritesPublish({
    merged: mergeFavoritesList({ read: parseFavoritesList(pubWire), local: mine, baseline: EMPTY_BASELINE }),
    readTags: pubWire, exists: true, trustworthy: true, local: mine, mode: 'public',
    privateMerged: mergeFavoritesList({ read: EMPTY_PARSED, local: EMPTY_LOCAL, baseline: EMPTY_BASELINE }),
    readPrivateTags: [], readContent: '', privateLocal: EMPTY_LOCAL,
    previousBaseline: staleClaim,
  });
  check('a claim whose entry the switch moved out is retired',
    plan.baseline.privateFeeds, []);
  // (naive) carry verbatim — the shape that shipped.
  check('(naive) carrying verbatim keeps naming it',
    staleClaim.privateFeeds, [showId(F_MUSIC2)]);
  // ...and that is what deletes another writer's entry later.
  const laterPrivWire = [['alt', LIST_ALT], ['medium', 'music'], ['i', showId(F_MUSIC2)], ['k', 'podcast:guid']];
  const deleted = mergeFavoritesList({
    read: parseFavoritesList(laterPrivWire), local: EMPTY_LOCAL,
    baseline: baselineHalf(staleClaim, 'private'),
  });
  check('(naive) ...so a later foreign private entry is deleted', deleted.nodes.length, 0);
  const survives = mergeFavoritesList({
    read: parseFavoritesList(laterPrivWire), local: EMPTY_LOCAL,
    baseline: baselineHalf(plan.baseline, 'private'),
  });
  check('retired, that entry survives', survives.nodes.length, 1);

  // MUST STILL WORK: an UNREADABLE half is carried verbatim. Absence from a half
  // we could not open is not evidence of anything, and filtering on it would
  // disown every private entry at once — the bug the carry rule exists for.
  const keptPlan = planFavoritesPublish({
    merged: mergeFavoritesList({ read: parseFavoritesList(pubWire), local: mine, baseline: EMPTY_BASELINE }),
    readTags: pubWire, exists: true, trustworthy: true, local: mine, mode: 'public',
    privateMerged: null, privateUnreadable: true,
    readPrivateTags: [], readContent: 'nip44:…', privateLocal: EMPTY_LOCAL,
    previousBaseline: staleClaim,
  });
  check('an unreadable half keeps its claims verbatim',
    keptPlan.baseline.privateFeeds, [showId(F_MUSIC2)]);
}

// ---------------------------------------------------------------------------
section('a stale RECORDED mode the wire contradicts is corrected, one way only');
// ---------------------------------------------------------------------------
//
// `favPrivacy` rides in the kind:30078 settings backup, whose d-tag is
// unbranded on purpose — so one stale `'public'` is restored on every sign-in,
// on every device and both deploys. `seedFavoritesMode` short-circuited on a
// recorded mode and never asked the wire, and in public mode the private half
// is filtered by `claimedByBaseline`, which on a device with no baseline drops
// ALL of it. Measured on a real account: 0 public tags, 880 private, 218 feeds
// and 230 items rendering as an empty library with no error anywhere.
{
  const MODE_VECTORS = [
    // The measured bug.
    { args: ['public', false, true], expect: 'private', alsoNaive: true,
      why: 'a private-only wire corrects a stale recorded public' },

    // MUST NOT MOVE. One plaintext tag from any other writer means the account
    // may genuinely be public, and moving a real public list into `content` is
    // an edit every app without NIP-44 reads as an empty list.
    { args: ['public', true, true], expect: null,
      why: 'a MIXED wire is not evidence — leave it alone' },
    { args: ['public', true, false], expect: null, alsoNaive: true,
      why: 'a genuinely public account is untouched' },
    { args: ['public', false, false], expect: null, alsoNaive: true,
      why: 'an empty wire teaches nothing' },

    // MUST NOT REWRITE what is already right — a correction that returns the
    // value it was given still costs a write on every load.
    { args: ['private', false, true], expect: null,
      why: 'already private, nothing to correct' },

    // 'off' is a deliberate opt-out. The wire has no standing to overrule it,
    // and turning sync back on for someone who switched it off is the one
    // answer here that is never recoverable by reloading.
    { args: ['off', false, true], expect: null,
      why: 'a deliberate opt-out survives the wire' },

    // Never seeded here — that is `seedModeFromWire`'s job, and conflating them
    // would let this path invent a mode for an account that has never chosen.
    { args: [null, false, true], expect: null, alsoNaive: false,
      why: 'an unrecorded mode is seeding, not correcting' },
  ];

  for (const v of MODE_VECTORS) {
    check(`correctedModeFromWire(${JSON.stringify(v.args)}) — ${v.why}`,
      correctedModeFromWire(...v.args), v.expect);
  }

  // TOTAL naive replay. `naive` is the version somebody would write from the
  // symptom alone: "the wire has a private half, so this account is private".
  // It ignores what was RECORDED and whether the wire is mixed — so it moves a
  // genuinely mixed list, rewrites a mode that was already right, and overrules
  // a user who deliberately switched sync off.
  const naive = (_recorded, _hasPublic, hasPrivate) => (hasPrivate ? 'private' : null);
  let proved = 0, exempt = 0;
  for (const v of MODE_VECTORS) {
    if (v.alsoNaive) { exempt += 1; continue; }
    if (naive(...v.args) === v.expect) {
      failures += 1;
      console.error(`  FAIL  (naive) agrees on "${v.why}" — this vector proves nothing`);
    } else proved += 1;
  }
  console.log(`        ${proved} vector(s) proved against naive(), ${exempt} exempt as must-still-work`);
}

// ---------------------------------------------------------------------------
section('a refused read may still be PAINTED when the guard protects nothing');
// ---------------------------------------------------------------------------
//
// `wholesale-delete` means "do not publish this". It never meant "do not render
// this", and the two were the same branch — so the SAME ACCOUNT on a SECOND
// ORIGIN (this repo builds two deploys, and localStorage is per-origin) read
// 880 private entries off the relay and painted none of them. The planner was
// right to refuse the publish; the refusal was withholding the list from the
// user to protect a device holding nothing.
//
// Recorded as calls so the naive replay at the foot is total.
{
  const ADOPT_VECTORS = [
    // The bug this exists for: a new origin. Nothing cached, nothing ever
    // agreed here, and a full relay list carried through the merge.
    // Exempt one vector at a time, never by default: `naive` adopts here too,
    // and correctly. Its fault is the OTHER direction — it over-adopts — which
    // is what the two refusals below catch.
    { args: [{ cacheHasEntries: false, baselineClaimsEntries: false, carriedNodes: 880 }],
      expect: true, alsoNaive: true, why: 'a second origin adopts the list it can see' },

    // MUST KEEP REFUSING. A baseline naming ids beside a cache holding none is
    // the 2026-08-21 wipe's exact input — the device DID agree something here
    // once, so an empty local set is a removal claim, not a fresh start.
    { args: [{ cacheHasEntries: false, baselineClaimsEntries: true, carriedNodes: 880 }],
      expect: false, why: 'a baseline claiming ids over an empty cache is the wipe shape' },

    // MUST KEEP REFUSING. Painting nothing is the destructive case itself: it
    // writes through and destroys cached[feed.feedGuid].
    { args: [{ cacheHasEntries: false, baselineClaimsEntries: false, carriedNodes: 0 }],
      expect: false, why: 'there is nothing to adopt, so painting only destroys' },

    // MUST STILL WORK: the guard's original job. A device that holds favorites
    // keeps them; this branch must not touch that case at all.
    { args: [{ cacheHasEntries: true, baselineClaimsEntries: false, carriedNodes: 880 }],
      expect: false, alsoNaive: true, why: 'a device that holds favorites is unaffected' },
    { args: [{ cacheHasEntries: true, baselineClaimsEntries: true, carriedNodes: 0 }],
      expect: false, alsoNaive: true, why: 'the ordinary refusal is unchanged' },
  ];

  for (const v of ADOPT_VECTORS) {
    check(`mayAdoptRefusedRead — ${v.why}`, mayAdoptRefusedRead(...v.args), v.expect);
  }

  // TOTAL naive replay. `naive` is the version somebody would actually write:
  // "the cache is empty, so there is nothing to lose". It misses BOTH halves
  // that matter — the baseline claim, and the empty read.
  const naive = (i) => !i.cacheHasEntries;
  let proved = 0, exempt = 0;
  for (const v of ADOPT_VECTORS) {
    if (v.alsoNaive) { exempt += 1; continue; }
    const n = naive(...v.args);
    if (n === v.expect) {
      failures += 1;
      console.error(`  FAIL  (naive) agrees on "${v.why}" — this vector proves nothing`);
    } else proved += 1;
  }
  console.log(`        ${proved} vector(s) proved against naive(), ${exempt} exempt as must-still-work`);
}

// ---------------------------------------------------------------------------
console.log('\nfavorites-list.ts stays loadable under plain Node');
// ---------------------------------------------------------------------------
{
  // The arrangement this whole script depends on: it imports the REAL module,
  // so the module must keep resolving under `node --experimental-strip-types`.
  // See scripts/import-free.mjs for why a type-only relative import counts.
  const problems = importFreeProblems('lib/nostr/favorites-list.ts');
  if (problems.length) { explainImportFree('lib/nostr/favorites-list.ts', problems); failures += problems.length; }
  else console.log('  ok    lib/nostr/favorites-list.ts has no imports that plain Node cannot resolve');
}

if (failures) {
  console.error(`\n${failures} favorites check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll favorites checks passed.');
