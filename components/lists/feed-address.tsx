'use client';

import type { Podcast } from '@/lib/types';
import { httpUrl } from '@/lib/util';
import { CopyLinkButton } from '../copy-link-button';

// A PLAYLIST's own RSS address, written out and copyable (Chad, 2026-11-18: "i
// need to show the rss link for the v4vmusic music playlist"). A listener takes
// it to another podcast app, and a playlist made on v4vmusic or kolomona has no
// other page on this site that names it.
//
// Written out, not only a COPY button: the address IS the information, and a
// phone has no hover to show a tooltip. Every playlist gets it, wherever it is
// hosted and whether or not Podcast Index holds it, because the address is a fact
// about the feed. Through `httpUrl`, because a `?playlist=` link supplies this
// string and React renders a `javascript:` href. The link is a flex item with
// `py-1`, so it is a 24px target on its own line.
export function FeedAddress({ podcast }: { podcast: Podcast }) {
  const href = httpUrl(podcast.url);
  if (!href) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 text-xs" data-feed-address>
      <span className="text-muted font-mono uppercase tracking-wider text-[10px] shrink-0">RSS</span>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="btn-inline py-1 min-w-0 break-all font-mono text-muted hover:text-bone"
      >
        {href}
      </a>
      <CopyLinkButton
        url={href}
        title="Copy this playlist's RSS feed address"
        word="COPY"
        className="btn-mini shrink-0"
      />
    </div>
  );
}
