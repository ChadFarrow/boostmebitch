'use client';

import { useCallback, useEffect, useState } from 'react';
import { nip19 } from 'nostr-tools';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { ModalShell } from '@/components/modal-shell';
import { RowThumb } from '@/components/chapter-ui';
import { artCandidates } from '@/lib/util';
import { timeAgo } from '@/lib/format';
import { fetchProfilesFor } from '@/lib/nostr';
import { shortNpub } from '@/lib/nostr/profile-metadata';
import { COMMUNITY_PLAYLISTS_ON } from '@/lib/curated-playlists';
import { NoSignerError, SignTimeoutError, signedFetch } from '@/lib/community/client';
import type { CommunityPlaylistSummary } from '@/lib/community/rules';

const ADMIN_PATH = '/api/community-playlists/admin';

interface Ban { pubkey: string; bannedAt: string; bannedBy: string }
type Load =
  | { s: 'loading' }
  | { s: 'forbidden' }
  | { s: 'error' }
  | { s: 'ok'; playlists: CommunityPlaylistSummary[]; bans: Ban[] };
type Confirm =
  | { kind: 'delete'; playlist: CommunityPlaylistSummary }
  | { kind: 'ban'; pubkey: string; who: string };

const npubOf = (pubkey: string) => { try { return nip19.npubEncode(pubkey); } catch { return pubkey; } };

/**
 * /admin: delete a playlist, ban a maker, unban. No text input anywhere: every
 * target is a button on a row the server listed, so there is no pasted key that
 * could be an `nsec1…` (docs/security.md).
 */
