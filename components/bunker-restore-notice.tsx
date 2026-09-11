'use client';
import { useEffect, useState } from 'react';
import {
  subscribeBunkerApproval,
  subscribeBunkerRestore,
  type BunkerApprovalStage,
  type BunkerRestoreStage,
} from '@/lib/nostr';

// "We are reconnecting to your signer, and we do not know yet whether it is
// there."
//
// THE INTERVAL BEFORE A GUARD HAS DECIDED. `<BunkerHealthBanner>` renders off
// `bunkerStale`, which `restoreBunkerSigner` sets only once the connect attempt
// SETTLES, so the window before that showed nothing at all. The two ways it can
// fail are nothing like each other in length: no network rejects in
// milliseconds, while a relay that CONNECTS and then answers nothing costs the
// whole 90 s `BUNKER_CONNECT_TIMEOUT_MS`. For those 90 s the app looks signed
// in, `window.nostr` is not installed, and anything the user touches that signs
// fails with a generic error — CLAUDE.md's "a guard that withholds must say so",
// failed one step earlier than the rule is usually read.
//
// THE ANSWER IS A PROGRESS STATE, NOT A SMALLER NUMBER. docs/signers.md records
// why the timeout is that long: a queueing signer answers `permission denied`
// first, and the round trip includes an APNs wake of a closed app. Shortening it
// would break the case it was measured against.
//
// Renders nothing when idle, so a surface can mount it unconditionally.
export function BunkerRestoreNotice({ className = '' }: { className?: string }) {
  const [stage, setStage] = useState<BunkerRestoreStage>({ restoring: false, phase: null, startedAt: null });
  const [approval, setApproval] = useState<BunkerApprovalStage>({ waiting: false, label: null, attempt: 0 });
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => subscribeBunkerRestore(setStage), []);
  useEffect(() => subscribeBunkerApproval(setApproval), []);

  // Counted from the module's timestamp rather than from this component's own
  // mount, so the copy is right for a surface that appears PART WAY THROUGH a
  // restore — opening the account menu swaps which copy of this is on screen,
  // and a fresh clock there would restart the count at zero and re-arm the
  // quiet period below, hiding the wait at the exact moment the user went
  // looking for it.
  const startedAt = stage.startedAt;
  useEffect(() => {
    if (startedAt === null) { setElapsedMs(0); return; }
    const tick = () => setElapsedMs(Date.now() - startedAt);
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [startedAt]);

  if (!stage.restoring) return null;
  // THE APPROVAL NOTICE WINS. Both can be live at once — `withApprovalWait`
  // wraps the restore's own `connect`, so a queueing signer raises the approval
  // stage while this restore is still running — and that one says strictly more:
  // the signer has answered, it names the act the user must perform in another
  // app, and it carries "Stop waiting". Two boxes about one wait is how a reader
  // learns to distrust both.
  if (approval.waiting) return null;
  // HELD BACK FOR THE ORDINARY RESTORE. A healthy handshake is a couple of relay
  // round trips and settles well inside this, so raising a box on every cold
  // load would spend the user's attention on nothing and teach them to ignore
  // the one case it is for. Five seconds of silence is already outside ordinary,
  // and is still far below the first moment anyone reaches for something that
  // signs.
  if (elapsedMs < 5_000) return null;

  const secs = Math.floor(elapsedMs / 1000);
  // The two phases differ in what the user can still do, which is the whole
  // reason the phase is carried. During `probing` the session's adapter is
  // still installed and still signs — `pingBunkerAdapter` only asks it a
  // question. `connecting` begins after `closeStaleBunkerTransport`, so from
  // there a signature has nothing to reach.
  const probing = stage.phase === 'probing';

  return (
    <div role="status" className={`border border-nostr/40 bg-nostr/10 p-2 flex flex-col gap-1 ${className}`}>
      <span className="text-[11px] text-bone leading-snug">
        ◆ {probing ? 'Checking the link to your signer' : 'Reconnecting to your signer'}… ({secs}s)
      </span>
      <span className="text-[10px] text-muted leading-snug">
        {probing
          ? 'Your signer still works while this runs.'
          : 'Anything that needs your signature will fail until this finishes. A relay that answers slowly can hold it for up to 90 seconds.'}
      </span>
    </div>
  );
}
