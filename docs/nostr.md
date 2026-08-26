# Nostr — identity, lists, live streams, notes, feeds

Read before touching `lib/nostr/*` (non-signer), `components/*note*`, `components/*feed*`, or `live-chat.tsx`.

Core rules live in [`../CLAUDE.md`](../CLAUDE.md); this file holds the reasoning.

## Nostr identity enrichment

`loginWithExtension()` returns only `{ pubkey, npub }`. After login, `components/nostr-auth/index.tsx:loadProfile` merges these in parallel:

- **kind:0 profile** — `name`, `display_name`, `picture`, `nip05`, `about` → header avatar, boost-modal "From" auto-fill.
- **NIP-65 relay list (kind:10002)** — unmarked + `write` entries → publish target.
- **Favorites (kind:10333, no `d` tag)** — shared cross-app list, one plain replaceable event per pubkey; see Favorites and [the spec](https://github.com/ChadFarrow/PC20-Nostr/blob/main/pc20-favorites.md). The three addresses it replaced (kind:30078 `d:podcast:favorites` and `d:podcast:favorites:items`, kind:30003 `d:boostmebitch:favorites`) are read-only, for the one-time migration.
- **NIP-51 mutes (kind:10000)** — public + NIP-04 private p-tags. See Mutes.
- **Spark backup (kind:30078, `d:boostmebitch:wallet:spark`)** — NIP-44 v2 encrypted-to-self mnemonic; best-effort silent restore, failures swallowed.
- **Settings (kind:30078, `d:boostmebitch:settings`)** — NIP-44 encrypted-to-self JSON, currently just `railPref` → `storage.railPref`. `lib/nostr/settings-backup.ts`.
- **NWC backup (kind:30078, `d:boostmebitch:wallet:nwc`)** — NIP-44 encrypted-to-self `{ uri }`, **opt-in only**. Restored to `bmb:nwc_uri` when this device has none. `lib/nostr/wallet-backup.ts`.

NIP-07 perms ever requested: `getPublicKey`, `signEvent`, `nip04.{en,de}crypt` (private mutes), `nip44.{en,de}crypt` (wallet backup). No DMs, no reactions. **kind:3 contacts** are read + written, but only for Follows — on demand when a follow button renders, never in `loadProfile`; `signEvent` already covers it.

**Fast-path identity hydration.** On page load, cached `bmb:npub` is decoded synchronously via `nip19.decode` into a bare `{ pubkey, npub }` identity, and `storage.profile` + `storage.favorites` + `storage.muted` land in the store within the same frame. The signer is called lazily, only when something needs to sign.

**Relay query timeouts.** Every `pool.querySync` passes a `maxWait` from `lib/nostr/pool.ts`: `QUERY_MAX_WAIT_MS = 4000` for single-author lookups, `FEED_QUERY_MAX_WAIT_MS = 8000` for broad feed scans. Without these a stalled relay pins the tab in loading.

**Single-latest-event lookups don't `querySync`.** `fetchLatestEvent` (`lib/nostr/event-queries.ts`) uses `subscribeMany` and resolves at the earliest of all-relays-EOSE, **1.5 s after the first matching event** (grace window for a newer replaceable version), or `maxWait`. `querySync` waits for every relay, so one dead relay in a 20-relay union pinned every restore at the full timeout.

**Never record an absence you didn't reliably observe.** A null from `fetchLatestEvent` means either "every relay answered and none had it" or "nothing answered in time" — any caller writing a **negative cache** must tell them apart. `fetchProfile` didn't — it called `storage.profile.setMiss(pubkey)` on any null — so a sign-in coinciding with one relay 503ing cached a miss for a kind:0 live on five relays, pinning a bare npub for the full 15-minute `PROFILE_MISS_TTL_MS`.

- **`fetchLatestEventDetailed`** returns `{ event, trustworthy }`; `fetchLatestEvent` is a thin wrapper, so callers that don't cache misses are unaffected.
- `trustworthy` is a **signal, not a guarantee** — a relay that never connects doesn't hold nostr-tools' aggregate `oneose` open, so EOSE means "every *reachable* relay confirmed none." Same caveat as the kind:3 `ok` flag.
- An event that arrives but won't parse **is** a cacheable miss — we heard back.
- Same discipline as `fetchFollowList`'s `ok` and `resolveProfilesForNotes`' `firstHealthy`. **Apply it to any new negative cache.**

**`resolvePublishRelays(identity)`** (`lib/nostr/relays.ts`) is the single source of truth for publish targets: `bmb:relays` override, else NIP-65 write relays **unioned with `DEFAULT_RELAYS`**, capped at 20. The union (not write-relays-*instead-of*) is deliberate — a user whose write relays are all dead/AUTH-gated was getting "published to 0/N relays" on a boost that paid. A manual override is used as-is.

**`backupReadRelays(identity)`** (same module) is the READ-side set for an encrypted-to-self kind:30078 backup — the union of `resolvePublishRelays` *and* `DEFAULT_RELAYS`, deduped, capped at 20. The union rather than just the publish set covers a specific race: on a fresh sign-in via Amber on Android, NIP-65 hydrates *in parallel* with everything else inside `loadProfile`, so a user who taps "Restore from Nostr" before that resolves has `identity.writeRelays` still undefined and `resolvePublishRelays` falling back to `DEFAULT_RELAYS`. If the backup was originally published from a session that *did* have write relays, it may live only on the user's outbox — and a narrowed read would miss it. Querying both sides covers either case without weakening the publish path, which still targets only the user's intended write relays.

**This matters more than a normal read because of how the failure presents: a backup read that silently narrows its relay set doesn't error, it reports "no backup exists"** — which is the one answer a restore path must never get wrong, and downstream of it sits a *replaceable* event that a backfill may then overwrite. Shared rather than per-module because it was duplicated byte-for-byte in `wallet-backup.ts` and `settings-backup.ts`, and the second copy's own comment already said so ("Mirrors wallet-backup.ts:readRelays"). See [`signers.md`](signers.md) for the decrypt half of the same path.

**A sign-in paints the account's caches into the store before hydration runs — the page-load restore effect is a different path and does not cover it.** That effect early-returns on `if (identity) return;`, so `completeSignIn` (the extension / Amber / bunker / local sign-in path, and the extension account-switch detector) never reached it. The gap was not cosmetic. `localFavoriteEntries()` reads the **store**, seeded from the `:guest` bucket; `storage.favBaseline` is read from **disk** and names every id this device last agreed with the relay on. Signing in on a device that already had favorites therefore handed `mergeFavoritesList` an empty `local` beside a full baseline — the removal test *ours, and we no longer hold it*, satisfied for every entry at once. The merge came out empty; `setFavorites` writes through to localStorage; the device's own cache went with it. `planFavoritesPublish` refused the publish, so the relay copy survived — the local one did not.

Favorites **union** the store rather than replace it, unlike the restore path: a signed-out user's favorites live in the store and are adopted on first sign-in by design, and the identity-switch block above has already cleared the store when this is a switch, so nothing leaks from A into B. Mutes **replace**, matching the restore effect — there is no guest-mute adoption path, and showing a `:guest` mute the account's own state doesn't carry renders a control the user cannot turn off. Mutes had the milder half of the same gap: the store kept the guest set until `hydrateMutes` resolved, so a hydration that hung (see the decrypt rule below) left the mute list empty for the whole session rather than falling back to the cache already on disk.

**Plan before you paint. `setFavorites`/`setFavoriteEpisodes` write THROUGH to localStorage, and that cache is an INPUT to the next hydrate, not a copy of its output.** `cached[feed.feedGuid]` in `runHydrate` is the only thing that tells a real album favorite from a group opened purely to place a track — the wire cannot restate that distinction — so painting an empty merge does not blank a screen, it destroys the record that keeps those rows recoverable, and the next load reads every one of them as placement-only, permanently.

`planFavoritesPublish` already knew the shape that must never be believed. It was consulted too late and too narrowly: it ran **after** the store had been replaced, and only `plan.publish` was read, so `wholesale-delete` fell through to the `else` branch and called `onSynced(plan.baseline)` — `baselineFrom(local)`, i.e. an EMPTY baseline, recorded as agreement, beside an `'ok'` status, for a list the planner had just refused to write. That is the exact failure the `wholesale-delete` reason exists to prevent, committed one layer out from `syncFavorites`, which gets it right.

Two shapes now refuse, and both behave exactly like a degraded read — keep what is on screen, publish nothing, record **no** baseline:

- `plan.reason === 'wholesale-delete'` — the merge is empty over a **relay** list that is not.
- The merge is empty over a **cache** that is not. Same mistake, caught when the relay copy is missing too (a narrowed read, or another app's delete arriving before this device has hydrated).

Both surface `<FavoritesSyncNotice>`. Its wording names the consequence — "couldn't confirm your list" — rather than one cause, because from the notice the two are indistinguishable and "couldn't reach the relays" would be a lie in the second case. The user's action is identical either way.

**Read a shared list from the relays you WRITE it to, and don't start the read before you know what those are.** Favorites (kind:10333) and mutes (kind:10000) both read-merge-republish, and the republish targets `resolvePublishRelays` — the user's NIP-65 write set unioned with `DEFAULT_RELAYS`. `loadProfile` used to fire both hydrations *alongside* the kind:10002 query that produces that write set, so `identity.writeRelays` was still undefined and both reads saw the defaults alone. That is the same race `backupReadRelays` exists for, one level up, and it is worse here than for a backup: these two events are replaceable and multi-writer, so a merge computed against a version that never included half the relays is a merge that can publish over data it never saw.

**Be precise about the size of that hole, because `resolvePublishRelays` unions `DEFAULT_RELAYS` into every publish and so absorbs most of it.** For an event *this app* wrote, a defaults-only read is a SUBSET of where it was sent and normally finds it. Four narrower cases survive, and only the first is ordinary:

1. **Another app is the writer.** Nothing makes a third-party client publish to our five defaults; it publishes to the user's outbox. This app never *creates* a kind:10000 — Damus, Amethyst and Coracle do — and kind:10333 is shared by design, so both are exposed. `hydrateMutes` compounded it by passing `undefined` for `queryRelays`, which `fetchMutedPubkeys` reads as `DEFAULT_RELAYS`.
2. **The 20 cap.** `writeRelays` are listed first, so an account with 20 or more slices every default off the publish set.
3. **Partial acceptance.** `assertPublished` requires only one relay, so an event all five defaults refused lives on a write relay alone and is still recorded as published.
4. **An override.** `bmb:relays` replaces the defaults rather than joining them. Nothing in the UI sets it, so this is theoretical.

**This is the invariant "read from where you write", not the explanation for a reported disappearance.** An earlier version of this section claimed the second — that signing in on a phone showed no favorites *because* the events lived only on the user's write relays. That was never demonstrated, and for favorites the union above makes it unlikely. The reported symptom is explained by [`ui.md`](ui.md)'s in-flight empty-library claim, and possibly by the sign-in cache wipe below.

Two things fix it together, and neither is sufficient alone:

- **`bmb:wrelays:<npub>` caches the resolved write set**, and `resolvePublishRelays` falls back to it whenever `identity.writeRelays` is absent. That covers every caller at once rather than asking each to remember, which is the same reason the sanitize step lives there. The live NIP-65 answer always wins over the cache — a user who narrows their write set must not keep publishing to relays they just dropped — and an empty answer is never cached, since `fetchRelayList` returns the same `null` for "no kind:10002" and "nothing answered".
- **Hydration awaits the write set when this device has no cached one.** That is a first-sign-in-per-account cost only, paid against a query already in flight, and it is what makes the cache exist in the first place. Every later load starts wide immediately.

**A new read of a shared, replaceable, multi-writer event inherits this: pass the publish relay set explicitly, and treat a missing one as a reason to wait rather than a reason to narrow.** `fetchFavoritesList` already refuses to default its `queryRelays` for exactly this reason; `fetchMutedPubkeys` still has a default, and the hydrator now overrides it.

**Cap every signer decrypt — a NIP-07 extension that goes away does not reject, it hangs.** `withDecryptTimeout` (`lib/nostr/signer.ts`) is shared by the NIP-44 backup reads and the NIP-04 private-mutes read. iOS Safari kills an extension's background while a relay query is in flight, so the decrypt issued after that query returns never settles: no rejection to catch, no error to log, just a pending promise. `hydrateMutes` awaits it and its caller swallows failures with `.catch(() => {})`, so the entire mute list was lost in silence on that path. The timeout turns the hang into the branch that already exists — park the ciphertext verbatim, keep this device's cached private entries — which is a degradation the code already handles correctly.

**`sanitizeRelays(urls)`** drops any entry that isn't a parseable `ws://`/`wss://` URL (gated on `new URL()`), dedupes, strips trailing slashes. Applied at **every point an untrusted relay list enters a pool query**: `fetchRelayList`'s NIP-65 parse, the output of `resolvePublishRelays` (falls back to `DEFAULT_RELAYS` if sanitizing empties it), and in `lib/nostr/discover.ts` — `fetchAuthorWriteRelays`, `fetchQuotedEvents`, `fetchSocialInteractThread`.

A corrupt entry (a NIP-65 `r`-tag of `"avatar wss://purplerelay.com"`, or spam stuffed into one) otherwise reaches nostr-tools' `normalizeURL`, which **throws `Invalid URL` synchronously inside `pool.querySync`/`subscribeMany`**; that rejection escapes per-call try/catch and aborts the whole flow. **A `startsWith('wss://')` check does not catch this** — only `new URL()` does, because a comma in the host is what throws. Defense in depth: `collectEventsByAuthors` wraps its `subscribeMany` so a survivor resolves empty rather than aborting.


## Favorites (kind:10333) — SHARED with other apps

♡ toggles a favorite on a podcast row (`<FavHeart>`), an episode row
(`<FavEpisodeHeart>`) or a track a show played (`<FavTrackHeart>`), all in
`components/fav-heart.tsx`. They go into **one**
plain replaceable event at **kind 10333** — no `d` tag, one per pubkey — an
app-neutral address shared with StableKraft and any other app implementing
[the spec](https://github.com/ChadFarrow/PC20-Nostr/blob/main/pc20-favorites.md).

**That document, not this code, is the spec, and it is not ours to change.** It
lives in its own app-neutral repo precisely so neither implementation owns it. A
change to the format is a PR there first; `docs/pc20-favorites.md` is only a
stub pointing at it. The kind is **self-assigned, not NIP-allocated** — relay
filters are kind-scoped, so a later NIP landing on 10333 would put two unrelated
event types into every query either app makes.

`content` stays empty and public, unlike `settings-backup.ts`/`wallet-backup.ts`
which NIP-44 encrypt their 30078 payloads — a second app has to be able to read
this one.

**A track favorite is an ordinary item favorite, and it names the artist's
release rather than the show that played it.** `<FavTrackHeart>` builds its
`FavoriteEpisode` out of a `<podcast:valueTimeSplit>`'s `remoteItem`, whose
`feedGuid`/`itemGuid` pair points at the track on the album feed it lives on —
so favoriting a song off a DJ set and favoriting it off the artist's own album
produce the **same entry**, and nothing about the intermediary is recorded.
There is no third entry type here and there must not be: the format has feeds
and items, a track is an item, and inventing a "track played by show X" shape
would be a spec change (see above) to express something the spec already says.
Reasoning about which list the rows come from is in
[`ui.md`](ui.md#tracks-podcastvaluetimesplit--the-list-a-chapter-list-is-not).

**But `remoteItem.feedGuid` is not always the track's parent feed, and the
difference is invisible in a resolved row.** A host may point a
`valueTimeSplit` at a **publisher** feed, whose `<podcast:remoteItem>` entries
name the real album feeds; `resolveRemoteItemFromRss` walks that chain and
returns a value block, a title and a cover either way, so the row looks fully
resolved while its `feedGuid` names something `/episodes/byguid` will never
accept as a `podcastguid`. Recording it publishes an entry to the shared
kind:10333 list that **no app can ever open** — not a placeholder that fills
itself in on a later load, which is ordinary and fine, but a permanent one.
`ValueTimeSplit.parentFeedGuid` carries the verdict back in three states:
`undefined` (nothing learned — use the wire value, a placeholder is fine), a
string (the album's own `<podcast:guid>`, recovered during the walk — use it
instead), and `null` (walked to a publisher, album declared no guid — **offer
no heart at all**, the same refusal `<FavEpisodeHeart>` makes for an episode
with no parent feed). The distinction matters because the naive test —
"suppress when `episodeGuid` is missing" — over-blocks: that is also true when
PI simply hasn't crawled the item yet, which is exactly the independent release
this app exists to pay.

### Tag order is the data

This is the one property everything else follows from, and the easiest thing in
the format to break by accident.

An `i` tag is **bare** — `['i', '<identifier>']`, two elements. There is no
parent field and no medium field. Instead:

| Tag | Meaning |
|---|---|
| `['alt', 'PC 2.0 Favorites']` | NIP-31 label, first, ours — a read `alt` is discarded and re-emitted |
| `['medium', v]` | a **running value**: applies to every entry after it, until the next one |
| `['i', 'podcast:guid:<uuid>']` | opens a **feed group**, tagged with the current medium |
| `['i', 'podcast:item:guid:<guid>']` | belongs to the **most recently opened** feed group |
| `['k', kind]` | trailing, **one per distinct kind** — ignored entirely on read |

So a client that parses entries into structs and rebuilds the array from them —
sorting, deduping, or emitting groups in a different order — silently reattaches
every item to the wrong feed and re-labels everything past a medium boundary.
Nothing else in the format recovers the association, and nothing looks wrong on
screen. **The parsed model is therefore an ordered node list** (`ParsedList.nodes`,
each a `FeedGroup` or a `LooseEntry`), the merge is an *edit* of that list, and
`tagsFromList` walks it in place.

This is the predecessor format's mistake one level up. That design carried a
feed URL, a parent guid and a medium at positions 2–4 *inside* each `i` tag, and
this app rebuilt the tag from a three-field struct — deleting every position past
the third, on every entry, on every publish, for the feature's entire life. The
fix there was to carry the whole tag; the fix here is to carry the whole array.

Two emission rules exist only to keep that array stable:

- **Unknown-medium nodes are emitted FIRST**, ahead of any `medium` tag.
  Appending them would make them inherit whatever medium was declared last, and
  minting `['medium','unknown']` would write a value no reader has been told
  about. Ahead of the first tag is the one position that says "not told" without
  inventing anything. **Never default a missing medium to `podcast`** — the list
  carries podcasts and music at once by design, so a default is wrong for
  exactly the half the hint exists to separate.
- **Where preserving read order and keeping same-medium groups contiguous
  conflict, contiguity wins.** Reordering groups within a medium block reattaches
  nothing, since an item always travels directly beneath its own feed entry,
  whereas a broken block silently re-labels every entry after the boundary. This
  means our first publish after an interleaved read legitimately differs from
  what we read — so **idempotence is `merge(parse(output)) === output`**, not
  `output === input`. A vector written the naive way fails correctly and gets
  "fixed" wrongly.

`k` is ignored on read and the kind comes from the identifier's prefix via a
known-kinds **table**, never string-scanning: item guids are routinely permalink
URLs, so "everything before the last colon" on
`podcast:item:guid:https://example.com/ep/42` yields `podcast:item:guid:https`, a
tag no relay filter matches, breaking discovery with nothing visibly wrong. An
earlier revision of the spec paired a `k` with every `i`; **a reader must accept
both layouts**, and one that walks `i`/`k` in pairs reads a current-form list as
an empty library rather than as an error.

### A feed group is not always a favorite

Opening a group is the only way to name an item's parent, so **a group appears
whether or not the user favorited the feed**. On the live list this was built
against, 211 groups carry 50 unambiguous favorites; the other 161 exist so a
favorited track can name its album. (Measured 2026-08-20 with `npm run
probe:favorites`; it was 197/38 when this was written. The ratio is what
matters and it has held — roughly three-quarters of the groups are there to
place a track, not because anyone favorited the album.)

**Only an *itemless* group reads back as a feed favorite** (`partitionList`
reports `itemless`). Treating every `podcast:guid:` as one manufactures albums
the user never made, on every page load — the reference implementation read its
own output back and would have created 114 of them. Inventing a favorite is
worse than missing one, and the missing case self-corrects as soon as the feed is
the only thing left on that group.

The hydrator has **one exception**, a record that predates the ambiguity and is
not contradicted by the wire, only unrepresentable in it:

- `storage.favorites` — this device's own cache. The user favorited it *here*.

There was going to be a second — a pre-10333 event that named the feed
outright, worth 46 of one user's 94 album favorites on a device hydrating
without a cache. It went away with the migration path (see *There is no
migration path* below), so a fresh device now recovers only what the wire
states unambiguously plus whatever this device already cached. Don't go
looking for `explicitFeeds` in the hydrator; it isn't there.

The converse limitation has no workaround: **unfavoriting a feed while a track
of it stays favorited is invisible on the wire.** The placement group and the
feed favorite are the same bytes, so a writer cannot signal the removal and a
reader cannot detect it. It is removed locally and stays for everyone else.

### The baseline — foreign entry, or one you removed?

There is deliberately no "publish my favorites" function. One replaceable event
with many writers has no partial update, so a blind publish deletes whatever the
other app added, silently, with no undo. `syncFavorites` reads → merges →
publishes as one step and the exported surface gives a caller no way to skip the
read.

`storage.favBaseline` (`{feeds, items}` of full NIP-73 ids) answers the question
a **second** writer must answer and a single writer never faces: an entry on the
relay and absent from local state is *either* something another app added *or*
something this device just unfavorited. Prefer the relay and unfavoriting
silently stops working; prefer local state and you delete the other app's
entries.

`feeds` records every group this device **emitted** — favorited or opened purely
to place an item — because the question it answers is "did I write this group",
which is what licenses dropping it once its last item is gone. It is emphatically
not "did the user favorite this feed"; conflating the two either manufactures
favorites or strands empty groups forever.

Rules the merge encodes (`mergeFavoritesList`):

- **Item removals are reconciled under EVERY group**, not only groups we still
  hold — otherwise unfavoriting a track whose album we've since dropped never
  propagates.
- **A group we published keeps its place while any item under it survives.**
  Dropping it takes the other app's items with it, since the group is the only
  thing naming their parent. It is dropped only once nothing is left to place.
- **Items read off the wire keep their wire position**; local-only items append.
  Imposing our own order on every republish means two apps reorder the event at
  each other forever, each publish locally reasonable, the only symptom being
  that it never stops.
- **The append pass honours the baseline**, so an entry another app *removed* is
  not resurrected by this device on the next cycle.
- **An empty baseline deletes nothing** — a device that hasn't hydrated is not
  making a claim — while an empty local set with a full baseline is a real
  clear-all.
- **A local value never overwrites a non-empty one another writer set.** The
  medium is filled only into a gap; "prefer my own resolved value" is what makes
  two apps rewrite the event against each other forever.
- **`changed` is a BYTE comparison against what the relay holds**, not a
  membership one — order and grouping are semantic, so two lists with identical
  membership can mean different things. Comparing against the read rather than a
  digest of our own last publish is also what lets us notice another app has
  edited the event since. Byte-equality with the read *is* the idempotence
  vector, executed on every cycle in production.

**A degraded read publishes nothing.** `fetchFavoritesList` reports `trustworthy`
(from `fetchLatestEventDetailed`), and both `syncFavorites` and `hydrateFavorites`
bail on false. Under wholesale replacement this is the most expensive mistake the
format allows: one bad read, republished, is the entire list. Same rule as kind:3
and kind:0. The read also passes `dTag: ''` as its `ReadExpectation` — which
`acceptsEvent` treats as matching an **absent** `d` — so an addressable event
sharing the kind can't be laundered into the user's favorites.

### Carry what you can't read

An identifier kind outside the table, a tag type we have no meaning for, a `k`
naming a kind we never emit, a malformed `podcast:guid:<not-a-uuid>` — all belong
to a writer newer or older than us and ride through untouched as `LooseEntry`
nodes holding the **whole tag**, because a future writer may use NIP-73's third
element (the spec reserves it for a feed-URL fallback). Rebuilding the tag from
its identifier would delete that.

A loose node deliberately does **not** close the open group: an unrecognized `i`
sitting between a feed and its items must not re-parent the ones after it. The
entries around it belong to a writer that knew what it meant, and our not
understanding one of them is not licence to move the others.

`parseShowGuid` is UUID-gated and `bareFeedGuid` must reject exactly what it
rejects — otherwise we'd open groups whose emitted `podcast:guid:` we can't read
back, the array would never reach a fixed point, and two writers would rewrite
the event at each other forever. `parseItemGuid` is **not** gated: an RSS `<guid>`
is an arbitrary publisher-chosen string, and the live list carries
`thenogs-donkey-01-porky-piggin-it` alongside 226 UUIDs.

Malformed guids are separated at read (`partitionList().malformed`), never
dropped at write — older versions of this app wrote feed IDs and live-episode
strings there. `window.bmbCleanFavorites()` is an explicit, user-invoked purge.
"This app can't read it" is not the same claim as "this is junk".

### There is no migration path

kind:10333 is the only favorites address this app reads or writes. The three it
replaced — kind:30078 `d:podcast:favorites` and `d:podcast:favorites:items`, and
kind:30003 `d:boostmebitch:favorites` — are **gone from the code entirely**, not
merely unwritten. Their events are still on relays, untouched, and remain the
rollback path; nothing here reads them.

A one-time fold of those addresses did exist for one build and was removed
deliberately. Two things are worth recording from it, because both are reasons
not to bring it back casually:

- **It recovered real data**, so removing it has a cost: the format cannot say
  "this album is favorited" once a track of it is, and the old events could.
  On the list this was developed against that was 46 of 94 album favorites,
  visible only on a device whose local cache already held them. A device
  hydrating fresh now sees the itemless groups and nothing more.
- **It destroyed real data**, which is why it went. The new baseline was seeded
  from the *old* baseline keys, which asserts that this device published those
  ids to the 10333 list — a list it had never written to. An album that existed
  only on the other app's side was in that stale baseline, absent from local, and
  the merge correctly read "mine, and I removed it" and deleted it. The merge was
  right; the input was a lie. **A baseline may only ever describe the list it
  belongs to.** `storage.favBaseline` therefore starts empty, and empty is the
  safe direction: no removals, so a first publish is a pure union.

### Rendering

Caches `bmb:favorites:<npub>` and `bmb:favepisodes:<npub>` (or `:guest`) render
instantly; toggles are optimistic and publish is **debounced 1.5 s**.

**The store maps are the source of truth for what gets published, not a render
cache.** Every entry on the merged list gets a row whether or not Podcast Index
resolved it; an unresolved row renders as a placeholder. Building those maps from
resolved entries only meant a PI outage pruned the store while the baseline still
named the un-pruned set — so the next page load read every unresolved entry as a
local removal and published the deletion. One outage plus one reload.
`addedAt: 0` means "not known yet", so a first real resolve stamps its own rather
than inheriting a placeholder's and sinking to the bottom forever.

**Medium sorts the list, and absent is its own bucket.** `<FavoritesPage>`
(`components/favorites-page.tsx`) builds its tab strip out of `groupByMedium`'s
own output (`components/lists/grouping.tsx`) rather than a hand-written list of
media, which is what keeps `MEDIUM_ORDER`'s ordering, medium-unknown last and
never folded into `podcast`, and a feed-supplied label that is never normalized
beyond lowercasing for the bucket key. Case is folded for bucketing only, and an
unrecognized value keeps its own label because the vocabulary is open. `'all'`
and `'~unknown'` are the two tab keys that name no medium, so `feedNoun` /
`itemNoun` give both the generic word: calling an undeclared-medium row a "show"
makes exactly the claim that keeping the bucket separate exists to refuse.
Precedence is `resolved ?? wire hint`: PI wins where we have
it, the hint fills the gap, and **a disagreement is a stale hint, not an error —
render your own value and never republish to correct the wire.** The hint is what
makes the split possible on first paint at all: resolution is one PI request per
entry, so a 300-entry library is 300 round trips before anything can be sorted,
and for a delisted feed there is no other answer ever. An item's medium is its
**parent feed's** (Podcasting 2.0 has no per-item medium), taken from the group
it sits in — deliberately not a per-parent `/podcasts/byguid` fan-out whose only
purpose would be a hint.

**Item favorites another app added are ordinary rows.** They used to need a
separate quarantine slot (`foreignFavoriteEpisodes`), because on the two-address
design copying an item entry found on the *feeds* list over to the *items* list
made it removable from one and not the other — so unfavoriting it brought it back
on every load, forever. One event means no relocation, so the hazard is gone and
the slot with it. What keeps another app's entries safe now is the baseline, per
entry.

### A degraded read must be VISIBLE

The guard being right is only half of it. Keeping local state and saying nothing
renders identically to "your list is empty", and on a device with no cache (new
browser, private tab, second device) that is a blank library indistinguishable
from "your favorites are gone". It cost about half an hour of production
debugging: the app looked broken, the correct address gate was suspected twice,
and a revert that would have re-exposed every user to the shared list was nearly
shipped for a bug that didn't exist. Read-path and write-path skips are equally
silent, so both report through one in-memory `favoritesSync` flag (`lib/store.ts`,
`'idle' | 'loading' | 'ok' | 'degraded'`):

- `hydrateFavorites` sets it, and sets `'ok'` **immediately after the
  trustworthy check** rather than at the end — everything past that point is
  Podcast Index resolution, which fails for unrelated reasons and must not be
  reported as a relay problem. It's wrapped so a throw lands on `'degraded'`,
  because the caller in `nostr-auth` swallows it and the status would otherwise
  sit on `'loading'` forever.
- `syncFavorites` reports through the optional `onDegraded` on `SyncOptions`,
  injected in `syncOptionsFor` exactly like `onSynced` — the callback shape is
  what keeps `favorites.ts` free of React and browser globals. `onSynced` sets
  `'ok'` in the same place, so a publish that lands clears a notice an earlier
  failed read put up.
- **ONE flag, where there used to be one per list.** That is a consequence of the
  format change, not a relaxation: two flags existed because two events could
  fail independently, and a single flag across them let a good read on one clear
  the notice the other's failure raised. There is one event now, so a partial
  failure is not expressible and one flag cannot lie. **`'idle'` is still not a
  failure** — it is the pre-hydration and signed-out state.
- `<FavoritesSyncNotice>` (`components/favorites-sync-notice.tsx`) renders it in
  the home-page aside, with a retry that also calls `resetPiBreaker()` — the PI
  breaker lives in sessionStorage and survives reloads for the life of the tab,
  so a combined outage otherwise leaves episodes short-circuiting to null with no
  fetch and no way back. `showFavoritesPanel` includes `favoritesDegraded` so the
  panel opens with nothing in it — otherwise the notice has nowhere to go in
  exactly the case it exists for. Never render it signed out: favorites are local
  by design there and there's no relay failure to report.
- **Hydration is single-flight, keyed by npub**, and every cycle is serialized
  through `serializeFavoritesCycle` — hydration and a heart-toggle publish are
  the same cycle as far as the relays are concerned, and two running concurrently
  merge against the same read, so whichever publishes second overwrites the
  first's changes. The retry button is what made that reachable.
- `setFavoritesSync('idle')` sits beside all three `setFavorites({})` teardowns
  in `nostr-auth`, or B inherits A's notice. It is deliberately **not** reset
  inside `setIdentity`, which runs mid-hydration with the enriched identity and
  would clobber a fresh `'ok'`.

### Module split

`lib/nostr/favorites-list.ts` is the wire format and the merge, and has **zero
imports** so `npm run check:favsync` can load the real thing under plain Node — a
reimplemented copy in the check script would stay green while the shipping merge
drifted, the exact failure being guarded. `favorites-legacy.ts` is import-free
for the same reason. `lib/nostr/favorites.ts` holds the I/O and re-exports both.
**Don't add an import to either pure module.**

`npm run probe:favorites -- <npub> [--dump f.json]` prints what is actually on
the relays for all four addresses, read-only, and is where the check script's
fixtures should come from — real wire data carries shapes nobody thinks to
invent.

Sign-out clears in-memory favorites; the per-npub caches are left so re-signing
in is fast. `bmb:favbaseline:<npub>` is deliberately **not** cleared on an
identity switch — it's per-npub, so switching back to A must find A's baseline
where A left it.

**Switching identities must wipe in-memory state — for favorites that's
correctness, not tidiness.** `hydrateFavorites` reads the store rather than the
per-npub cache (deliberately — that's how a signed-**out** user's favorites get
adopted on first sign-in), and adoption publishes whatever it finds there under
the incoming key. So carrying account A's favorites across a switch writes A's
list to relays under B's key. `completeSignIn`'s
`identity && identity.pubkey !== id.pubkey` branch therefore clears `favorites`,
`favoriteEpisodes`, `mutedPubkeys` and `resetFollows()` alongside the wallet
teardown — signed-out → signed-in leaves `identity` null, skips the block, and
still adopts as intended. (`hydrateMutes` reads the per-npub cache and was
already correct; cleared for consistency. `resetFollows()` is explicit because
`useFollows` only resets the singleton once a `<FollowButton>` effect runs, and a
stale `ok: true` gates the kind:3 publish path.)


## Mutes (NIP-51 kind:10000)

🚫 on a `<NoteCard>` mutes that author. Interoperates with Damus/Amethyst/Coracle. `MuteListState` (`lib/nostr/mutes.ts`) carries parallel **public** p-tags (event tags) and **private** p-tags (NIP-04-encrypted JSON tag-array in `event.content`). New mutes go private (Damus default); when the signer exposes no `nip04`, the read path parks the raw ciphertext in `unreadablePrivateContent` and the publish path passes it through verbatim — **we never destroy private mutes set in another client** — while new mutes degrade to public p-tags. Non-`p` tags (`e`, `t`, `word`) are preserved verbatim too.

Filtering is at render time (`<NoteCard>` early-returns null; feeds filter top-level + replies before mapping). `bmb:muted:<npub>` is `MuteListState` JSON; `lib/storage.ts` auto-promotes the legacy `{ pubkeys, otherTags }` shape on read. Account menu surfaces a collapsible "Muted accounts (N)" with kind:0 lookups firing only while expanded.

**A reconcile reads its local side AFTER the network round trip, never before it.** `hydrateMutes` took `storage.muted.get(npub)` as its first line and then awaited `fetchMutedPubkeys`, so every decision below was made against a snapshot taken up to ten seconds earlier — this hydration does not even *start* until the NIP-65 write set resolves (up to 4 s), then spends up to another 4 s on `fetchLatestEvent`, plus a NIP-04 decrypt. That window is not idle time: it is the user scrolling the feed the page has already painted, which is exactly when a spam account gets muted. A mute made in it was invisible to the reconcile, and both branches then wrote a state without it — to the store, so the note reappeared on screen a few seconds after being hidden, and to `bmb:muted:<npub>`, so it did not survive the reload either. The local-ahead branch also *republished* the loss, so the deletion propagated to the relays and to the user's other clients. Reported as "I keep muting this account but it keeps showing up", which is precisely what it does: the mute works, then a background promise undoes it. **Everything after the read is synchronous, so reading late closes the window rather than narrowing it** — a `setTimeout`-free tail is what makes that true, and a new `await` added below that line reopens the bug. `favorites-hydrator.ts` already reads its merge inputs (`localFavoriteEntries()`, `trustedBaseline()`) after its own await; mutes was the one that did not.

**`MuteListState` and `emptyMuteState()` are defined in `lib/nostr/mute-state.ts`, an import-free leaf, and re-exported by `mutes.ts`.** Both `mutes.ts` and `lib/storage.ts` need them, and `storage.ts` cannot import from `mutes.ts`: that closes a cycle, because `mutes.ts` → `relays.ts` → `../storage` (relays reads `storage.relays` for the user's relay override). So the shared piece moves **down** to a leaf rather than sideways. `storage.ts` takes the *value* import from the leaf directly while keeping `MuteListState` as a type-only import from the `./nostr` barrel — type imports erase and cannot cycle, value imports can, and the distinction is the whole reason this compiles.

Two constructors for one persisted shape is how a field added on one side goes missing on the other, which is what made this worth fixing rather than leaving: `storage.ts` had a private copy identical to the exported one. Note this leaf is a **different** thing from the four modules `scripts/import-free.mjs` enforces — those are import-free so a check script can load them under plain Node; this one is import-free to break a cycle. Same discipline, different reason, and it should not be added to that script's list.

## Follows (NIP-02 kind:3)

`+ Follow` / `✓ Following` on **note cards** (`<FollowButton>` in `nostr-note-card.tsx`'s author header) and on **npubs in show notes** (`notes-follows.ts`). Hidden signed-out and on the viewer's own pubkey. This is the **only** place the app touches kind:3.

`lib/nostr/follows.ts` is the single surface:

- **`fetchFollowList(identity)`** reads the latest kind:3 from a broad union (write ∪ default ∪ profile relays) and returns `{ event, following: Set<hex>, ok }`. **`ok` is the safety flag** — true only when an event arrived or every relay EOSE'd, via `collectEventsByAuthors`'s `allEosed`/`gotAnyEvent`.
- **`publishFollow(identity, current, targetHex, follow)`** republishes a kind:3 **preserving `current.content` and every existing tag**, changing exactly one `p` tag, and returns the new signed event so the next toggle builds on the latest tags.
- **The invariant: never publish a list you didn't reliably fetch.** Buttons stay disabled until `ok`; a failed fetch shows retry, never wipes. This is the classic kind:3 footgun — a blind republish overwrites the whole follow list.

**Nuke-guard (two layers, both gating only the empty-base publish).** The one wiping path is publishing onto an empty base (`state.event === null`) that was a *transient false-empty* — the load EOSE'd against relays that don't hold the list (classic case: right after login, before NIP-65 hydrated). `allEosed` only means "every **reachable** relay confirmed none", so empty + `ok` is not proof. `toggleFollow` therefore, **only** on that path (normal toggles pay nothing):

1. **Re-confirms** with a fresh `fetchFollowList` right before the write — a list found now **rebases**; an untrustworthy confirm **refuses** (button retries); a reliably-empty confirm **creates** the first list.
2. **Last-known-good cache** (`storage.follows`, `bmb:follows:<npub>`, hex[]), written **only from a real kind:3**. A reliably-empty confirm contradicted by a **non-empty** cached set is treated as false-empty and **refused**. Genuine new users have no cache; a user who really emptied their list has a non-null (empty) kind:3, so `state.event !== null` and this branch isn't reached. Not used for rendering — only as this signal.

**Shared singleton** (also `follows.ts`): `ensureFollowsLoaded` / `subscribeFollows` / `followsSnapshot` / `toggleFollow` / `resetFollows`. **One kind:3 fetch app-wide** (a 20-card feed does 1 fetch), with **serialized toggles** (a promise `chain`) so two quick follows can't republish from stale state and drop each other. `ensureFollowsLoaded` pins `loadedFor` only when `fetched.ok`, so a degraded fetch retries instead of freezing the buttons; `<FollowButton>` surfaces retry when `!ok && !loading`. `components/follow-button.tsx` holds the hook + button; show-notes buttons use the same singleton so both stay in sync. The singleton is store-free (no zustand import) to avoid a cycle with `lib/store`.


## Editing the user's own profile (kind:0)

`<ProfileEditor>` (`components/profile-editor.tsx`), opened from the account menu. Fields: `display_name`, `name`, `picture`. Every signer type can use it — nothing here needs the raw key. **A field absent from that list is preserved, not deleted** — `about` and `lud16` were both dropped, and a user who set either elsewhere still has it, because the editor merges rather than rebuilds.

**One name box, not two.** `display_name` is what renders (every client here and in the wild resolves `display_name || name`); `name` is the older handle some clients show as `@name`, and onboarding sets both to the same string, so for most users the second box is noise. There is one Name box and **no opt-in** — the `name` field appears only for a profile that already carries a genuinely different handle (both non-empty and unequal), set in some other client. **Hidden means synced, not ignored:** with the box off screen, save writes `name = display_name`. That auto-reveal is not a nicety; without it the only two alternatives both lose data. Overwriting a distinct handle with the display name destroys a field the user deliberately set, invisibly. Leaving `name` at its old value is the tempting version and it strands the profile — the merge preserves keys it doesn't manage, so a `name` the editor stopped showing would be unreachable and permanently disagree with the display name wherever a handle is rendered.

**kind:0 is replaceable, so this is the same footgun as kind:3 one kind over: what we publish REPLACES the profile everywhere, and anything we didn't carry forward is deleted from every client with no error.** Two rules, both enforced in the editor:

- **Merge over the RAW fetched content, never over `ProfileMetadata`.** `fetchProfile` returns what `coerceProfileMetadata` allows through — seven known string fields (`auth.ts`'s `PROFILE_STRING_FIELDS`) — because render paths need defending against `name` arriving as a number. Correct for display, catastrophic for editing: `banner`, `website`, `bot` and every custom field another client set simply aren't in the object, so a form built over it deletes them on the first save. **`fetchRawProfile` (`lib/nostr/profile.ts`) exists for this and only this** — it returns the author's parsed content object untouched, and the editor spreads its five keys over it. A blank input **deletes** its key rather than writing `''`, so cleared fields read as absent instead of as an empty string other clients render.
- **Refuse to publish on an untrustworthy read.** `fetchRawProfile` returns `trustworthy` from `fetchLatestEventDetailed` — the same flag `fetchProfile` uses to decide whether an absence is cacheable. An edit assembled after "no relay answered" wipes exactly as thoroughly as one assembled from a truncated parse; the trigger is a timeout instead of a whitelist, and "nobody had it" and "nothing answered" are the same `null` without the flag. The editor shows a retry instead of a form. Don't relax this into "publish anyway if we got *something*" — a newer kind:0 on an unreached relay loses to ours on `created_at`.

**`publishProfile` (`lib/nostr/profile.ts`) is the single kind:0 write path**, shared with onboarding's `provision-profile.ts`, so the relay set (`resolvePublishRelays ∪ PROFILE_RELAYS`, capped 20 — purplepag.es is the outbox Damus and Amethyst read) and the post-publish `storage.profile` reseed can't drift. It publishes `content` verbatim and deliberately does **not** merge for the caller: that would need its own fetch, and a second fetch is a second chance to get an untrustworthy null and wipe the profile. **The reseed is gated on `acceptedRelays.length > 0`** — the cache is a claim about what the network holds, so reseeding after a publish every relay refused caches a profile that exists nowhere, and the user sees a saved name that survives reloads until the miss TTL expires. That gate is what lets the editor's `acceptedRelays.length === 0` error mean something. Onboarding skips the merge safely by construction — a key generated seconds ago has no kind:0 to preserve.

**`picture` must accept `data:image/`, not just `https://`.** The app writes its own generated identicon as an inline `data:image/svg+xml;base64,…` (`lib/nostr/generated-profile.ts`), so an http(s)-only validator rejects the value the editor just loaded — Publish disabled and `save()` refusing on open, for every account that hasn't replaced its avatar. That shipped and was caught in review, not testing, because the test account had already set an https picture. The check is an allowlist of those two shapes (`data:text/html` and `javascript:` stay rejected), matching `safeUrlAttr`'s posture rather than denylisting bad schemes.

**`displayName` (camelCase) is the one field the editor updates without showing.** It's the pre-NIP-24 spelling of `display_name`, deprecated but still written by clients in the wild (Jumble writes it) and still *read* in preference by some. Left untouched it doesn't stay harmless — it keeps the old name, so the profile disagrees with itself and a stale name renders wherever that key wins. It's not a separate field, it's the same field spelled differently, which is why it's the sole exception to "preserve what we don't manage". Updated **only when already present**: creating it would spread a deprecated convention to every profile we touch, deleting it would break the clients still reading it.

**`lud16` is deliberately out of scope: the user sets it from another client.** `@buildonspark/spark-sdk` ships no lightning-address registration API, so the Spark wallet provisioned at signup can't advertise itself, and the editor doesn't offer the field. Other clients read `lud16` to decide whether to show a zap button, so a user who never sets one is unzappable outside this app — which is the accepted trade, not an oversight. **What makes it work is the merge:** an address set in Jumble, Primal or anywhere else survives every edit made here, exactly as `about` / `website` / `banner` do. Verified against live relays — a rename here changed only the name fields and left all four foreign fields byte-identical. So don't "helpfully" add a `lud16` input later without revisiting this; the reason it's absent is that the field belongs to whichever client can actually issue an address.

## Nostr live streams (NIP-53 kind:30311)

A **"Live on Nostr"** horizontal card row renders above the global feed on the browse view only (`components/nostr-live-streams.tsx`, mounted when `!inDetailView`). Pure Nostr, independent of Podcast Index. **One row, tab-selected** (saves the vertical space of stacked sections): a **Live / 24-7 / Upcoming** pill selector filters the single scroll row, defaulting to **Live** so current streams aren't buried behind a long upcoming list, and auto-falling back to the first non-empty group. Only non-empty groups get a tab. **24/7** = perpetual radio-style stations, detected by the `24/7` title convention (`/\b24\s*[/\-]\s*7\b/i`) since NIP-53 has no "perpetual" field. Polling is gated on document visibility + a 45 s floor, not a blind 60 s + every-focus refetch of the 7-relay query.

**Stream id is `<64hex pubkey>:<dTag>`** (the NIP-33 address tail), carried as `episode.guid`. Use the helpers in `lib/nostr/live-streams.ts` — `streamIdOf`, `parseStreamId` (validates the 64-hex pubkey), `isLiveStreamId` — and `streamChatAddr(streamId)` in live-chat.ts for the `30311:`-prefixed chat/zap `a`-tag. Don't inline `indexOf(':')`/`slice`/`/^[0-9a-f]{64}:/`.

**Fetch + filter.** `fetchNostrLiveStreams()` queries kind:30311 over `LIVE_STREAM_RELAYS` (`DEFAULT_RELAYS` ∪ `wss://relay.zap.stream` + `wss://nostr.wine`, sanitized) within a 7-day `since`, dedupes replaceable events by address (newest `created_at` wins), then:

- **Drops stale `live` events** older than `LIVE_FRESH_SECS` (2 h). An active 30311 is re-published while broadcasting, but most clients never publish the `ended` status — they just stop updating — so a stale `live` event is a dead broadcast. **Planned streams are exempt** (set once, ahead of time).
- **Sorts upcoming-first**, then live; within each group newest `startsAt` first.

**`fetchLiveStreamByAddr(pubkey, dTag, relayHints)`** fetches ONE stream for the `/stream/<naddr>` deep link. It queries by **author only** and filters the d-tag **client-side** — NOT a `#d` filter: a stream's event often lives only on the host's relay (e.g. `fountain.fm`), which doesn't honor `#d` reliably in-browser, so the filtered query came back empty and said "not found" even when the broad main-page query found it. The stream page also **retries** — cold Firefox-private tabs have no warm DNS/TLS/WS to the host relay, so the first query can time out.

**`streamNaddr(pubkey, dTag)`** encodes the shareable `naddr` with stream-relay hints (zap.stream/fountain/nos.lol); generic defaults aren't enough for other clients to resolve a fountain-only stream.

**Stream → player/boost bridge.** `streamToEpisode(stream, value)` / `streamToPodcast(stream, profile)` map a stream onto the existing `Episode`/`Podcast` so the player, boost modal and `liveStatus` UI work unmodified: `episode.guid = stream.id`, `enclosureUrl` = the HLS `streaming` URL, `liveStatus` from status, `id`/`feedId` synthetic (`fnvHash`/0).

**V4V (`resolveStreamV4V`).** A `ValueBlock` of `lnaddress` recipients from each participant's kind:0 `lud16`/`lud06` — from NIP-53 `zap` split tags when present, else the host alone. Explicit weight `0` means the host opted that participant out: **preserved, not coerced to 1**, and dropped; falls back to the host if every split is zeroed. Profiles are fetched against the **broad `LIVE_STREAM_RELAYS` set** and **re-fetched on a cached miss** — a streamer's lud16 often lives on the stream's relays, and a transient miss otherwise hid BOOST for the 15-min profile-miss TTL.

**HLS video (`player.tsx`).** A single `<video>` in a **reverse portal** (`react-reverse-portal`) moves between the mini-bar thumbnail and the fullscreen art pane **without remounting** — a remount kills playback and the `hls.js` attachment. `isHlsUrl(url)` gates the video path; everything else stays on native `<audio>` (the inactive element is left srcless). `hls.js` is **dynamic-imported** on first stream play; native HLS (Safari `canPlayType`) skips it. The portal node is **created client-only** — `createHtmlPortalNode()` touches `document` and crashes Next SSR.

**Dedicated route `app/stream/[naddr]/page.tsx`.** A shared stream link is a real route, so refresh restores it. The page renders ONLY a loading / "not found" state and opens the layout's player on top — no browse header or feeds mount. Collapsing the player navigates home (`router.push('/')`); the stream keeps playing in the mini-bar. A **fast-path** skips the fetch when `current` already matches the naddr. Tapping a card calls `play(...)` instantly + `router.push('/stream/<naddr>')`; the card's PLAY button stays in the mini-bar (no nav). It also mounts a hidden `<NostrAuth>` so sign-in works there without leaving. Old `/?stream=<naddr>` links redirect here.

**Permanent per-host route `app/live/[npub]/page.tsx`.** `/stream/<naddr>` pins ONE broadcast by its dTag, and every new broadcast gets a fresh dTag — so the link a show puts in its bio dies after one episode. `/live/<npub>` resolves the host's *current* stream at click time instead. Same shell as `/stream` (placeholder-only render, opens the layout player, collapse → `router.push('/')`, hidden `<NostrAuth>`), with three differences that each exist for a reason:

- **`fetchLatestStreamByPubkey` runs TWO queries — `authors: [pubkey]` AND `#p: [pubkey]`.** Platform-published streams (Shosho, zap.stream) are authored by the **platform's** key with the host in a `p` tag, so an authors-only query finds nothing for exactly the hosts most likely to hand out a share link. Host-role is checked client-side; no `#d` filter, same reasoning as `fetchLiveStreamByAddr`.
- **`episode.liveHostPubkey` is what the share link is built from, never the stream id's author half** (`streamHostPubkey` — the NIP-53 `p` tag with role `host`, falling back to the event author). Building it from the address's pubkey points a platform-published stream's permanent link at the *platform*, so it would resolve to whatever that platform is streaming next.
- **Offline is a first-class state, not a 404** — name, avatar, and a "Next: <title> — starts <time>" line when the latest event is `planned`. A bio link that 404s between broadcasts reads as broken.

Retries up to 3× at 800 ms, breaking early on `live`, for the cold-relay timeout `/stream` hits too. V4V enrichment lands as a second `play()` with the **same `episode.id`**, so the hls attachment isn't torn down.

**Live chat (`lib/nostr/live-chat.ts` + `components/live-chat.tsx`).** Shown in the fullscreen right pane for live streams. `subscribeLiveChat(streamId, onEvent)` owns a long-lived `SimplePool` and runs three phases: (1) `querySync` history backfill — relays trickle stored events slowly over a bare `subscribeMany`, so a reload would show only a handful; (2) `subscribeMany` for live messages; (3) a **re-sync backstop** every 12 s and on `visibilitychange`/focus, a `since`-bounded re-query, because the persistent subscription goes stale when a device backgrounds or a socket drops and the chat diverges across devices / from Fountain.

It subscribes to **kind:[1311, 9735]** — chat messages and zap receipts tagged to the stream. `<LiveChat>` renders both through one `<ChatRow>` (zap rows add a `⚡ N sats` badge + tint), shows a total-sats-zapped line (sum of 9735 amounts via `zapInfo`), resolves author/zapper/`@mention` profiles against `LIVE_STREAM_RELAYS`, renders `nostr:npub` mentions as `@names` and http links as anchors, applies the mute filter, and gates the composer on sign-in. `publishLiveChat(streamId, content)` posts a kind:1311.

**Boosting a live stream goes out as a real NIP-57 zap** so the receipt shows up in Fountain / tunestr / zap.stream and in BMB's chat — see Boost flow invariant 0 in [`../CLAUDE.md`](../CLAUDE.md) for the qualifying conditions and the fallback. Interop is the shared NIP-53 standard, not per-platform code; the only variable is relay coverage.


## Episode discussion (`podcast:socialInteract`, Nostr)

Episodes (and RSS live items) can carry `<podcast:socialInteract protocol="nostr" uri="nostr:nevent1…|note1…">` pointing at a publisher-designated root note. `lib/pi.ts` parses them into `Episode.socialInteract: SocialInteract[]` (sorted by `priority`), normalizing spec `nostr:<bech32>` and non-standard `https://njump.me/<bech32>` URIs via `extractNostrUri`. PI's `/episodes/byfeedid` doesn't expose the tag, so `/api/feed` picks it up from the shared RSS pass. Only `protocol="nostr"` is kept.

**Fetch + render.** `fetchSocialInteractThread(uri, opts)` (`lib/nostr/discover.ts`) decodes the note1/nevent1, unions `DEFAULT_RELAYS` with up to 4 nevent hints, fetches the root, and BFS-assembles the reply tree via the same `assembleNotes` as the feed. **Contract:** returns `[]` for an undecodable URI or a root no relay carries; **throws** when the relay query itself fails — so the UI can tell a transient outage (offer retry) from genuine emptiness. `components/episode-social-thread.tsx` is the self-contained surface, shared by the discussion view and the fullscreen player: status union `loading | ready | error`, skeleton, retry, a reply count excluding the root anchor, and a sign-in-gated composer.

**Comment composer.** A signed-in user replies to the root via `publishReply({ parent: notes[0].rawEvent })` (`lib/nostr/interactions.ts`) — a real reply, so it interoperates with other PC2.0 clients. Insert is **optimistic**: `signAndPublish` returns the signed `event` on `PublishedNote`, and `noteFromEvent` builds a `DiscoveredNote` appended under the root's `replies`. Optimistic rather than refetch because the publish relays may not overlap the query relays; a `pendingOptimistic` ref re-merges the comment if a wholesale revalidation lands during the reply-stream window.

**Faster first paint.** `fetchSocialInteractThread` fires an `onRoot(root)` callback the moment the root resolves (built from the cached profile, no extra network), so the anchor + composer appear in ~1 s while replies stream in — the component used to await root + up to 6 sequential 8 s BFS levels + profile/quote resolution before painting anything. Repeat visits paint instantly from `storage.socialThread` (per-URI, no TTL, stale-while-revalidate, mirroring `storage.feedNotes`); an error after a cache/root paint keeps what's shown and flips a quiet "couldn't refresh" hint instead of wiping it.

**Full-page discussion view (not inline, not a modal).** The `· 💬 discussion` button in the `EpisodeList` info row calls `openDiscussion(e)`; `components/home-page.tsx` renders `<DiscussionView>` *ahead of* the detail/browse branches — one of four state-driven page-level views (browse, `<EpisodeDetailView>`, detail, discussion) with a `← back to episodes` button. `discussionEpisode` lives in the store and `selectPodcast` clears it, so a thread can't outlive its show. Earlier iterations (inline in the expanded panel, then a scroll-to-thread shortcut) were dropped because a long thread ballooned the episode row and broke list scanning. The fullscreen player keeps its own inline `<EpisodeSocialThread>` — its scroll container absorbs the height.

**Inline images in notes.** `NoteCard` pulls image URLs (`jpg/jpeg/png/gif/webp/avif/bmp`, optional query string) out of the body via `extractImages` and renders `<img>` thumbnails (clickable, lazy, `max-h-80`) instead of raw links — every note surface, not just the thread. Detection is extension-based, so URLs without one (some `i.nostr.build/<hash>`) aren't caught; that would need NIP-92 `imeta` parsing. Uses `<img>`, not `next/image` (arbitrary hosts), like `PodcastCover`.


## Value playback receipts (kind:3369)

Spec and reasoning: [`docs/value-playback.md`](value-playback.md) and
[`docs/streaming.md`](streaming.md). What belongs here is the tag contract, so
it sits beside the boost note's.

`buildValuePlaybackReceipt()` in `lib/nostr/value-playback.ts` builds a kind:3369
with the **same NIP-73 `i`/`k` pairs, in the same order and the same pairing**,
that `buildBoostNoteTemplate` emits — that is the point of it. One `#i` filter
returns the boost note and every streaming receipt for one feed, episode or
track together; drift the tag shape and the two stop meeting.

Then `amount` (millisats that SETTLED), `action` (`auto`), `start`/`end` (the
wall-clock interval), `position` (playback seconds), `session`, `app`, and a
NIP-31 `alt`. `content` is the empty string: the field exists in the spec for a
boostagram message and an unattended payment has none.

Two tags the spec allows and this app deliberately omits:

- **No `name`.** The event's author pubkey IS the sender, so a display name is a
  second answer to a question the signature has already settled — and a
  user-editable one, which is the shape that drifts.
- **No `p`.** Streaming pays value-block recipients by node pubkey or lnaddress;
  this app learns no Nostr identity for them, and inventing one from a feed's
  `<podcast:txt purpose="nostr">` would `p`-tag the show's artist for a payment
  that may have gone to a different track's.

`alt` is not optional dressing. No client renders this kind — that is the design
— so without it a general-purpose client shows an empty box.

**No `assertPublished`.** That guard exists for callers that record durable
state on the strength of a publish, because recording success is exactly what
stops the next attempt retrying. Nothing is recorded here, so an event that
reached no relay costs one missing receipt and nothing else. The accepted-relay
count is logged instead, so "why are there no receipts?" stays answerable.

## Nostr publish shape

`publishBoostNote()` in `lib/nostr/boost-notes.ts` builds a kind:1 with:

- NIP-73 `i`/`k` pairs for `podcast:guid:<feed-guid>` and (per-episode) `podcast:item:guid:<item-guid>`.
- **Two `r` tags** when the URLs differ: a listen-link via `podcastLandingUrl` and a BMB deep-link via `bmbLandingUrl`. Both are appended to the body so readers see "listen elsewhere" and "boost back on BMB" as separate affordances. **Both take the `episode` and point at it when there is one** — a boost note about one episode that lands the reader on the show's front door makes them go hunt for it:
  - `podcastLandingUrl` prefers the **episode's own page** (`Episode.link`, the RSS `<link>`), then **the item guid when it's an http(s) URL** — RSS defines `<guid>` as a permalink unless `isPermaLink="false"`, and plenty of feeds (Bowl After Bowl) use the episode page URL verbatim; we don't parse that attribute, so it's a heuristic that only runs when the feed published no `<link>` at all, where the alternative is dropping the reader on the show. Then `https://pod.link/<itunesId>`, `https://podcastindex.org/podcast/<feedId>`, the raw RSS URL. Those last three are show-level on purpose: neither pod.link nor PI has an episode URL constructible from a guid (pod.link's episode paths key on an id of their own).
  - `bmbLandingUrl` appends `&episode=<guid>` (encodeURIComponent'd — unlike the podcast UUID, an item guid is arbitrary feed-chosen text and is routinely a URL). `?podcast=&episode=` is a restorable view per the URL contract and `app/page.tsx` emits episode-level OG tags for it, so the unfurl carries the episode's own title and art. Still null without a `podcastGuid`, which is what keeps live-stream boosts (synthetic podcast, no guid) from emitting one.
    - **Emitting the OG tags is not the same as a fetcher finding them, and that gap is `htmlLimitedBots` in `next.config.mjs`.** Next 15 STREAMS metadata: `generateMetadata` runs while the shell is already flushing, so for an ordinary user agent the `<meta>` tags land in the **body** (the browser hoists them; a preview fetcher reads the head and stops). Only a UA matching Next's built-in bot list gets a blocking render. Measured on the production deploy, one URL, one request each: `Twitterbot/1.0` → `og:title` at byte 5761 with `</head>` at 7398; curl's default UA → `og:title` at 22251 with `</head>` at 4024. The visible symptom was a boost note's deep link unfurling in jumble as a blank card titled with the hostname, while the same note in another client showed the episode's title, description and art — which reads as one client's bug and is not. The setting **replaces** Next's list rather than extending it, so the built-in pattern is copied verbatim and the generic-fetcher words appended; **re-copy it on a Next upgrade**, because a bot dropped from the list costs a preview card nobody will report.
      - **It does not fix jumble, and no word list can.** `scout.jumble.social` sends `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36` — captured by pointing it at a request logger — which is byte-for-byte a real Chrome UA, so any pattern that catches it catches every Chrome visitor too. What the list does buy is every *honest* fetcher (curl, axios, python-requests, and the preview services that identify themselves), which is worth having on its own. The only lever that would reach jumble is `htmlLimitedBots: /.*/`, i.e. blocking metadata for everyone, and that was measured and **declined**: three runs each against production gave ~0.35 s TTFB blocking against ~0.19 s streamed, about +150 ms on the document for every visitor, to fill in one client's small secondary link card. The picture that matters — the `/api/og/boost.png` banner — is a bare image URL in the body and renders in jumble regardless, because a client does not need a preview service to show an image it can see in the text. **Don't re-open this by widening the regex**: a pattern broad enough to match that UA is a pattern that turns streaming off for everyone, with the cost hidden in a word list instead of stated.
- **`Episode.link` is raw feed text** — `lib/pi.ts` only checks it's a non-empty string. Anything derived from it goes through **`httpUrl` (`lib/util.ts`)**, an http(s) allowlist over the WHATWG parser (same fail-closed direction as `safeUrlAttr`, returning the parser's normalized form so a value that only parsed because tab/CR/LF were stripped can't be re-emitted with them). Used both here and for the detail view's "Episode page ↗" anchor — **React does not block a `javascript:` href, it only warns in dev.**
- **`p` tags for the npubs the feed declares** via `<podcast:txt purpose="nostr|npub">` and `<podcast:person npub="…">` — episode-level first (a music track's own artist), then channel-level (the show), deduped by pubkey and capped at 4 (`noteNpubs`). Parsing + validation happen server-side in `lib/feed-xml.ts`; see [`feeds.md`](feeds.md). This is the difference between a boost being a post *about* an artist and one that reaches them — without it the note never enters their mentions.
  - **Deliberately NOT gated on the share picker's "Anonymous".** Every other identity-adjacent branch in the boost modals is, so this looks like an oversight and isn't: `anonymous` exists to stop the **sender** leaking (it drops `sender_id` and replaces `sender_name`), while a `p` tag names the **recipient**. An anonymous boost should still reach the artist. Don't "fix" it.
  - Each npub is also appended to the body as `nostr:<npub>`, by `withMentions` in `buildBoostNoteTemplate` — **not** inside `formatContent`, because `BoostAllModal` hand-builds a `contentOverride` that replaces the whole body and would silently lose the mention. Appending post-override is the one place both content paths converge (same drift that bit the sender-name line). Append-only, so the `⚡ Boost ⚡` prefix the site-sign route validates on survives.
  - **The mention is invisible in BMB's own feed** — `<NoteCard>` runs `stripNostrUris`, so other clients render `@name` and ours renders nothing. The `p` tag fires the notification either way; `noteHasSubstance` also strips `nostr:` refs but boosts short-circuit on `isBoost`, so the note is never filtered out.
- **The picture, in the BODY as a bare URL and in an `imeta` tag** (`boostBannerUrl` + `withArt`). A boost note is a public post about one track, and text-only it is a wall of prose beside every other client's — the reader cannot see what was boosted without opening a link. **The body URL is what actually renders the picture**; a NIP-92 `imeta` describes an image the body already names, it does not add one, so the tag alone shows nothing anywhere. Six rules:
  - **It is a GENERATED banner, `/api/og/boost.png`, not the artwork URL.** A cover is square, and a square in a note column is a tall block that pushes the sats, the show and the message apart; the banner is 4:1 and spends the width the column has. Generating it also closes two gaps naming the feed's URL cannot: artwork whose URL carries no image extension is invisible to every client, and a feed with no artwork has nothing to show — both still get a branded banner. The route holds the drawing, the SSRF-safe cover fetch and the text bounds; see its own header.
  - **The route's path, parameter names and `.png` suffix are a permanent public contract.** Every note ever published names them, and a kind:1 cannot be edited, so a rename silently blanks the picture on all of them with no repair available. Add parameters, never repurpose one. The same permanence rule `bmbLandingUrl`'s `www` host already carries — and the `.png` lives in the PATH because a client decides whether a bare URL is an image before it has fetched anything.
  - **The artwork handed to it is the first THREE of `episode.image` → `episode.feedImage` → `podcast.image` → `podcast.artwork`, deduped, as `art`/`art2`/`art3`** — the item's own art first, then the same channel-level pair, in the same order, that `<PodcastCover>` tries on screen (PI mirrors RSS `<image><url>` as `image` and `<itunes:image>` as `artwork`, and they routinely disagree). **Sending only the first shipped an empty left third on a real show, because the first candidate is routinely unusable and nothing on this side can tell.** Homegrown Hits proves it twice in one feed: its channel `image` is a **404** on a domain that still resolves, and its episode art is a **19 MB animated GIF** — over the route's 2 MB ceiling, the same ceiling that stops a feed starving the renderer, and the same oversized-GIF behaviour `docs/ui.md` records for that feed's chapter art. One dead, one too big, one fine, and only a fetch separates them. The route tries them in order under **one 6 s deadline** rather than three independent timeouts, because three dead hosts at 4 s each is a request that outlives the platform's limit and returns nothing at all. Capped at three: the fourth is a fourth sequential fetch inside a request that has to answer. Notes published before this carry `art` alone and cannot be repaired — that is what "the parameters are a permanent contract" means in practice, and why the fix is a NEW parameter rather than a changed one.
      - **An animated GIF is cut to its FIRST FRAME rather than refused** (`lib/gif-first-frame.ts`, pinned by `check:gif`). Falling through to the next candidate was the first fix and it is not enough: on Homegrown Hits the channel-level URL is a *different, older* cover, so the banner quietly advertised the wrong artwork — a failure with no error anywhere and no way to notice except by knowing the show. Frame one sits at the front of the file (measured: **byte 606,584 of a 19 MB file**), so `readBytesUpTo` reads a bounded prefix, **cancels the rest of the transfer**, and the walk cuts it — 0.6 MB moved instead of 19, inside the ceiling that already existed. The cut copies the file's own bytes and appends a trailer; it decodes no pixels, so the surface is arithmetic over length bytes the format supplies, not an LZW decoder. **Do not "simplify" this into a bigger ceiling** — the ceiling exists because a request that has to answer must not decode 19 MB, and the byte count was never the point. `httpUrl`-validated but deliberately **not** extension-gated: the route fetches it and checks the real `Content-Type`, which is the honest test, and no client ever sees this URL.
  - **Appended by `withArt` in `buildBoostNoteTemplate`, above the mentions** — same convergence point as `withMentions` and for the same reason: `BoostAllModal`'s `contentOverride` replaces the whole body, so a picture added inside `formatContent` would be missing from every boost-all note. Above the mentions because a trailing `nostr:npub…` run is what every compose box writes last.
  - **The `imeta` tag is dropped when `url <banner>` exceeds 512 characters.** The site-sign route rejects the WHOLE template on one over-long tag item (`MAX_TAG_ITEM_LEN`), and this URL carries the artwork address plus both titles, so a long one is reachable — it would stop a signed-out user's note publishing at all. The body still names the banner, so the soft failure costs nothing on screen. **The route's `ALLOWED_TAG_NAMES` had to learn `imeta` in the same change** — that allowlist is fail-closed, and a new tag emitted here without it breaks every site-signed note.
  - **The origin is always `https://www.boostmebitch.com`, even under `next dev`.** Building it against the dev server so a design change can be previewed in a real note is the obvious convenience, and it is wrong twice: the URL is `http://localhost:3000`, which nobody else can resolve, and every serious Nostr client is served over HTTPS, so the browser blocks it as **mixed content** and shows nothing even on the machine that published it. Measured on jumble.social — the event carried the localhost URL in both the body and the `imeta`, and no picture appeared. Naming the production route instead means a note published before the route ships is blank only until the deploy and correct forever after; a kind:1 cannot be edited, so that is the only version of "later" available. Preview a design change by fetching the local route directly (`curl 'localhost:3000/api/og/boost.png?…'`), never by publishing a note.
- `amount` in millisats from `value_msat_total` (intent).
- `client` tag from `app_name`, default `BoostMeBitch`.
- `t`: `boostagram` + `value4value`.

Publish target is `resolvePublishRelays(identity)`. Body lives in `formatContent()` (override per call with `contentOverride`):

```
⚡ Boost ⚡

[message, if present]

[sender name] boosted N sats → [podcast title]
📻 [episode title, omitted on show-level boosts]

[pod.link or PI URL]
[boostmebitch.com deep link]

[the /api/og/boost.png banner URL — rendered as the picture]

[nostr:npub… mentions, when the feed declared any]
```

`signAndPublish` handles both kind:1 boost notes and kind:10333 favorites — a third event kind is ~10 lines.

## Site Nostr identity (boost notes for signed-out users)

Since Lightning and Nostr are independent logins, a signed-out boost would otherwise never reach Nostr. The **site owns one persistent Nostr identity** that signs the note on the user's behalf, so "Share on Nostr" is usable when signed out.

- **`SITE_NOSTR_SK` is a server-only secret** (nsec or 32-byte hex), read only by `lib/nostr/site-key.ts` (`siteSecretKey()` / `sitePubkey()`) — **never** `NEXT_PUBLIC`, never shipped to the browser (a signing key in the bundle is extractable by anyone). Absent/malformed → the feature is off. Set in Vercel (Production) + `.env.local`.
- **Signing is server-side.** `app/api/nostr/site-sign/route.ts` accepts an unsigned kind:1 template and **validates it's a boost note** — kind 1, required `⚡ Boost ⚡` content prefix, `t:boostagram` + `t:value4value`, `created_at` within ±5 min — bounding the signing oracle so it can't sign arbitrary events as the site. 503 when unconfigured. **The tag caps bound size, not just count**: `MAX_TAGS` limits how many, `MAX_TAG_ITEMS`/`MAX_TAG_ITEM_LEN`/`MAX_TAGS_TOTAL_LEN` how big. That gap mattered because the content-prefix check constrains only `content`, so tags were the way to get attacker-chosen text signed under the site's NIP-05-verified identity. Real boost notes are ~10 short tags totalling ~600 chars, so the limits sit far above anything genuine. **`ALLOWED_TAG_NAMES` is fail-closed, so a tag `buildBoostNoteTemplate` starts emitting must be added here in the same change** or every site-signed note fails — `imeta` is the one that has been added since, capped at one because the tag carries a URL each reader's client will FETCH, and an unbounded list turns one unauthed POST into a signed instruction to load N attacker-chosen hosts from every reader's device.
- **Client path:** `publishBoostNoteViaSite()` builds the same template as `publishBoostNote` (shared `buildBoostNoteTemplate`), POSTs to the route, then publishes the returned signed event via `publishSignedEvent` to `DEFAULT_RELAYS`. Branch in both modals: the user's own key only when signed in **and** `storage.shareNostrAs` is `'self'` (default); the site key when signed out or the user picked "Post via boostmebitch.com". Publish failures are swallowed — the boost still pays.
- **Share UI:** `<ShareNostrPicker>` (`components/boost-modal/share-nostr-picker.tsx`), shared by both modals. Signed in → one compact pill row (My feed / Anonymous / Don't post, same pattern as the rail picker) with a single description line, persisted as `bmb:share_nostr` + `bmb:share_nostr_as`; signed out → a two-state checkbox.
- **NIP-05:** `app/.well-known/nostr.json/route.ts` maps `_@boostmebitch.com` to the site pubkey **derived from `SITE_NOSTR_SK`** so it can't drift. CORS-open per spec, served by the Next app (nothing to configure at the registrar).
- **Profile:** `scripts/publish-site-profile.mjs` publishes/updates the kind:0. One-off: `node --env-file=.env.local scripts/publish-site-profile.mjs`. Edit `PROFILE` and re-run (kind:0 is replaceable).


## Feed loading (`useNostrFeed`)

`lib/nostr/use-feed.ts` is the stale-while-revalidate hook behind global + per-podcast feeds:

1. **Cache always paints first.** `storage.feedNotes.get(cacheKey)` returns whatever's there regardless of age (no TTL gate), set into state synchronously in the mount effect.
2. **Full fetch on every load.** Mount and user-triggered `refresh()` both do a full relay fetch (no `since`). Stale cached state is replaced, not merged — simpler, and stale notes can't block new relay activity.
3. **No auto-refresh.** Mount + user click only, never a timer. Local mutations (e.g. `boostsTick` after a sent boost) intermix client-side, not via re-fetch.

**Album-page track union.** `fetchPodcastNotes(podcastGuid, opts, episodeGuids?)` widens its `#i` filter to `podcast:guid:<guid>` **plus** `podcast:item:guid:<g>` per entry (OR semantics in one filter). `PodcastNostrFeed` passes every track guid **only for music feeds** (keyed into the fetch deps via a joined `guidsKey`) — music tracks have no per-track pages, so this is what surfaces boosts that tagged only a track's item guid. Regular podcasts have per-episode pages, so they don't pass the union (avoids duplication).

**Substance filter (`noteHasSubstance`, `lib/nostr/discover.ts`).** The feeds are a firehose of *every* kind:1 tagged with NIP-73 `podcast:guid`/`podcast:item:guid`. Some clients (notably **Amplify**) publish an empty kind:1 per listen — `content: ""` plus the podcast tags — which renders as a bare podcast chip; at ~1/3 of all podcast-tagged traffic these drowned out real posts. `noteHasSubstance` keeps boosts always (`isBoost`), otherwise strips `nostr:` refs + image URLs the way `<NoteCard>` does and requires non-empty body text or an image. **Filter on content, not the `client` tag** — real human comments made *via* those same clients survive, and Fountain notes (no `client` tag at all) are unaffected. Applied at render time beside the `mutedPubkeys` filter, so it doesn't touch the `bmb:feed:*` cache and a stale paint can briefly flash filtered cards.



## Boost explorer (`/npub/<npub>`)

A shareable, read-only page: what one npub boosted, and who boosted it.
`components/boost-explorer.tsx` renders it and the two fetchers live beside the
other feed fetchers in `lib/nostr/discover.ts`.

**The way in is the ordinary podcast search box, not a second input.** An npub is
unmistakable — `npub1…`, 63 characters of bech32, or an `nprofile`/hex/profile
link — so `<SearchBar>` runs `parseNpubInput` on the query synchronously and
offers a "Boosts for …" row instead of searching shows. A dedicated box shipped
first and was worse: two inputs side by side, each silently useless for the
other's input, and the user made to know which was which. When the query parses
as an npub the box **skips the `/api/search` fetch entirely** — a 63-character
bech32 string matches no show, so the call spends Podcast Index quota to return
nothing and then paints "no results" over the suggestion, which is the answer.
It also reports an EMPTY query upward, so the page behind it keeps the favorites
panel rather than flipping into a searching layout for a query about a person.

**Navigation hangs off the suggestion — click or Enter — never off the npub
merely parsing.** Someone pasting an npub mid-edit, or pasting one they then
correct, must not have the page moved out from under them; this is the same rule
`onResults` already follows by refusing to navigate when results arrive.

Nobody has their own npub to hand, so "my boosts" is **not** in that box — it
sits beside "edit profile" in `<AccountMenu>`, where the rest of the user's
identity already is.

### Latency

Recognizing an npub is local — no network, tens of microseconds per keystroke —
so the suggestion row is instant. The page behind it is three relay queries the
sections fire **independently on mount**, so each paints when its own resolves
and a revisit paints from `bmb:feed:*` within one frame.

Two caveats on the zaps column below, both deliberate. Its query is independent
but its **paint** is not: `zapsVisible` holds at `null` until the received-boosts
notes land, because `quotedEventIds` needs them to know which receipts are
already on screen above, so in practice that column is `max(zaps, received)`.
And it has no warm cache — `useNostrFeed` and `bmb:feed:*` are typed to
`DiscoveredNote`, so on a revisit the two boost sections repaint in a frame while
this one goes through "searching nostr relays…" again. A sibling cache namespace
is the fix if that ever matters; making `useNostrFeed` generic for one caller is
not.

Measured against a local relay (`Promise.all` of all three, 12 sent + 12 received
+ 8 zaps):

| relay behaviour | sent | received | zaps | page |
|---|---|---|---|---|
| instant reply + EOSE | 0.6 s | 0.1 s | 0.1 s | **0.6 s** |
| 120 ms round trip | 0.6 s | 0.5 s | 0.3 s | **0.6 s** |
| 400 ms round trip | 1.7 s | 1.3 s | 0.9 s | **1.7 s** |
| answers, never EOSEs | 14.8 s | 10.8 s | 2.8 s | **14.8 s** |
| accepts the socket, then silence | 12.0 s | 8.0 s | 8.0 s | **12.0 s** |

**The sent panel is the slow one, structurally, and it is worth knowing why.** It
is the only one that must resolve the author's NIP-65 write relays *before* its
own query can open — an artist who publishes to their own relay is exactly the
person whose page this is. That lookup early-exits the moment the kind:10002
arrives, but an author who has **none** waits out the whole window, so the two
windows stack. It is therefore capped at `QUERY_MAX_WAIT_MS`, not the 8 s feed
window — which is what `lib/nostr/pool.ts` documents that constant for anyway
("single-author / single-event / replaceable-event lookups … kind:10002"). Before
the cap the silent-relay case measured 16.0 s against the other panels' 8.0 s.
`fetchAuthorWriteRelays` takes `maxWait` as a parameter for this reason; leave
its default alone, since `fetchProfiles` calls it as a fallback *after* its own
query and does not stack.

**The two halves are not symmetric, and the copy on screen is load-bearing.**
`buildBoostNoteTemplate` writes `['p', <recipient pubkey>]` for every npub the
feed declared in `<podcast:txt purpose="nostr">`, deliberately un-gated on the
share picker's Anonymous — an anonymous boost should still reach the artist. So
**received is complete**: `{kinds:[1], '#p':[pubkey]}` finds a boost whoever
signed it. **Sent is not, and cannot be.** A boost is authored by the sender only
when they picked "post to my Nostr feed"; every other boost is signed by the site
key via `publishBoostNoteViaSite`, and an anonymous one drops `sender_id` and
`sender_name` on top of that. Nothing on the wire points back at the payer, so no
better filter recovers them.

That is why the sent section's caveat renders **always**, not only when the list
is empty, and why every empty message here says "surfaced from these relays"
rather than making a claim about the person. This is the same rule the favorites
degraded-read notice exists for, pointed at a read instead of a write: a short
list that reads as complete is indistinguishable from a correct one, and the
person who can't tell is the user concluding they boosted less than they did.

**Neither `#p` query may be widened to a bare `{kinds:[1], '#p':[pubkey]}`** —
that is the person's whole mentions firehose, and the `limit` would be spent on
ordinary replies before one boost arrived. Received runs two filters in parallel
and merges: `#k: ['podcast:guid','podcast:item:guid']` for every client following
the NIP-73 convention, and `#t: ['boostagram','value4value']` for a Helipad-style
aggregator that tagged the boost but no podcast. Sent takes the author's whole
timeline instead — `authors` already bounds the scan to one person, and a tag
filter there would silently drop a client whose tags we hadn't thought of.
`eventLooksLikeBoost` trims the raw events **before** `assembleNotes`, so the
reply-tree BFS never walks a mention that was never going to render.

**Zap receipts are read, in their OWN section, and must never be merged into the
boosts list.** The history is the rule here, because both halves of it were
right. Receipts started life merged into the received list and were removed in
`9699c81`: a kind:9735 is a different object with a different author (the
recipient's LNURL server, never the payer) and different evidential weight, and
two kinds of evidence under one heading made the list answer a question ("what
was I paid") that the page does not answer. But the objection was to the **merge**
— the coverage gap was real. A payment that produced no kind:1 at all is invisible
to a boost-note query, and that is most of what a Fountain, zap.stream or Wavlake
sender pays, plus this app's own live-stream boosts, which go out as real NIP-57
zaps (boost invariant 0). So `fetchZapsReceivedBy` is back, under its own
heading, and the two lists never mix.

**The bare `#p` filter there is not the widening this section forbids two
paragraphs down.** That rule is about kind:1, where `{'#p':[pubkey]}` is the
person's whole mentions firehose and the `limit` is spent on ordinary replies
before a boost arrives. A kind:9735 is not a conversational kind: every event the
filter returns is a payment to them.

`quotedEventIds` is live again and is what keeps one payment to one card. A
Fountain-style boost publishes a kind:1 wrapper that quote-references its own
receipt, and **both `p`-tag the recipient**; split across two sections that is
the same payment twice, with the zaps total double-counting money the boosts
panel already showed. The wrapper wins — it is the richer card and its amount is
adopted off the quoted receipt in `buildNote` — so the receipt is dropped. It
must go through `parseQuoteRefs` and not an `e`/`q` tag scan, because Fountain
writes the reference as a `nostr:nevent1…` URI in the note **body**. Dedupe on
the receipt's own id only: a receipt whose `targetEventId` names a note in the
list is someone zapping that boost note, which is a second real payment.

**The zaps section may print a sats total and the received-boosts one still may
not** — see the review-pass note below for why the boosts sum was removed. The
difference is what the number measures. A boost note's `amount` is
`value_msat_total`, the whole boost before the value block divides it, so it is
the same figure on every p-tagged npub's page. A receipt's amount is the invoice
**this** recipient's own LNURL server issued: a per-payee settled fact.
`zapReceiptAmountMsat` falls back to the zap request's amount only after the
receipt tag and the bolt11 HRP, and NIP-57 requires those to agree. The copy
still scopes it twice, because both limits are real — the scan is limit-bounded
("across the receipts shown", not a lifetime total) and `zapSats` floors an
unreadable msat to 0, so those rows are counted out loud rather than left to sink
into the sum. This is not licence to bring the boosts sum back.

Two further guards the surface has to name rather than apply silently.
`parseZapReceipt` returns `null` for a receipt carrying no usable kind:9734, and
those are **dropped rather than attributed to the LNURL server** — a card naming
the server as the payer would be worse than no card. And mutes are filtered in
`<BoostExplorer>` as well as inside `<ZapReceiptCard>`: the card returns `null`
for a muted zapper, but `<FeedSection>` counts `notes.length` and renders one
wrapper `<div>` per item, so filtering only in the card leaves N empty rows under
a header reading `(N)`. The card keeps its own `useApp` selector regardless,
because it is memoized and a mute arriving only through props is skipped.

**`lib/nostr/zap-receipt.ts` has three live callers**: `buildNote` reads a quoted
receipt's amount through `zapReceiptAmountMsat`, `<LiveChat>` renders receipts in
a stream's chat, and `fetchZapsReceivedBy` parses the zaps section. It kept
earning its place through the release where the explorer read no receipts at all,
which is why it was there to restore them. Its `zapReceiptAmountMsat`
keeps the original precedence (receipt `amount` → `bolt11` HRP → *then* the
embedded request's `amount`); the third source was appended, so it can only fire
where the old function returned `null`, leaving `buildNote` unchanged. And a
receipt's sender is never `rawEvent.pubkey` — the payer is the kind:9734 author
inside the `description` tag, which is what `parseZapReceipt` exists to reach.

**The page never reads `storage.boosts`.** That log is this device's, for the
signed-in user — on someone else's page it would show the viewer their own
boosts. `<BoostCard>` is unusable here for the same reason: it draws the avatar
out of `identity`.

### What the review pass changed, and why each was wrong

The explorer shipped in six commits and then a seventh (`5165567`) fixing six
defects a review found. Each is a different way for a read-only page to lie, so
they are worth keeping separately rather than as "review fixes".

**The received panel printed a sats total it could not support.** It summed
`DiscoveredNote.amountMsat`, which is the note's `amount` tag, which
`buildBoostNoteTemplate` sets to `value_msat_total` — **the whole boost, before
the value block divides it**. A boost note `p`-tags *every* npub the feed
declared, so one 1000-sat boost split 90/10 between an artist and their host
printed "1000 sats" on both their pages. There is no fix inside the note: the
splits live in the value block, not on this wire, so no per-payee number is
recoverable. The count stayed and the sum went. **The sent side keeps its sum** —
that npub authored the note and did pay the total, so it is the one place the
number is honest. This is the boost modal's `?`-not-`✗` rule reaching a
read-only surface: a number about money that nobody can check is worse than no
number.

**A store-driven view switch is not a navigation.** `<NoteCard>`'s show and
episode links call `selectPodcast` / `openEpisode`, which only `<HomePage>` at
`/` reads. On this route the tap set the store, scrolled to the top, and did
nothing else — no error, no feedback, indistinguishable from a slow load.
`openShow` now pushes `/` when it isn't already there. See the cross-cutting rule
in CLAUDE.md; it binds any future standalone route, not just this one.

**`repostedIds` is not decoration.** `<BoostExplorer>` didn't pass it, so
`alreadyReposted` was false on every card and a viewer could publish a second
kind:6 for a note they had already reposted. The prop is optional, so its absence
type-checks — the only defence is the convention.

**Muting the page's subject emptied the sent panel while the copy blamed
signing.** Every note in that list is authored by the subject, so the shared
`!mutedPubkeys.has(n.pubkey)` filter removes all of them at once, and the empty
message went on to explain site-signing and anonymity — a wrong explanation the
user has no way to see through. The message now names the mute. The received
list is written by other people, so the same filter is ordinary there. Same rule
as the favorites degraded-read notice: a guard that withholds has to say so.

**`decodeURIComponent` in a render body is a crash, not a parse.** Next already
decodes a route segment, and the function throws `URIError` on a malformed
percent sequence — so `/npub/50%` reached `app/error.tsx` instead of the route's
own "isn't valid" branch twelve lines below, which exists for exactly that input.
It is wrapped now. `app/live/[npub]/page.tsx` doesn't decode at all and is the
other valid answer.

**Two ordinary profile links didn't parse.** `parseNpubInput` took the text after
the last `/`, so `njump.me/npub1…/` gave an empty token and
`primal.net/p/npub1…?ref=x` kept the query string and failed the bech32 decode.
The query and hash are stripped first now, then the trailing slash, then the path
segment, then `nostr:` — that order also makes `…/nostr:npub1…` work. Handling a
pasted link is the entire reason the function does string surgery, so the real
shapes are the requirement, not an extra.

One thing deliberately **not** fixed: a bare 64-char hex string cannot be told
from an event id — they are the same shape — so a pasted event id resolves to a
person who does not exist and both panels come back empty. The bech32 forms
(`note1…`, `nevent1…`) are rejected properly. The doc comment says so rather than
claiming note ids are rejected in general.

### The suggestion row names a person, not an npub

`Boosts for npub180c…wsyjh6w6` is not something anyone can check. You pasted a
string you cannot read, and the row asks you to commit to a navigation on the
strength of it — **the profile name is the confirmation that you pasted the right
npub**, which is the whole job of that row.

`<SearchBar>` resolves the kind:0 for `npubHit.pubkey` and renders `<Avatar>`
plus the display name. Three details are load-bearing:

- **Seed from `storage.profile` synchronously, then fetch.** A name already in
  cache paints in the same frame as the row; without the seed it arrives a second
  later and pushes the layout under a cursor that is already moving.
- **Read that cache in an effect, never during render.** The box is
  server-rendered at `/`. This row can never be in the server HTML (it needs
  typed input), so it would get away with it — and that is exactly why the habit
  is worth refusing here, on the surface where it is free.
- **The short npub holds the name slot until a profile lands**, and permanently
  for an npub with no kind:0, so the row never reads "Boosts for" and then
  nothing. `<Avatar>`'s deterministic colored initial does the same job for the
  picture. The avatar **replaces** the ⚡ rather than joining it — the input's own
  left icon already carries that.

The npub is deliberately not kept beside a resolved name. It is one line, and the
full npub is in the input directly above for anyone who wants to compare it.

## The read index (`services/nostr-index`)

A server-side cache of public Nostr events, deployed separately on Railway. It
exists because every Nostr read in this app happens in the browser, against
relays, on every page load — and one feed load is four serial stages with
nothing on screen until the last one resolves:

```
warmRelays (≤3s) → kind:1 collect (≤8s) → reply tree (≤8s × up to 6 depths) → profiles (3 stacked passes)
```

The index answers all of that in one request. `assembleFromBundle`
(`lib/nostr/discover.ts`) turns the response into the same `DiscoveredNote[]`
`assembleNotes` builds, sharing `buildTree` and `splitTopLevel` with it so the
two paths cannot disagree about how a thread is shaped.

**It is an accelerator and never a dependency.** Unset `NOSTR_INDEX_URL` and
every path falls back to relays exactly as before. That is also the rollback.

### The rules that are not derivable from reading the code

- **`null` from the index means "no answer", never "there are none".** Every
  function in `lib/nostr/index-client.ts` returns `null` for unconfigured,
  unreachable, timed out, refused, unparseable *and for an empty result*. The
  empty case is the surprising one and it is deliberate: an index that has not
  crawled a show yet is indistinguishable from a show with no notes, and letting
  the fast path assert the second would replace a slow-but-correct feed with a
  fast-and-wrong one. The proxy answers **503**, never an empty body, for the
  same reason. Any new index-backed surface inherits this.

- **The three sources UNION, they do not replace.** `useNostrFeed` paints
  localStorage, then the index, then relays, merging by event id. The relay pass
  finishes many seconds after the index one and asks a *different* question —
  the index holds what it has seen since deploy, each relay holds whatever it
  kept — so a replace would make notes VANISH from a feed the user is already
  reading, seconds after they appeared, with nothing on screen explaining it.
  Notes are append-only and carry their own id, so a union is both correct and
  the only shape that cannot lose one. On a collision the newer pass wins: a
  note whose author profile resolved on the second pass must not revert to the
  anonymous version from the first.

- **The index pass runs ALONGSIDE the relay pass, never in front of it.**
  Awaiting the index first makes an index that is merely *slow* worse than no
  index at all, because the relay query would not have started yet.

- **A relay failure is only an error when nothing is on screen.** An index hit
  followed by a relay failure is a working feed, and saying otherwise is a claim
  the user cannot check. Same rule in the boost explorer's zaps panel, which
  keeps a populated list rather than blanking to `[]`.

- **Every event is verified client-side, chunked.** The index verified it all
  before storing it, so a failure here means that service or its database was
  tampered with — checking again is what stops a compromised index putting sat
  amounts under someone else's npub. It costs ~3ms per event, which the relay
  path also pays (nostr-tools verifies everything it receives) but spreads
  across an 8-second window. Arriving in one lump it would freeze the main
  thread, so `verifyAll` yields between chunks of 15.

- **Reply nesting is recomputed from NIP-10 on the client, not taken from the
  server's shape.** The index finds replies with a recursive walk over `e` tags,
  so a note carrying both a `root` and a `reply` marker is reachable from two
  parents. `getParentEventId` decides which is real, and it stays the only place
  that does. `assembleFromBundle` loops until nothing new attaches, because the
  bundle is not ordered by depth and one pass would silently drop everything
  below depth 1. A reply whose parent is outside the bundle is dropped, never
  promoted to top level — rendering a reply as a standalone boost is worse than
  not showing it.

### What it must never index

Enforced in `services/nostr-index/src/ingest.ts` (`FORBIDDEN_KINDS`) rather than
only in the subscription filters, because **a filter is a request and a relay
may send anything** — pinned by `verify/check-indexer.mjs`, which pushes a
kind:10333 down a subscription that never asked for one.

kind:10333 favorites, kind:10000 mutes, kind:3 follows, kind:30078 backups,
kind:4/1059 DMs, kind:10002 relay lists. The first four drive destructive
replaceable-event writes on the client or carry ciphertext; **a stale index read
of kind:10333 satisfies `mergeFavoritesList`'s removal test and deletes entries
another app wrote, on someone else's device, with no undo.** The favorites
speed-up comes entirely from the Podcast Index tables — the kind:10333 read
itself keeps coming from relays, always.

**No degraded-read decision is ever downstream of the index.**
`lib/nostr/read-trust.ts` stays the only authority, and the index never feeds it.

