'use client';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  localMentionCandidates,
  indexMentionCandidates,
  mergeMentionCandidates,
  warmMentionCandidates,
  MIN_MENTION_QUERY,
  type MentionCandidate,
} from '@/lib/nostr/mention-search';
import { parseNpubInput, looksLikeSecretKey } from '@/lib/nostr/npub-input';
import { MAX_MENTION_NPUBS, type MentionNpub } from '@/lib/nostr/mention-tags';
import { fetchProfilesFor } from '@/lib/nostr';
import { storage } from '@/lib/storage';
import { shortNpub } from '@/lib/nostr/profile-metadata';
import { Avatar } from '../avatar';

/** How long a keystroke waits before the index is asked. */
const SEARCH_DEBOUNCE_MS = 200;

/** The `@…` immediately before the caret, if the caret is inside one. */
function activeMention(value: string, caret: number): { q: string; start: number } | null {
  const upto = value.slice(0, caret);
  // An '@' only opens a mention at the start of the text or after whitespace,
  // so an email address and a nip05 in prose do not turn into a picker.
  const m = /(?:^|\s)@([^\s@]*)$/.exec(upto);
  if (!m) return null;
  return { q: m[1], start: caret - m[1].length - 1 };
}

/** Whether the index answered at all — the two empties are not the same. */
type IndexState = 'idle' | 'searching' | 'answered' | 'unavailable';

