'use client';
import { useEffect, useId, useMemo, useState } from 'react';
import type { GifResult } from '@/lib/giphy';
import { giphyTile, gifPreviewUrl, type GifPick } from '@/lib/gifs/pick';
import { prefersReducedMotion } from '@/lib/format';
import { GifGrid } from './gif-grid';
import { looksLikeSecretKey } from '@/lib/nostr/npub-input';
import { ModalShell } from '@/components/modal-shell';

/** How long a keystroke waits before GIPHY is asked. */
const SEARCH_DEBOUNCE_MS = 300;

type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; gifs: GifResult[] }
  | { kind: 'error'; message: string };

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
  const tiles = useMemo(() => (state.kind === 'ready' ? state.gifs.map(giphyTile) : []), [state]);
  const inputId = useId();
  // Refused BEFORE any fetch and SAID so — the retype is as dangerous as the
  // first paste, so a silent no-op is not enough.
  const secretHit = looksLikeSecretKey(q);

  useEffect(() => {
    if (!open || secretHit) return;
    let live = true;
    setState({ kind: 'loading' });
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/gifs?q=${encodeURIComponent(q.trim())}`);
        const body = (await res.json().catch(() => null)) as { gifs?: GifResult[]; error?: string } | null;
        if (!live) return;
        if (!res.ok || !body?.gifs) {
          setState({
            kind: 'error',
            message: res.status === 503 ? 'GIF search is not set up on this site.' : 'GIF search is not available now.',
          });
          return;
        }
        setRefused(false);
        setState({ kind: 'ready', gifs: body.gifs });
      } catch {
        if (live) setState({ kind: 'error', message: 'GIF search is not available now.' });
      }
    }, q.trim() ? SEARCH_DEBOUNCE_MS : 0);
    return () => { live = false; clearTimeout(t); };
  }, [open, q, secretHit]);

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
            <span className="text-[10px] text-muted">Powered by GIPHY</span>
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

  const close = () => { setOpen(false); setQ(''); };

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
        onChange={(e) => setQ(e.target.value)}
        placeholder="search GIPHY…"
        autoComplete="off"
        autoFocus
        disabled={disabled}
      />
      {secretHit ? (
        <p className="mt-1.5 flex items-start gap-2 rounded border border-red-400/50 bg-red-400/5 px-3 py-2 text-xs text-red-300">
          <span aria-hidden className="shrink-0">⚠</span>
          <span>
            That is a <strong>secret key</strong>. Nothing was searched and nothing was
            sent anywhere. Clear the box.
          </span>
        </p>
      ) : state.kind === 'error' ? (
        <p className="mt-2 text-xs text-muted" role="status">{state.message}</p>
      ) : state.kind === 'ready' && state.gifs.length === 0 ? (
        <p className="mt-2 text-xs text-muted" role="status">No GIFs match that search.</p>
      ) : (
        // The scroll box is held in STATE, not a ref: the grid's observers are
        // rooted at it, and the dialog mounts its content after the first
        // render, so a ref read then measured nothing.
        <div
          ref={setScrollBox}
          data-gif-scroll=""
          className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain"
          aria-busy={state.kind === 'loading'}
        >
          {state.kind === 'ready' ? (
            <GifGrid
              tiles={tiles}
              scrollRoot={scrollBox}
              motion={prefersReducedMotion() || refused ? 'still' : 'play'}
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
      )}
      <div className="mt-2 text-right text-[10px] text-muted">Powered by GIPHY</div>
      </ModalShell>
    </>
  );
}