export function AdminPlaylists() {
  const identity = useApp((s) => s.identity);
  const setSignInOpen = useApp((s) => s.setSignInOpen);
  const [mounted, setMounted] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const [load, setLoad] = useState<Load>({ s: 'loading' });
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
    const timer = setTimeout(() => setGaveUp(true), 8000);
    return () => clearTimeout(timer);
  }, []);
  const restoring = mounted && !identity && !gaveUp && !!storage.npub.get();
  const pubkey = identity?.pubkey ?? null;

  const read = useCallback(async (): Promise<Load> => {
    try {
      const r = await signedFetch(ADMIN_PATH, 'GET');
      if (r.status === 403) return { s: 'forbidden' };
      if (!r.ok) return { s: 'error' };
      const j = (await r.json()) as { playlists?: CommunityPlaylistSummary[]; bans?: Ban[] };
      if (!Array.isArray(j.playlists) || !Array.isArray(j.bans)) return { s: 'error' };
      return { s: 'ok', playlists: j.playlists, bans: j.bans };
    } catch {
      return { s: 'error' };
    }
  }, []);

  useEffect(() => {
    if (!pubkey) return;
    let live = true;
    setLoad({ s: 'loading' }); setNote(null);
    void read().then((l) => { if (live) setLoad(l); });
    return () => { live = false; };
  }, [pubkey, read]);

  // One batched kind:0 read for every maker on the page (never one subscription per row).
  const okLoad = load.s === 'ok' ? load : null;
  const pubkeysKey = okLoad
    ? [...new Set([...okLoad.playlists.map((p) => p.ownerPubkey), ...okLoad.bans.map((b) => b.pubkey)])].sort().join(',')
    : '';
  useEffect(() => {
    if (!pubkeysKey) return;
    let live = true;
    void fetchProfilesFor(pubkeysKey.split(',')).then((m) => {
      if (!live) return;
      const out = new Map<string, string>();
      for (const [pk, p] of m) {
        const n = p.display_name?.trim() || p.name?.trim();
        if (n) out.set(pk, n);
      }
      setNames(out);
    }).catch(() => {});
    return () => { live = false; };
  }, [pubkeysKey]);

  async function act(body: Record<string, unknown>, done: (j: { deleted?: number }) => string) {
    setBusy(true); setNote(null);
    try {
      const r = await signedFetch(ADMIN_PATH, 'POST', body);
      if (!r.ok) { setNote('That did not work. Nothing was changed.'); return; }
      const j = (await r.json().catch(() => ({}))) as { deleted?: number };
      const fresh = await read();
      if (fresh.s === 'ok') setLoad(fresh);
      setNote(fresh.s === 'ok' ? done(j) : `${done(j)} The list could not be reloaded.`);
    } catch (e) {
      setNote(e instanceof SignTimeoutError ? 'The signer did not answer. Nothing was changed.'
        : e instanceof NoSignerError ? 'No signer is connected.' : 'That did not work. Nothing was changed.');
    } finally {
      setBusy(false); setConfirm(null);
    }
  }

  if (!COMMUNITY_PLAYLISTS_ON) return null;
  const head = <h1 className="headline text-3xl sm:text-4xl">admin</h1>;

  if (!identity && (restoring || !mounted)) {
    return <section>{head}<p className="mt-3 text-sm text-muted" role="status">Signing in…</p></section>;
  }
  if (!identity) {
    return (
      <section>
        {head}
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-bone/80">Sign in to moderate playlists.</p>
        <button type="button" className="btn-bolt btn-compact mt-4" onClick={() => setSignInOpen(true)}>SIGN IN</button>
      </section>
    );
  }
  if (load.s === 'loading') {
    return <section>{head}<p className="mt-3 text-sm text-muted" role="status">Loading…</p></section>;
  }
  if (load.s === 'forbidden') {
    return <section>{head}<p className="mt-3 text-sm text-bone/80" role="status">This account is not an admin.</p></section>;
  }
  if (load.s === 'error') {
    return (
      <section>
        {head}
        <p className="mt-3 text-sm text-bone/80" role="alert">Could not load the admin list.</p>
        <button type="button" className="btn-ghost btn-compact mt-4"
          onClick={() => { setLoad({ s: 'loading' }); void read().then(setLoad); }}>TRY AGAIN</button>
      </section>
    );
  }

  const { playlists, bans } = load;
  const makerName = (pk: string) => names.get(pk) ?? shortNpub(npubOf(pk));
  const sorted = [...playlists].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <section>
      {head}
      {note && <p className="mt-3 text-sm text-bone/80" role="status" data-testid="admin-note">{note}</p>}

      <h2 className="mt-6 font-display text-xl">Playlists</h2>
      {sorted.length === 0 ? (
        <p className="mt-2 text-sm text-muted">There are no playlists yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-bone/15 border-y border-bone/15" data-testid="admin-playlists">
          {sorted.map((p) => (
            <li key={p.id} className="flex flex-col gap-3 py-3" data-admin-playlist={p.id}>
              <div className="flex gap-3 items-start">
                <div className="h-16 w-16 shrink-0 border border-bone/30">
                  <RowThumb src={artCandidates(p.coverUrl, null, 160)[0]} fallback={p.coverUrl} className="h-full w-full object-cover" />
                </div>
                <div className="min-w-0">
                  <p className="font-display text-lg break-words">{p.title}</p>
                  {p.description && <p className="text-sm text-bone/70 break-words line-clamp-2">{p.description}</p>}
                  <p className="mt-1 text-xs font-mono text-muted break-all">
                    {shortNpub(p.ownerNpub)}{names.get(p.ownerPubkey) ? ` · ${names.get(p.ownerPubkey)}` : ''}
                  </p>
                  <p className="text-xs font-mono text-muted">
                    {p.songCount} songs · {timeAgo(Math.floor(Date.parse(p.createdAt) / 1000))}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-ghost btn-compact" disabled={busy}
                  onClick={() => setConfirm({ kind: 'delete', playlist: p })}>DELETE</button>
                <button type="button" className="btn-ghost btn-compact" disabled={busy}
                  onClick={() => setConfirm({ kind: 'ban', pubkey: p.ownerPubkey, who: makerName(p.ownerPubkey) })}>BAN MAKER</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-8 font-display text-xl">Banned</h2>
      {bans.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No one is banned.</p>
      ) : (
        <ul className="mt-3 divide-y divide-bone/15 border-y border-bone/15" data-testid="admin-bans">
          {bans.map((b) => (
            <li key={b.pubkey} className="flex flex-wrap items-center justify-between gap-2 py-3" data-admin-ban={b.pubkey}>
              <div className="min-w-0">
                <p className="text-sm break-all">{makerName(b.pubkey)}</p>
                <p className="text-xs font-mono text-muted">{shortNpub(npubOf(b.pubkey))} · banned {timeAgo(Math.floor(Date.parse(b.bannedAt) / 1000))}</p>
              </div>
              <button type="button" className="btn-ghost btn-compact" disabled={busy}
                onClick={() => void act({ action: 'unban', pubkey: b.pubkey }, () => 'Unbanned.')}>UNBAN</button>
            </li>
          ))}
        </ul>
      )}

      {confirm?.kind === 'delete' && (
        <ModalShell onClose={() => setConfirm(null)} label="Delete this playlist" className="w-full max-w-sm" closeButton>
          <div className="p-5">
            <h2 className="font-display text-xl">Delete this playlist?</h2>
            <p className="mt-2 text-sm text-bone/80 break-words">{confirm.playlist.title}. Its feed address stops working. This cannot be undone.</p>
            <div className="mt-4 flex gap-2">
              <button type="button" className="btn-ghost btn-compact" onClick={() => setConfirm(null)}>CANCEL</button>
              <button type="button" className="btn-bolt btn-compact" disabled={busy}
                onClick={() => void act({ action: 'delete', id: confirm.playlist.id }, (j) => (j.deleted ? 'Playlist deleted.' : 'That playlist was already gone.'))}>DELETE</button>
            </div>
          </div>
        </ModalShell>
      )}
      {confirm?.kind === 'ban' && (
        <ModalShell onClose={() => setConfirm(null)} label="Ban this maker" className="w-full max-w-sm" closeButton>
          <div className="p-5">
            <h2 className="font-display text-xl">Ban {confirm.who}?</h2>
            <p className="mt-2 text-sm text-bone/80">Also delete this person&apos;s other playlists?</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className="btn-bolt btn-compact" disabled={busy}
                onClick={() => void act({ action: 'ban', pubkey: confirm.pubkey, deleteAll: true },
                  (j) => `Banned. ${j.deleted ?? 0} ${j.deleted === 1 ? 'playlist' : 'playlists'} deleted.`)}>BAN AND DELETE ALL</button>
              <button type="button" className="btn-ghost btn-compact" disabled={busy}
                onClick={() => void act({ action: 'ban', pubkey: confirm.pubkey }, () => 'Banned.')}>BAN ONLY</button>
              <button type="button" className="btn-ghost btn-compact" onClick={() => setConfirm(null)}>CANCEL</button>
            </div>
          </div>
        </ModalShell>
      )}
    </section>
  );
}
