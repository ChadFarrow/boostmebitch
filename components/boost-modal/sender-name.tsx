'use client';

/**
 * What ships as the boostagram's `sender_name` (and lands in the Nostr note
 * body) when the user has no name to send — either they left "From" empty or
 * they picked "Anonymous". A real default, NOT just the input's ghost text:
 * omitting the field entirely left presentation up to each recipient's
 * aggregator, so the same boost showed as blank in one client and "Unknown" in
 * another. Both modals resolve their `senderName` through this.
 */
export const DEFAULT_SENDER_NAME = 'boostmebitch.com user';

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
  return (
    <div>
      <label className="text-[11px] uppercase tracking-widest text-muted">From</label>
      <input
        className="input mt-1.5 w-full disabled:opacity-60"
        value={anonymous ? '' : value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={DEFAULT_SENDER_NAME}
        disabled={anonymous}
      />
      <p className="text-[11px] text-muted mt-1">
        {anonymous
          ? `Sent as “${DEFAULT_SENDER_NAME}” — your name isn’t included.`
          : `Left blank, boosts are sent as “${DEFAULT_SENDER_NAME}”.`}
      </p>
    </div>
  );
}
