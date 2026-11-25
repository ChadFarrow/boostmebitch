'use client';

// ⚡ ZAP on a community playlist: a NIP-57 zap to the playlist's MAKER, paid to
// the Lightning address on the maker's Nostr profile (Chad, 2026-11-25: "since
// playlist need nostr to make them can we add a zap button at the top to zap
// the maker of the playlist").
//
// A tile in the show header's row of peers (FAV / SHARE / RSS / ZAP). It is a
// zap to a PERSON, like ⚡ zap on a Nostr note, never a boost: no boostagram,
// no value block, no keysend (boost invariant 12). docs/money-boosts.md,
// "A playlist maker's ZAP", holds the reasoning for each rule below.

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import type { FeedNpub, Podcast } from '@/lib/types';
import { useApp } from '@/lib/store';
import { fetchProfileDetailed } from '@/lib/nostr';
import { COMMUNITY_PLAYLISTS_ON, communityIdFromFeedUrl } from '@/lib/curated-playlists';
import { useGuestKey } from '@/lib/community/use-guest-key';
import { showShareUrl } from '@/lib/util';
import { BoltIcon } from '../icons';

// DEFERRED, as `<BoostModal>` is in episode-list.tsx: most readers never open
// it, and it pulls in the payment rails.
const ZapDialog = dynamic(() => import('../zap-dialog').then((m) => m.ZapDialog), { ssr: false });

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

type MakerRead =
  | { state: 'reading' }
  /** The kind:0 names a Lightning address. */
  | { state: 'found'; name?: string; lud16?: string; lud06?: string }
  /** The relays answered, and the newest kind:0 (if any) names no address. */
  | { state: 'none'; name?: string }
  /** Nothing to believe: no profile in hand and the read was degraded. */
  | { state: 'unread' };

async function readMaker(pubkey: string): Promise<MakerRead> {
  try {
    // `fetchProfileDetailed`, never `fetchProfile`: "this maker has no address"
    // is a claim on screen, and a bare null is also what a dead relay set gives.
    const { profile, trustworthy } = await fetchProfileDetailed(pubkey);
    const name = profile?.display_name?.trim() || profile?.name?.trim() || undefined;
    const lud16 = profile?.lud16?.trim() || undefined;
    const lud06 = profile?.lud06?.trim() || undefined;
    if (lud16 || lud06) return { state: 'found', name, lud16, lud06 };
    return trustworthy ? { state: 'none', name } : { state: 'unread' };
  } catch {
    return { state: 'unread' };
  }
}

export function PlaylistZapButton({ podcast }: { podcast: Podcast }) {
  const maker = playlistMaker(podcast);
  // Split so every other show page pays for none of the hooks below (the guest
  // key is an IndexedDB read, the profile a relay query).
  return maker ? <MakerZap podcast={podcast} maker={maker} /> : null;
}

function MakerZap({ podcast, maker }: { podcast: Podcast; maker: FeedNpub }) {
  const identity = useApp((s) => s.identity);
  const setSignInOpen = useApp((s) => s.setSignInOpen);
  const guest = useGuestKey();
  // Keyed by pubkey, so a read for the previous playlist never paints this one.
  const [read, setRead] = useState<{ pubkey: string; r: MakerRead } | null>(null);
  const [open, setOpen] = useState(false);
  const [rereading, setRereading] = useState(false);

  useEffect(() => {
    let live = true;
    void readMaker(maker.pubkey).then((r) => { if (live) setRead({ pubkey: maker.pubkey, r }); });
    return () => { live = false; };
  }, [maker.pubkey]);

  const cur: MakerRead = read?.pubkey === maker.pubkey ? read.r : { state: 'reading' };

  // The maker is the viewer: their account, or the guest key THIS browser holds
  // (a guest-made playlist). Nothing to zap. `undefined` is the guest key still
  // being read, so the tile waits rather than flashing on the maker's own page.
  const self = identity?.pubkey === maker.pubkey || (guest != null && guest.pubkey === maker.pubkey);
  const showTile = !self && guest !== undefined && (cur.state === 'found' || cur.state === 'unread');

  async function onPress() {
    // A zap request is signed by the viewer's key. Signed out there is none, so
    // the press opens the sign-in sheet (no anonymous zap).
    if (!identity) { setSignInOpen(true); return; }
    if (cur.state === 'unread') {
      // The page-load read was degraded. Ask again now; the dialog then says
      // what the second read found, which may still be "could not read".
      setRereading(true);
      const r = await readMaker(maker.pubkey);
      setRead({ pubkey: maker.pubkey, r });
      setRereading(false);
    }
    setOpen(true);
  }

  const makerName = (cur.state === 'found' || cur.state === 'none' ? cur.name : undefined)
    || podcast.author?.trim()
    || undefined;
  const lud16 = cur.state === 'found' ? cur.lud16 : undefined;
  const lud06 = cur.state === 'found' ? cur.lud06 : undefined;
  const subtitle = `For the playlist “${podcast.title}”${lud16 ? `, to ${lud16}` : ''}.`;
  const noAddressText = cur.state === 'none'
    ? "This playlist's maker has no Lightning address on their Nostr profile, so they can't receive zaps."
    : "Could not read the maker's Nostr profile: the relays did not answer. Close this and try again.";

  return (
    <>
      {showTile && (
        <button
          type="button"
          onClick={() => { void onPress(); }}
          disabled={rereading}
          className="tile disabled:opacity-50"
          title={identity ? 'Zap the maker of this playlist (NIP-57)' : 'Sign in to zap the maker of this playlist'}
          aria-label="Zap the maker of this playlist"
          data-playlist-zap
        >
          <BoltIcon className="text-bolt" />
          {rereading ? '…' : 'ZAP'}
        </button>
      )}
      {open && identity && (
        <ZapDialog
          recipient={{ pubkey: maker.pubkey, npub: maker.npub, name: makerName, lud16, lud06 }}
          identity={identity}
          onClose={() => setOpen(false)}
          // The receipt names the playlist: the recipient's server mirrors the
          // NIP-73 pairs onto it, and that is the only place it says what for.
          refs={{ podcastGuid: podcast.podcastGuid, podcastUrl: showShareUrl(podcast) ?? undefined }}
          subtitle={subtitle}
          noAddressText={noAddressText}
          commentPlaceholder="great playlist"
        />
      )}
    </>
  );
}
