'use client';
import { useApp } from '@/lib/store';
import { shortNpub } from '@/lib/nostr/profile-metadata';
import { Avatar } from '../avatar';

/**
 * WHO WILL SIGN, in one 26px box — the fullscreen player's bar and nothing
 * else so far.
 *
 * That bar carries `<AuthControl overlay>`, which offers the two logins while
 * the user is signed OUT and renders nothing once they are in: the account
 * menu belongs to `<NostrAuth>`, which the header-less routes mount hidden. So
 * a signed-in listener saw no Nostr at all there, reported from the phone as
 * "Nostr info missing in the top right". The boost note this screen publishes
 * goes out under that identity, which makes it the same kind of fact as the
 * wallet balance beside it: worth reading before BOOST, not worth a control.
 *
 * A READOUT, like `<WalletBalanceBox>`: no hover, no press. The account menu —
 * sign out, profile, relays — stays in `<AppHeader>`, which is one ← BACK
 * away, and putting a second mounted copy of it here would duplicate its
 * bunker-health and restore subscriptions for the rest of the session.
 *
 * `<Avatar>`, never a bare `<img>`: a picture that fails to load returns the
 * generated one in the same box, where an `<img>` would leave the name with no
 * mark beside it. The ◆ is the fallback when the profile carries no picture,
 * the same pair `<AccountMenu>`'s own trigger draws.
 *
 * THE NAME IS `hidden sm:inline`, and the number is why. With the balance box
 * beside it this chip ran 117px, and at 320px the bar overflowed by 18px —
 * 375px cleared it by 1. The picture is the part that says WHICH account, so
 * that is the part a phone keeps; `title` and the screen-reader text carry the
 * name at every width.
 */
export function NostrIdentityChip({ className = '' }: { className?: string }) {
  const identity = useApp((s) => s.identity);
  if (!identity) return null;
  const name = identity.profile?.display_name || identity.profile?.name;
  const pic = identity.profile?.picture;
  return (
    <span
      // From lg: the caller makes the box 38px, so the picture and the name
      // grow with it, and the cap widens: at 8rem "ChadF and 33…" was cut on a
      // 1920px bar with most of the bar empty.
      className={`inline-flex items-center gap-1.5 lg:gap-2 border border-bone/40 px-2 py-1 text-base leading-none max-w-[8rem] lg:max-w-[14rem] ${className}`}
      title={`Signed in as ${name || shortNpub(identity.npub, 8)}`}
    >
      {pic ? (
        <Avatar
          pubkey={identity.pubkey}
          picture={pic}
          name={name}
          className="w-4 h-4 lg:w-5 lg:h-5 rounded-full border border-nostr/40 flex-shrink-0"
        />
      ) : (
        <span aria-hidden className="text-nostr text-xs lg:text-sm">◆</span>
      )}
      <span className="sr-only">Signed in as </span>
      <span className="hidden sm:inline text-[11px] lg:text-sm text-bone/80 truncate">
        {name || shortNpub(identity.npub, 6)}
      </span>
    </span>
  );
}
