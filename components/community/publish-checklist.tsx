'use client';

import type { ReactNode } from 'react';
import { ModalShell } from '@/components/modal-shell';
import { MIN_SONGS } from '@/lib/community/rules';

/**
 * What PUBLISH (or SAVE) still needs, opened when it is pressed too early.
 *
 * A playlist needs two things now (Chad, 2026-11-15: "nostr, title and 10 tracks
 * is it"; 2026-11-19: no Nostr account is needed, the browser keeps a key, and
 * <StartChoice> asks about the account, not this list), and
 * both are listed every time, done or not, so one press shows the whole list
 * rather than one reason at a time. Each missing item carries the button that
 * fixes it. Anything else `validatePlaylistDraft` refuses (a secret
 * key, a bad art link, a duplicate song) follows under ALSO FIX: those block the
 * send too, and a guard that withholds must say why.
 */
export function PublishChecklist({
  action,
  title,
  songs,
  others,
  onClose,
  onAddTitle,
  onAddSongs,
}: {
  action: 'PUBLISH' | 'SAVE';
  /** The line under "A title": the title as it will publish, never one holding a key; null when it is missing. */
  title: string | null;
  /** `have` is what `validatePlaylistDraft` counts: valid songs, a duplicate once. */
  songs: { ok: boolean; have: number };
  /** Each further refusal, already in words. */
  others: string[];
  onClose: () => void;
  onAddTitle: () => void;
  onAddSongs: () => void;
}) {
  const verb = action === 'SAVE' ? 'save' : 'publish';
  const short = MIN_SONGS - songs.have;
  return (
    <ModalShell onClose={onClose} label={`Before you ${verb}`} className="w-full max-w-md" closeButton>
      <div className="p-5" data-publish-check>
        <h2 className="pr-8 font-display text-xl">Before you {verb}</h2>
        <p className="mt-1 text-sm text-bone/80">
          A playlist needs both of these. {action} works when each one has a ✓.
        </p>
        <ul className="mt-3 divide-y divide-bone/15 border-y border-bone/15" aria-label="What a playlist needs">
          <Item
            id="title"
            ok={title !== null}
            label="A title"
            detail={title ?? 'Give the playlist a name.'}
            clip={title !== null}
            fix={<button type="button" className="btn-ghost btn-compact" onClick={onAddTitle}>ADD TITLE</button>}
          />
          <Item
            id="songs"
            ok={songs.ok}
            label={`At least ${MIN_SONGS} songs`}
            detail={songs.ok
              ? `${songs.have} songs.`
              : `${songs.have} of ${MIN_SONGS} now. Add ${short} more.`}
            fix={<button type="button" className="btn-ghost btn-compact" onClick={onAddSongs}>+ ADD SONGS</button>}
          />
        </ul>
        {others.length > 0 && (
          <div className="mt-3" data-check-others>
            <p className="font-mono text-xs uppercase tracking-wider text-muted">ALSO FIX</p>
            <ul className="mt-1 space-y-1 text-sm text-bone/90">
              {others.map((o, i) => <li key={i}>{o}</li>)}
            </ul>
          </div>
        )}
        <button type="button" className="btn-ghost btn-compact mt-4" onClick={onClose}>OK</button>
      </div>
    </ModalShell>
  );
}

function Item({ id, ok, label, detail, fix, clip = false }: {
  id: string; ok: boolean; label: string; detail: string; fix: ReactNode;
  /** One line, cut with an ellipsis: for the title the user typed, which can be long. */
  clip?: boolean;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3" data-check-item={id} data-check-ok={ok ? 'true' : 'false'}>
      <span aria-hidden
        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center border font-mono text-sm ${ok ? 'border-bolt/60 text-bolt' : 'border-nostr/60 text-nostr'}`}>
        {ok ? '✓' : '✗'}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-bone"><span className="sr-only">{ok ? 'Done: ' : 'Missing: '}</span>{label}</p>
        <p className={`${clip ? 'truncate ' : ''}text-xs text-bone/70`}>{detail}</p>
      </div>
      {!ok && <div className="shrink-0">{fix}</div>}
    </li>
  );
}
