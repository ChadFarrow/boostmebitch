# Cross-app podcast favorites on Nostr

This spec now lives at its own canonical, app-neutral home — not inside
either participating app's repo, so there's one copy to link to instead of
several that can silently drift apart:

**→ [github.com/ChadFarrow/PC20-Nostr/specs/pc20-favorites.md](https://github.com/ChadFarrow/PC20-Nostr/blob/main/specs/pc20-favorites.md)**

Implemented here in `lib/nostr/favorites-merge.ts` (wire format + merge),
`lib/nostr/favorites.ts` (I/O), `lib/nostr/favorites-hydrator.ts` (hydration +
migration), and `components/favorites-sync-notice.tsx` (the degraded-read
notice). Read the linked doc, not this stub, for the format and merge
algorithm.
