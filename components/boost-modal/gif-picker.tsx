'use client';
import { useEffect, useId, useState } from 'react';
import type { GifResult } from '@/lib/giphy';
import { giphyTile, gifPreviewUrl, nbTile, type GifPick, type GifTile } from '@/lib/gifs/pick';
import { NB_BROWSE_URL, nbSearchUrl, normalizeNbQuery, parseNbResults } from '@/lib/gifs/nostr-build';
import { readCappedJson } from '@/lib/capped-body';
import { BRAND } from '@/lib/brand';
import { storage } from '@/lib/storage';
import { prefersReducedMotion } from '@/lib/format';
import { GifGrid } from './gif-grid';
import { looksLikeSecretKey } from '@/lib/nostr/npub-input';
import { ModalShell } from '@/components/modal-shell';

/** How long a keystroke waits before the GIF source is asked. */
// 250, the low end of nostr.build's 250–350 range (Chad, 2026-11-14: "a little slow").
const SEARCH_DEBOUNCE_MS = 250;

/** A 200-result nostr.build answer is well under 1 MB. */
const NB_MAX_BYTES = 2 * 1024 * 1024;
const NB_TIMEOUT_MS = 15_000;
const NB_RETRY_AFTER_MS = 1_000;

type Failure = 'rate' | 'unavailable' | 'setup';

const FAILURE_TEXT: Record<Failure, string> = {
  rate: 'Too many searches for now: give it a minute.',
  unavailable: 'GIFs are unavailable right now.',
  setup: 'GIF search is not set up on this site.',
};

type SearchState =
  | { kind: 'idle' }
  // `previous`: the grid shown when the search began, kept on screen, faded,
  // until the answer replaces it — grey boxes between two searches read as
  // a picker that forgot what it had (Chad, 2026-11-14).
  | { kind: 'loading'; previous: GifTile[] | null }
  | { kind: 'ready'; tiles: GifTile[] }
  | { kind: 'error'; failure: Failure };

type Answer = { tiles: GifTile[] } | { failure: Failure };

/**
 * gifs.nostr.build, called from the BROWSER with a plain `fetch` and no
 * custom headers: the API admits this site by its registered Origin, and an
 * `Authorization` header would fail the CORS preflight. An unregistered
 * Origin is answered before CORS headers are added, so it reaches this code
 * as a network error — "unavailable", like any other.
 *
 * `q` null is the empty box: the daily reaction list (there is no trending).
 * One request per query, never aborted (a late answer is ignored by the
 * caller instead); retried ONCE after a second, and only when no answer came
 * back — never a timeout, which may have arrived and been counted.
 */
async function searchNostrBuild(q: string | null): Promise<Answer> {
  const url = q ? nbSearchUrl(q) : NB_BROWSE_URL;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      // AbortSignal.timeout exists from Safari 16; without it, no timeout.
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(NB_TIMEOUT_MS)
        : undefined;
      res = await fetch(url, signal ? { signal } : undefined);
    } catch (e) {
      if (attempt === 0 && (e as { name?: string } | null)?.name !== 'TimeoutError') {
        await new Promise((r) => setTimeout(r, NB_RETRY_AFTER_MS));
        continue;
      }
      return { failure: 'unavailable' };
    }
    if (res.status === 429) return { failure: 'rate' };
    if (!res.ok) return { failure: 'unavailable' };
    try {
      return { tiles: parseNbResults(await readCappedJson(res, NB_MAX_BYTES)).map(nbTile) };
    } catch {
      return { failure: 'unavailable' };
    }
  }
}

/** GIPHY through our own `/api/gifs`, which holds the key. */
async function searchGiphy(q: string): Promise<Answer> {
  try {
    const res = await fetch(`/api/gifs?q=${encodeURIComponent(q)}`);
    if (res.status === 503) return { failure: 'setup' };
    if (!res.ok) return { failure: 'unavailable' };
    const body = (await res.json().catch(() => null)) as { gifs?: GifResult[] } | null;
    return Array.isArray(body?.gifs) ? { tiles: body.gifs.map(giphyTile) } : { failure: 'unavailable' };
  } catch {
    return { failure: 'unavailable' };
  }
}

/** Each source's required credit line. nostr.build's is a condition of use. */
function Attribution({ source }: { source: 'nostrbuild' | 'giphy' }) {
  if (source === 'giphy') return <>Powered by GIPHY</>;
  return (
    <>
      GIFs from{' '}
      <a href="https://nostr.build" target="_blank" rel="noopener noreferrer" className="underline">
        nostr.build
      </a>
    </>
  );
}

/**
 * Pick one GIF for a boost. Holds a {@link GifPick} only — the caller turns it
 * into the URL on the wire (`gifWireUrl`), so the picker never decides what a
 * boostagram says.
 *
 * The URL comes out of the same 250-character budget as the typed words. The
 * CALLER owns that budget: it lowers the message box's `maxLength` while a GIF
 * is picked, and says so — and holds the send — when words typed earlier no
 * longer fit beside it.
 */
