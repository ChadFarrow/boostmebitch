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
import { storage } from '@/lib/storage';
import type { ProfileMetadata } from '@/lib/nostr/profile-metadata';
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

/**
 * A HINT that the maker can be zapped: the name and whether a Lightning address
 * is there. It LIGHTS the tile and nothing more — it never names the payee. The
 * device's cached kind:0 gives one at once; else the first kind:0 a relay sends.
 * Measured on beta 2026-11-25: purplepag.es answered at 1.0 s and 2.9 s, while
 * the settled read waited on relays that never connected (damus, nos.lol) or
 * never answered (primal) until 2.6 s and 4.5 s — on a desktop line; a phone
 * waits longer (Chad: "It just takes a minute to light up").
 */
type MakerHint = { name?: string; zappable: boolean };

function hintOf(p: ProfileMetadata | null | undefined): MakerHint | null {
  if (!p) return null;
  return {
    name: p.display_name?.trim() || p.name?.trim() || undefined,
    zappable: !!(p.lud16?.trim() || p.lud06?.trim()),
  };
}

async function readMaker(pubkey: string, onHint?: (h: MakerHint) => void): Promise<MakerRead> {
  try {
    // `fetchProfileDetailed`, never `fetchProfile`: "this maker has no address"
    // is a claim on screen, and a bare null is also what a dead relay set gives.
    const { profile, trustworthy } = await fetchProfileDetailed(
      pubkey,
      undefined,
      onHint ? (p) => { const h = hintOf(p); if (h) onHint(h); } : undefined,
    );
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
  // The hint, keyed by pubkey like the read. Seeded from the device's cache.
  const [hint, setHint] = useState<{ pubkey: string; h: MakerHint } | null>(() => {
    const h = hintOf(storage.profile.get(maker.pubkey));
    return h ? { pubkey: maker.pubkey, h } : null;
  });
  const [open, setOpen] = useState(false);
  const [rereading, setRereading] = useState(false);

  useEffect(() => {
    let live = true;
    const cached = hintOf(storage.profile.get(maker.pubkey));
    setHint(cached ? { pubkey: maker.pubkey, h: cached } : null);
    // The hint stored with the playlist on PUBLISH or SAVE (`maker_ln`), for a
    // first visit, before any relay answers. Only for the SAME owner the feed
    // names, and only "zappable": the payee is still the settled read's.
    const guid = podcast.podcastGuid;
    if (guid) {
      void fetch(`/api/community-playlists/maker-hint?guid=${encodeURIComponent(guid)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((b: { owner?: unknown; zappable?: unknown } | null) => {
          if (!live || !b || b.owner !== maker.pubkey || b.zappable !== true) return;
          setHint((prev) => (prev?.pubkey === maker.pubkey && prev.h.zappable ? prev : { pubkey: maker.pubkey, h: { zappable: true } }));
        })
        .catch(() => { /* a hint only */ });
    }
    void readMaker(maker.pubkey, (h) => {
      // A cached "zappable" is not taken back by a first answer: the settled
      // read decides that. Only a hint that lights the tile is kept early.
      if (live && h.zappable) setHint({ pubkey: maker.pubkey, h });
    }).then((r) => { if (live) setRead({ pubkey: maker.pubkey, r }); });
    return () => { live = false; };
  }, [maker.pubkey, podcast.podcastGuid]);

  const cur: MakerRead = read?.pubkey === maker.pubkey ? read.r : { state: 'reading' };

  // The maker is the viewer: their account, or the guest key THIS browser holds
  // (a guest-made playlist). Nothing to zap. `undefined` is the guest key still
  // being read, so the tile waits rather than flashing on the maker's own page.
  const self = identity?.pubkey === maker.pubkey || (guest != null && guest.pubkey === maker.pubkey);
  const curHint = hint?.pubkey === maker.pubkey ? hint.h : null;
  // Lit by the settled read, or EARLY by a hint while that read is still out.
  // A hint never outlives the read: once it lands, its answer alone decides.
  const lit = cur.state === 'found' || cur.state === 'unread' || (cur.state === 'reading' && !!curHint?.zappable);
  const showTile = !self && guest !== undefined && lit;
  // The payee is named ONLY by the settled read. A hint can be stale (a cache
  // up to seven days old, a first answer that is not the newest), so until the
  // read lands the dialog says so and offers no Send.
  const payeePending = cur.state === 'reading';
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
    || (cur.state === 'reading' ? curHint?.name : undefined)
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
          payeePending={payeePending}
          commentPlaceholder="great playlist"
        />
      )}
    </>
  );
}
