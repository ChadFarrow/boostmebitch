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

Read the linked doc, not this stub, for the format and the merge algorithm.
`npm run probe:favorites -- <npub>` prints what is actually on the relays.
