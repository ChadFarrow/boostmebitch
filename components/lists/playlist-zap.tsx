'use client';

// ⚡ ZAP on a community playlist: a NIP-57 zap to the playlist's MAKER, paid to
// the Lightning address on the maker's Nostr profile (Chad, 2026-11-25: "since
// playlist need nostr to make them can we add a zap button at the top to zap
// the maker of the playlist").
//
// A tile in the show header's row of peers (FAV / SHARE / ZAP). It is a
// zap to a PERSON, like ⚡ zap on a Nostr note, never a boost: no boostagram,
// no value block, no keysend (boost invariant 12). docs/money-boosts.md,
// "A playlist maker's ZAP", holds the reasoning for each rule below.

import dynamic from 'next/dynamic';
import type { FeedNpub, Podcast } from '@/lib/types';
import { COMMUNITY_PLAYLISTS_ON, communityIdFromFeedUrl } from '@/lib/curated-playlists';

// DEFERRED in BYTES: this file is in `/`'s first load (the show header), and
// only a playlist this site hosts needs the tile's hooks, the guest-key read
// and the profile read. Measured on a production build with the switch on:
// `/` first-load JS 348 kB on main, 350 kB with `MakerZap` imported here
// statically, 348 kB deferred.
const MakerZap = dynamic(() => import('./maker-zap').then((m) => m.MakerZap), { ssr: false });

/**
 * The maker of a playlist THIS SITE HOSTS, or null.
 *
 * Both gates are the payee guard, not a nicety. `nostrNpubs` reaches the show
 * header from any RSS feed that writes `<podcast:txt purpose="npub">`, so on a
 * third-party feed it is whatever key that feed chose to name. On a playlist we
 * host it is the `owner_pubkey` of the row (`communityPlaylistToPodcast`, built
 * by `/api/playlist` from the store), the key that signed the NIP-98 publish.
 * Exactly ONE entry, because that is all our feed writes.
 *
 * `COMMUNITY_PLAYLISTS_ON` keeps production unchanged: it runs with
 * `COMMUNITY_FEEDS=on`, so it plays these playlists while the maker is beta only.
 */
export function playlistMaker(podcast: Podcast): FeedNpub | null {
  if (!COMMUNITY_PLAYLISTS_ON || !communityIdFromFeedUrl(podcast.url)) return null;
  const makers = podcast.nostrNpubs;
  return makers?.length === 1 ? makers[0]! : null;
}

export function PlaylistZapButton({ podcast }: { podcast: Podcast }) {
  const maker = playlistMaker(podcast);
  // Every other show page pays for none of `MakerZap`'s hooks (the guest key
  // is an IndexedDB read, the profile a relay query) nor its bytes.
  return maker ? <MakerZap podcast={podcast} maker={maker} /> : null;
}
