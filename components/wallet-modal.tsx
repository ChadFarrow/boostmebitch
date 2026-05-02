'use client';

// Lightning wallet modal — a single overlay that consolidates the three
// wallet rails (NWC / Spark / WebLN) so the account menu doesn't have to
// stack three sub-cards. Triggered by the WalletButton in AccountMenu.
//
// Display rule: when ANY rail is connected (NWC URI saved or Spark SDK
// initialized), only the connected rail(s) are shown. The unconnected
// connect forms only appear when nothing is connected — keeping the
// account menu uncluttered after the user picks their wallet. WebLN is
// tracked as "available" rather than "connected" (the extension is either
// injected or it isn't) so it surfaces alongside the connect options.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { hasNwc, subscribeNwc } from '@/lib/v4v/nwc';
import { hasSpark, subscribeSpark } from '@/lib/v4v/spark';
import { hasWebln } from '@/lib/v4v/webln';
import { NwcWallet } from './nwc-wallet';
import { SparkWallet } from './spark-wallet';
import { WeblnWallet } from './webln-wallet';

interface Props {
  onClose: () => void;
}

export function WalletModal({ onClose }: Props) {
  // Bump on either rail's state change so the modal flips between
  // "connected wallets only" and "all options" without remounting.
  const [, setTick] = useState(0);
  // Portal target only resolves on the client; tracking it in state lets the
  // first render no-op during SSR and re-render once the body is available.
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortalTarget(document.body);
    const bump = () => setTick((t) => t + 1);
    const unsubSpark = subscribeSpark(bump);
    const unsubNwc = subscribeNwc(bump);
    return () => { unsubSpark(); unsubNwc(); };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const nwcReady = hasNwc();
  const sparkReady = hasSpark();
  const weblnAvailable = hasWebln();
  const anyConnected = nwcReady || sparkReady;

  // Portal to body so `position: fixed` resolves against the viewport, not the
  // sticky <header>. The header uses `backdrop-blur` which creates a
  // containing block for fixed descendants per CSS spec — without the portal,
  // the modal renders clipped to the header's bounding box on mobile (looking
  // like the menu "opens upward").
  if (!portalTarget) return null;
  return createPortal(
    <div className="fixed inset-0 z-40 bg-ink/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="card w-full max-w-md bg-ink relative max-h-[92vh] overflow-y-auto">
        <button
          onClick={onClose}
          className="absolute top-2 right-3 text-muted hover:text-bone text-lg z-10"
          aria-label="Close"
        >
          ×
        </button>

        <div className="p-5 border-b border-bone/15">
          <div className="stamp text-bolt border-bolt/60 mb-2">⚡ LIGHTNING WALLET</div>
          <h3 className="font-display text-2xl leading-tight">
            {anyConnected ? 'Connected' : 'Connect a wallet'}
          </h3>
          <p className="text-xs text-muted mt-1">
            {anyConnected
              ? 'Disconnect below to switch to a different wallet.'
              : 'Pick one option to send Lightning payments.'}
          </p>
        </div>

        <div className="p-5 space-y-5">
          {nwcReady && (
            <section>
              <div className="text-[11px] uppercase tracking-widest text-bone/60">NWC</div>
              <NwcWallet />
            </section>
          )}

          {sparkReady && (
            <section>
              <div className="text-[11px] uppercase tracking-widest text-bone/60">Spark</div>
              <SparkWallet />
            </section>
          )}

          {!anyConnected && (
            <>
              <section>
                <div className="text-[11px] uppercase tracking-widest text-bone/60">NWC</div>
                <NwcWallet />
              </section>
              <section>
                <div className="text-[11px] uppercase tracking-widest text-bone/60">Spark</div>
                <SparkWallet />
              </section>
              {weblnAvailable && (
                <section>
                  <div className="text-[11px] uppercase tracking-widest text-bone/60">WebLN</div>
                  <WeblnWallet />
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    portalTarget,
  );
}
