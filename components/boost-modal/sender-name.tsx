'use client';

import { useId } from 'react';
import { DEFAULT_SENDER_NAME } from '@/lib/util';

// Re-exported so every existing import site keeps working. The constant itself
// lives in lib/util.ts because lib/v4v/streaming.ts needs it and must not
// import from components/ — see the note there.
export { DEFAULT_SENDER_NAME };

export function SenderName({
  value,
  onChange,
  anonymous = false,
}: {
  value: string;
  onChange: (v: string) => void;
  /**
   * The share picker is on "Anonymous". The typed name is replaced by
   * DEFAULT_SENDER_NAME on the wire, so the field has to SHOW that — a
   * filled-in "From" next to an anonymity promise reads as "this is what
   * recipients will see". The value stays in the parent's state (not wiped) so
   * flipping back to "My feed" restores it.
   */
  anonymous?: boolean;
}) {
  // htmlFor/id: the label was a bare sibling, so this field had no accessible
  // name. aria-describedby carries the anonymity sentence with it — that line
  // is the whole explanation for why the input is disabled and blank.
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div>
      <label htmlFor={id} className="text-[11px] uppercase tracking-widest text-muted">
        From
      </label>
      <input
        id={id}
        aria-describedby={hintId}
        className="input mt-1.5 w-full disabled:opacity-60"
        value={anonymous ? '' : value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={DEFAULT_SENDER_NAME}
        disabled={anonymous}
      />
      <p id={hintId} className="text-[11px] text-muted mt-1">
        {anonymous
          ? `Sent as “${DEFAULT_SENDER_NAME}” — your name isn’t included.`
          : `Left blank, boosts are sent as “${DEFAULT_SENDER_NAME}”.`}
      </p>
    </div>
  );
}
