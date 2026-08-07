'use client';

import { useEffect, useState } from 'react';
import { liveTargetSnapshot, subscribeLiveTarget } from '@/lib/v4v/live-value';
import type { Episode } from '@/lib/types';

/**
 * Who a live show's payments are going to right now.
 *
 * A live boost that silently pays someone other than the artist on screen is
 * the failure this whole feature exists to prevent, and a modal is the last
 * place to catch it — so the target is named wherever money is about to move.
 *
 * Subscribes to the watcher itself rather than taking a prop, so nothing above
 * it re-renders on a track change (the same discipline <StreamPulse> follows).
 */
/**
 * The live target for an episode, or null.
 *
 * Subscribes to the watcher rather than the store, so a block change repaints
 * only the surfaces that show it. Cheap to call from an always-mounted
 * component: `setTarget` dedupes on identity, so Split Kit's ~5 s heartbeat
 * produces one notify per block, not twelve a minute.
 */
function useLiveTarget(episodeGuid?: string) {
  const [target, setTarget] = useState(liveTargetSnapshot);
  useEffect(() => subscribeLiveTarget(() => setTarget(liveTargetSnapshot())), []);
  if (!episodeGuid || target?.guid !== episodeGuid) return null;
  return target;
}

/**
 * Cover art the live block shipped, for the surfaces that show artwork.
 *
 * Returns null for everything that isn't a live block with an image, so every
 * caller can use it as the first entry in an existing `??` chain and change
 * nothing for ordinary playback.
 */
export function useLiveBlockImage(episodeGuid?: string): string | null {
  return useLiveTarget(episodeGuid)?.split?.image ?? null;
}

export function LiveNowPlaying({ episode, className }: { episode?: Episode; className?: string }) {
  const [target, setTarget] = useState(liveTargetSnapshot);
  useEffect(() => subscribeLiveTarget(() => setTarget(liveTargetSnapshot())), []);

  if (!episode?.guid || target?.guid !== episode.guid) return null;
  const split = target.split;
  if (!split?.value?.recipients?.length) return null;

  const label = split.title
    || split.value.recipients.find((r) => r.name)?.name
    || 'the current track';
  const n = split.value.recipients.length;
  return (
    <div className={`flex items-center gap-2 text-[11px] text-muted ${className ?? ''}`}>
      {/* The block's own cover. This is the surface where a wrong target costs
          the most — the user is about to press BOOST — and art is recognised
          faster than a title is read. <img> not next/image: the host is
          whatever the live block names, which is any domain at all. */}
      {split.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={split.image} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
      )}
      <span>
        <span className="text-bolt">● LIVE</span>{' '}
        paying <span className="text-bone">{label}</span>
        {n > 1 ? ` · ${n} recipients` : ''}
      </span>
    </div>
  );
}
