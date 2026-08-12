// Pins the cross-app favorites merge — the function that decides what stays on
// a Nostr list several apps write to.
//
// Usage:
//   npm run check:favsync
//
// Run it after ANY edit to lib/nostr/favorites-merge.ts.
//
// Why this earns a check script: the shared list is ONE kind:30078 replaceable
// event at a well-known address (docs/pc20-favorites.md). A replaceable event
// has no partial update — every publish replaces the whole thing — so a merge
// bug doesn't degrade, it DELETES, silently, on someone else's device, with no
// undo and no error anywhere. The three ways to get it wrong all type-check:
//
//   - Publish the local set → every entry another app added is erased.
//   - Publish the union → unfavoriting stops working, permanently.
//   - Interpret before merging → identifier kinds this app doesn't implement
//     (a third app's, or StableKraft's track favorites seen from here) get
//     dropped as "unrecognized" the first time this app publishes.
//
// The must-still-work half is the removal cases: a merge that never deletes
// anything is trivially safe and completely useless, so `lastSynced` semantics
// are pinned in both directions.
//
// `--experimental-strip-types` lets this .mjs import the real .ts module. That
// is the whole point: a reimplemented copy stays green while the shipping merge
// drifts, which is the exact failure being guarded. favorites-merge.ts is
// importable by plain Node because it has NO imports at all — keep it that way
// (favorites.ts, which does the I/O, is not loadable here, which is why the
// pure half lives in its own module).

