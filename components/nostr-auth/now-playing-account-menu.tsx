'use client';

import { useApp } from '@/lib/store';
import { AccountMenu } from './account-menu';
import { useSignOut } from './use-sign-out';

/**
 * The account menu on the now-playing screen — the SAME menu the header opens.
 *
 * Asked for from that screen on 2026-11-13: *"if I click my avatar in the top
 * right, I'd like it to open the same menu that it does on the home screen."*
 * It replaced `<NostrIdentityChip>`, a readout with no press, kept that way so
 * a second mounted menu would not hold its bunker-health and restore
 * subscriptions for the rest of the session. The player answers that by
 * mounting this only while it is OPEN (`open &&`, as `<WalletBalanceBox>`
 * beside it), so the subscriptions last exactly as long as the screen.
 *
 * Signing out goes through `useSignOut`, its own working copy of the one
 * function the header's menu calls — not a request to <NostrAuth>, which no
 * route is guaranteed to mount (`/privacy` mounts none, and the player opens
 * over every route). The confirm it may draw renders here.
 *
 * Signed out it renders nothing: `<AuthControl overlay>` beside it offers the
 * sign-in then.
 */
export function NowPlayingAccountMenu({ className = '' }: { className?: string }) {
  const identity = useApp((s) => s.identity);
  const [signOut, confirmEl] = useSignOut();
  if (!identity) return null;
  return (
    <>
      {confirmEl}
      <AccountMenu identity={identity} onSignOut={() => { void signOut(); }} overlay triggerClassName={className} />
    </>
  );
}
