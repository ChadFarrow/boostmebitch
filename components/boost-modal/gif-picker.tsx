'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { giphyPreviewUrl, giphyStillUrl, type GifResult } from '@/lib/giphy';
import { looksLikeSecretKey } from '@/lib/nostr/npub-input';
import { ModalShell } from '@/components/modal-shell';

/** How long a keystroke waits before GIPHY is asked. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * How long the mouse (or keyboard focus) rests on a tile before its animation
 * is fetched. A sweep across the grid passes each tile in well under this, so
 * it fetches nothing; without the wait every tile crossed starts a 24–870 KB
 * download that unmounting the preview does not cancel.
 */
const HOVER_PREVIEW_DELAY_MS = 150;

/** True when focus came from the keyboard — not from a click or a tap. */
function focusFromKeyboard(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return false; // a browser without :focus-visible throws on the selector
  }
}

type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; gifs: GifResult[] }
  | { kind: 'error'; message: string };

/**
 * Pick one GIF for a boost. Holds the GIPHY id only — the caller turns it into
 * the URL on the wire (`giphyGifUrl`), so the picker never decides what a
 * boostagram says.
 *
 * The URL comes out of the same 250-character budget as the typed words. The
 * CALLER owns that budget: it lowers the message box's `maxLength` while a GIF
 * is picked, and says so — and holds the send — when words typed earlier no
 * longer fit beside it.
 */
export function GifPicker({
  gifId,
  onChange,
  disabled = false,
}: {
  gifId: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [state, setState] = useState<SearchState>({ kind: 'idle' });
  // The ONE grid tile shown animated: the one the mouse rests on, or the one
  // keyboard focus is on. Every other tile stays a still.
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputId = useId();
  // Refused BEFORE any fetch and SAID so — the retype is as dangerous as the
  // first paste, so a silent no-op is not enough.
  const secretHit = looksLikeSecretKey(q);

  useEffect(() => () => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
  }, []);

  useEffect(() => {
    if (!open || secretHit) return;
    let live = true;
    setState({ kind: 'loading' });
    // The tiles unmount under the pointer, so no pointerleave clears this; a
    // new result list holding the same id would otherwise open animated.
    setPreviewId(null);
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
        setState({ kind: 'ready', gifs: body.gifs });
      } catch {
        if (live) setState({ kind: 'error', message: 'GIF search is not available now.' });
      }
    }, q.trim() ? SEARCH_DEBOUNCE_MS : 0);
    return () => { live = false; clearTimeout(t); };
  }, [open, q, secretHit]);

  if (gifId) {
    return (
      <div>
        <div className="text-[11px] uppercase tracking-widest text-muted">GIF</div>
        <div className="mt-1.5 flex items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- third-party animated media; next/image would re-encode it */}
          <img
            src={giphyPreviewUrl(gifId)}
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

  const startPreview = (id: string) => {
    if (disabled) return;
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => setPreviewId(id), HOVER_PREVIEW_DELAY_MS);
  };
  const endPreview = (id: string) => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = null;
    setPreviewId((p) => (p === id ? null : p));
  };

  const close = () => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    setPreviewId(null);
    setOpen(false);
    setQ('');
  };

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
        // The scroll box and the layout are two elements, and the layout is
        // CSS columns, not a grid. A grid inside a fixed-height scroll box
        // sized its rows from each tile's min-content height — which is 0 for
        // a percent-sized square — so iOS Safari squeezed every row to fit the
        // box and the tiles covered each other. Columns let each GIF keep its
        // own shape, uncropped, at the height its width gives it.
        <div
          className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain"
          aria-busy={state.kind === 'loading'}
        >
          <div className="columns-2 gap-2 sm:columns-3">
          {state.kind === 'ready'
            ? state.gifs.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className="mb-2 block min-h-[44px] w-full break-inside-avoid overflow-hidden rounded border border-line bg-bone/5 hover:border-bolt focus-visible:border-bolt disabled:opacity-40"
                  onClick={() => { onChange(g.id); close(); }}
                  // A MOUSE previews the tile it rests on, and so does
                  // keyboard focus. A touch does not: a tap is the pick, and
                  // the picked GIF animates above the message anyway. Gated on
                  // `pointerType`, not `(hover: hover)` — the chapter tip's
                  // rule (docs/ui.md), and headless Chrome matches neither
                  // media query, so only this shape can be tested.
                  onPointerEnter={(e) => { if (e.pointerType === 'mouse') startPreview(g.id); }}
                  onPointerLeave={() => endPreview(g.id)}
                  onFocus={(e) => { if (focusFromKeyboard(e.currentTarget)) startPreview(g.id); }}
                  onBlur={() => endPreview(g.id)}
                  // The grid can be open when Send is pressed. A pick after
                  // that would show a GIF the sent boost does not carry.
                  disabled={disabled}
                  title={g.title || 'GIF'}
                >
                  {/* The animation is laid OVER the still, not swapped into
                      its `src`: the still stays painted while the animation
                      loads, and both are 200px wide, so the tile neither
                      blanks nor changes height. The wrapper, not the button,
                      is the box, because the button's 44px floor can be
                      taller than a wide GIF. */}
                  <span className="relative block">
                    {/* eslint-disable-next-line @next/next/no-img-element -- third-party media */}
                    <img
                      src={giphyStillUrl(g.id)}
                      alt={g.title || 'GIF'}
                      loading="lazy"
                      className="block h-auto w-full"
                    />
                    {previewId === g.id && (
                      // eslint-disable-next-line @next/next/no-img-element -- third-party animated media
                      <img
                        src={giphyPreviewUrl(g.id)}
                        alt=""
                        aria-hidden="true"
                        data-gif-preview=""
                        className="absolute inset-0 h-full w-full"
                      />
                    )}
                  </span>
                </button>
              ))
            : Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="mb-2 h-32 w-full break-inside-avoid rounded border border-line bg-bone/5 animate-pulse" />
              ))}
          </div>
        </div>
      )}
      <div className="mt-2 text-right text-[10px] text-muted">Powered by GIPHY</div>
      </ModalShell>
    </>
  );
}
