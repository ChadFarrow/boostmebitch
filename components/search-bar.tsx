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
 * The menu shows the user's pending selection, which moves the moment they pick
 * it; the results on screen are still the previous lane's until a response
 * lands. So a consumer wording an empty state from the selector would name a
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
   * CONTROLLED from the parent rather than held here, because the menu is not
   * the only thing that sets it: when a narrowed search comes back empty, the
   * results panel offers a way back to ALL, and that control has to move the
   * same state this box reads. Held privately it would move only the results,
   * leaving the menu naming a lane that is no longer running.
   *
   * Not persisted anywhere. A search filter restored from disk is on before you
   * touched it — you come back a week later, search a show, get nothing, and the
   * box reads as broken with the only explanation folded away inside a menu you
   * never opened. The favorites page stores its tab because that is a library
   * you own; this is a question you ask once.
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

/**
 * The content-type selector: one button naming the current mode, and a menu.
 *
 * It replaced a row of five chips, which read fine on a desktop and became a
 * WRAPPED TWO-LINE BLOCK at 320px — a filter standing taller than the search box
 * it filters. A dropdown states the current mode in one word and costs one line
 * at every width. It is also how podcastindex.org presents the same choice,
 * which is worth something on its own: this app's users are already reading that
 * site, and a control they recognise needs no explaining.
 *
 * **`role="menuitemradio"`, not `menuitem`.** This is one choice out of a fixed
 * set, and `aria-checked` is what makes the ✓ mean something to a screen reader
 * rather than being decoration next to a name.
 *
 * Dismissal is the mousedown-outside + Escape pair `<AccountMenu>` already uses,
 * and it needs both: Escape alone strands the menu open under a thumb, and
 * click-outside alone strands it open for anyone on a keyboard.
 */
