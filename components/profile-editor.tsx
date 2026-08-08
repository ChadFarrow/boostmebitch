'use client';

// Editing a kind:0 is not the same job as rendering one, and the difference is
// the reason this component exists rather than a form over `identity.profile`.
//
// A kind:0 is replaceable: whatever we publish REPLACES the user's profile
// everywhere, wholesale. So the risk here isn't a bad edit, it's a silent
// deletion — every field we fail to carry forward is gone from every client,
// with no error and nothing on screen to notice. `identity.profile` is a
// `ProfileMetadata`, which `coerceProfileMetadata` has already narrowed to
// seven known string fields, so a form built over it would drop `banner`,
// `website` and anything else the user set elsewhere the moment they changed
// their display name.
//
// Hence: fetch the author's RAW content (`fetchRawProfile`), edit a handful of
// keys on top of it, publish the merge. And refuse entirely when the fetch
// wasn't trustworthy — see the guard in `load()`.

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { coerceProfileMetadata, fetchRawProfile, publishProfile, type NostrIdentity } from '@/lib/nostr';
import { useApp } from '@/lib/store';
import { getErrorMessage } from '@/lib/util';

/** The keys this editor manages. Everything else in the fetched content is
 *  passed through untouched — that's the whole contract, and it's why dropping
 *  a field from this list does NOT delete it from the user's profile. `about`
 *  and `lud16` were both here and were removed: a user who set either in
 *  another client keeps it, because we merge rather than rebuild.
 *
 *  Note what dropping `lud16` costs, since it isn't visible from here: it's the
 *  field other clients read to decide whether to show a zap button. Nobody who
 *  onboards through Google gets one, so they remain unzappable outside this app
 *  until something else writes it. */
const FIELDS = [
  {
    key: 'display_name',
    label: 'Name',
    placeholder: 'How you want to be known',
    hint: null,
  },
  {
    key: 'name',
    label: 'Handle',
    placeholder: 'shortname',
    hint: 'No spaces, lowercase. Some clients show this as @handle instead of your name.',
  },
  {
    key: 'picture',
    label: 'Picture URL',
    placeholder: 'https://…',
    hint: 'A direct link to an image. There is no upload — paste a URL.',
  },
] as const;

type FieldKey = (typeof FIELDS)[number]['key'];
type Draft = Record<FieldKey, string>;

