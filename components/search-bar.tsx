'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fetchProfile, shortNpub } from '@/lib/nostr';
import type { ProfileMetadata } from '@/lib/nostr/auth';
import { looksLikeSecretKey, parseNpubInput } from '@/lib/nostr/npub-input';
import { storage } from '@/lib/storage';
import type { Podcast } from '@/lib/types';
import { SEARCH_TYPES, parseSearchType } from '@/lib/util';
import type { SearchType } from '@/lib/util';
import { Avatar } from './avatar';
import { Chip } from './chip';

/**
 * What produced the results, travelling WITH them.
 *
 * The chip row shows the user's pending selection, which moves the moment they
 * press it; the results on screen are still the previous lane's until a response
 * lands. So a consumer wording an empty state from the chip row would name a
 * filter that did not produce the list it is describing — "no albums match" over
 * podcast results, for the ~300 ms in between. `type` is the type the SERVER
 * applied (the feed-URL branch ignores the selector and says so), and `total` is
 * the unfiltered count for the same query, which is what lets a narrowed empty
 * result avoid claiming Podcast Index holds nothing.
 */
export interface SearchInfo {
  type: SearchType;
  total: number;
}

interface Props {
  /** Both callbacks are effect dependencies — pass referentially stable
   *  functions (useCallback / state setters) or the debounce restarts on
   *  every parent render and the empty-query reset loops. */
  onResults: (feeds: Podcast[], q: string, info: SearchInfo) => void;
  onLoading: (b: boolean) => void;
  /**
   * The selected content type, and the way to change it.
   *
   * CONTROLLED from the parent rather than held here, because the chip row is
   * not the only thing that sets it: when a narrowed search comes back empty,
   * the results panel offers a way back to ALL, and that control has to move
   * the same state this box reads. Held privately it would move only the
   * results, leaving the chip row pointing at a lane that is no longer running.
   *
   * Not persisted anywhere. A search filter restored from disk is on before you
   * touched it — you come back a week later, search a show, get nothing, and the
   * box reads as broken with the only explanation sitting in a chip you never
   * pressed. The favorites page stores its tab because that is a library you
   * own; this is a question you ask once.
   */
  type: SearchType;
  onTypeChange: (t: SearchType) => void;
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

export function SearchBar({ onResults, onLoading, onQueryChange, type, onTypeChange }: Props) {
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const active = SEARCH_TYPES.find((s) => s.type === type) ?? SEARCH_TYPES[0];

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

  /**
   * The kind:0 behind the pasted npub, so the suggestion names a PERSON.
   *
   * `npub177f…yqx0aaq7` is not a thing anyone can check. The row asks the user
   * to commit to a navigation, and the only way to know it is the right npub is
   * to see whose it is — which is the same reason the /npub page resolves the
   * profile for its own header.
   *
   * Seeded SYNCHRONOUSLY from `storage.profile` before the relay round-trip, so
   * a name already in cache paints in the same frame as the row rather than
   * appearing a second later and pushing the layout. The cache distinguishes
   * "not cached" (undefined) from a cached MISS (null); both leave the row on
   * its npub fallback, and only the first is worth a query — but we fetch
   * either way, because `fetchProfile` is what refreshes an expired entry and
   * it de-duplicates through the same cache.
   *
   * Reading storage in an effect rather than during render is deliberate: this
   * box is server-rendered at `/`. The row itself can never be in the server
   * HTML (it needs typed input), but seeding state from localStorage during
   * render is the habit that breaks hydration on the next surface that isn't
   * so lucky.
   */
  const [npubProfile, setNpubProfile] = useState<ProfileMetadata | null>(null);
  const hitPubkey = npubHit?.pubkey ?? null;
  useEffect(() => {
    if (!hitPubkey) { setNpubProfile(null); return; }
    setNpubProfile(storage.profile.get(hitPubkey) ?? null);
    let cancelled = false;
    fetchProfile(hitPubkey)
      .then((p) => { if (!cancelled && p) setNpubProfile(p); })
      .catch(() => { /* the row falls back to shortNpub, which is never wrong */ });
    return () => { cancelled = true; };
  }, [hitPubkey]);

  // Never let a half-resolved profile print an empty name where a name goes.
  const npubName = npubProfile?.display_name?.trim() || npubProfile?.name?.trim() || null;

  // Every edit goes through here — the input, the clear button and the type
  // chips all — so the "user is searching" signal can't be attached to one and
  // forgotten on the others. Deliberately not an effect: the point is that it
  // fires on the gesture, ahead of the debounce and the fetch.
  function edit(next: string) {
    setQ(next);
    onQueryChange?.(next);
  }

  /**
   * The type the last fetch ran under, so the effect can tell a CHIP PRESS from
   * a keystroke.
   *
   * The 280 ms below exists to coalesce typing, and a press is not typing: a
   * discrete deliberate action should not sit behind a delay sized for the next
   * character. Compared against the current prop rather than set by the click
   * handler, so it stays right no matter which control changed the type — and
   * the results panel's "search all types" button is a second one.
   */
  const lastTypeRef = useRef(type);

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
    //
    // `type === 'npub'` joins that list rather than getting a branch of its own.
    // The NPUB chip is a mode of the INPUT — it accepts a pasted key and nothing
    // else, because this app has no Nostr name search to offer — so there is
    // never a podcast query to send under it. That also makes it the strongest
    // possible form of the secret-key guard: no request is issued at all.
    const byPress = lastTypeRef.current !== type;
    lastTypeRef.current = type;
    if (!q.trim() || npubHit || secretHit || type === 'npub') {
      onResults([], '', { type, total: 0 });
      return;
    }
    const gen = ++genRef.current;
    const t = setTimeout(async () => {
      onLoading(true);
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}&type=${type}`);
        const data = await r.json();
        if (gen !== genRef.current) return;
        const feeds = Array.isArray(data?.feeds) ? data.feeds : [];
        // The type is read back from the RESPONSE, not from local state: the
        // feed-URL branch ignores the selector, so echoing `type` here would let
        // the empty state name a filter the server never applied. `parseSearchType`
        // is the same allowlist the route validated with, so a missing or odd
        // field falls back to 'all' rather than to a filter nobody chose.
        onResults(feeds, q, {
          type: parseSearchType(data?.type),
          total: typeof data?.total === 'number' ? data.total : feeds.length,
        });
      } catch {
        // try/finally with no catch made a dropped connection or a non-JSON
        // body an unhandled rejection. An empty result set is the honest answer
        // here — the surrounding UI already renders "no results" — and the next
        // keystroke retries anyway.
        //
        // `total: 0` on purpose: we learned nothing about how many results the
        // unfiltered query has, and a narrowed empty state offering to "search
        // all types" over a number we invented would be a worse claim than none.
        if (gen === genRef.current) onResults([], q, { type, total: 0 });
      } finally {
        if (gen === genRef.current) onLoading(false);
      }
    }, byPress ? 0 : 280);
    return () => clearTimeout(t);
  }, [q, type, npubHit, secretHit, onResults, onLoading]);

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
      {/* ABOVE the input, not below it. The rows under the box hang off it as
          one control — no gap, no top border — and a chip row wedged into that
          stack would split the input from the suggestion it belongs to. Above,
          it reads as what it is: the question the box is about to answer.

          `flex-wrap` because five chips do not fit one line at 320px, and
          wrapping is the honest failure there — an `overflow-x-auto` strip hides
          whichever chip falls off the end, and the one that falls off is NPUB. */}
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        {SEARCH_TYPES.map((s) => (
          <Chip key={s.type} active={type === s.type} onClick={() => onTypeChange(s.type)}>
            {s.label}
          </Chip>
        ))}
      </div>
      <div className="relative">
        {/* The warning outranks everything, then the parsed key, then the mode.
            A ⚡ over an nsec would say "this is a person" about a secret key. */}
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-xs">
          {secretHit ? '⚠' : npubHit || type === 'npub' ? '⚡' : '⌕'}
        </span>
        <input
          ref={inputRef}
          className="input pl-8 pr-8"
          value={q}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && npubHit) { e.preventDefault(); openBoosts(); } }}
          placeholder={active.placeholder}
          // The placeholder verbatim, not `Search ${noun}`. An aria-label
          // REPLACES the placeholder as the accessible name, so a shorter one
          // loses the instruction — and under NPUB "Search people" would promise
          // a name search this app does not have, to the one user who cannot see
          // the explainer row saying otherwise.
          aria-label={active.placeholder}
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
          {/* The avatar replaces the ⚡ rather than joining it — the input's own
              left icon already carries that, and two bolts in a column read as
              decoration. <Avatar> falls back to a deterministic colored initial,
              so the row is never a blank square while the relays answer. */}
          <Avatar
            pubkey={npubHit.pubkey}
            picture={npubProfile?.picture}
            name={npubName}
            className="h-7 w-7 shrink-0 rounded-full border border-bone/20 text-[10px]"
          />
          {/* One line: the profile name, or the short npub until one resolves.
              The npub is deliberately NOT kept alongside a resolved name — a
              display name is self-chosen and not unique, so the row can name
              the wrong person convincingly, and the full npub is still in the
              input directly above for anyone checking. */}
          <span className="min-w-0 flex-1 truncate text-muted">
            Boosts for{' '}
            <span className={npubName ? 'text-bone' : 'font-mono text-bone'}>
              {npubName ?? shortNpub(npubHit.npub)}
            </span>
          </span>
          <span className="text-muted shrink-0">↵</span>
        </button>
      )}
      {/* NPUB mode with text that is neither a key nor an nsec.

          Without this the chip is a DEAD CONTROL: press it, type a name, and
          nothing happens anywhere on screen — which this repo has already paid
          for twice, and which is the hardest failure to notice because a dead
          control is indistinguishable from a slow one. It says what the mode
          accepts, and it says plainly that searching people by name is not
          something this app can do, rather than leaving that to be inferred from
          an empty result.

          Ordered after the two branches above so a pasted key gets the
          suggestion row and an nsec gets the warning; this is the remainder. */}
      {type === 'npub' && !!q.trim() && !npubHit && !secretHit && (
        <p className="border border-t-0 border-bone/30 bg-ink/60 px-3 py-2 text-xs text-muted">
          Paste an <code className="font-mono text-bone">npub</code>,{' '}
          <code className="font-mono text-bone">nprofile</code> or hex pubkey to see that
          person&apos;s boosts. Searching people by name isn&apos;t available yet.
        </p>
      )}
    </div>
  );
}
