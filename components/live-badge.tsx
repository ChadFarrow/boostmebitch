import type { Episode } from '@/lib/types';

/**
 * The `● LIVE` / `PENDING` stamp for a `<podcast:liveItem>`.
 *
 * Lifted out of `<EpisodeList>` when `/live` started rendering live items too.
 * It is twelve lines and copying them would have been easy, which is exactly
 * the drift this repo catalogues under "one place per thing": two badges mean
 * two answers to "what does a broadcast that has not started look like", on two
 * surfaces nobody compares side by side.
 *
 * `ended` renders NOTHING rather than a grey stamp. An ended broadcast is an
 * ordinary episode by then — on the show page it keeps its row and loses only
 * the badge, and on `/live` it should not have been in the list at all.
 */
export function LiveBadge({ status }: { status: NonNullable<Episode['liveStatus']> }) {
  if (status === 'live') {
    return (
      <span className="stamp shrink-0 whitespace-nowrap text-nostr border-nostr/60 bg-nostr/10 animate-bolt">
        ● LIVE
      </span>
    );
  }
  if (status === 'pending') {
    return <span className="stamp shrink-0 whitespace-nowrap text-bolt border-bolt/60">PENDING</span>;
  }
  return null;
}
