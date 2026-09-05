'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { subscribeBunkerHealth, restoreBunkerSigner, isKeyEphemeral, shortNpub, type NostrIdentity } from '@/lib/nostr';
import { storage } from '@/lib/storage';
import { getErrorMessage } from '@/lib/util';
import { MutedAccountsSection } from './muted-accounts';
import { ExportKeySection } from './export-key';
import { ProfileEditor } from '../profile-editor';
import { ThemeMenuLink } from '../theme-toggle';
import { BunkerApprovalNotice } from '../bunker-approval-notice';

// Surfaced inside AccountMenu when the NIP-46 bunker subscription has
// gone stale (typically because iOS suspended the PWA's WebSocket while
// it was backgrounded). Lives here rather than inside SparkWallet /
// NwcWallet because the failure is signer-side, not wallet-side. The
// reconnect button calls restoreBunkerSigner which reuses the same
// persisted client_sk, so the bunker treats us as the same logical
// client and skips re-auth.
// Storage-restricted browsers (private mode, partitioned storage) leave the
// local key in memory only — the session works, a reload loses it. A soft
// hint, mirroring the storage.nwcUri.isEphemeral() line in nwc-wallet.tsx,
// rather than a banner demanding action: the Drive backup still exists, so the
// recovery is just signing in again.
function LocalKeyEphemeralBanner() {
  if (storage.signer.get() !== 'local' || !isKeyEphemeral()) return null;
  return (
    <div className="text-[11px] text-bolt/80 border border-bolt/40 bg-bolt/10 px-2 py-1.5 mb-3">
      Storage is restricted in this browser — you&apos;ll be signed out when you
      reload. Sign in with Google and your PIN to come back.
    </div>
  );
}

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

/**
 * The way back out of "open my private lists on load".
 *
 * It renders ONLY when the flag is set, and that is the point rather than an
 * optimisation. Granting it removes the two notices from the page, so the
 * control the user granted it from is gone; without this there is no surface
 * left that mentions the setting at all. Showing it unconditionally would be
 * worse in the other direction — a preference nobody has expressed, sitting in
 * the menu explaining a state that does not apply to them.
 *
 * Turning it off does not re-lock anything that is already on screen. The next
 * load simply stops asking the signer, and the notices come back, which is
 * exactly the state the user is asking to return to.
 */
function ListUnlockSection({ npub }: { npub: string }) {
  // Read once on mount rather than during render: this is localStorage, so a
  // render-time read differs between the server pass and the first client one
  // and React calls that a hydration mismatch.
  const [on, setOn] = useState(false);
  useEffect(() => { setOn(storage.listUnlock.get(npub)); }, [npub]);

  if (!on) return null;

  return (
    <div className="border-t border-bone/15 mt-4 pt-3">
      <p className="text-[10px] text-muted leading-snug">
        Your private favorites and mutes open automatically on this device.
      </p>
      <button
        type="button"
        onClick={() => { storage.listUnlock.set(npub, false); setOn(false); }}
        className="text-[11px] underline underline-offset-2 text-muted hover:text-nostr mt-1"
      >
        ask me again instead
      </button>
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
  const [editing, setEditing] = useState(false);
  const router = useRouter();
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
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={() => { setEditing(true); setOpen(false); }}
                className="btn-ghost text-[10px] py-1 px-2"
              >
                edit profile
              </button>
              {/* The one place "my boosts" belongs now that the lookup lives in
                  the podcast search box: that box takes an npub the user has to
                  have to hand, and nobody has their own npub to hand. This is
                  where the rest of their identity already is. */}
              <button
                onClick={() => { setOpen(false); router.push(`/npub/${identity.npub}`); }}
                className="btn-ghost text-[10px] py-1 px-2"
              >
                my boosts
              </button>
            </div>
          </div>

          {/* Beside the health banner, never instead of it: they say opposite
              things. Stale means the transport looks dead; this means it
              demonstrably is not — the signer answered, it just answered "not
              yet". The one that matters here is the "Stop waiting" control,
              which is otherwise only reachable from the boost modal. */}
          <BunkerApprovalNotice className="mb-3" />
          <BunkerHealthBanner />
          <LocalKeyEphemeralBanner />

          <MutedAccountsSection />

          <ExportKeySection />

          <ListUnlockSection npub={identity.npub} />


          {/* The theme control lives here now rather than in the page header,
              where a rarely-touched preference sat among primary actions as
              the one bare icon in a row of bordered chips. It does NOT close
              the menu: flipping the palette is something you want to see land,
              and closing the thing you are looking at to show you the result
              hides half of it. "sign out" closes because it has to. */}
          <div className="border-t border-bone/15 mt-4 pt-3 flex items-center justify-between gap-3">
            <button
              onClick={() => { onSignOut(); setOpen(false); }}
              className="text-[11px] text-muted hover:text-nostr"
            >
              sign out
            </button>
            <ThemeMenuLink />
          </div>
        </div>
      )}

      {/* Outside the `open &&` block: the editor portals to <body> and must
          survive the menu closing behind it. */}
      {editing && <ProfileEditor identity={identity} onClose={() => setEditing(false)} />}
    </div>
  );
}
