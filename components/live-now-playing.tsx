'use client';

import { useEffect, useState } from 'react';
import { liveTargetSnapshot, subscribeLiveTarget } from '@/lib/v4v/live-value';
import type { Episode, ValueBlock } from '@/lib/types';

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

/**
 * The name to print for a redirected payment target.
 *
 * The block's own title first; failing that the first named recipient, because
 * an artist's own value block routinely names them where the split doesn't.
 * Never the address — a row that reads "paying artist@fountain.fm" tells the
 * user where the sats go but not who gets them, which is the question this line
 * exists to answer.
 */
export function splitTargetLabel(split: { title?: string; value?: ValueBlock | null }): string {
  return split.title
    || split.value?.recipients?.find((r) => r.name)?.name
    || 'the current track';
}

/**
 * One "payment is going HERE, not to the show" row.
 *
 * Shared by the live path and the valueTimeSplit path because they are making
 * the same promise on the same screen and must not phrase it two ways. The
 * badge is what differs: a live show's target moves under the user, a
 * valueTimeSplit's is fixed by the feed, and those are different things to know
 * while deciding whether to press the button.
 */
export function NowPayingRow({
  badge,
  image,
  label,
  detail,
  className,
}: {
  badge: string;
  image?: string;
  label: string;
  detail?: string;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-2 text-[11px] text-muted ${className ?? ''}`}>
      {/* The block's own cover. This is the surface where a wrong target costs
          the most — the user is about to press BOOST — and art is recognised
          faster than a title is read. <img> not next/image: the host is
          whatever the block names, which is any domain at all. */}
      {image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
      )}
      <span>
        <span className="text-bolt">{badge}</span>{' '}
        paying <span className="text-bone">{label}</span>
        {detail ? ` · ${detail}` : ''}
      </span>
    </div>
  );
}

export function LiveNowPlaying({ episode, className }: { episode?: Episode; className?: string }) {
  const [target, setTarget] = useState(liveTargetSnapshot);
  useEffect(() => subscribeLiveTarget(() => setTarget(liveTargetSnapshot())), []);

  if (!episode?.guid || target?.guid !== episode.guid) return null;
  const split = target.split;
  if (!split?.value?.recipients?.length) return null;

  const n = split.value.recipients.length;
  return (
    <NowPayingRow
      badge="● LIVE"
      image={split.image}
      label={splitTargetLabel(split)}
      detail={n > 1 ? `${n} recipients` : undefined}
      className={className}
    />
  );
}
