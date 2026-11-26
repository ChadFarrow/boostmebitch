import { CloudIcon, SavedIcon } from '../icons';

/**
 * Where the playing item's bytes come from: the file downloaded to this
 * device, or the network. Asked for from the installed Android app (#669):
 * "A little icon showing that you're playing a downloaded file or streaming
 * would be sweet."
 *
 * `null` is "not decided yet" — the local read is still in flight — and keeps
 * the slot without claiming either answer.
 */
export type PlaySourceKind = 'local' | 'network';

const LABEL: Record<PlaySourceKind, string> = {
  local: 'Playing the downloaded file on this device',
  network: 'Playing online, over the network',
};

// The visible word, fullscreen only. Not "STREAMING": the streaming-SATS meter
// (`<StreamMeter>`, "≋ Streaming 21 sats/min") sits in the same pane, and a
// listener who sees both must not read one as the other.
const WORD: Record<PlaySourceKind, string> = { local: 'Downloaded', network: 'Online' };

/**
 * A MARK, NOT A CONTROL: it has no press, so it has no border and no 24px
 * floor, and it must not look like `.btn-mini` (docs/ui.md, "What makes a
 * control look like a control"). `role="img"` + `aria-label` is its name;
 * `title` is for a mouse only, which is why the fullscreen variant also shows
 * the WORD — a phone has no hover, and the mini-bar has no room for one.
 *
 * It never adds a line: the mini-bar puts it on its secondary line, and the
 * fullscreen player in the clock row under the seek bar (docs/ui.md, "Where
 * the playing file comes from").
 */
export function PlaySource({ kind, variant }: { kind: PlaySourceKind | null; variant: 'mini' | 'full' }) {
  if (!kind) {
    // Keep the slot. In the mini-bar it holds the title in place while the
    // answer lands. In the fullscreen clock row it is the grid's middle CELL:
    // render nothing there and the duration moves into the middle column.
    return <span aria-hidden data-play-source-slot className={variant === 'mini' ? 'w-3 h-3 shrink-0' : ''} />;
  }
  const tone = kind === 'local' ? 'text-bone' : 'text-muted';
  if (variant === 'mini') {
    return (
      <span role="img" aria-label={LABEL[kind]} title={LABEL[kind]} data-play-source={kind} className={`shrink-0 inline-flex ${tone}`}>
        {kind === 'local' ? <SavedIcon /> : <CloudIcon />}
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={LABEL[kind]}
      title={LABEL[kind]}
      data-play-source={kind}
      className={`inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider whitespace-nowrap ${tone}`}
    >
      {kind === 'local' ? <SavedIcon /> : <CloudIcon />}
      {WORD[kind]}
    </span>
  );
}
