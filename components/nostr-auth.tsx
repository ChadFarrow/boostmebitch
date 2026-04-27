'use client';
import { useEffect, useState } from 'react';
import { loginWithExtension, shortNpub, fetchProfile, type NostrIdentity } from '@/lib/nostr';
import { useApp } from '@/lib/store';

export function NostrAuth() {
  const { identity, setIdentity } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function loadProfile(id: NostrIdentity) {
    try {
      const profile = await fetchProfile(id.pubkey);
      if (profile) setIdentity({ ...id, profile });
    } catch { /* ignore — keep bare identity */ }
  }

  useEffect(() => {
    // Auto-sign-in if extension is already present and previously approved
    const stored = localStorage.getItem('bmb:npub');
    if (stored && !identity && typeof window !== 'undefined' && window.nostr) {
      loginWithExtension()
        .then((id) => { setIdentity(id); loadProfile(id); })
        .catch(() => {});
    }
  }, [identity, setIdentity]);

  async function signin() {
    setBusy(true); setErr(null);
    try {
      const id = await loginWithExtension();
      setIdentity(id);
      localStorage.setItem('bmb:npub', id.npub);
      loadProfile(id);
    } catch (e: any) {
      setErr(e?.message ?? 'sign-in failed');
    } finally { setBusy(false); }
  }

  function signout() {
    setIdentity(null);
    localStorage.removeItem('bmb:npub');
  }

  if (identity) {
    const name = identity.profile?.display_name || identity.profile?.name;
    const pic = identity.profile?.picture;
    return (
      <button onClick={signout} className="btn-ghost group flex items-center gap-2" title="Sign out">
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
        <span className="hidden sm:inline truncate max-w-[160px]">
          {name || shortNpub(identity.npub, 6)}
        </span>
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
