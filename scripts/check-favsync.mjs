// Pins the cross-app favorites merge — the function that decides what stays on
// a Nostr list several apps write to.
//
// Usage:
//   npm run check:favsync
//
// Run it after ANY edit to lib/nostr/favorites-merge.ts.
//
// Why this earns a check script: the shared list is ONE kind:30078 replaceable
// event at a well-known address, specified by an external app-neutral spec
// (github.com/ChadFarrow/PC20-Nostr/specs/pc20-favorites.md). A replaceable event
// has no partial update — every publish replaces the whole thing — so a merge
// bug doesn't degrade, it DELETES, silently, on someone else's device, with no
// undo and no error anywhere. The four ways to get it wrong all type-check:
//
//   - Publish the local set → every entry another app added is erased.
//   - Publish the union → unfavoriting stops working, permanently.
//   - Interpret before merging → identifier kinds this app doesn't implement
//     (a third app's, or StableKraft's track favorites seen from here) get
//     dropped as "unrecognized" the first time this app publishes.
//   - Rebuild the `i` tag from the fields you parsed → every position past the
//     ones you model is deleted, on every entry, on every publish.
//
// The must-still-work half is the removal cases: a merge that never deletes
// anything is trivially safe and completely useless, so `lastSynced` semantics
// are pinned in both directions.
//
// ---------------------------------------------------------------------------
// FIXTURE RULE, and it is the reason this file was rewritten.
//
// Build every wire fixture with `wire(...)` — from a literal `i` tag — never
// from an object literal made of the fields the code already knows about. A
// round-trip assertion whose input is constructed out of your own struct CANNOT
// FAIL: you write the positions you know, read them back, and the comparison is
// vacuously true while the code truncates everything else.
//
// This script had exactly such an assertion, named 'tags → items → tags is
// lossless', and it was green for the entire life of the feature while every
// publish dropped whatever another app had written past position 3. The spec
// calls this file out by name for it. The tail-preservation block below is the
// fixture that can actually fail: it carries a position nothing here models.
// ---------------------------------------------------------------------------
//
// `--experimental-strip-types` lets this .mjs import the real .ts module. That
// is the whole point: a reimplemented copy stays green while the shipping merge
// drifts, which is the exact failure being guarded. favorites-merge.ts is
// importable by plain Node because it has NO imports at all — keep it that way
// (favorites.ts, which does the I/O, is not loadable here, which is why the
// pure half lives in its own module).

