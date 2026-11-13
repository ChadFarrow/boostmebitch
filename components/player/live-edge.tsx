import { LiveBadge } from '../live-badge';

/**
 * The row under a playing live item: `● LIVE streaming now`, or — once the
 * player is `LIVE_BEHIND_MIN_SEC` or more behind a fresh connect —
 * `● LIVE 12 s behind ⏭ GO LIVE` (docs/ui.md, "Catch up to live").
 *
 * It was fixed text, and a listener who could not tell whether they were
 * caught up refreshed the page to find out (Homegrown Hits 158, 2026-11-12).
 * The refresh replayed the stream's connect burst — audio they had just heard.
 *
 * One component for the mini-bar and both live rows of `<FullscreenPlayer>`,
 * so the three cannot disagree about the threshold, the words or the button.
 * `behindSec` is already `behindToShow`'s answer: 0 means say nothing.
 *
 * The button stops propagation because the mini-bar is a pointer hit area
 * that opens the fullscreen player; a GO LIVE that also opened it would be two
 * actions for one press. In the mini-bar it is `min-h-6` with no vertical
 * padding — 24 px, WCAG 2.5.8's floor — and `-my-0.5` gives 4 px of that back
 * to the row, so the row stays the ~21 px of the `● LIVE` stamp and the bar does
 * not grow when the button appears (it did, 84 → 87 px; `e2e:livecatchup`
 * measures it). The title button above uses the same trick. In the fullscreen
 * row the button is `.btn-mini`'s ~26 px, and the row grows ~5 px inside the
 * live pane's slack.
 *
 * **In the mini-bar the `N s behind` is `hidden sm:inline`.** At 390 px the
 * whole row is ~235 px in a ~215 px column, and the play/pause button covered
 * the end of GO LIVE. Below `sm:` `<Player>` says the number on the line above
 * instead (`miniSecondary`), the way it folds the buffering line — hidden
 * here, never dropped.
 */
export function LiveEdge({
  behindSec,
  onGoLive,
  variant,
  className = '',
}: {
  behindSec: number;
  onGoLive: () => void;
  variant: 'mini' | 'full';
  className?: string;
}) {
  const text = variant === 'mini' ? 'text-[10px]' : 'text-xs';
  return (
    <div data-live-edge={variant} className={`flex items-center gap-2 ${className}`}>
      <LiveBadge status="live" />
      {behindSec > 0 ? (
        <>
          <span className={`${text} text-muted tabular-nums whitespace-nowrap ${variant === 'mini' ? 'hidden sm:inline' : ''}`}>
            {behindSec} s behind
          </span>
          <button
            type="button"
            data-go-live
            className={`btn-mini shrink-0 whitespace-nowrap text-bone ${variant === 'mini' ? 'min-h-6 py-0 -my-0.5' : ''}`}
            title="Reconnect at the live edge"
            aria-label={`Go live — ${behindSec} seconds behind`}
            onClick={(e) => {
              e.stopPropagation();
              onGoLive();
            }}
          >
            ⏭ GO LIVE
          </button>
        </>
      ) : (
        <span className={`${text} text-muted`}>streaming now</span>
      )}
    </div>
  );
}
