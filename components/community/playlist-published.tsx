'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { CopyLinkButton } from '@/components/copy-link-button';
import { RowThumb } from '@/components/chapter-ui';
import { artCandidates } from '@/lib/util';
import { communityPlaylistToPodcast } from '@/lib/util';
import type { CommunityPlaylistSummary } from '@/lib/community/rules';

/** PI's add form. The site cannot add a feed itself: its key is read-only (docs/feeds.md, "Podcast Index"). */
export const PI_ADD_FORM = 'https://podcastindex.org/add';

/**
 * Is this feed in Podcast Index? `undefined` while asking; a PI feed id when it is
 * listed; `null` when it is not, or when no answer came (a 429, a 5xx, offline). The
 * add form is the safe offer for both: PI answers a feed it already holds with that
 * feed, and adds nothing.
 */
function usePiFeedId(feedUrl: string): number | null | undefined {
  const [id, setId] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setId(undefined);
    fetch(`/api/by-guid?url=${encodeURIComponent(feedUrl)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { podcast?: { id?: unknown } } | null) => {
        const n = j?.podcast?.id;
        // A positive id is PI's; the RSS fallbacks elsewhere mint negative ones.
        if (live) setId(typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null);
      })
      .catch(() => { if (live) setId(null); });
    return () => { live = false; };
  }, [feedUrl]);
  return id;
}

/**
 * Screen 5: the playlist is live. `summary` is what the owner listing says about
 * it (null when that read failed, which costs only the cover, PLAY and SHARE:
 * the feed address is known from the 201).
 */
export function PlaylistPublished({
  feedUrl,
  title,
  byName,
  tracks,
  summary,
  guestKept,
  onEdit,
}: {
  feedUrl: string;
  title: string;
  byName: string;
  tracks: number;
  summary: CommunityPlaylistSummary | null;
  /**
   * Published without an account: did this browser keep the key that lets it edit
   * the playlist later? `null` for an account's playlist.
   */
  guestKept: boolean | null;
  onEdit: () => void;
}) {
  const router = useRouter();
  const piFeedId = usePiFeedId(feedUrl);
  const selectPodcast = useApp((s) => s.selectPodcast);
  const setShowOrigin = useApp((s) => s.setShowOrigin);

  function play() {
    if (!summary) return;
    // The store-then-navigate handoff, all three halves (docs/ui.md).
    selectPodcast(communityPlaylistToPodcast(summary));
    setShowOrigin({ path: '/playlists', label: 'playlists' });
    router.push('/');
  }

  return (
    <section aria-labelledby="published-heading" data-testid="published">
      <div className="flex gap-4 items-start">
        {summary && (
          <div className="h-24 w-24 shrink-0 border border-bone/30">
            <RowThumb src={artCandidates(summary.coverUrl, null, 160)[0]} fallback={summary.coverUrl} className="h-full w-full object-cover" />
          </div>
        )}
        <div className="min-w-0">
          <h1 id="published-heading" className="font-display text-2xl break-words">{title}</h1>
          <p className="mt-1 text-sm text-muted">by {byName}</p>
          <p className="mt-2 stamp">♫ PLAYLIST · {tracks} TRACKS</p>
        </div>
      </div>

      {guestKept !== null && (
        <p className="mt-3 max-w-xl text-xs text-bone/80" data-testid="guest-kept" data-guest-kept={guestKept ? 'true' : 'false'}>
          {guestKept
            ? 'Made without an account. You can edit this playlist again in this browser. If you clear its site data you cannot, and you can make the playlist again.'
            : 'Made without an account, but this browser could not keep the key, so you cannot edit this playlist later. Copy the feed address now, and make the playlist again if you need to change it.'}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {summary && (
          <button type="button" className="btn-bolt btn-compact" onClick={play}>PLAY</button>
        )}
        <button type="button" className="btn-ghost btn-compact" onClick={onEdit}>EDIT</button>
        {summary && (
          <CopyLinkButton
            // The current origin, not BRAND.origin: a beta or preview link must open the beta.
            url={`${location.origin}/?podcast=${encodeURIComponent(summary.podcastGuid)}`}
            title="Copy the link to this playlist"
            className="btn-ghost btn-compact"
          />
        )}
      </div>

      <div className="mt-6">
        <label htmlFor="feed-address" className="block text-xs font-mono uppercase tracking-wider text-muted">
          Feed address
        </label>
        <div className="mt-1 flex gap-2">
          <input id="feed-address" readOnly value={feedUrl} className="input" onFocus={(e) => e.currentTarget.select()} />
          <CopyLinkButton url={feedUrl} word="COPY" title="Copy the feed address" className="btn-ghost btn-compact shrink-0" />
        </div>
        <p className="mt-2 max-w-xl text-xs leading-relaxed text-muted">
          Paste this address into any Podcasting 2.0 app to follow the playlist. It updates when you edit it.
        </p>
      </div>

      <div
        className="mt-6"
        data-testid="pi-listing"
        data-pi={piFeedId === undefined ? 'checking' : piFeedId ? 'listed' : 'not-listed'}
      >
        <h2 className="text-xs font-mono uppercase tracking-wider text-muted">Podcast Index</h2>
        {piFeedId === undefined ? (
          <p className="mt-1 text-xs text-muted">Checking Podcast Index…</p>
        ) : piFeedId ? (
          <>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">
              This playlist is in Podcast Index, so people can find it in Podcasting 2.0 apps.
            </p>
            <a
              href={`https://podcastindex.org/podcast/${piFeedId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost btn-compact mt-2 inline-flex"
            >
              OPEN IN PODCAST INDEX →
            </a>
          </>
        ) : (
          <>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">
              Not in Podcast Index yet. To let people find it in Podcasting 2.0 apps, open the
              Podcast Index form, paste the feed address above, and send it. Podcast Index cannot
              remove a feed: if you delete the playlist later, it stays listed there until Podcast
              Index marks it dead.
            </p>
            <a href={PI_ADD_FORM} target="_blank" rel="noopener noreferrer" className="btn-ghost btn-compact mt-2 inline-flex">
              ADD IT TO PODCAST INDEX →
            </a>
          </>
        )}
      </div>
    </section>
  );
}
