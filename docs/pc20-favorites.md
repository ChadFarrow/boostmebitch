# Cross-app podcast favorites on Nostr

This spec lives at its own canonical, app-neutral home — not inside either
participating app's repo, so there's one copy to link to instead of several
that can silently drift apart:

**→ [github.com/ChadFarrow/PC20-Nostr/pc20-favorites.md](https://github.com/ChadFarrow/PC20-Nostr/blob/main/pc20-favorites.md)**

One plain (non-`d`-tagged) replaceable event at **kind 10333**, shared with
StableKraft, and the only favorites address this app reads or writes. It
replaced a two-address kind:30078 design that carried its data by position
*inside* each `i` tag; those events are still on relays, still valid, and are
the rollback path — nothing here reads or deletes them.

Implemented here in `lib/nostr/favorites-list.ts` (wire format + merge, and
import-free so `scripts/check-favsync.mjs` can pin the real thing),
`lib/nostr/favorites.ts` (I/O), `lib/nostr/favorites-hydrator.ts` (hydration +
Podcast Index resolution), and
`components/favorites-sync-notice.tsx` (the degraded-read notice).

## Three documents now, not one

The spec repo was reorganized on 2026-09-08 (PC20-Nostr#46). The rules and the
reasons are separate files, and each rule links its own reason with a `(why)` —
so following a `(why)` is the fastest way to find out which way the obvious
version is wrong.

| document | what is in it |
|---|---|
| [`pc20-favorites.md`](https://github.com/ChadFarrow/PC20-Nostr/blob/main/pc20-favorites.md) | **normative.** The event, the entries, `medium`, tag order and bands, the five merge rules, public/private, and what a read-only consumer owes |
| [`notes/pc20-favorites-rationale.md`](https://github.com/ChadFarrow/PC20-Nostr/blob/main/notes/pc20-favorites-rationale.md) | the measurements and the history behind each rule — not normative, and the half that says why |
| [`conformance/vectors.md`](https://github.com/ChadFarrow/PC20-Nostr/blob/main/conformance/vectors.md) | the 31 vectors in prose, beside the `vectors.test.mjs` that `npm run check:conformance` runs |

Two more sit beside them: `pc20-favorites-feed-guid-migration.md` (the four
stages) and `conformance/adapter.d.ts` (the contract
`scripts/conformance-adapter.mjs` implements).

**The spec says *place* where this app's code says *half*.** `ListHalf`,
`baselineHalf`, `foldHalves` and the baseline's `privateFeeds`/`privateItems`
all predate that wording, and they are the same concept: the plaintext `i` tags,
and the entries encrypted into `content`. Deliberately not renamed — the churn
would reach the merge, the baseline and every vector in `check:favsync`, and buy
nothing on the wire.

## Where this app stands

`npm run check:conformance` is **28 green / 3 red**, and
`scripts/conformance.mjs` names each red one and why it is deliberate. A NEW red
is a regression.

**The feed-guid revision** (PC20-Nostr#34): an item entry carries the guid of
its feed at position 1 of its own `i` tag, with the item's identifier at
position 2, instead of taking its feed from the entry above it. The same
revision prescribes a band order for each `medium` run. The migration is staged
across both writers of this event, and this app ships **stages 2 and 4**: it
reads and writes the three-element form, rewrites a legacy item once, claims the
(feed, item) pair, and bands each run. **Stage 3 is not shipped** — a placement
feed entry already on the wire is carried rather than retracted.

**A reader that has not shipped stage 1 takes `podcast:guid:F` at position 1 and
converts a saved episode into a followed show**, so dropping those placement
entries is what costs data, not writing position 2. The migration doc says stage
3 is the one to hold back longest, and nothing measured in this repo says what
any other reader has shipped — so it stays held.

**Three later rules** landed here too: a change of mode is a merge and not a
copy (#38), an emptied `content` encodes to the empty string rather than to
ciphertext (#40), and a carried claim retires with the entry it names (#40).
And **an empty, untagged list is public** (#47) — nobody has chosen anything and
nothing can be disclosed, so a brand-new account's first ♡ publishes into the
tags with no `visibility` tag and no prompt. `seedModeFromWire` keeps that answer
to lists that are empty in all three places; see its header.

Read the linked docs, not this stub, for the format and the merge algorithm.
`npm run probe:favorites -- <npub>` prints what is actually on the relays.
