'use client';
import { useEffect, useRef, useState } from 'react';
import { subscribeBunkerHealth, restoreBunkerSigner, shortNpub, type NostrIdentity } from '@/lib/nostr';
import { getErrorMessage } from '@/lib/util';
import { MutedAccountsSection } from './muted-accounts';

// Surfaced inside AccountMenu when the NIP-46 bunker subscription has
// gone stale (typically because iOS suspended the PWA's WebSocket while
// it was backgrounded). Lives here rather than inside SparkWallet /
// NwcWallet because the failure is signer-side, not wallet-side. The
// reconnect button calls restoreBunkerSigner which reuses the same
// persisted client_sk, so the bunker treats us as the same logical
// client and skips re-auth.
function BunkerHealthBanner() {
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => subscribeBunkerHealth(setStale), []);

  if (!stale) return null;

  async function reconnect() {
    setBusy(true); setErr(null);
    try {
      const ok = await restoreBunkerSigner();
      if (!ok) setErr('Reconnect failed. Try signing out and back in.');
    } catch (e) {
      setErr(getErrorMessage(e, 'reconnect failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-nostr/40 bg-nostr/10 p-2 mb-3 flex flex-col gap-1">
      <span className="text-[11px] text-bone">
        Signer disconnected — your iPhone may have suspended the relay link.
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={reconnect}
          disabled={busy}
          className="btn-ghost text-[10px] py-1 px-2 disabled:opacity-30"
        >
          {busy ? 'Reconnecting…' : 'Reconnect'}
        </button>
        {err && <span className="text-[10px] text-nostr/80">{err}</span>}
      </div>
    </div>
  );
}

export function AccountMenu({
  identity,
  onSignOut,
}: {
  identity: NostrIdentity;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Dismiss on click-outside / Escape so the menu doesn't trap focus.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const name = identity.profile?.display_name || identity.profile?.name;
  const pic = identity.profile?.picture;

  return (
    <div ref={wrapperRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="btn-ghost group flex items-center gap-2"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {pic ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={pic}
            alt=""
            className="w-5 h-5 rounded-full object-cover border border-nostr/40 flex-shrink-0"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
        ) : (
          <span className="text-nostr">◆</span>
        )}
        <span className="hidden sm:inline truncate max-w-[160px] lg:max-w-[280px]">
          {name || shortNpub(identity.npub, 6)}
        </span>
        <span className="opacity-40 group-hover:opacity-100 transition text-[10px]">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-2 w-[min(360px,calc(100vw-2rem))] card bg-ink p-4 z-30 shadow-xl"
        >
          <div className="border-b border-bone/15 pb-3 mb-3">
            <div className="text-sm">{name || 'Anon'}</div>
            <div className="text-[10px] text-muted truncate">{shortNpub(identity.npub, 8)}</div>
          </div>

          <BunkerHealthBanner />

          <MutedAccountsSection />

          <div className="border-t border-bone/15 mt-4 pt-3">
            <button
              onClick={() => { onSignOut(); setOpen(false); }}
              className="text-[11px] text-muted hover:text-nostr"
            >
              sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
