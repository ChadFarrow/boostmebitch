'use client';

// Shared bits for the two places the Libre widget can appear: its persistent floating host
// (libre-wallet-host.tsx) and the wallet modal's borrowed slot (wallet-modal.tsx). Both need the
// same mount options and the same answer to "the widget isn't on screen — is that fine, is it
// still loading, or did it fail?".

import { getLibreMountError, isLibreLoading, isLibreMounted, retryLibreMount } from '@/lib/v4v/libre';

const CLIENT_ID = process.env.NEXT_PUBLIC_LIBRE_GOOGLE_CLIENT_ID;

/** The Libre rail exists only where its OAuth client id is baked in — the widget can't mount
 *  without one, so with no id there is no picker row, no host, and no widget chunk. This is the
 *  kill switch that keeps the experiment off production: NEXT_PUBLIC_* is inlined at build time,
 *  so a build without the var simply cannot turn Libre on. */
export function libreConfigured(): boolean {
  return !!CLIENT_ID;
}

export const LIBRE_MOUNT_OPTS = {
  googleClientId: CLIENT_ID ?? '',
  wasmUrl: '/liblightningjs.wasm',
  appName: 'boostmebitch',
  network: 'mainnet' as const,
};

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
    <div className="card p-4 space-y-3">
      <div className="text-xs text-bone">Couldn&apos;t load Libre Wallet.</div>
      <div className="text-[11px] text-muted break-words">{getLibreMountError()}</div>
      <button
        className="btn-ghost w-full"
        onClick={() => { if (slot.current) void retryLibreMount(slot.current, LIBRE_MOUNT_OPTS); }}
      >
        Try again
      </button>
    </div>
  );
}
