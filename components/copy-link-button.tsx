'use client';

import { useEffect, useRef, useState } from 'react';
import { ShareIcon } from './icons';

const COPIED_FLASH_MS = 1800;

/**
 * "SHARE" → copies `url`, flashes "COPIED" for ~1.8 s, reverts.
 *
 * Shared because `components/lists.tsx` and `components/fullscreen-player.tsx`
 * each had a private `ShareButton` doing exactly this, and the copies had
 * already produced two different links for the same show: one built
 * `new URL(origin + pathname)` and set a `podcast` search param, the other
 * interpolated `${origin}/?podcast=`. Those agree only while the app is served
 * from `/`, and they disagree silently everywhere else.
 *
 * URL BUILDING STAYS AT THE CALL SITE. The fullscreen player's is genuinely
 * different — a live stream shares as `/live/<npub>`, not as a podcast link —
 * so this component takes a finished string and owns only the copy interaction
 * and the chrome. A caller with nothing to share passes `null` and renders
 * nothing, which is what both originals did via an early return.
 *
 * The timeout is cleared on unmount, which NEITHER original did: both could
 * fire `setCopied(false)` after the component was gone. Harmless in React 18
 * (the warning was removed) but a real leak of a pending timer, and the
 * fullscreen player unmounts on every collapse.
 */
export function CopyLinkButton({
  url,
  title,
  word = 'SHARE',
  className = 'btn-ghost',
}: {
  /** Finished URL to copy. `null` renders nothing. */
  url: string | null;
  /** Tooltip + accessible name, e.g. "Copy link to this show". */
  title: string;
  /**
   * The visible word. Defaults to the ACTION ("SHARE"), which is right
   * wherever the surface has one thing to share. Where two of these sit in one
   * cluster the caller passes the TARGET instead — `targetWord` (`lib/util.ts`)
   * — for the same reason the hearts do: two buttons reading SHARE side by
   * side say nothing about which link each copies, and the difference is
   * invisible until someone opens what you sent them. `title` spells out the
   * whole action either way, so the accessible name never gets shorter.
   */
  word?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  if (!url) return null;

  async function onClick() {
    if (timer.current) clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(url!);
      setCopied('ok');
    } catch {
      // Clipboard blocked (insecure context, denied permission). There is no
      // recovery to offer, but a button that does NOTHING is indistinguishable
      // from one that worked — so the failure flashes in the same slot, for
      // the same time, and then the button reads SHARE again.
      setCopied('failed');
    }
    timer.current = setTimeout(() => setCopied(null), COPIED_FLASH_MS);
  }

  return (
    <button onClick={onClick} className={className} title={title} aria-label={title}>
      <ShareIcon />{' '}
      {/* `role="status"` so the flash is announced, not only painted. */}
      <span role="status">{copied === 'ok' ? 'COPIED' : copied === 'failed' ? 'COPY FAILED' : word}</span>
    </button>
  );
}
