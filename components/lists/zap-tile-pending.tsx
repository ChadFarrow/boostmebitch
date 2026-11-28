'use client';

import { BoltIcon } from '../icons';

// The ZAP tile's place, held while its code and the maker's kind:0 load.
//
// Without it the row painted FAV / SHARE / RSS and then, a second or more later,
// reflowed to four tiles under the reader's thumb (Chad, 2026-11-25: "after a bit
// [the ZAP] ... Not ideal"). It renders from the first paint of a playlist this
// site hosts: as `dynamic()`'s `loading` in `playlist-zap.tsx`, then from
// `<MakerZap>` while the guest key and the profile are read. It goes only when
// the read PROVES there is nothing to zap (no address, or the viewer is the
// maker), which is the uncommon case.
//
// Its own file because both of those import it, and `maker-zap.tsx` importing
// `playlist-zap.tsx` would close a module cycle. Disabled, and not
// `data-playlist-zap`: it is not the tile, and pressing it does nothing.
export function ZapTilePending() {
  return (
    <button
      type="button"
      className="tile disabled:opacity-50"
      disabled
      aria-label="Zap the maker of this playlist (reading the maker's profile)"
      data-playlist-zap-pending
    >
      <BoltIcon className="text-bolt" />
      ZAP
    </button>
  );
}
