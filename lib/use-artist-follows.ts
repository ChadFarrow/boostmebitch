'use client';

import { useEffect, useState } from 'react';
import { storage } from './storage';
import type { ArtistFollow } from './new-music';

/**
 * The artists this device follows (♡ ARTIST), for one account, kept current
 * across components: the album page's chip and the NEW MUSIC section both read
 * it, and either can change it. Empty on the server and on the first render.
 */
export function useArtistFollows(npub: string | null): Record<string, ArtistFollow> {
  const [follows, setFollows] = useState<Record<string, ArtistFollow>>({});
  useEffect(() => {
    const read = () => setFollows(storage.artistFollows.get(npub));
    read();
    return storage.artistFollows.subscribe(read);
  }, [npub]);
  return follows;
}

/** Follow or stop following one artist on this device. Returns whether the
 *  change reached disk — the caller says so when it did not. */
export function setArtistFollow(
  npub: string | null,
  artist: { feedGuid: string; feedUrl: string; title?: string },
  on: boolean,
): boolean {
  const next = { ...storage.artistFollows.get(npub) };
  if (on) {
    next[artist.feedGuid] = {
      feedGuid: artist.feedGuid,
      feedUrl: artist.feedUrl,
      ...(artist.title ? { title: artist.title } : {}),
      addedAt: Date.now(),
    };
  } else {
    delete next[artist.feedGuid];
  }
  return storage.artistFollows.set(npub, next);
}
