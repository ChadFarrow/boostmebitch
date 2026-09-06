'use client';
import { useEffect, useState } from 'react';
import { detectUnofficialLauncher } from '@/lib/launcher';
import { storage } from '@/lib/storage';
import { BRAND } from '@/lib/brand';

/**
 * A strip at the top of the page when an Android wrapper that is not ours
 * opened the site — see lib/launcher.ts for what the signal is and why it can
 * only ever be a notice. Names the package, says whose servers this is, and
 * points at the official app. Dismissable for the tab.
 *
 * In normal flow above the app header, not `fixed`: the sticky show header
 * pins at `--app-header-h`, and a strip in flow scrolls away before that
 * offset is ever measured against it. Android only by construction (the
 * referrer is Chrome-on-Android's), so no iOS safe-area inset is needed.
 */
export function UnofficialAppNotice() {
  const [pkg, setPkg] = useState<string | null>(null);
  useEffect(() => {
    if (storage.launcherNoticeDismissed.get()) return;
    setPkg(detectUnofficialLauncher());
  }, []);
  if (!pkg) return null;
  return (
    <div
      role="status"
      className="border-b border-nostr/40 bg-nostr/10 px-4 py-2 text-xs text-bone flex items-start gap-3"
    >
      <span className="min-w-0 flex-1 leading-relaxed">
        Opened from <code className="font-mono">{pkg}</code>, which is not the official{' '}
        {BRAND.displayName} app. It runs on {BRAND.domain}&apos;s servers. Get the official app:{' '}
        <a
          href={BRAND.androidAppUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-nostr"
        >
          {BRAND.androidAppUrl.replace(/^https:\/\//, '')}
        </a>
      </span>
      <button
        type="button"
        onClick={() => { storage.launcherNoticeDismissed.set(); setPkg(null); }}
        aria-label="Dismiss"
        className="shrink-0 px-2 py-1 min-h-6 min-w-6 text-muted hover:text-bone"
      >
        ×
      </button>
    </div>
  );
}
