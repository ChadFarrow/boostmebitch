'use client';

// Shared bits for the two places the Libre widget can appear: its persistent floating host
// (libre-wallet-host.tsx) and the wallet modal's borrowed slot. Both need the same answer to "the
// widget isn't on screen — is that fine, is it still loading, or did it fail?".
//
// The gate (`libreConfigured` / `libreAvailable`) and the mount options live in lib/v4v/libre.ts,
// beside the mount itself, so no surface can mount the widget around them.

import { getLibreMountError, isLibreLoading, isLibreMounted, retryLibreMount } from '@/lib/v4v/libre';

/** 'loading' | 'error' | null — null means the widget itself is on screen (or nothing is wanted). */
export function libreStatusKind(): 'loading' | 'error' | null {
  if (isLibreMounted()) return null;
  if (getLibreMountError()) return 'error';
  if (isLibreLoading()) return 'loading';
  return null;
}

/**
 * What to show while the widget element isn't there yet. Without this the user stares at an empty
 * box: the LDK bundle is ~17 MB (seconds, even on the happy path), and a failed load left no
 * element, no error and nothing to retry — a permanently blank card.
 */
export function LibreMountStatus({ slot }: { slot: React.RefObject<HTMLDivElement | null> }) {
  const kind = libreStatusKind();
  if (!kind) return null;

  if (kind === 'loading') {
    return (
      <div className="card p-4 text-center space-y-2">
        <div className="text-xs text-muted">Loading Libre Wallet…</div>
        <div className="text-[11px] text-muted/70">Downloading the wallet — this can take a moment.</div>
      </div>
    );
  }

  return (
    <div className="card p-4 space-y-3" data-libre-error>
      <div className="text-xs text-bone">Couldn&apos;t load Libre Wallet.</div>
      <div className="text-[11px] text-muted break-words">{getLibreMountError()}</div>
      <button
        className="btn-ghost w-full"
        onClick={() => { if (slot.current) void retryLibreMount(slot.current); }}
      >
        Try again
      </button>
    </div>
  );
}
