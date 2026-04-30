'use client';
import type { NostrIdentity } from '@/lib/nostr';

export type RelaySource = 'override' | 'nip65' | 'default';

export function NostrShareToggle({
  checked,
  onChange,
  identity,
  relayCount,
  relaySource,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  identity: NostrIdentity | null;
  relayCount: number;
  relaySource: RelaySource;
}) {
  return (
    <label
      className={`card flex items-start gap-3 p-3 cursor-pointer transition ${
        !identity ? 'opacity-40 cursor-not-allowed' : ''
      } ${checked && identity ? '!border-nostr/60' : ''}`}
    >
      <input
        type="checkbox"
        checked={checked && !!identity}
        disabled={!identity}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-nostr mt-0.5"
      />
      <div className="flex-1 text-xs">
        <div className="text-bone flex items-center gap-2">
          <span className={checked && identity ? 'text-nostr' : 'text-muted'}>◆</span>
          {identity && !checked ? 'Private boost — Lightning only' : 'Share boost on Nostr'}
        </div>
        <div className="text-muted mt-0.5 leading-relaxed">
          {identity ? (
            checked ? (
              <>
                Publishes a kind:1 note tagged with NIP-73 podcast refs to {relayCount} relays.
                {relaySource === 'nip65' && (
                  <span className="text-nostr/80"> · using your NIP-65 list</span>
                )}
                {relaySource === 'default' && (
                  <span className="text-muted/70"> · using defaults (no NIP-65 found)</span>
                )}
              </>
            ) : (
              'No Nostr note will be published. Only the Lightning payment goes out.'
            )
          ) : (
            'Sign in with Nostr to enable.'
          )}
        </div>
      </div>
    </label>
  );
}
