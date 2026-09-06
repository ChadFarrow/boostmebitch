'use client';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ModalShell } from './modal-shell';

/**
 * An in-app confirmation, in place of `window.confirm()`.
 *
 * Four confirmations used the native dialog, two of them on the money path (a
 * Spark seed about to be OVERWRITTEN on the relays). A native dialog is
 * unstyleable, is suppressed outright once the browser's "prevent this page
 * from creating additional dialogs" box has been ticked, and is unreliable
 * inside an installed PWA / Trusted Web Activity — which this app ships as. It
 * also cannot say "this deletes a wallet" in anything but a wall of text.
 *
 * `<ModalShell>` already owns a focus trap, `aria-modal`, Escape, the shared
 * scroll lock and the portal, so a confirm is a small card inside it. It stacks
 * correctly over the wallet modal because every shell portals to `document.body`
 * and the scroll lock is refcounted app-wide.
 *
 * `useConfirm()` returns `[confirm, element]`: call `await confirm({...})` where
 * `window.confirm(...)` used to be, and render `element` once anywhere in the
 * component's tree. Escape and the backdrop resolve `false`, the same answer
 * the native dialog gave for a dismissal.
 */
export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  /** The affirmative button's word. Name the ACTION ("Overwrite backup"), never "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Paints the affirmative button as destructive: an overwrite, an erase. */
  danger?: boolean;
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmOptions & { onConfirm: () => void; onCancel: () => void }) {
  return (
    <ModalShell onClose={onCancel} label={title} className="w-full max-w-sm p-5">
      <h2 className="font-display text-xl mb-2">{title}</h2>
      <div className="text-sm text-bone/80 leading-relaxed space-y-2">{body}</div>
      <div className="flex flex-wrap justify-end gap-2 mt-5">
        <button type="button" onClick={onCancel} className="btn-ghost">
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          // The affirmative is NOT the default-focused control: the focus trap
          // lands on the first focusable, which is Cancel, so a stray Enter
          // cannot confirm an erase. `danger` names the colour, not the order.
          className={danger ? 'btn border-nostr text-nostr hover:bg-nostr/10' : 'btn'}
        >
          {confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}

export function useConfirm(): [(opts: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpts(null);
  }, []);

  const confirm = useCallback((next: ConfirmOptions) => {
    // A second ask while one is open answers the first with `false` rather
    // than leaving its caller waiting forever.
    resolver.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setOpts(next);
    });
  }, []);

  const element = opts ? (
    <ConfirmDialog {...opts} onConfirm={() => settle(true)} onCancel={() => settle(false)} />
  ) : null;

  return [confirm, element];
}
