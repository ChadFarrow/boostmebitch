'use client';
import { useApp } from '@/lib/store';
import { WalletModal } from './wallet-modal';

/**
 * The one place `<WalletModal>` is rendered.
 *
 * It used to be rendered inside `<AuthControl>`, and `walletOpen` is a store
 * flag any surface may flip. Those two facts only agreed while every surface
 * that flipped it lived in `<AppHeader>` — which renders on `/`, `/favorites`
 * and `/playlists` and nowhere else. The tab bar's Wallet tab renders on EVERY
 * route, so a tap on `/live/<npub>` or `/stream/<naddr>` would have set the
 * flag with nothing mounted to read it: no modal, no error, a dead control.
 * That is the same failure `<FavoritesPrivacyPrompt>` moved into the layout to
 * fix, and this is the same repair.
 *
 * `<WalletModal>` portals to `document.body` (see docs/wallets.md), so where
 * this host sits in the tree affects nothing about where the modal paints.
 */
export function WalletModalHost() {
  const walletOpen = useApp((s) => s.walletOpen);
  const setWalletOpen = useApp((s) => s.setWalletOpen);
  if (!walletOpen) return null;
  return <WalletModal onClose={() => setWalletOpen(false)} />;
}