import {
  baselineFrom,
  ITEMS_D_TAG,
  LEGACY_FAVORITES_KIND,
  SHARED_FAVORITES_KIND,
  placementFor,
  planFavoritesPublish,
  titleFor,
  feedRefOf,
  feedUrlOf,
  identifierKind,
  interpretItems,
  interpretShows,
  itemFrom,
  itemId,
  itemsFromTags,
  looksLikeFeedGuid,
  mediumOf,
  mergeSharedFavorites,
  otherTagsFrom,
  showId,
  tagsForSharedFavorites,
  LEGACY_D_TAG,
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
const FEED_GUID = '9b024349-ccf0-5f69-a609-6b82873eab3c';
const A = showId(FEED_GUID);
const B = showId('c31ad2f6-1b7e-5b34-a2a4-6b06d5b0b4e2');
const C = itemId('https://example.com/ep/42');
const X = 'podcast:publisher:guid:0e8f6a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b';

// An entry as it arrives FROM A RELAY: parsed out of a literal wire tag, the
// same way the reader does it. See the FIXTURE RULE above — this is what makes
// a preservation vector capable of failing.
const wire = (...tag) => itemsFromTags([['i', ...tag]])[0];
// An entry as THIS DEVICE builds it from the store.
const mine = itemFrom;

const ids = (items) => items.map((i) => i.id);
const tagsOf = (items) => items.map((i) => i.tag);

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
    ids(mergeSharedFavorites({ latest: [], lastSynced: [], local: [mine({ id: A })] })),
    [A],
  );

  // THE clobber case. Another app added B while this device was offline: B is
  // on the relay but absent from both `local` and `lastSynced`. Publishing the
  // local set here is what wipes another app's favorites.
  check(
    'an entry another app added survives a republish from this device',
    ids(mergeSharedFavorites({ latest: [wire(B)], lastSynced: [], local: [mine({ id: A })] })),
    [B, A],
  );

  check(
    'a local removal propagates — it was in the baseline and is now gone',
    ids(mergeSharedFavorites({ latest: [wire(A), wire(B)], lastSynced: [A, B], local: [mine({ id: B })] })),
    [B],
  );

  // Both directions at once: this is the merge doing its actual job.
  check(
    'a local add and a local removal apply on top of a concurrent foreign add',
    ids(mergeSharedFavorites({
      latest: [wire(A), wire(X)],
      lastSynced: [A],
      local: [mine({ id: C })],
    })),
    [X, C],
  );

  // The single most destructive input: a device that has hydrated nothing yet.
  // With no baseline there are no removals, so the relay's list must survive
  // untouched — an empty `local` must never read as "delete everything".
  check(
    'an empty local set with no baseline deletes nothing',
    ids(mergeSharedFavorites({ latest: [wire(A), wire(B)], lastSynced: [], local: [] })),
    [A, B],
  );

  // ...but an empty local set WITH a baseline is a real "I unfavorited them
  // all", and must be honoured, or the list can never be emptied.
  check(
    'an empty local set with a full baseline is a real clear-all',
    ids(mergeSharedFavorites({ latest: [wire(A), wire(B)], lastSynced: [A, B], local: [] })),
    [],
  );

  check(
    'an identifier kind this app does not implement is never dropped',
    ids(mergeSharedFavorites({ latest: [wire(X)], lastSynced: [], local: [mine({ id: A })] })),
    [X, A],
  );

  // THE RESURRECTION CASE. Another app unfavorited A and published without it.
  // This device still has A locally (it hasn't hydrated yet) and A is in its
  // baseline. Appending every local item — the obvious way to write the second
  // loop — puts A straight back, so the user unfavorites in app A, opens app B,
  // and it returns. Only a genuine local ADD may be appended.
  check(
    'an entry another app removed is NOT resurrected by this device',
    ids(mergeSharedFavorites({ latest: [wire(B)], lastSynced: [A, B], local: [mine({ id: A }), mine({ id: B })] })),
    [B],
  );
  // ...while an entry this device added and has never published (not in the
  // baseline) still goes up, which is what distinguishes the two.
  check(
    'a never-published local add still goes up',
    ids(mergeSharedFavorites({ latest: [wire(B)], lastSynced: [B], local: [mine({ id: A }), mine({ id: B })] })),
    [B, A],
  );

  // The `∪ adds` vs `∪ local` asymmetry, which the vectors above cannot
  // distinguish: with local == baseline both produce the same answer. This is
  // the first asymmetry the spec flags and it silently resurrects deleted
  // favorites, so it gets its own vector. Another app unfavorited B; this
  // device has changed nothing, so B must not come back.
  check(
    'a foreign removal is not undone by appending the whole local set',
    ids(mergeSharedFavorites({
      latest: [wire(A)],
      lastSynced: [A, B],
      local: [mine({ id: A }), mine({ id: B })],
    })),
    [A], // `∪ local` would give [A, B], on every device, on every publish
  );

  check(
    'surviving entries keep relay order; new local entries append',
    ids(mergeSharedFavorites({
      latest: [wire(B), wire(X), wire(A)],
      lastSynced: [B, X, A],
      local: [mine({ id: A }), mine({ id: B }), mine({ id: X }), mine({ id: C })],
    })),
    [B, X, A, C],
  );
}

