/**
 * The mark beside one payment leg: ✓ sent, ? the wallet never answered, ✗
 * failed. One component because three surfaces drew it — the boost modal's
 * split preview, the boost-all modal and the stored `<BoostCard>` — and had
 * drifted into three failure colours (one of them, `red-400`, not in the
 * palette), with the card the only one a screen reader could not hear.
 *
 * **Three states, never two, and the order of the test is the point.** A leg
 * whose wallet never answered may still have paid: a ✗ there is what talks
 * someone into boosting again and paying twice (CLAUDE.md, boost invariant
 * 11). `ok` is checked first and `indeterminate` second, so an unanswered leg
 * can never fall through to ✗.
 *
 * Each glyph carries an sr-only word, because colour plus a symbol is not a
 * status a reader can hear, and the `?`'s explanation cannot live in `title`
 * alone — that is unreachable on touch and unreliably announced.
 */
export function LegStatusGlyph({
  ok,
  indeterminate,
  className = '',
}: {
  ok: boolean;
  indeterminate?: boolean;
  className?: string;
}) {
  if (ok) {
    return <span className={`text-bolt ${className}`}>✓<span className="sr-only"> sent</span></span>;
  }
  if (indeterminate) {
    return (
      <span className={`text-muted ${className}`} title="Wallet did not answer — this may still have been sent">
        ?<span className="sr-only"> wallet did not answer — this may still have been sent</span>
      </span>
    );
  }
  return <span className={`text-nostr ${className}`}>✗<span className="sr-only"> failed</span></span>;
}
