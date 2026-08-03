'use client';

export function SenderName({
  value,
  onChange,
  anonymous = false,
}: {
  value: string;
  onChange: (v: string) => void;
  /**
   * The share picker is on "Anonymous". The name is withheld from the
   * boostagram and the note, so the field has to SHOW that — a filled-in "From"
   * next to an anonymity promise reads as "this is what recipients will see".
   * The typed value is kept in the parent's state (not wiped) so flipping back
   * to "My feed" restores it.
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
        placeholder={anonymous ? 'Anonymous' : 'boostmebitch.com user'}
        disabled={anonymous}
      />
      {anonymous && (
        <p className="text-[11px] text-muted mt-1">
          Your name isn&apos;t sent with an anonymous boost.
        </p>
      )}
    </div>
  );
}
