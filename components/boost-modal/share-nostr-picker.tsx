'use client';
import { useId } from 'react';
import type { ShareNostrAs } from '@/lib/storage';

// The "Share boost on Nostr" chooser, shared by BoostModal and BoostAllModal.
//
// Signed in with Nostr the user gets an explicit three-way pick: post signed
// by their OWN key, post via the SITE's Nostr identity (server-signed, same
// path signed-out boosts use), or don't post at all. Signed out there are only
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
  const group = useId();

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
      label: 'Post to my Nostr feed',
      desc: `${noteNoun} posted to your feed, signed with your key.`,
    },
    {
      value: 'site',
      label: 'Post via boostmebitch.com',
      desc: `${noteNoun} posted from the site's Nostr account instead of yours.`,
    },
    {
      value: 'off',
      label: "Don't post to Nostr",
      desc: 'Lightning only — nothing posted publicly.',
    },
  ];

  function select(value: ShareMode) {
    if (value === 'off') {
      onShareChange(false);
    } else {
      onShareChange(true);
      onShareAsChange(value);
    }
  }

  return (
    <div className={`card p-3 space-y-2.5 transition ${share ? '!border-nostr/60' : ''}`}>
      <div className="text-xs text-bone flex items-center gap-2">
        <span className={share ? 'text-nostr' : 'text-muted'}>◆</span>
        Share boost on Nostr
      </div>
      {options.map((opt) => (
        <label key={opt.value} className="flex items-start gap-3 cursor-pointer">
          <input
            type="radio"
            name={group}
            checked={mode === opt.value}
            onChange={() => select(opt.value)}
            className="accent-nostr mt-0.5"
          />
          <div className="flex-1 text-xs">
            <div className="text-bone">{opt.label}</div>
            <div className="text-muted mt-0.5 leading-relaxed">{opt.desc}</div>
          </div>
        </label>
      ))}
    </div>
  );
}
