'use client';
import { useEffect, useMemo, useState } from 'react';
import { nip19 } from 'nostr-tools';
import { shortNpub, fetchProfile, type ProfileMetadata } from '@/lib/nostr';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { Avatar } from '../avatar';

// Muted accounts (NIP-51 kind:10000). Only renders when there's at least one
// muted pubkey so the menu stays compact for users who haven't used the
// feature. Profile names are best-effort from the kind:0 cache; an unresolved
// pubkey falls back to its short-npub.
export function MutedAccountsSection() {
  const mutedPubkeys = useApp((s) => s.mutedPubkeys);
  const unmutePubkey = useApp((s) => s.unmutePubkey);
  const pubkeys = useMemo(() => Array.from(mutedPubkeys), [mutedPubkeys]);
  const [profiles, setProfiles] = useState<Record<string, ProfileMetadata | null>>({});
  const [expanded, setExpanded] = useState(false);

  // Fill from cache synchronously, then resolve any uncached pubkeys in the
  // background. Only runs while the section is expanded — collapsed state
  // doesn't render names so there's no point fetching them. Names cache to
  // localStorage so re-expanding is instant.
  useEffect(() => {
    if (!expanded) return;
    if (pubkeys.length === 0) return;
    const next: Record<string, ProfileMetadata | null> = {};
    const unresolved: string[] = [];
    for (const pk of pubkeys) {
      const cached = storage.profile.get(pk);
      if (cached !== undefined) next[pk] = cached;
      else unresolved.push(pk);
    }
    setProfiles((prev) => ({ ...prev, ...next }));
    if (unresolved.length === 0) return;
    let cancelled = false;
    (async () => {
      const fetched = await Promise.all(
        unresolved.map((pk) =>
          fetchProfile(pk).then((p) => {
            if (p) storage.profile.set(pk, p);
            else storage.profile.setMiss(pk);
            return [pk, p] as const;
          }).catch(() => [pk, null] as const),
        ),
      );
      if (cancelled) return;
      setProfiles((prev) => {
        const merged = { ...prev };
        for (const [pk, p] of fetched) merged[pk] = p;
        return merged;
      });
    })();
    return () => { cancelled = true; };
  }, [pubkeys, expanded]);

  if (pubkeys.length === 0) return null;

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full text-[11px] uppercase tracking-widest text-bone/60 mb-2 flex items-center justify-between gap-2 hover:text-bone"
      >
        <span>Muted accounts ({pubkeys.length})</span>
        <span aria-hidden className="text-bone/60">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && (
      <ul className="space-y-1.5 max-h-48 overflow-y-auto">
        {pubkeys.map((pk) => {
          const profile = profiles[pk];
          const npub = (() => {
            try { return nip19.npubEncode(pk); } catch { return pk.slice(0, 12); }
          })();
          const name =
            profile?.display_name?.trim() ||
            profile?.name?.trim() ||
            shortNpub(npub, 6);
          return (
            <li key={pk} className="flex items-center gap-2 text-xs">
              <Avatar
                pubkey={pk}
                picture={profile?.picture}
                name={profile?.display_name || profile?.name}
                className="w-6 h-6 rounded-full border border-bone/20 flex-shrink-0 text-[10px]"
              />
              <span className="truncate flex-1" title={npub}>{name}</span>
              <button
                onClick={() => unmutePubkey(pk)}
                className="text-[10px] text-muted hover:text-nostr"
                title="Unmute this account"
              >
                unmute
              </button>
            </li>
          );
        })}
      </ul>
      )}
    </div>
  );
}
