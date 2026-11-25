'use client';

// The ⚡ ZAP tile's state and the dialog it opens. Loaded only for a playlist
// this site hosts: `playlist-zap.tsx` decides that (`playlistMaker`, the payee
// guard) and defers this module. docs/money-boosts.md, "A playlist maker's ZAP".

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import type { FeedNpub, Podcast } from '@/lib/types';
import { useApp } from '@/lib/store';
import { fetchProfileDetailed, receiptRefUrls } from '@/lib/nostr';
import { noteBrandFor } from '@/lib/brand';
import { COMMUNITY_FEED_ORIGIN } from '@/lib/curated-playlists';
import { useGuestKey } from '@/lib/community/use-guest-key';
import { BoltIcon } from '../icons';
import { ZapTilePending } from './zap-tile-pending';

// DEFERRED, as `<BoostModal>` is in episode-list.tsx: most readers never open
// it, and it pulls in the payment rails.
const ZapDialog = dynamic(() => import('../zap-dialog').then((m) => m.ZapDialog), { ssr: false });

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

export function MakerZap({ podcast, maker }: { podcast: Podcast; maker: FeedNpub }) {
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
  // Until the reads answer, the tile's place is held (`<ZapTilePending>`), so
  // the row does not reflow from three tiles to four under the reader's thumb.
  // A signed-in maker is known at once and holds nothing.
  const pending = !self && !showTile && (guest === undefined || cur.state === 'reading');

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
      {pending && <ZapTilePending />}
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
          // The hint is the one a boost's summary receipt signs for a song from
          // this playlist (`receiptRefUrls`): `?podcast=<guid>`, on the Buddy
          // origin from either deploy (`noteBrandFor`), because a receipt is
          // never edited and must not carry beta's or a dev server's address.
          refs={{
            podcastGuid: podcast.podcastGuid,
            podcastUrl: receiptRefUrls(noteBrandFor(true, COMMUNITY_FEED_ORIGIN), podcast.podcastGuid).podcastUrl,
          }}
          subtitle={subtitle}
          noAddressText={noAddressText}
          commentPlaceholder="great playlist"
        />
      )}
    </>
  );
}
