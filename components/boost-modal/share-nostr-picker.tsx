'use client';
import type { ShareNostrAs } from '@/lib/storage';

// The "Share boost on Nostr" chooser, shared by BoostModal and BoostAllModal.
//
// Signed in with Nostr the user gets an explicit three-way pick: post signed
// by their OWN key, post via the SITE's Nostr identity (server-signed, same
// path signed-out boosts use), or don't post at all. Rendered as one compact
// pill row (same pattern as BoostAllModal's "Pay via" rail picker) with a
// single description line for the selected option — three stacked radios with
// permanent descriptions ate too much of the modal. Signed out there are only
// two real outcomes (site key or nothing), so the original checkbox stays.
//
// State lives in the parent (share on/off + shareAs), matching how the old
// inline checkbox worked; the parent persists both via lib/storage.ts.

interface Props {
  signedIn: boolean;
  share: boolean;
  shareAs: ShareNostrAs;
  onShareChange: (v: boolean) => void;
  onShareAsChange: (v: ShareNostrAs) => void;
  /** Subject for the descriptions: "A public note" / "One summary note". */
  noteNoun: string;
}

type ShareMode = ShareNostrAs | 'off';

export function ShareNostrPicker({
  signedIn, share, shareAs, onShareChange, onShareAsChange, noteNoun,
}: Props) {
  if (!signedIn) {
    return (
      <label
        className={`card flex items-start gap-3 p-3 cursor-pointer transition ${
          share ? '!border-nostr/60' : ''
        }`}
      >
        <input
          type="checkbox"
          checked={share}
          onChange={(e) => onShareChange(e.target.checked)}
          className="accent-nostr mt-0.5"
        />
        <div className="flex-1 text-xs">
          <div className="text-bone flex items-center gap-2">
            <span className={share ? 'text-nostr' : 'text-muted'}>◆</span>
            Share boost on Nostr
          </div>
          <div className="text-muted mt-0.5 leading-relaxed">
            {share
              ? `${noteNoun} posted from boostmebitch.com's Nostr account.`
              : 'Lightning only — nothing posted publicly.'}
          </div>
        </div>
      </label>
    );
  }

  const mode: ShareMode = share ? shareAs : 'off';
  const options: { value: ShareMode; label: string; desc: string }[] = [
    {
      value: 'self',
      label: 'My feed',
      desc: `${noteNoun} posted to your feed, signed with your key.`,
    },
    {
      value: 'site',
      label: 'Anonymous',
      // Kept short enough to fit ONE line at full modal width, like the other
      // two descs — a second line grows the modal past its 92vh cap and
      // toggles the scrollbar (width jitter) when flipping options.
      desc: `${noteNoun} posted from boostmebitch.com's account, not your npub.`,
    },
    {
      value: 'off',
      label: "Don't post",
      desc: 'Lightning only — nothing posted publicly.',
    },
  ];
  const selected = options.find((o) => o.value === mode) ?? options[0];

  function select(value: ShareMode) {
    if (value === 'off') {
      onShareChange(false);
    } else {
      onShareChange(true);
      onShareAsChange(value);
    }
  }

  return (
    <div className={`card p-3 space-y-1.5 transition ${share ? '!border-nostr/60' : ''}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-xs ${share ? 'text-nostr' : 'text-muted'}`}>◆</span>
        <span className="text-xs text-bone">Share on Nostr</span>
        <div className="flex gap-1.5 flex-wrap sm:ml-auto">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => select(o.value)}
              aria-pressed={mode === o.value}
              className={`btn-ghost !px-2.5 !py-1 text-[11px] ${
                mode === o.value ? '!border-nostr text-nostr' : ''
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <div className="text-[11px] text-muted leading-relaxed">{selected.desc}</div>
    </div>
  );
}