console.log('\noverlayTag — fill what is empty, never touch what is not');
{
  check(
    'a local hint fills a position the relay entry left empty',
    tagsOf(mergeSharedFavorites({
      latest: [wire(C)],
      lastSynced: [C],
      local: [mine({ id: C, feedRef: FEED_GUID })],
    })),
    [['i', C, '', FEED_GUID]],
  );

  // The one licensed rewrite of a value we may not have written. Position 3 is
  // re-encoded to bare — lossless, in a position whose meaning is fixed — which
  // is how the wire converges off the 13-byte prefix. The fixture MUST arrive
  // prefixed or it exercises nothing. Contrast position 2 below, where
  // stripping a value you didn't write is forbidden.
  check(
    'a prefixed parent ref from another writer is re-emitted bare',
    tagsOf(mergeSharedFavorites({
      latest: [wire(C, 'https://example.com/feed.xml', A)],
      lastSynced: [],
      local: [],
    })),
    [['i', C, 'https://example.com/feed.xml', FEED_GUID]],
  );

  // Position 2 is reserved. An existing value is carried forever...
  check(
    'a legacy feed URL on the wire is never blanked by a local entry lacking one',
    tagsOf(mergeSharedFavorites({
      latest: [wire(A, 'https://example.com/feed.xml')],
      lastSynced: [A],
      local: [mine({ id: A })],
    })),
    [['i', A, 'https://example.com/feed.xml']],
  );
  // ...and one this device somehow held would still never reach the wire,
  // because `itemFrom` has no parameter that can put it there. Reintroducing
  // origination is a compile error, not a silent regression.
  check(
    'this app cannot originate a position 2 even when handed one',
    itemFrom({ id: A, feedUrl: 'https://example.com/feed.xml' }).tag,
    ['i', A],
  );

  // Spec vector 7 — absent is not "clear it".
  check(
    'a medium this device does not know is left alone, not blanked',
    tagsOf(mergeSharedFavorites({
      latest: [wire(A, '', '', 'music')],
      lastSynced: [A],
      local: [mine({ id: A })],
    })),
    [['i', A, '', '', 'music']],
  );

  // Spec vector 8 — filling position 4 must hold 2 and 3 open. Shifting the
  // medium down into position 3 would have the next reader hand "music" to
  // Podcast Index as a podcastguid.
  check(
    'filling an empty medium holds the earlier positions open',
    tagsOf(mergeSharedFavorites({
      latest: [wire(A, 'https://example.com/feed.xml')],
      lastSynced: [A],
      local: [mine({ id: A, medium: 'music' })],
    })),
    [['i', A, 'https://example.com/feed.xml', '', 'music']],
  );

  // Spec vector 9 — the medium vocabulary is open. A value we don't recognize
  // is one a newer app does: not overwritten, not dropped, not case-normalized.
  check(
    'an unrecognized medium survives contact with this app',
    tagsOf(mergeSharedFavorites({
      latest: [wire(A, '', '', 'somethingL')],
      lastSynced: [A],
      local: [mine({ id: A, medium: 'music' })],
    })),
    [['i', A, '', '', 'somethingL']],
  );

  // Spec vector 6, and the one worth copying first. A hint that flip-flops is
  // invisible to any single-pass assertion: each publish looks locally
  // reasonable and the only symptom is that it never stops. Two apps running
  // "prefer my own resolved value" pass every other vector here and rewrite the
  // event against each other forever.
  const local = [mine({ id: A, medium: 'podcast' })]; // we resolved something else
  const once = mergeSharedFavorites({ latest: [wire(A, '', '', 'music')], lastSynced: [A], local });
  const twice = mergeSharedFavorites({ latest: once, lastSynced: [A], local });
  check('the foreign hint wins over our own resolved value', tagsOf(once), [['i', A, '', '', 'music']]);
  check('and feeding the result back in changes nothing (idempotent)', tagsOf(twice), tagsOf(once));
}