const EMPTY_DRAFT: Draft = { display_name: '', name: '', picture: '' };

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function ProfileEditor({
  identity,
  onClose,
}: {
  identity: NostrIdentity;
  onClose: () => void;
}) {
  const setIdentity = useApp((s) => s.setIdentity);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  /** The author's own kind:0 content, which we merge over. null until loaded. */
  const [base, setBase] = useState<Record<string, unknown> | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'blocked' | 'saving' | 'saved'>('loading');
  const [err, setErr] = useState<string | null>(null);
  /**
   * kind:0 carries two name fields and almost nobody wants both. `display_name`
   * is what actually renders — every client here and in the wild resolves
   * `display_name || name` — while `name` is the older handle some clients show
   * as `@name`. Onboarding sets both to the same string, so for most users the
   * distinction is noise.
   *
   * So: one box, and this second one appears only for someone who already has a
   * genuinely different handle (or asks for one). Deleting the field outright
   * was the tempting version and it's wrong — the merge preserves keys it
   * doesn't manage, so a `name` we stopped showing would be stuck forever,
   * invisibly disagreeing with the display name in every client that renders a
   * handle. Hidden here means SYNCED, not ignored; see save().
   */
  const [showHandle, setShowHandle] = useState(false);

  const load = useCallback(async () => {
    setPhase('loading');
    setErr(null);
    try {
      const { content, trustworthy } = await fetchRawProfile(identity.pubkey, identity.writeRelays);
      if (!trustworthy) {
        // Not a network error to shrug at. Publishing an edit assembled after a
        // degraded read overwrites the real profile with whatever little we
        // managed to see — the same wipe as building from a truncated parse,
        // just triggered by a timeout. "Nobody had it" and "nothing answered"
        // are the same null without this flag, so we stop instead of guessing.
        setPhase('blocked');
        return;
      }
      const c = content ?? {};
      setBase(c);
      const dn = str(c.display_name).trim();
      const nm = str(c.name).trim();
      setDraft({
        // Fall back to `name` so someone whose only name field is the old one
        // doesn't open an empty box and think their profile is blank.
        display_name: dn || nm,
        name: nm,
        picture: str(c.picture),
      });
      // Only surface the handle when it's genuinely a second, different name.
      // One of them being absent isn't a disagreement — it's a profile that
      // never set it, and save() will fill it in.
      setShowHandle(dn !== '' && nm !== '' && dn !== nm);
      setPhase('ready');
    } catch (e) {
      setErr(getErrorMessage(e, 'could not read your profile'));
      setPhase('blocked');
    }
  }, [identity.pubkey, identity.writeRelays]);

  useEffect(() => {
    setPortalTarget(document.body);
    void load();
  }, [load]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pic = draft.picture.trim();
  const picInvalid = pic !== '' && !/^https?:\/\//i.test(pic);

  async function save() {
    if (base === null || picInvalid) return;
    setPhase('saving');
    setErr(null);
    try {
      // Spread over the author's own content so every field this editor doesn't
      // model survives. A blank input DELETES its key rather than writing '',
      // so clearing a field reads as absent to other clients instead of as an
      // empty string they then render.
      const merged: Record<string, unknown> = { ...base };
      for (const { key } of FIELDS) {
        if (key === 'name' && !showHandle) continue; // handled below
        const v = draft[key].trim();
        if (v) merged[key] = v;
        else delete merged[key];
      }
      if (!showHandle) {
        // With no handle box on screen, `name` tracks the one name the user can
        // see. Leaving it at its old value instead is what would strand a
        // profile reading "Chad Farrow" as @amber-otter in every client that
        // shows a handle — the field would be unreachable from this editor and
        // wrong forever.
        const n = draft.display_name.trim();
        if (n) merged.name = n;
        else delete merged.name;
      }

      const res = await publishProfile(identity, merged);
      if (res.acceptedRelays.length === 0) {
        throw new Error('No relay accepted the update. Check your connection and try again.');
      }

      // Reflect it in the header immediately. publishProfile already reseeded
      // storage.profile; this is the in-memory identity the UI renders from.
      const parsed = coerceProfileMetadata(merged);
      if (parsed) setIdentity({ ...identity, profile: parsed });

      setPhase('saved');
      setTimeout(onClose, 900);
    } catch (e) {
      setErr(getErrorMessage(e, 'could not publish your profile'));
      setPhase('ready');
    }
  }

  if (!portalTarget) return null;

  const busy = phase === 'saving';

  return createPortal(
    // pb-28 so the centered card clears the mini-player bar.
    <div className="fixed inset-0 z-40 bg-ink/85 backdrop-blur-sm flex items-center justify-center p-4 pb-28">
      <div className="card w-full max-w-md bg-ink relative max-h-[92vh] overflow-y-auto">
        <button
          onClick={onClose}
          className="absolute top-2 right-3 text-muted hover:text-bone text-lg z-10"
          aria-label="Close"
        >
          ×
        </button>

        <div className="p-5 border-b border-bone/15">
          <div className="stamp text-nostr border-nostr/60 mb-2">◆ NOSTR PROFILE</div>
          <h3 className="font-display text-2xl leading-tight">Edit your profile</h3>
          <p className="text-xs text-muted mt-1">
            This is your public Nostr profile — every other client sees it too.
          </p>
        </div>

        {phase === 'loading' && (
          <div className="p-5 text-xs text-muted">Reading your current profile…</div>
        )}

        {phase === 'blocked' && (
          <div className="p-5 flex flex-col gap-3">
            <div className="text-[11px] text-bolt/90 border border-bolt/40 bg-bolt/10 px-2 py-2">
              {err ??
                "Couldn't reach enough relays to read your current profile. Saving now could " +
                  'erase fields set from another client, so editing is disabled until a read succeeds.'}
            </div>
            <button onClick={() => void load()} className="btn-ghost text-[11px] self-start">
              Try again
            </button>
          </div>
        )}

        {(phase === 'ready' || busy || phase === 'saved') && (
          <div className="p-5 flex flex-col gap-4">
            {FIELDS.filter((f) => f.key !== 'name' || showHandle).map((f) => (
              <label key={f.key} className="flex flex-col gap-1">
                <span className="text-[11px] uppercase tracking-wide text-muted">{f.label}</span>
                <input
                  className="input"
                  value={draft[f.key]}
                  placeholder={f.placeholder}
                  disabled={busy}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                />
                {f.key === 'picture' && picInvalid ? (
                  <span className="text-[10px] text-nostr">Must start with http:// or https://</span>
                ) : (
                  f.hint && <span className="text-[10px] text-muted">{f.hint}</span>
                )}
              </label>
            ))}

            {!showHandle && (
              <button
                type="button"
                onClick={() => {
                  // Seed it from the visible name so turning this on doesn't
                  // read as "your handle is empty" — it isn't, it's just been
                  // tracking the name until now.
                  setDraft((d) => ({ ...d, name: d.name.trim() || d.display_name.trim() }));
                  setShowHandle(true);
                }}
                disabled={busy}
                className="text-[10px] text-muted hover:text-bone self-start -mt-2"
              >
                + use a separate handle
              </button>
            )}

            {err && <div className="text-[11px] text-nostr">{err}</div>}

            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={() => void save()}
                disabled={busy || picInvalid || phase === 'saved'}
                className="btn-bolt text-xs disabled:opacity-40"
              >
                {busy ? 'Publishing…' : phase === 'saved' ? 'Published ✓' : 'Publish'}
              </button>
              <button onClick={onClose} disabled={busy} className="btn-ghost text-xs">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    portalTarget,
  );
}