export function GifPicker({
  pick,
  onChange,
  disabled = false,
}: {
  pick: GifPick | null;
  onChange: (pick: GifPick | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [state, setState] = useState<SearchState>({ kind: 'idle' });
  const [scrollBox, setScrollBox] = useState<HTMLDivElement | null>(null);
  // A `play()` refused with NotAllowedError (iOS Low Power Mode): stills for
  // the whole grid until the next answer, so no tile loads a video only to be
  // refused.
  const [refused, setRefused] = useState(false);
  // Bumped by "Try again", which sends the same search once more.
  const [attempt, setAttempt] = useState(0);
  // A phone's keyboard would cover the grid, so the field takes focus on open
  // only where a pointer can hover. Headless Chrome matches neither, so tests
  // see the phone's behaviour.
  const [focusOnOpen] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(hover: hover)').matches,
  );
  const source = BRAND.gifSource;
  const tiles = state.kind === 'ready' ? state.tiles : state.kind === 'loading' && state.previous ? state.previous : [];
  const searching = state.kind === 'loading' && tiles.length > 0;
  const inputId = useId();
  // Refused BEFORE any fetch and SAID so — the retype is as dangerous as the
  // first paste, so a silent no-op is not enough.
  const secretHit = looksLikeSecretKey(q);
  // Read at render, never cached: the setting can change while the picker is open.
  const reduced = prefersReducedMotion();
  // "Play anyway" under Reduce Motion, remembered on this device (bmb:gif_motion).
  const [playAnyway, setPlayAnyway] = useState(() => typeof window !== 'undefined' && storage.gifMotion.get());
  const choosePlayAnyway = (v: boolean) => { setPlayAnyway(v); storage.gifMotion.set(v); };
  // nostr.build: a single Latin letter is NOT a search (it would spend the
  // reader's 120-a-minute budget on noise), so the grid keeps what it shows.
  const notASearch = source === 'nostrbuild' && q.trim() !== '' && normalizeNbQuery(q) === null;
  // The query as SENT, which the search runs on — not the box's raw text. A
  // trailing space or a capital is the same search, and a single letter is
  // none at all: keyed on the raw text, both cancelled the search in flight,
  // and a letter typed before the first list arrived left the skeleton
  // pulsing under "Keep typing to search." for good.
  const [searchQ, setSearchQ] = useState('');
  const onQuery = (value: string) => {
    setQ(value);
    if (source !== 'nostrbuild') { setSearchQ(value.trim()); return; }
    if (value.trim() === '') { setSearchQ(''); return; }
    const n = normalizeNbQuery(value);
    if (n !== null) setSearchQ(n);
  };

  useEffect(() => {
    if (!open || secretHit) return;
    let live = true;
    setState((s) => ({
      kind: 'loading',
      previous: s.kind === 'ready' ? s.tiles : s.kind === 'loading' ? s.previous : null,
    }));
    const t = setTimeout(async () => {
      const answer = source === 'nostrbuild' ? await searchNostrBuild(searchQ || null) : await searchGiphy(searchQ);
      // A newer search has started: this answer must not replace its grid.
      if (!live) return;
      if ('failure' in answer) {
        setState({ kind: 'error', failure: answer.failure });
        return;
      }
      setRefused(false);
      setState({ kind: 'ready', tiles: answer.tiles });
    }, searchQ ? SEARCH_DEBOUNCE_MS : 0);
    return () => { live = false; clearTimeout(t); };
  }, [open, searchQ, secretHit, source, attempt]);

  if (pick) {
    return (
      <div>
        <div className="text-[11px] uppercase tracking-widest text-muted">GIF</div>
        <div className="mt-1.5 flex items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- third-party animated media; next/image would re-encode it */}
          <img
            src={gifPreviewUrl(pick)}
            alt="The GIF this boost will carry"
            className="h-24 w-auto max-w-[60%] rounded border border-line object-contain bg-bone/5"
          />
          <div className="flex flex-col items-start gap-2">
            <button
              type="button"
              className="btn-mini"
              onClick={() => onChange(null)}
              disabled={disabled}
            >
              × Remove GIF
            </button>
            <span className="text-[10px] text-muted">
              <Attribution source={pick.src} />
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (!open) {
    return (
      <div>
        <button
          type="button"
          // A full-width `.btn-ghost`, not a `.btn-mini`: as a small grey chip
          // between the message and FROM it read as a hint, not a control.
          // Not bolt-yellow — that colour is the money action's.
          className="btn-ghost w-full"
          onClick={() => setOpen(true)}
          disabled={disabled}
        >
          + Add a GIF
        </button>
      </div>
    );
  }

  const close = () => { setOpen(false); setQ(''); setSearchQ(''); };

  // The search opens as its OWN modal over the boost modal: inline, the grid
  // got a 256px window inside a card already full of amount, message and
  // splits, so on a phone a row of GIFs was cut in half. `<ModalShell>` stacks
  // (portal + shared scroll-lock refcount), and its Escape handler stops
  // propagation, so Escape closes this one and leaves the boost modal open.
  return (
    <>
      <div>
        <button type="button" className="btn-ghost w-full" disabled>
          + Add a GIF
        </button>
      </div>
      <ModalShell
        onClose={close}
        label="Search GIFs"
        clearsPlayer={false}
        className="flex h-full w-full max-w-lg flex-col p-4"
      >
      <div className="flex items-center justify-between">
        <label htmlFor={inputId} className="text-[11px] uppercase tracking-widest text-muted">
          Search GIFs
        </label>
        <button type="button" className="btn-mini min-h-[32px]" onClick={close}>
          Close
        </button>
      </div>
      <input
        id={inputId}
        className="input mt-2"
        type="search"
        value={q}
        maxLength={50}
        onChange={(e) => onQuery(e.target.value)}
        placeholder={source === 'giphy' ? 'search GIPHY…' : 'search GIFs…'}
        autoComplete="off"
        autoFocus={focusOnOpen}
        disabled={disabled}
      />
      {notASearch && !secretHit && (
        <p className="mt-1.5 text-xs text-muted" role="status">Keep typing to search.</p>
      )}
      {secretHit ? (
        <p className="mt-1.5 flex items-start gap-2 rounded border border-red-400/50 bg-red-400/5 px-3 py-2 text-xs text-red-300">
          <span aria-hidden className="shrink-0">⚠</span>
          <span>
            That is a <strong>secret key</strong>. Nothing was searched and nothing was
            sent anywhere. Clear the box.
          </span>
        </p>
      ) : state.kind === 'error' ? (
        // The old results are hidden under an error: they are not the answer
        // to this search. A 429 offers no Try again — the minute is the fix.
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted" role="status">
          <span>{FAILURE_TEXT[state.failure]}</span>
          {state.failure === 'unavailable' && (
            <button type="button" className="btn-mini min-h-[32px]" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          )}
        </div>
      ) : state.kind === 'ready' && state.tiles.length === 0 ? (
        <p className="mt-2 text-xs text-muted" role="status">No GIFs match that search.</p>
      ) : (
        <>
        {/* Still pictures are on purpose in two cases, and the picker SAYS
            which: a phone showing a still grid otherwise looks broken (Chad's
            iPhone, beta, 2026-11-14). The refusal line names Low Power Mode as
            the usual cause, not the only one. Under Reduce Motion the reader
            may choose motion anyway ("Play anyway", remembered on this device
            in bmb:gif_motion) and take it back; a refusal has no such button —
            the device would refuse again. */}
        {state.kind === 'ready' && reduced && playAnyway && (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted" role="status">
            <span>GIFs play although Reduce Motion is on.</span>
            <button type="button" className="btn-mini min-h-[32px]" onClick={() => choosePlayAnyway(false)}>
              Show still pictures
            </button>
          </p>
        )}
        {state.kind === 'ready' && ((reduced && !playAnyway) || refused) && (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted" role="status">
            <span>
              {refused
                ? 'This device did not let the GIFs play by themselves (Low Power Mode does this), so they show as still pictures.'
                : 'Reduce Motion is on, so the GIFs show as still pictures.'}
            </span>
            {!refused && (
              <button type="button" className="btn-mini min-h-[32px]" onClick={() => choosePlayAnyway(true)}>
                Play anyway
              </button>
            )}
          </p>
        )}
        {/* The scroll box is held in STATE, not a ref: the grid's observers are
            rooted at it, and the dialog mounts its content after the first
            render, so a ref read then measured nothing. */}
        <div
          ref={setScrollBox}
          data-gif-scroll=""
          data-searching={searching ? "" : undefined}
          className={`mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain transition-opacity ${searching ? 'opacity-40' : ''}`}
          aria-busy={state.kind === 'loading'}
        >
          {state.kind === 'ready' || searching ? (
            <GifGrid
              tiles={tiles}
              scrollRoot={scrollBox}
              motion={(reduced && !playAnyway) || refused ? 'still' : 'play'}
              onAutoplayRefused={() => setRefused(true)}
              // The grid can be open when Send is pressed. A pick after that
              // would show a GIF the sent boost does not carry.
              disabled={disabled}
              onPick={(tile) => { onChange(tile.pick); close(); }}
            />
          ) : (
            <div className="flex gap-2" aria-hidden>
              {[0, 1].map((c) => (
                <div key={c} className="flex flex-1 flex-col gap-2">
                  {[0, 1, 2].map((r) => (
                    <div key={r} className="h-32 rounded border border-line bg-bone/5 animate-pulse" />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
        </>
      )}
      <div className="mt-2 text-right text-[10px] text-muted">
        <Attribution source={source} />
      </div>
      </ModalShell>
    </>
  );
}