function SearchTypeMenu({ type, onChange }: { type: SearchType; onChange: (t: SearchType) => void }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const active = SEARCH_TYPES.find((s) => s.type === type) ?? SEARCH_TYPES[0];

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative mb-2 w-fit">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Search type: ${active.label}`}
        className="flex items-center gap-2 px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider border border-bone/30 text-muted transition hover:border-bone/60 hover:text-bone"
      >
        <span className="text-bone">{active.label}</span>
        <span className="text-[10px] opacity-40">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div role="menu" className="absolute left-0 top-full z-30 mt-1 min-w-[190px] card bg-ink p-1 shadow-xl">
          {SEARCH_TYPES.map((s) => (
            <button
              key={s.type}
              type="button"
              role="menuitemradio"
              aria-checked={s.type === type}
              onClick={() => { onChange(s.type); setOpen(false); }}
              className={`flex w-full items-center gap-2 px-2 py-2 text-left text-xs font-mono uppercase tracking-wider transition ${
                s.type === type ? 'text-bolt' : 'text-muted hover:bg-bone/5 hover:text-bone'
              }`}
            >
              {/* A fixed gutter for the ✓, so every label starts at the same x
                  whether or not its row is the checked one. A tick that shifts
                  the text makes the list appear to jitter as you move down it. */}
              <span className="w-3 shrink-0" aria-hidden>{s.type === type ? '✓' : ''}</span>
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SearchBar({ onResults, onLoading, onQueryChange, type, onTypeChange }: Props) {
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const active = SEARCH_TYPES.find((s) => s.type === type) ?? SEARCH_TYPES[0];

  /**
   * A pasted key, parsed once. `npub1…`, an `nprofile`, bare hex, or a profile
   * link.
   *
   * Memoized on `q` so the object identity is stable per query — it feeds an
   * effect dependency below, and a fresh object every render would restart the
   * debounce on every keystroke of an ordinary podcast search.
   */
  const parsedNpub = useMemo(() => parseNpubInput(q), [q]);

  /**
   * The pasted key this mode will ACT on, which is NPUB's alone.
   *
   * The box used to look one up whichever mode it was in: an npub is
   * unmistakable, so it could tell what the user meant without being told. That
   * was right while there was nothing to tell it with. Now there is, and
   * inferring over the top of an explicit choice is worse than not inferring at
   * all — somebody who picked PODCASTS and pasted a key gets a person lookup
   * they did not ask a podcast search for, and no mode means what it says.
   *
   * Under every other mode a key is ordinary text and is searched as typed.
   * Deriving rather than memoizing is deliberate: both arms are already stable
   * references, so this stays safe as an effect input.
   */
  const npubHit = type === 'npub' ? parsedNpub : null;

  /**
   * A key pasted under a mode that will not look it up.
   *
   * Parsed, never acted on. It exists only so the box can SAY that, because the
   * alternative is the dead end this repo keeps paying for: the search runs, no
   * show is called `npub1vl029mg…`, and "no results yet — try another phrase"
   * is the last word on a lookup the app can do perfectly well. Nothing here
   * navigates, fetches a profile, or changes the query — it offers the mode.
   */
  const strayNpub = type === 'npub' ? null : parsedNpub;

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
  // menu all — so the "user is searching" signal can't be attached to one and
  // forgotten on the others. Deliberately not an effect: the point is that it
  // fires on the gesture, ahead of the debounce and the fetch.
  function edit(next: string) {
    setQ(next);
    onQueryChange?.(next);
  }

  /**
   * The type the last fetch ran under, so the effect can tell a MENU PICK from
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
    // NPUB never needs the podcast API: it accepts a pasted key and nothing
    // else, because this app has no Nostr name search to offer, so there is no
    // podcast query to send under it. That also makes it the strongest possible
    // form of the secret-key guard — no request is issued at all.
    //
    // A parsed npub under ANY OTHER mode is deliberately NOT in this list. It is
    // ordinary text there and gets searched as typed, which is what those modes
    // say they do; the row below is what stops that reading as a dead end.
    //
    // `secretHit` IS unconditional, in every mode, and must stay that way. It is
    // a different question from "did this parse" — `parseNpubInput` returns the
    // same null for an nsec as for "bowl after bowl", and that null falling
    // through to a fetch is how a signing key reached this origin's logs and
    // then Podcast Index's. A key sent to a third party cannot be recalled.
    //
    // Reports an EMPTY query rather than `q`, so the page behind the box does
    // not flip into its searching layout for a query that was never about shows.
    const byPress = lastTypeRef.current !== type;
    lastTypeRef.current = type;
    if (!q.trim() || secretHit || type === 'npub') {
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
  }, [q, type, secretHit, onResults, onLoading]);

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
      {/* ABOVE the input, not inside it. The rows UNDER the box hang off it as
          one control — no gap, no top border — so anything added down there
          splits the input from the suggestion that belongs to it, and anything
          added inside competes with the × for a box that is 288px wide at
          320px. Above costs one line and touches neither. */}
      <SearchTypeMenu type={type} onChange={onTypeChange} />
      <div className="relative">
        {/* The warning outranks the mode. A ⚡ over an nsec would say "this is a
            person" about a secret key. The ⚡ now follows the MODE rather than a
            parse, because a key pasted under PODCASTS is not being looked up. */}
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-xs">
          {secretHit ? '⚠' : type === 'npub' ? '⚡' : '⌕'}
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

          Without this the mode is a DEAD CONTROL: pick it, type a name, and
          nothing happens anywhere on screen — which this repo has already paid
          for twice, and which is the hardest failure to notice because a dead
          control is indistinguishable from a slow one. It says what the mode
          accepts, and it says plainly that searching people by name is not
          something this app can do, rather than leaving that to be inferred from
          an empty result.

          Ordered after the two branches above so a pasted key gets the
          suggestion row and an nsec gets the warning; this is the remainder. */}
      {/* A key pasted under a mode that does not look one up.

          The search still runs — PODCASTS searching for what you typed is what
          PODCASTS says it does — so this sits BESIDE "no results", not instead
          of it. It offers the mode rather than instructing the reader to go and
          find it: the same one-press way out the results panel gives a narrowed
          empty result, for the same reason. Nothing here navigates or resolves a
          profile; that is what makes it an offer and not the inference the mode
          selector exists to replace. */}
      {strayNpub && (
        <div className="flex flex-wrap items-center gap-2 border border-t-0 border-bone/30 bg-ink/60 px-3 py-2 text-xs text-muted">
          <span className="min-w-0">
            That looks like an <code className="font-mono text-bone">npub</code>. This
            mode searches podcasts.
          </span>
          <Chip active={false} onClick={() => onTypeChange('npub')}>⚡ look it up</Chip>
        </div>
      )}
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