console.log('\ntail preservation — a position this app has no field for');
{
  // SPEC VECTOR 4, and the fixture this script was missing. Everything past
  // position 4 belongs exclusively to somebody else: an earlier revision of the
  // spec, or an app newer than this one. The fixture carries a position nothing
  // here models, because a round trip built from our own fields cannot fail.
  // Position 3 is bare here so the vector stays about the TAIL. A prefixed one
  // would be normalized on write — legitimately, see "a prefixed parent ref
  // from another writer is re-emitted bare" above — and the round trip would
  // fail for a reason that has nothing to do with truncation.
  const full = ['i', C, 'https://example.com/feed.xml', FEED_GUID, 'music', 'something-new'];

  const merged = mergeSharedFavorites({
    latest: itemsFromTags([full]),
    lastSynced: [C],
    local: [mine({ id: C })], // this device knows only the identifier
  });

  check('every position survives read → merge → write', tagsOf(merged), [full]);
  check('including the one past anything this app models', merged[0].tag[5], 'something-new');
  check(
    'and it reaches the wire, not just the merge',
    tagsForSharedFavorites(merged).find((t) => t[1] === C),
    full,
  );

  // The same entry, unfavorited elsewhere and re-added locally, must not be
  // rebuilt from our three fields on the way back up.
  check(
    'a local entry never truncates the relay tag it merges onto',
    tagsOf(mergeSharedFavorites({
      latest: itemsFromTags([full]),
      lastSynced: [],
      local: [mine({ id: C, feedRef: B })],
    })),
    [full], // ours fills nothing: every position it could touch is already set
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
    baselineFrom([wire(B), wire(X), wire(A)], [mine({ id: A })]),
    [A],
  );
  check(
    'so it survives the SECOND publish too, not just the first',
    ids(mergeSharedFavorites({
      latest: [wire(X), wire(A)],
      lastSynced: baselineFrom([wire(X), wire(A)], [mine({ id: A })]),
      local: [mine({ id: A })],
    })),
    [X, A],
  );
  check(
    'an entry this device dropped locally leaves the baseline',
    baselineFrom([wire(A), wire(B)], [mine({ id: B })]),
    [B],
  );
}

console.log('\nthe migration round trip — a migrated entry must survive the hydrate that added it');
{
  // `migrateLegacyList` publishes legacy ∪ shared, then the SAME hydrate runs
  // `mergeSharedFavorites` again before the store has been populated with the
  // migrated shows. So the second merge sees `local` WITHOUT them, and whatever
  // baseline the migration recorded decides whether they live.
  //
  // The trap is that "the entries we just moved across" reads like the obvious
  // definition of this app's contribution, and it type-checks. It also deletes
  // them one line later, because the baseline is not a record of authorship —
  // it's a promise that `local` will keep asserting every id in it.
  //
  // This shipped: 17 legacy entries added and removed twice per page load,
  // forever, with 0 of them ever reaching the shared list. Vectors below pin
  // the composed behaviour, since the ordering bug lives in the hydrator (which
  // imports the store and can't be loaded here) rather than in the merge.
  const shared = [wire(X)];                          // a foreign entry already on the list
  const legacy = [mine({ id: A }), mine({ id: B })]; // this app's pre-sync history
  const merged = mergeSharedFavorites({ latest: shared, lastSynced: [], local: legacy });
  check('migration adds the legacy entries without touching the foreign one', ids(merged), [X, A, B]);

  // The store has not been populated yet at this point in the hydrate.
  const localDuringHydrate = [];

  check(
    'the baseline recorded at migration time is empty, NOT the legacy ids',
    baselineFrom(merged, localDuringHydrate),
    [],
  );
  check(
    'so the very next merge in the same hydrate carries them instead of deleting them',
    ids(mergeSharedFavorites({
      latest: merged,
      lastSynced: baselineFrom(merged, localDuringHydrate),
      local: localDuringHydrate,
    })),
    [X, A, B],
  );
  check(
    'the buggy baseline (built from the legacy list) is what wipes them — pinned so the fix cannot silently revert',
    ids(mergeSharedFavorites({
      latest: merged,
      lastSynced: baselineFrom(merged, legacy), // ← what shipped
      local: localDuringHydrate,
    })),
    [X],
  );
  check(
    'once the shows resolve into the store, the baseline adopts them',
    baselineFrom(merged, [mine({ id: A }), mine({ id: B })]),
    [A, B],
  );
}

