'use client';
import { useEffect, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { parseNpubInput } from '@/lib/nostr/npub-input';
import { NostrAuth } from '@/components/nostr-auth';
import { BoostExplorer } from '@/components/boost-explorer';

/**
 * Permanent per-npub boost page: `/npub/<npub>`.
 *
 * A shareable link is the point — an artist can put this in their bio and it
 * keeps answering "who boosted me" without anyone signing in. That is why this
 * is a route rather than another branch of the store-driven view switch in
 * <HomePage>: those views have no URL to give anyone.
 *
 * A real scrollable page, not a fixed overlay like /live/<npub> — that route
 * covers the screen because it opens the player, and this one is something you
 * read. `pb-32` clears the mini-player bar at the foot of the viewport.
 *
 * The segment is normalized rather than required to be an npub: an nprofile, a
 * hex pubkey or a pasted profile link all resolve through the same
 * `parseNpubInput` the search box uses, so the box can never send someone to a
 * page that refuses the string it just accepted. When the segment was not
 * already the canonical npub we redirect, so the URL people copy is stable.
 *
 * There is deliberately NO "not found" state for an npub with no activity. A
 * valid npub that has never boosted is a real npub, and a 404 there would make
 * the same false claim about a person that an empty relay read makes about a
 * list.
 */
export default function NpubPage() {
  const params = useParams();
  const router = useRouter();
  const raw = Array.isArray(params.npub) ? params.npub[0] : (params.npub ?? '');
  const parsed = useMemo(() => parseNpubInput(decodeURIComponent(raw)), [raw]);

  // Canonicalize the URL when the visitor arrived on an nprofile / hex / link
  // form, so the address bar always holds the npub worth sharing. `replace`,
  // not `push` — the un-canonical form should not sit in the back stack. In an
  // effect, not the render body: navigating during render is a side effect, and
  // React may run the render twice.
  const canonical = parsed?.npub;
  useEffect(() => {
    if (canonical && canonical !== raw) router.replace(`/npub/${canonical}`);
  }, [canonical, raw, router]);

  if (!parsed) {
    return (
      <main className="max-w-2xl mx-auto px-4 py-16 flex flex-col items-center gap-4 text-center text-muted">
        <span className="text-sm">That npub link isn&apos;t valid.</span>
        <Link href="/" className="btn-ghost">← Go home</Link>
      </main>
    );
  }

  return (
    <>
      {/* Mounts the Nostr session logic (identity hydration + sign-in modal) on
          this standalone route where the home page's <NostrAuth> isn't present.
          Hidden; nothing here needs a signer, but the wallet/account controls a
          visitor reaches from a boost card do. */}
      <div className="hidden">
        <NostrAuth />
      </div>
      <main className="max-w-3xl mx-auto px-4 py-10 pb-32 flex flex-col gap-8">
        <Link href="/" className="text-xs text-muted hover:text-bone w-fit">
          ← back to Boost Me Bitch
        </Link>
        <BoostExplorer pubkey={parsed.pubkey} npub={parsed.npub} />
      </main>
    </>
  );
}
