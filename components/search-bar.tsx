'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { shortNpub } from '@/lib/nostr';
import { looksLikeSecretKey, parseNpubInput } from '@/lib/nostr/npub-input';
import type { Podcast } from '@/lib/types';

interface Props {
  /** Both callbacks are effect dependencies — pass referentially stable
   *  functions (useCallback / state setters) or the debounce restarts on
   *  every parent render and the empty-query reset loops. */
  onResults: (feeds: Podcast[], q: string) => void;
  onLoading: (b: boolean) => void;
  /**
   * Fired synchronously on every edit of the query, before any fetch is queued.
   *
   * Exists so a consumer can react to the USER searching rather than to results
   * ARRIVING. Those are not the same moment, and a view change driven by the
   * second one races: a response for a query the user has since abandoned lands
   * after they've navigated away and moves the page under them. Not an effect
   * dependency, so it doesn't have to be referentially stable.
   */
  onQueryChange?: (q: string) => void;
}

export function SearchBar({ onResults, onLoading, onQueryChange }: Props) {
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  /**
   * One box, two kinds of thing to find. An npub is unmistakable — `npub1…`,
   * 63 characters of bech32, or an `nprofile`/hex/profile link — so the box can
   * tell which the user meant instead of making them know which box to use.
   * That was the alternative and it was worse: a second input beside this one,
   * each silently useless for the other's input.
   *
   * Memoized on `q` so the object identity is stable per query — it is an
   * effect dependency below, and a fresh object every render would restart the
   * debounce on every keystroke of an ordinary podcast search.
   */
  const npubHit = useMemo(() => parseNpubInput(q), [q]);

  /**
   * A pasted SECRET key, which this box now invites by asking for a key at all.
   *
   * `parseNpubInput` rejects an nsec by returning null — and null is the same
   * answer it gives for "bowl after bowl", which falls through to
   * `/api/search?q=…`. So the rejection quietly put the user's signing key in a
   * URL, in this origin's server logs, and then in Podcast Index's. Checked
   * BEFORE the fetch and rendered as a refusal, because a key that has been
   * sent to a third party cannot be recalled and a silent drop would leave
   * nobody knowing it went.
   */
  const secretHit = useMemo(() => looksLikeSecretKey(q), [q]);

  // Every edit goes through here — the input and the clear button both — so the
  // "user is searching" signal can't be attached to one and forgotten on the
  // other. Deliberately not an effect: the point is that it fires on the
  // gesture, ahead of the debounce and the fetch.
  function edit(next: string) {
    setQ(next);
    onQueryChange?.(next);
  }

  // Focus on mount only for fine-pointer (mouse) devices. On touch devices
  // autofocus pops the keyboard and scrolls the viewport to the input — and
  // since goHome() remounts the bar via searchKey, tapping the header title
  // on mobile jumped to the search box instead of just showing home.
  useEffect(() => {
    if (window.matchMedia('(pointer: fine)').matches) inputRef.current?.focus();
  }, []);

  // Generation counter, because `clearTimeout` only cancels a request that
  // hasn't STARTED. Once one is in flight the cleanup can't reach it, so a slow
  // response for "bow" could land after a fast one for "bowl after bowl" and
  // replace the results the user is looking at with the ones they'd moved past.
  const genRef = useRef(0);

  useEffect(() => {
    // An npub never needs the podcast API. Skipping the fetch is not just an
    // optimisation: a 63-character bech32 string matches no show, so the call
    // spends Podcast Index quota to return nothing and then paints "no results"
    // over the suggestion below, which IS the answer.
    //
    // Reports an EMPTY query rather than `q`, so the page behind the box does
    // not flip into its searching layout and throw away the favorites panel
    // for a query that was never about shows.
    if (!q.trim() || npubHit || secretHit) { onResults([], ''); return; }
    const gen = ++genRef.current;
    const t = setTimeout(async () => {
      onLoading(true);
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = await r.json();
        if (gen !== genRef.current) return;
        onResults(Array.isArray(data?.feeds) ? data.feeds : [], q);
      } catch {
        // try/finally with no catch made a dropped connection or a non-JSON
        // body an unhandled rejection. An empty result set is the honest answer
        // here — the surrounding UI already renders "no results" — and the next
        // keystroke retries anyway.
        if (gen === genRef.current) onResults([], q);
      } finally {
        if (gen === genRef.current) onLoading(false);
      }
    }, 280);
    return () => clearTimeout(t);
  }, [q, npubHit, secretHit, onResults, onLoading]);

  // Navigation hangs off the suggestion (click or Enter), never off the npub
  // merely PARSING. Someone pasting an npub mid-edit, or pasting one they then
  // correct, must not have the page moved out from under them — the same reason
  // `onResults` deliberately doesn't navigate.
  function openBoosts() {
    if (!npubHit) return;
    router.push(`/npub/${npubHit.npub}`);
  }

  return (
    // No gap between the input and the suggestion, and the suggestion carries no
    // top border of its own: it hangs off the input as one control. The first
    // version put a full `.card` at the same width and the same height directly
    // below, separated by a gap — which read as a SECOND SEARCH BOX, i.e. exactly
    // the two-input design merging them into one was meant to remove.
    <div className="flex flex-col">
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-xs">
          {secretHit ? '⚠' : npubHit ? '⚡' : '⌕'}
        </span>
        <input
          ref={inputRef}
          className="input pl-8 pr-8"
          value={q}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && npubHit) { e.preventDefault(); openBoosts(); } }}
          placeholder="search podcasts, or paste an npub…"
        />
        {q && (
          <button
            type="button"
            onClick={() => edit('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded-full text-muted hover:bg-line hover:text-bone"
          >
            ×
          </button>
        )}
      </div>
      {/* Sits where the npub suggestion sits, and says what was NOT done. A
          guard that silently withholds is indistinguishable from a broken box —
          the user retypes, and the second paste is as dangerous as the first. */}
      {secretHit && (
        <p className="flex items-start gap-2 border border-t-0 border-red-400/50 bg-red-400/5 px-3 py-2 text-xs text-red-300">
          <span aria-hidden className="shrink-0">⚠</span>
          <span>
            That is a <strong>secret key</strong>. It was not searched for and it was not
            sent anywhere. Clear the box, and paste your <code className="font-mono">npub</code>{' '}
            instead — never your <code className="font-mono">nsec</code>.
          </span>
        </p>
      )}
      {npubHit && (
        <button
          type="button"
          onClick={openBoosts}
          className="flex items-center gap-2 border border-t-0 border-bone/30 bg-ink/60 px-3 py-2 text-left text-xs hover:border-bolt hover:bg-bolt/5"
        >
          <span className="text-bolt shrink-0">⚡</span>
          <span className="min-w-0 flex-1 truncate text-muted">
            Boosts for{' '}
            <span className="font-mono text-bone">{shortNpub(npubHit.npub)}</span>
          </span>
          <span className="text-muted shrink-0">↵</span>
        </button>
      )}
    </div>
  );
}
