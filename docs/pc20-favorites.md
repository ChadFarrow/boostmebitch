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

**The format was revised on 2026-09-08** (PC20-Nostr#34): an item entry now
carries the guid of its feed at position 1 of its own `i` tag, with the item's
identifier at position 2, instead of taking its feed from the entry above it.
The same revision prescribes a band order for each `medium` run. The migration is
staged across both writers of this event, and this app ships **stages 2 and 4**:
it reads and writes the three-element form, rewrites a legacy item once, claims
the (feed, item) pair, and bands each run. **Stage 3 is not shipped** — a
placement feed entry already on the wire is carried rather than retracted.

**A reader that has not shipped stage 1 takes `podcast:guid:F` at position 1 and
converts a saved episode into a followed show**, so deploying this before
StableKraft reads the new form is what costs data, not merging it. The four
stages are in `pc20-favorites-feed-guid-migration.md` beside the spec, and
`scripts/conformance.mjs` records which vectors are red and why.

Read the linked doc, not this stub, for the format and the merge algorithm.
`npm run probe:favorites -- <npub>` prints what is actually on the relays.
