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
    <div className={`text-[11px] text-muted ${className ?? ''}`}>
      <span className="text-bolt">● LIVE</span>{' '}
      paying <span className="text-bone">{label}</span>
      {n > 1 ? ` · ${n} recipients` : ''}
    </div>
  );
}
