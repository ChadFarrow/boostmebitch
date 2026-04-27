'use client';
import { useEffect, useState } from 'react';
import { loginWithExtension, shortNpub } from '@/lib/nostr';
import { useApp } from '@/lib/store';

export function NostrAuth() {
  const { identity, setIdentity } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // Auto-sign-in if extension is already present and previously approved
    const stored = localStorage.getItem('pv4v:npub');
    if (stored && !identity && typeof window !== 'undefined' && window.nostr) {
      loginWithExtension().then(setIdentity).catch(() => {});
    }
  }, [identity, setIdentity]);

  async function signin() {
    setBusy(true); setErr(null);
    try {
      const id = await loginWithExtension();
      setIdentity(id);
      localStorage.setItem('pv4v:npub', id.npub);
    } catch (e: any) {
      setErr(e?.message ?? 'sign-in failed');
    } finally { setBusy(false); }
  }

  function signout() {
    setIdentity(null);
    localStorage.removeItem('pv4v:npub');
  }

  if (identity) {
    return (
      <button onClick={signout} className="btn-ghost group" title="Sign out">
        <span className="text-nostr">◆</span>
        <span className="hidden sm:inline">{shortNpub(identity.npub, 6)}</span>
        <span className="opacity-40 group-hover:opacity-100 transition">↗</span>
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button onClick={signin} disabled={busy} className="btn-ghost">
        <span className="text-nostr">◆</span>
        {busy ? 'Connecting…' : 'Sign in with Nostr'}
      </button>
      {err && <span className="text-[10px] text-nostr/80 max-w-[260px] text-right">{err}</span>}
    </div>
  );
}
