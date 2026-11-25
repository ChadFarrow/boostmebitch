'use client';

// "Your playlists", the FIRST section of /playlists (Chad, 2026-11-25: "start
// showing their playlist first, then community, then my playlist at the
// bottom"). The visitor's published playlists — made under the signed-in
// account, or under the guest key this browser keeps — and, under them, the
// drafts on this device (`<LocalDraftsList>`).
//
// Read straight from the store (`fetchCommunityPlaylists(owner)`), not filtered
// out of the Community section: that list is the newest 200, so an older
// playlist of the visitor's would be missing here. The rows stay in Community
// too, whose count line is a claim about that whole collection.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/store';
import { PodcastResults } from '@/components/lists';
import { useGuestKey } from '@/lib/community/use-guest-key';
import { fetchCommunityPlaylists } from '@/lib/community/client';
import type { CommunityPlaylistSummary } from '@/lib/community/rules';
import { communityIdFromFeedUrl } from '@/lib/curated-playlists';
import { communityPlaylistToPodcast } from '@/lib/util';
import type { Podcast } from '@/lib/types';
import { LocalDraftsList } from './local-drafts-list';

type Published =
  | { state: 'none' }        // nobody to ask for: signed out with no guest key
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ok'; rows: CommunityPlaylistSummary[] };

export function YourPlaylists({ onOpen }: { onOpen: (p: Podcast) => void }) {
  const identity = useApp((s) => s.identity);
  const pubkey = identity?.pubkey ?? null;
  // The guest key's public half, read only: this page never makes one.
  const guest = useGuestKey();
  const [published, setPublished] = useState<Published>({ state: 'loading' });
  const [drafts, setDrafts] = useState(0);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    // `undefined`: the key read is in flight, so who to ask is not known yet.
    if (guest === undefined) return;
    const owners = [...new Set([pubkey, guest?.pubkey].filter((k): k is string => !!k))];
    if (!owners.length) { setPublished({ state: 'none' }); return; }
    let live = true;
    setPublished({ state: 'loading' });
    void Promise.all(owners.map((o) => fetchCommunityPlaylists(o))).then((lists) => {
      if (!live) return;
      // One owner answering is enough to show its rows; NO answer is a failure,
      // never "you have none".
      if (lists.every((l) => l === null)) { setPublished({ state: 'failed' }); return; }
      const seen = new Set<string>();
      const rows: CommunityPlaylistSummary[] = [];
      for (const l of lists) for (const p of l ?? []) if (!seen.has(p.id)) { seen.add(p.id); rows.push(p); }
      rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setPublished({ state: 'ok', rows });
    });
    return () => { live = false; };
  }, [pubkey, guest, reload]);

  const onDraftRows = useCallback((n: number) => setDrafts(n), []);

  const rows = published.state === 'ok' ? published.rows : [];
  const feeds = rows.map(communityPlaylistToPodcast);
  const counts = new Map(rows.map((r) => [r.feedUrl, r.songCount]));
  // "Nothing yet" only once every read has answered: loading is not empty.
  const settled = published.state === 'ok' || published.state === 'none';
  const empty = settled && !rows.length && drafts === 0;

  return (
    <section className="mt-8" data-your-playlists>
      <h2 className="font-display text-lg">Your playlists</h2>
      <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">
        Playlists you published, and the ones you started on this device.
      </p>

      {published.state === 'loading' && (
        <div className="text-[11px] uppercase tracking-widest text-muted mt-4 mb-2 px-1">loading your playlists…</div>
      )}
      {published.state === 'failed' && (
        <p className="text-sm py-4 px-1 flex flex-wrap items-center gap-3">
          <span className="text-muted">couldn&apos;t load your published playlists</span>
          <button type="button" onClick={() => setReload((n) => n + 1)} className="btn-ghost btn-compact">↻ RETRY</button>
        </p>
      )}
      {feeds.length > 0 && (
        <div className="mt-4">
          <PodcastResults
            feeds={feeds}
            selected={null}
            onSelect={onOpen}
            // Rows from our own store: Podcast Index was not asked about them here.
            piUnasked
            action={(p) => {
              const id = communityIdFromFeedUrl(p.url);
              return id ? (
                <Link href={`/playlists/make?id=${id}`} className="btn-mini" data-edit-playlist aria-label={`Edit ${p.title}`}>
                  EDIT
                </Link>
              ) : null;
            }}
            meta={(p) => {
              const n = p.url ? counts.get(p.url) : undefined;
              return n === undefined ? null : `${n.toLocaleString()} tracks`;
            }}
          />
        </div>
      )}

      <LocalDraftsList onRows={onDraftRows} />

      {empty && (
        <p className="text-sm text-muted py-4 px-1 flex flex-wrap items-center gap-3">
          <span>No playlists yet. Save songs with + PLAYLIST while you listen, or</span>
          <Link href="/playlists/make" className="btn-mini">+ MAKE PLAYLIST</Link>
        </p>
      )}
    </section>
  );
}
