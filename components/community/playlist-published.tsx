'use client';

import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { CopyLinkButton } from '@/components/copy-link-button';
import { useFlash } from '@/lib/use-flash';
import { siteLandingUrl } from '@/lib/nostr/boost-notes';
import { communityPlaylistToPodcast } from '@/lib/util';
import type { CommunityPlaylistSummary } from '@/lib/community/rules';

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
  onEdit,
}: {
  feedUrl: string;
  title: string;
  byName: string;
  tracks: number;
  summary: CommunityPlaylistSummary | null;
  onEdit: () => void;
}) {
  const router = useRouter();
  const selectPodcast = useApp((s) => s.selectPodcast);
  const setShowOrigin = useApp((s) => s.setShowOrigin);
  const [copied, flashCopied] = useFlash<boolean>(1800);

  function play() {
    if (!summary) return;
    // The store-then-navigate handoff, all three halves (docs/ui.md).
    selectPodcast(communityPlaylistToPodcast(summary));
    setShowOrigin({ path: '/playlists', label: 'playlists' });
    router.push('/');
  }

  async function copyFeed() {
    try {
      await navigator.clipboard.writeText(feedUrl);
      flashCopied(true);
    } catch { /* a blocked clipboard: the address is on screen to select */ }
  }

  return (
    <section aria-labelledby="published-heading" data-testid="published">
      <div className="flex gap-4 items-start">
        {summary && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={summary.coverUrl} alt="" width={96} height={96} className="h-24 w-24 shrink-0 object-cover border border-bone/30" />
        )}
        <div className="min-w-0">
          <h1 id="published-heading" className="font-display text-2xl break-words">{title}</h1>
          <p className="mt-1 text-sm text-muted">by {byName}</p>
          <p className="mt-2 stamp">♫ PLAYLIST · {tracks} TRACKS</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {summary && (
          <button type="button" className="btn-bolt btn-compact" onClick={play}>PLAY</button>
        )}
        <button type="button" className="btn-ghost btn-compact" onClick={onEdit}>EDIT</button>
        {summary && (
          <CopyLinkButton
            url={siteLandingUrl(summary.podcastGuid)}
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
          <button type="button" className="btn-ghost btn-compact shrink-0" onClick={copyFeed}>
            {copied ? 'COPIED' : 'COPY'}
          </button>
        </div>
        <p className="mt-2 max-w-xl text-xs leading-relaxed text-muted">
          Paste this address into any Podcasting 2.0 app to follow the playlist. It updates when you edit it.
        </p>
      </div>
    </section>
  );
}
