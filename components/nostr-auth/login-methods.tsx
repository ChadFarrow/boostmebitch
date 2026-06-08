'use client';
import { useEffect, useState } from 'react';
import { subscribeAmberStage } from '@/lib/nostr/amber';

function AmberManualPaste({ onSubmit }: { onSubmit: (value: string) => boolean }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-[10px] text-muted hover:text-nostr underline mt-1"
      >
        Amber didn&apos;t come back? Paste manually
      </button>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1 mt-1 max-w-[280px]">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Paste pubkey / npub from Amber"
        className="input text-[11px] w-full"
        rows={2}
      />
      <div className="flex items-center gap-2">
        <button
          onClick={() => setOpen(false)}
          className="text-[10px] text-muted hover:text-bone"
        >
          cancel
        </button>
        <button
          onClick={() => {
            const ok = onSubmit(value);
            if (!ok) setHint('Could not match a pending request.');
            else { setValue(''); setHint(null); }
          }}
          className="btn-ghost text-[10px] py-1 px-2"
        >
          submit
        </button>
      </div>
      {hint && <span className="text-[10px] text-nostr/80">{hint}</span>}
    </div>
  );
}

// While an Amber request is in flight, surface a "Read from clipboard"
// button: tapping it grants the user activation that navigator.clipboard
// .readText needs to succeed. The existing manual-paste form is the
// secondary fallback if the clipboard read is denied or the value doesn't
// match the expected shape.
//
// `returned` is driven by `subscribeAmberStage` — invokeAmber promotes the
// stage to 'returned' on the SAME signals that drive its auto-clipboard
// path (visibilitychange / pageshow / focus / pointerdown / touchstart /
// keydown), so the hint copy and the underlying flow agree. A late mount
// (e.g. after Fast Refresh) gets the current stage on subscribe.
export function AmberCompletion({ onSubmit }: { onSubmit: (value: string) => boolean }) {
  const [returned, setReturned] = useState(false);
  const [readErr, setReadErr] = useState<string | null>(null);

  useEffect(
    () => subscribeAmberStage((stage) => setReturned(stage === 'returned')),
    [],
  );

  async function readClipboard() {
    setReadErr(null);
    try {
      const text = await navigator.clipboard.readText();
      const ok = onSubmit(text);
      if (!ok) {
        setReadErr("Clipboard didn’t look like an Amber result. Paste manually below.");
      }
    } catch {
      setReadErr(
        'Clipboard read denied. Long-press → paste, or use "Paste manually" below.',
      );
    }
  }

  // Recovery UI for Amber. Most of the time `invokeAmber` resolves silently
  // on the first user gesture after return (its capture-phase pointerdown /
  // touchstart / keydown listener reads the clipboard with fresh user
  // activation). What renders here is the safety net for when that read
  // fails — clipboard permission denied, ciphertext that doesn't match the
  // expected shape, or Amber writing into a different browser than the one
  // running the PWA.
  return (
    <div className="flex flex-col items-end gap-1 mt-1 max-w-[280px]">
      <span className="text-[10px] text-muted text-right">
        {returned
          ? "If sign-in didn't complete, tap below."
          : 'Approve in Amber, then come back — sign-in will finish on your next tap.'}
      </span>
      <button onClick={readClipboard} className="btn-ghost text-[10px] py-1 px-2">
        ◆ Read clipboard manually
      </button>
      {readErr && <span className="text-[10px] text-nostr/80 text-right">{readErr}</span>}
      <AmberManualPaste onSubmit={onSubmit} />
    </div>
  );
}