console.log('\ntagsForSharedFavorites / itemsFromTags — the wire round trip');
{
  const items = [
    mine({ id: A }),
    mine({ id: C, feedRef: A }),
    mine({ id: X }),
  ];
  const tags = tagsForSharedFavorites(items, [['alt', 'from another client']]);

  check('the d tag is the shared, app-neutral address', tags[0], ['d', SHARED_D_TAG]);
  check(
    'another writer\'s tag is replayed verbatim',
    tags.filter((t) => t[0] === 'alt'),
    [['alt', 'from another client']],
  );
  check(
    'a show this app writes is a bare NIP-73 identifier, no feed URL',
    tags.find((t) => t[1] === A),
    ['i', A],
  );
  // SPEC VECTOR 10, writer half. An app whose local type column defaults to
  // "album" publishes that default as fact, and no other app will ever correct
  // it. Absent must stay absent.
  check(
    'a medium is never invented for an entry this app was not told about',
    itemFrom({ id: A }).tag,
    ['i', A],
  );
  // ...but one the feed DID declare goes out, with 2 and 3 held open. On a feed
  // entry that padding costs nearly as much as the value it precedes, and it
  // buys the position its meaning.
  check(
    'a declared medium is published at position 4',
    itemFrom({ id: A, medium: 'music' }).tag,
    ['i', A, '', '', 'music'],
  );
  check(
    'an item publishes its parent feed and its medium together',
    itemFrom({ id: C, feedRef: A, medium: 'music' }).tag,
    ['i', C, '', A, 'music'],
  );
  check(
    'an episode carries its parent feed in position 3, with position 2 held open',
    tags.find((t) => t[1] === C),
    ['i', C, '', A],
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
  // The k tag is derived from position 1 and nothing else. A `["k","music"]`
  // names nothing any app subscribes to, and it pollutes the #k discovery
  // filter for every app that relies on one.
  check(
    'a medium at position 4 mints no k tag of its own',
    tagsForSharedFavorites([wire(A, '', '', 'music')]).filter((t) => t[0] === 'k'),
    [['k', 'podcast:guid']],
  );
  check(
    'nor does a value at a position the spec does not define',
    tagsForSharedFavorites([wire(A, '', '', '', 'something-new')]).filter((t) => t[0] === 'k'),
    [['k', 'podcast:guid']],
  );
  check(
    'but another app\'s k tag for an unknown kind is preserved, not stripped',
    otherTagsFrom([['k', 'some:other:scheme'], ['k', 'podcast:guid'], ['d', SHARED_D_TAG]]),
    [['k', 'some:other:scheme']],
  );
  // NOTE: this round trip is built from `mine(...)`, so it can only ever prove
  // that what we write we can read. It is NOT the losslessness vector — see
  // "tail preservation" above, which is the one with a fixture that can fail.
  check('what this app writes, it reads back identically', itemsFromTags(tags), items);
  check('managed tags are not mistaken for another writer\'s', otherTagsFrom(tags), [
    ['alt', 'from another client'],
  ]);

  // An entry with a parent feed but no feed URL still needs position 3, so
  // position 2 is held open with an empty string rather than shifting.
  check(
    'a feed ref with no URL hint holds position 2 open',
    tagsForSharedFavorites([mine({ id: C, feedRef: A })]).find((t) => t[1] === C),
    ['i', C, '', A],
  );
  const heldOpen = itemsFromTags([['i', C, '', A]])[0];
  check('...and position 2 reads back as absent, not empty-string', feedUrlOf(heldOpen), undefined);
  check(
    '...while position 3 reads back bare, whichever form was written',
    feedRefOf(heldOpen),
    '9b024349-ccf0-5f69-a609-6b82873eab3c',
  );
  check('...and an absent position 4 is undefined, never a default', mediumOf(heldOpen), undefined);
}

console.log('\ninterpretShows / interpretItems — reading is lossy, the wire is not');
{
  // Feed IDs and live-episode strings written by old versions of this app.
  const junk = [wire(A), wire(showId('920666')), wire(showId('live:abc'))];
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

  const BARE = '9b024349-ccf0-5f69-a609-6b82873eab3c';

  // SPEC VECTOR 3, second half. Position 3 is a bare uuid in this revision, but
  // every event written before it carries `podcast:guid:<uuid>` there — and
  // that is still most of what is on the wire. The fixture MUST arrive
  // prefixed: one whose input is already bare passes without exercising the
  // strip at all, which is the whole behaviour being pinned.
  check(
    'a PREFIXED parent feed is normalized on read',
    interpretItems([wire(C, 'https://example.com/feed.xml', A)]),
    [{ itemGuid: 'https://example.com/ep/42', feedGuid: BARE, feedUrl: 'https://example.com/feed.xml' }],
  );
  // ...and the bare form a spec-compliant writer produces reads identically.
  // Before this, a bare uuid failed parseShowGuid, `feedGuid` came back
  // undefined, and the hydrator dropped the episode from the UI entirely —
  // which is why the other app deferred adopting the bare form.
  check(
    'a BARE parent feed reads the same way',
    interpretItems([wire(C, '', BARE)]),
    [{ itemGuid: 'https://example.com/ep/42', feedGuid: BARE, feedUrl: undefined }],
  );
  check(
    'an episode with no parent feed is readable but unresolvable',
    interpretItems([wire(C)]),
    [{ itemGuid: 'https://example.com/ep/42', feedGuid: undefined, feedUrl: undefined }],
  );
  // A parent ref that is neither form is carried, not dropped. The uuid test
  // gates only whether it is worth a Podcast Index request.
  check(
    'a parent ref this app cannot parse is still surfaced',
    interpretItems([wire(C, '', 'not-a-guid')]),
    [{ itemGuid: 'https://example.com/ep/42', feedGuid: 'not-a-guid', feedUrl: undefined }],
  );
  check('...but is not sent to Podcast Index', looksLikeFeedGuid('not-a-guid'), false);
  check('...while a real one is', looksLikeFeedGuid(BARE), true);
  check('...and the prefixed form is never handed over as-is', looksLikeFeedGuid(A), false);
  check(
    'a show identifier is never read as an episode',
    interpretItems([wire(A), wire(X)]),
    [],
  );
}

console.log('\nplacement — which of the two lists an entry belongs to');
{
  // SPEC VECTOR 5, mapping half. Placement is DERIVED from the identifier and
  // never chosen: an entry two apps could place differently is one that gets
  // added to one list, removed from the other, and comes back forever.
  //
  // The publish-level half of this vector — that a combined local set fans out
  // to the right address, asserted over publish() rather than over this
  // function — belongs with the two-address publish and is not pinnable until
  // there is one. A test on the mapping table alone is exactly the vacuity
  // vectors 3 and 4 warn about, so this block is deliberately labelled as only
  // half the assertion.
  check('a show goes to the feeds list', placementFor(A), 'feeds');
  check('an episode goes to the items list', placementFor(C), 'items');
  check('a publisher goes to the feeds list', placementFor(X), 'feeds');
  // An unrecognized kind has no derivation, so it gets the default home rather
  // than a guess. Two apps guessing differently is the bounce this prevents.
  check(
    'an unrecognized kind defaults to the feeds list',
    placementFor('podcast:season:guid:whatever'),
    'feeds',
  );
  // A URL-shaped item guid must not be scanned for a colon — see the k-tag
  // rule. `podcast:item:guid:https` is not a recognized kind, so a scanning
  // implementation would silently place every permalink-guid track on the
  // FEEDS list, which is the list the split exists to keep small.
  check(
    'a URL-shaped item guid still places as an item',
    placementFor(itemId('https://example.com/ep/42')),
    'items',
  );

  check('the items list has its own title', titleFor(ITEMS_D_TAG), 'Podcast Favorite Items');
  check('the feeds list keeps the original', titleFor(SHARED_D_TAG), 'Podcast Favorites');
  // The legacy address gets the same title as the feeds address — it does NOT
  // preserve what is on the event. The live legacy event says 'Favorite
  // Podcasts' and the next publish overwrites it. Harmless (nothing renders a
  // title tag) and longstanding, but pinned so nobody reads the branch above as
  // "only the items list is special-cased because the others are preserved".
  check('the legacy list gets the feeds title, not its own', titleFor(LEGACY_D_TAG), 'Podcast Favorites');
  check(
    'the title tag follows the address it is published to',
    tagsForSharedFavorites([mine({ id: C })], [], ITEMS_D_TAG).slice(0, 2),
    [['d', ITEMS_D_TAG], ['title', 'Podcast Favorite Items']],
  );
}

console.log('\nplanFavoritesPublish — asserted over publish(), not over placementFor');
{
  const D = itemId('https://example.com/ep/99');
  // Defaults are a quiet, fully-trustworthy, empty cycle; each vector overrides
  // only what it is about.
  const plan = (over) => planFavoritesPublish({
    latestFeeds: [], latestItems: [],
    feedsTrustworthy: true, itemsTrustworthy: true,
    baselineFeeds: [], baselineItems: [],
    local: [], split: true,
    ...over,
  });
  const on = (plans, list) => plans.find((p) => p.list === list);
  const idsOn = (plans, list) => on(plans, list)?.next.map((i) => i.id);

  // SPEC VECTOR 5, the half that matters. A unit test on the mapping table
  // passes while the publish path ignores placement entirely — which is the
  // failure being pinned. Feed a COMBINED local set through a full plan.
  const fanOut = plan({ local: [mine({ id: A }), mine({ id: C }), mine({ id: X })] });
  check('the feeds list gets no item guids', idsOn(fanOut, 'feeds'), [A, X]);
  check('the items list gets no feed guids', idsOn(fanOut, 'items'), [C]);

  // Running one list's merge against the WHOLE local set is the failure this
  // guards: `adds = local − baseline` would sweep every track onto the feeds
  // list and every show onto the items list in a single publish.
  check(
    'neither list ends up holding everything',
    [idsOn(fanOut, 'feeds').length, idsOn(fanOut, 'items').length],
    [2, 1],
  );

  // Spec vector 5 as literally written says next_feeds contains no
  // podcast:item:guid. That is FALSE here and correctly so: a foreign legacy
  // item entry stays on the feeds list, because removing another app's data is
  // what the merge exists to prevent. Assert on the deltas instead.
  const withForeign = plan({
    latestFeeds: [wire(A), wire(D)], // D was put there by another app
    baselineFeeds: [A],              // not ours
    local: [mine({ id: A })],        // and quarantined out of `local`
  });
  check('a foreign legacy item is carried on the feeds list', idsOn(withForeign, 'feeds'), [A, D]);
  check('...and never copied to the items list', idsOn(withForeign, 'items'), []);

  console.log('\n  relocation — add first, confirm, only then remove');
  // Cycle 1: our own item C is on the feeds list; the items list is empty.
  const c1 = plan({
    latestFeeds: [wire(A), wire(C)], latestItems: [],
    baselineFeeds: [A, C], baselineItems: [],
    local: [mine({ id: A }), mine({ id: C })],
  });
  check('cycle 1 — added to the items list', idsOn(c1, 'items'), [C]);
  check('cycle 1 — NOT yet removed from the feeds list', idsOn(c1, 'feeds'), [A, C]);

  // Cycle 2: it has been read back from the items list, so the add is confirmed.
  const c2 = plan({
    latestFeeds: [wire(A), wire(C)], latestItems: [wire(C)],
    baselineFeeds: [A, C], baselineItems: [C],
    local: [mine({ id: A }), mine({ id: C })],
  });
  check('cycle 2 — only now does it leave the feeds list', idsOn(c2, 'feeds'), [A]);
  check('cycle 2 — and it stays on the items list', idsOn(c2, 'items'), [C]);

  // Cycle 3: settled, and nothing left to say.
  const c3 = plan({
    latestFeeds: [wire(A)], latestItems: [wire(C)],
    baselineFeeds: [A], baselineItems: [C],
    local: [mine({ id: A }), mine({ id: C })],
  });
  check('cycle 3 — converged, no further publish', c3.map((p) => p.changed), [false, false]);

  // THE vector for the formula. `local_feeds` keeps our not-yet-relocated item
  // entries — but only those still in the local set. Without that
  // intersection an unfavorited entry is put back into local_feeds, never
  // enters `removes`, and the unfavorite never propagates.
  check(
    'unfavoriting a not-yet-relocated item still propagates off the feeds list',
    idsOn(plan({
      latestFeeds: [wire(A), wire(C)], latestItems: [],
      baselineFeeds: [A, C], baselineItems: [],
      local: [mine({ id: A })], // C unfavorited
    }), 'feeds'),
    [A],
  );

  console.log('\n  independence — one list\'s failure is not the other\'s');
  const itemsDown = plan({
    latestFeeds: [wire(A)], itemsTrustworthy: false,
    baselineFeeds: [A], local: [mine({ id: A }), mine({ id: C })],
  });
  check('a degraded items read publishes nothing to that list', itemsDown.map((p) => p.list), ['feeds']);
  check('...but does not block the feeds publish', !!on(itemsDown, 'feeds'), true);

  const feedsDown = plan({
    latestItems: [wire(C)], feedsTrustworthy: false,
    baselineItems: [C], local: [mine({ id: A }), mine({ id: C })],
  });
  check('a degraded feeds read publishes nothing to that list', feedsDown.map((p) => p.list), ['items']);

  // The trust FLAG decides, not whether the array happens to be empty. A
  // refactor that populated `latestItems` from a cache would otherwise read a
  // failed read as proof the relocation landed and drop the entry off the
  // feeds list while it exists nowhere else.
  check(
    'an untrustworthy items read is never evidence a relocation landed',
    idsOn(plan({
      latestFeeds: [wire(A), wire(C)], latestItems: [wire(C)], itemsTrustworthy: false,
      baselineFeeds: [A, C], baselineItems: [],
      local: [mine({ id: A }), mine({ id: C })],
    }), 'feeds'),
    [A, C],
  );

  console.log('\n  the baseline at the split — and the version that deletes');
  // Correct: everything you ever published went to the feeds list, whatever
  // kind it was, so baselineFeeds is the whole existing baseline and
  // baselineItems starts empty.
  check(
    'with baselineItems empty, the item moves across',
    idsOn(plan({
      latestFeeds: [wire(A), wire(C)], latestItems: [],
      baselineFeeds: [A, C], baselineItems: [],
      local: [mine({ id: A }), mine({ id: C })],
    }), 'items'),
    [C],
  );
  // The obvious alternative — split the old baseline by placement — makes
  // baselineItems name an entry the items list has never held, so `adds` is
  // empty and the first publish there is an empty event. The entry is stranded
  // on the feeds list and the migration silently never completes.
  check(
    'splitting the old baseline by placement strands it instead — pinned so it cannot be reintroduced',
    idsOn(plan({
      latestFeeds: [wire(A), wire(C)], latestItems: [],
      baselineFeeds: [A], baselineItems: [C], // ← the buggy derivation
      local: [mine({ id: A }), mine({ id: C })],
    }), 'items'),
    [],
  );

  console.log('\n  legacy single-list mode — everyone not on the allowlist');
  const legacy = planFavoritesPublish({
    latestFeeds: [], latestItems: [],
    feedsTrustworthy: true, itemsTrustworthy: true,
    baselineFeeds: [], baselineItems: [],
    local: [mine({ id: A }), mine({ id: C })],
    split: false,
  });
  check('exactly one list is planned', legacy.map((p) => p.list), ['feeds']);
  check('holding shows and episodes together, unsplit', legacy[0].next.map((i) => i.id), [A, C]);
}

// ---------------------------------------------------------------------------
console.log('\nthe published d tag — which list a user\'s favorites land on');
{
  const dOf = (tags) => tags.find((t) => t[0] === 'd')?.[1];

  // The default is the shared address, so every existing caller is unchanged.
  check(
    'defaults to the shared cross-app address',
    dOf(tagsForSharedFavorites([mine({ id: A })])),
    SHARED_D_TAG,
  );

  // While the feature is gated, accounts that are NOT allowlisted keep
  // publishing to this app's own list. If this parameter is ever "simplified"
  // away, every one of them starts writing to the shared address instead —
  // silently, on a list other apps read and write. See favorites-gate.ts.
  check(
    'honors an explicit address (the trial gate depends on this)',
    dOf(tagsForSharedFavorites([mine({ id: A })], [], LEGACY_D_TAG)),
    LEGACY_D_TAG,
  );

  // The d tag is the ONLY thing that changes with the address: same items,
  // same k tags, same carried-through foreign tags.
  const shared = tagsForSharedFavorites([mine({ id: A })], [['alt', 'x']]);
  const legacy = tagsForSharedFavorites([mine({ id: A })], [['alt', 'x']], LEGACY_D_TAG);
  check(
    'nothing but the d tag differs between the two addresses',
    JSON.stringify(shared.filter((t) => t[0] !== 'd')),
    JSON.stringify(legacy.filter((t) => t[0] !== 'd')),
  );
}


if (failures) {
  console.error(`\n${failures} favorites-sync check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll favorites-sync checks passed.');
