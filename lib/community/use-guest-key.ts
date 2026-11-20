'use client';

import { useEffect, useState } from 'react';
import { loadGuestKey, type GuestKeyInfo } from './guest-key';

/**
 * The guest key's PUBLIC half, read once on mount, never created here.
 * `undefined` while it is being read, `null` when this browser holds none.
 * The key is made only when someone publishes or uploads a cover without an
 * account (`ensureGuestKey`, called from the maker); a page that only asks
 * "is this playlist mine?" must not mint a key by looking.
 */
export function useGuestKey(): GuestKeyInfo | null | undefined {
  const [info, setInfo] = useState<GuestKeyInfo | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadGuestKey().then((k) => { if (live) setInfo(k); }, () => { if (live) setInfo(null); });
    return () => { live = false; };
  }, []);
  return info;
}