import {
  baselineFrom,
  LEGACY_FAVORITES_KIND,
  SHARED_FAVORITES_KIND,
  identifierKind,
  interpretItems,
  interpretShows,
  itemId,
  itemsFromTags,
  mergeSharedFavorites,
  otherTagsFrom,
  showId,
  tagsForSharedFavorites,
  SHARED_D_TAG,
} from '../lib/nostr/favorites-merge.ts';

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) console.log(`       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// Real-shaped identifiers. A is a show this device favorited, B a show another
// app added, C an episode, X an identifier kind this app doesn't implement.
const A = showId('9b024349-ccf0-5f69-a609-6b82873eab3c');
const B = showId('c31ad2f6-1b7e-5b34-a2a4-6b06d5b0b4e2');
const C = itemId('https://example.com/ep/42');
const X = 'podcast:publisher:guid:0e8f6a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b';

const ids = (items) => items.map((i) => i.id);

console.log('the address — where the shared list actually lives');
{
  // Pinned because a drift here has no visible symptom other than "my
  // favorites didn't sync", which is the least diagnosable failure in the
  // feature: both apps keep working, they just stop seeing each other.
  //
  // 30078 is NIP-78 app data, NOT NIP-51's kind 30003 (bookmark sets). Podcast
  // favorites are not bookmarks, and a generic bookmark client editing a set
  // would rewrite this list without any of the merge discipline below.
  check('the shared list is NIP-78 app data', SHARED_FAVORITES_KIND, 30078);
  check('it is NOT a NIP-51 bookmark set', SHARED_FAVORITES_KIND === 30003, false);
  // The pre-sync list stays where its data already is. Read-only forever.
  check('the legacy list is still read at kind 30003', LEGACY_FAVORITES_KIND, 30003);
}

console.log('\nmergeSharedFavorites — a shared list several apps write to');
{
  check(
    'a first publish from a device with no baseline is a pure union',
    ids(mergeSharedFavorites({ latest: [], lastSynced: [], local: [{ id: A }] })),
    [A],
  );

  // THE clobber case. Another app added B while this device was offline: B is
  // on the relay but absent from both `local` and `lastSynced`. Publishing the
  // local set here is what wipes another app's favorites.
  check(
    'an entry another app added survives a republish from this device',
    ids(mergeSharedFavorites({ latest: [{ id: B }], lastSynced: [], local: [{ id: A }] })),
    [B, A],
  );

  check(
    'a local removal propagates — it was in the baseline and is now gone',
    ids(mergeSharedFavorites({ latest: [{ id: A }, { id: B }], lastSynced: [A, B], local: [{ id: B }] })),
    [B],
  );

  // Both directions at once: this is the merge doing its actual job.
  check(
    'a local add and a local removal apply on top of a concurrent foreign add',
    ids(mergeSharedFavorites({
      latest: [{ id: A }, { id: X }],
      lastSynced: [A],
      local: [{ id: C }],
    })),
    [X, C],
  );

  // The single most destructive input: a device that has hydrated nothing yet.
  // With no baseline there are no removals, so the relay's list must survive
  // untouched — an empty `local` must never read as "delete everything".
  check(
    'an empty local set with no baseline deletes nothing',
    ids(mergeSharedFavorites({ latest: [{ id: A }, { id: B }], lastSynced: [], local: [] })),
    [A, B],
  );

  // ...but an empty local set WITH a baseline is a real "I unfavorited them
  // all", and must be honoured, or the list can never be emptied.
  check(
    'an empty local set with a full baseline is a real clear-all',
    ids(mergeSharedFavorites({ latest: [{ id: A }, { id: B }], lastSynced: [A, B], local: [] })),
    [],
  );

  check(
    'an identifier kind this app does not implement is never dropped',
    ids(mergeSharedFavorites({ latest: [{ id: X }], lastSynced: [], local: [{ id: A }] })),
    [X, A],
  );

  // THE RESURRECTION CASE. Another app unfavorited A and published without it.
  // This device still has A locally (it hasn't hydrated yet) and A is in its
  // baseline. Appending every local item — the obvious way to write the second
  // loop — puts A straight back, so the user unfavorites in app A, opens app B,
  // and it returns. Only a genuine local ADD may be appended.
  check(
    'an entry another app removed is NOT resurrected by this device',
    ids(mergeSharedFavorites({ latest: [{ id: B }], lastSynced: [A, B], local: [{ id: A }, { id: B }] })),
    [B],
  );
  // ...while an entry this device added and has never published (not in the
  // baseline) still goes up, which is what distinguishes the two.
  check(
    'a never-published local add still goes up',
    ids(mergeSharedFavorites({ latest: [{ id: B }], lastSynced: [B], local: [{ id: A }, { id: B }] })),
    [B, A],
  );

  check(
    'surviving entries keep relay order; new local entries append',
    ids(mergeSharedFavorites({
      latest: [{ id: B }, { id: X }, { id: A }],
      lastSynced: [B, X, A],
      local: [{ id: A }, { id: B }, { id: X }, { id: C }],
    })),
    [B, X, A, C],
  );

  check(
    'a local hint upgrades a relay entry that has none',
    mergeSharedFavorites({
      latest: [{ id: A }],
      lastSynced: [A],
      local: [{ id: A, feedUrl: 'https://example.com/feed.xml' }],
    }),
    [{ id: A, feedUrl: 'https://example.com/feed.xml', feedRef: undefined }],
  );

  check(
    'a relay hint is never blanked by a local entry that lacks one',
    mergeSharedFavorites({
      latest: [{ id: A, feedUrl: 'https://example.com/feed.xml' }],
      lastSynced: [A],
      local: [{ id: A }],
    }),
    [{ id: A, feedUrl: 'https://example.com/feed.xml', feedRef: undefined }],
  );
}

console.log('\nbaselineFrom — what this app is allowed to delete later');
{
  // The baseline feeds `removes = baseline − local`, and `local` can only ever
  // hold what this app can represent. So a baseline built from the whole
  // published list makes every foreign identifier a removal on the NEXT
  // publish — the app deletes a third app's entries one toggle later, which is
  // the exact opposite of the rule the format rests on.
  check(
    'a foreign id is never written into the baseline',
    baselineFrom([{ id: B }, { id: X }, { id: A }], [{ id: A }]),
    [A],
  );
  check(
    'so it survives the SECOND publish too, not just the first',
    ids(mergeSharedFavorites({
      latest: [{ id: X }, { id: A }],
      lastSynced: baselineFrom([{ id: X }, { id: A }], [{ id: A }]),
      local: [{ id: A }],
    })),
    [X, A],
  );
  check(
    'an entry this device dropped locally leaves the baseline',
    baselineFrom([{ id: A }, { id: B }], [{ id: B }]),
    [B],
  );
}

console.log('\ntagsForSharedFavorites / itemsFromTags — the wire round trip');
{
  const items = [
    { id: A, feedUrl: 'https://example.com/feed.xml' },
    { id: C, feedUrl: 'https://example.com/feed.xml', feedRef: A },
    { id: X },
  ];
  const tags = tagsForSharedFavorites(items, [['alt', 'from another client']]);

  check('the d tag is the shared, app-neutral address', tags[0], ['d', SHARED_D_TAG]);
  check(
    'another writer\'s tag is replayed verbatim',
    tags.filter((t) => t[0] === 'alt'),
    [['alt', 'from another client']],
  );
  check(
    'a show is a NIP-73 i tag with the feed URL as the position-2 hint',
    tags.find((t) => t[1] === A),
    ['i', A, 'https://example.com/feed.xml'],
  );
  check(
    'an episode carries its parent feed in position 3',
    tags.find((t) => t[1] === C),
    ['i', C, 'https://example.com/feed.xml', A],
  );
  check(
    'k tags are one per distinct identifier kind, not one per favorite',
    tags.filter((t) => t[0] === 'k'),
    [['k', 'podcast:guid'], ['k', 'podcast:item:guid'], ['k', 'podcast:publisher:guid']],
  );
  // C's guid is a permalink URL, which is what real feeds ship. Deriving the
  // kind by scanning for a colon yields `podcast:item:guid:https` — a k tag no
  // relay filter matches, and nothing on screen looks wrong.
  check(
    'a URL-shaped item guid does not corrupt its k tag',
    identifierKind(itemId('https://example.com/ep/42')),
    'podcast:item:guid',
  );
  check(
    'an unrecognized identifier kind gets no invented k tag',
    identifierKind('some:other:scheme:value'),
    null,
  );
  check(
    'but another app\'s k tag for that kind is preserved, not stripped',
    otherTagsFrom([['k', 'some:other:scheme'], ['k', 'podcast:guid'], ['d', SHARED_D_TAG]]),
    [['k', 'some:other:scheme']],
  );
  // The round trip is what a second app depends on: anything this app writes,
  // it must be able to read back identically, hints and all.
  check('tags → items → tags is lossless', itemsFromTags(tags), items);
  check('managed tags are not mistaken for another writer\'s', otherTagsFrom(tags), [
    ['alt', 'from another client'],
  ]);

  // An entry with a parent feed but no feed URL still needs position 3, so
  // position 2 is held open with an empty string rather than shifting.
  check(
    'a feed ref with no URL hint holds position 2 open',
    tagsForSharedFavorites([{ id: C, feedRef: A }]).find((t) => t[1] === C),
    ['i', C, '', A],
  );
  check(
    'and reads back with the hint absent, not empty-string',
    itemsFromTags([['i', C, '', A]]),
    [{ id: C, feedUrl: undefined, feedRef: A }],
  );
}

console.log('\ninterpretShows / interpretItems — reading is lossy, the wire is not');
{
  // Feed IDs and live-episode strings written by old versions of this app.
  const junk = [{ id: A }, { id: showId('920666') }, { id: showId('live:abc') }];
  check('malformed show guids are separated, not silently kept', interpretShows(junk), {
    guids: ['9b024349-ccf0-5f69-a609-6b82873eab3c'],
    malformed: ['920666', 'live:abc'],
  });
  // ...and the merge still carries them, which is the point: only an explicit
  // bmbCleanFavorites() removes them.
  check(
    'but the merge preserves them anyway',
    ids(mergeSharedFavorites({ latest: junk, lastSynced: [], local: [] })).length,
    3,
  );

  check(
    'an episode resolves its parent feed from the position-3 hint',
    interpretItems([{ id: C, feedUrl: 'https://example.com/feed.xml', feedRef: A }]),
    [{
      itemGuid: 'https://example.com/ep/42',
      feedGuid: '9b024349-ccf0-5f69-a609-6b82873eab3c',
      feedUrl: 'https://example.com/feed.xml',
    }],
  );
  check(
    'an episode with no parent feed is readable but unresolvable',
    interpretItems([{ id: C }]),
    [{ itemGuid: 'https://example.com/ep/42', feedGuid: undefined, feedUrl: undefined }],
  );
  check(
    'a show identifier is never read as an episode',
    interpretItems([{ id: A }, { id: X }]),
    [],
  );
}

if (failures) {
  console.error(`\n${failures} favorites-sync check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll favorites-sync checks passed.');