export function MessageInput({
  value,
  onChange,
  mentions = [],
  onMentionsChange,
  feedNpubs = [],
  willNotify = true,
}: {
  value: string;
  onChange: (v: string) => void;
  /** People the sender has attached. Identity lives here, not in the text. */
  mentions?: MentionNpub[];
  onMentionsChange?: (m: MentionNpub[]) => void;
  /** The npubs the boosted feed declares for itself — the first candidates. */
  feedNpubs?: readonly MentionNpub[];
  /**
   * Will these mentions actually reach anybody? False when the note will be
   * signed by the site (signed out, or the share picker set to Anonymous), in
   * which case they appear in the note body and carry no `p` tag.
   */
  willNotify?: boolean;
}) {
  const id = useId();
  const listId = useId();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [rows, setRows] = useState<MentionCandidate[]>([]);
  const [indexState, setIndexState] = useState<IndexState>('idle');
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const pickable = !!onMentionsChange;

  const trigger = useMemo(
    () => (pickable ? activeMention(value, caret) : null),
    [pickable, value, caret],
  );
  const q = trigger?.q ?? '';

  /**
   * A pasted secret key, refused BEFORE any decode or fetch.
   *
   * `looksLikeSecretKey` is a prefix test that never decodes, so a truncated
   * paste is caught and this component never holds the key. The refusal is
   * RENDERED rather than a silent no-op: retyping is as dangerous as the first
   * paste, and a key that reaches a third party cannot be recalled. Checked
   * against the whole field, not just the `@…` run, because the dangerous case
   * is a paste anywhere in the box.
   */
  const secretHit = useMemo(() => looksLikeSecretKey(value), [value]);

  const full = mentions.length >= MAX_MENTION_NPUBS;

  // Warm the follow list's names once the picker can be used. One batched call
  // for the whole list — never a fetchProfile per candidate.
  useEffect(() => {
    if (!pickable) return;
    void warmMentionCandidates(feedNpubs);
  }, [pickable, feedNpubs]);

  // Local tier: synchronous, every keystroke, no network.
  useEffect(() => {
    if (!pickable || dismissed || secretHit || full || q.length < MIN_MENTION_QUERY) {
      setRows([]);
      setIndexState('idle');
      return;
    }
    setRows(localMentionCandidates(q, feedNpubs));
    setActive(0);
  }, [pickable, dismissed, secretHit, full, q, feedNpubs]);

  // Index tier: debounced, merged UNDER the local rows.
  useEffect(() => {
    if (!pickable || dismissed || secretHit || full || q.length < MIN_MENTION_QUERY) return;
    let live = true;
    setIndexState('searching');
    const t = setTimeout(async () => {
      const found = await indexMentionCandidates(q);
      if (!live) return;
      // null is "no answer", [] is "answered, nobody by that name". Rendering
      // them the same way would tell somebody their friend is not on nostr
      // because a service was down.
      setIndexState(found ? 'answered' : 'unavailable');
      if (found) setRows((prev) => mergeMentionCandidates(prev, found, q));
    }, SEARCH_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(t); };
  }, [pickable, dismissed, secretHit, full, q]);

  const syncCaret = useCallback(() => {
    const el = areaRef.current;
    if (el) setCaret(el.selectionStart ?? 0);
  }, []);

  /**
   * Attach somebody, and put their NAME in the text — not their npub.
   *
   * A bech32 npub is 63 characters against this field's 200, and the same
   * string becomes the boostagram TLV message and the LNURL comment, where
   * `buildLnurlComment` truncates it against the recipient's `commentAllowed`
   * with nothing reporting that it did. A `nostr:npub…` clipped mid-string is a
   * mangled identifier on the wire. The identifier only ever enters the note
   * body, added by `withMentions` at publish time from `mentions`.
   */
  function pick(c: MentionCandidate) {
    if (!onMentionsChange || !trigger) return;
    const before = value.slice(0, trigger.start);
    const after = value.slice(caret);
    const inserted = `@${c.name} `;
    const next = `${before}${inserted}${after}`;
    onChange(next);
    if (!mentions.some((m) => m.pubkey === c.pubkey)) {
      onMentionsChange([...mentions, { npub: c.npub, pubkey: c.pubkey }]);
    }
    setRows([]);
    setIndexState('idle');
    requestAnimationFrame(() => {
      const el = areaRef.current;
      if (!el) return;
      const pos = before.length + inserted.length;
      el.focus();
      el.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  }

  /** Attach a pasted npub / nprofile / profile URL, name resolved after. */
  function attachPasted() {
    if (!onMentionsChange || secretHit) return;
    const parsed = parseNpubInput(q);
    if (!parsed || mentions.some((m) => m.pubkey === parsed.pubkey)) return;
    const cached = storage.profile.get(parsed.pubkey);
    pick({
      pubkey: parsed.pubkey,
      npub: parsed.npub,
      name: cached?.display_name?.trim() || cached?.name?.trim() || shortNpub(parsed.npub),
      source: 'index',
    });
    // Resolve the name for the chip. Failure costs a label, never the mention.
    if (!cached) void fetchProfilesFor([parsed.pubkey]).catch(() => {});
  }

  const pastedNpub = pickable && !secretHit && !full ? parseNpubInput(q) : null;
  const open = pickable && !secretHit && !!trigger && q.length >= MIN_MENTION_QUERY &&
    (rows.length > 0 || !!pastedNpub || indexState !== 'idle');

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % Math.max(rows.length, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + rows.length) % Math.max(rows.length, 1)); }
    else if (e.key === 'Enter' && rows[active]) { e.preventDefault(); pick(rows[active]); }
    else if (e.key === 'Enter' && pastedNpub && !rows.length) { e.preventDefault(); attachPasted(); }
    else if (e.key === 'Escape') { e.preventDefault(); setDismissed(true); }
  }

  return (
    <div>
      <label htmlFor={id} className="text-[11px] uppercase tracking-widest text-muted">
        Boostagram
      </label>
      <div className="relative">
        <textarea
          id={id}
          ref={areaRef}
          className="input mt-1.5 resize-none"
          rows={2}
          maxLength={200}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart ?? 0);
            setDismissed(false);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          role={pickable ? 'combobox' : undefined}
          aria-expanded={pickable ? open : undefined}
          aria-controls={pickable && open ? listId : undefined}
          aria-autocomplete={pickable ? 'list' : undefined}
          aria-activedescendant={open && rows[active] ? `${listId}-${active}` : undefined}
          placeholder={pickable ? 'optional message… @ to mention' : 'optional message…'}
        />

        {open && (
          <ul
            id={listId}
            role="listbox"
            aria-label="Mention someone"
            className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto overscroll-contain rounded border border-line bg-ink shadow-lg"
          >
            {rows.map((c, i) => (
              <li key={c.pubkey} id={`${listId}-${i}`} role="option" aria-selected={i === active}>
                {/* min-h rather than padding: WCAG 2.5.8 wants 24x24, and a row
                    that merely looks tall enough is the violation nobody spots
                    in review. */}
                <button
                  type="button"
                  className={`flex min-h-[44px] w-full items-center gap-2 px-2 text-left text-sm ${
                    i === active ? 'bg-bone/10' : ''
                  }`}
                  // onMouseDown, not onClick: the textarea loses focus on
                  // mousedown and the list unmounts before a click ever lands.
                  onMouseDown={(e) => { e.preventDefault(); pick(c); }}
                  onMouseEnter={() => setActive(i)}
                >
                  <Avatar pubkey={c.pubkey} picture={c.picture} name={c.name} className="h-6 w-6 shrink-0 rounded-full" />
                  <span className="truncate text-bone">{c.name}</span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-muted">
                    {c.source === 'feed' ? 'on this feed' : c.source === 'follow' ? 'you follow' : shortNpub(c.npub, 5)}
                  </span>
                </button>
              </li>
            ))}

            {pastedNpub && !rows.length && (
              <li role="option" aria-selected>
                <button
                  type="button"
                  className="flex min-h-[44px] w-full items-center gap-2 px-2 text-left text-sm"
                  onMouseDown={(e) => { e.preventDefault(); attachPasted(); }}
                >
                  <span className="truncate text-bone">Mention {shortNpub(pastedNpub.npub)}</span>
                </button>
              </li>
            )}

            {!rows.length && !pastedNpub && (
              <li className="px-2 py-2 text-xs text-muted">
                {indexState === 'searching' ? 'Searching…'
                  // The two empties, said differently on purpose. "Nobody here"
                  // is a claim about a corpus of people who have posted a boost
                  // — never about who exists on nostr.
                  : indexState === 'unavailable'
                    ? "Can't reach the directory — paste an npub instead."
                    : 'Nobody here by that name. Paste an npub to mention anyone.'}
              </li>
            )}
          </ul>
        )}
      </div>

      {secretHit && (
        <p className="mt-1.5 flex items-start gap-2 rounded border border-red-400/50 bg-red-400/5 px-3 py-2 text-xs text-red-300">
          <span aria-hidden className="shrink-0">⚠</span>
          <span>
            That is a <strong>secret key</strong>. Nothing was looked up and nothing was
            sent anywhere. Clear the box, and paste an <code className="font-mono">npub</code>{' '}
            instead — never an <code className="font-mono">nsec</code>.
          </span>
        </p>
      )}

      {pickable && mentions.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {mentions.map((m) => (
            <button
              key={m.pubkey}
              type="button"
              className="flex min-h-[24px] items-center gap-1 rounded-full border border-line px-2 text-[11px] text-muted hover:text-bone"
              onClick={() => onMentionsChange?.(mentions.filter((x) => x.pubkey !== m.pubkey))}
              aria-label={`Remove mention of ${storage.profile.get(m.pubkey)?.name ?? shortNpub(m.npub)}`}
            >
              <span className="truncate">
                @{storage.profile.get(m.pubkey)?.display_name?.trim()
                  || storage.profile.get(m.pubkey)?.name?.trim()
                  || shortNpub(m.npub, 5)}
              </span>
              <span aria-hidden>×</span>
            </button>
          ))}
          {/* A guard that withholds must SAY it withholds. Signed out or
              Anonymous, the note is signed by the site's own identity, and a
              sender-chosen `p` tag there would let one unauthenticated request
              notify strangers from a verified name. The mention still appears
              in the note; it just does not ring anybody. Silence here would be
              indistinguishable from the picker being broken. */}
          {!willNotify && (
            <span className="w-full text-[11px] text-muted">
              Mentions will show in the note but won&apos;t notify anyone unless you post as
              yourself.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
