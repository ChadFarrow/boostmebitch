'use client';
import { memo, useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ModalShell } from './modal-shell';
import {
  resolvePublishRelays,
  shortNpub,
  type DiscoveredNote,
} from '@/lib/nostr';
import { publishQuoteRepost, publishReply, publishRepost } from '@/lib/nostr/interactions';
import { sendZap } from '@/lib/v4v/zap';
import { useApp } from '@/lib/store';
import { loadEpisodeFromFeed } from '@/lib/podcast-meta';
import type { Episode, Podcast } from '@/lib/types';
import { getErrorMessage } from '@/lib/util';
import { linkify, extractImages, stripNostrUris, timeAgo } from '@/lib/format';
import { Avatar } from './avatar';
import { FollowButton } from './follow-button';

type ActionState = 'idle' | 'busy' | 'done' | 'error';

/**
 * Single Nostr note card with an action bar (reply / repost / quote / zap).
 * `podcast` is the show this note references — if provided, a small
 * "→ podcast title" line renders under the author header. The per-podcast
 * feed leaves it out since every card on that surface is about the same show.
 *
 * `episode` is the item the note's `podcast:item:guid:` tag names, resolved by
 * the feed surface. It renders to the right of the show on that same line and
 * opens the episode page, so a boost can be followed to the thing that was
 * boosted rather than only to its show. Requires `podcast` — the episode is
 * fetched out of the show's own feed, and the show has to be selected first
 * either way (see the click handler).
 *
 * `repostedIds` is the set of note ids the signed-in viewer has previously
 * reposted (kind:6 events) — used to seed the repost button into its "done"
 * state across reloads. The same set is threaded down through nested replies.
 */
function NoteCardImpl({
  note,
  podcast,
  episode,
  repostedIds,
  depth = 0,
}: {
  note: DiscoveredNote;
  podcast?: Podcast | null;
  episode?: Episode | null;
  repostedIds?: Set<string>;
  depth?: number;
}) {
  const identity = useApp((s) => s.identity);
  const mutedPubkeys = useApp((s) => s.mutedPubkeys);
  const mutePubkey = useApp((s) => s.mutePubkey);
  const selectPodcast = useApp((s) => s.selectPodcast);
  const openEpisode = useApp((s) => s.openEpisode);
  const syncSelectedPodcast = useApp((s) => s.syncSelectedPodcast);
  const name =
    note.author?.display_name?.trim() ||
    note.author?.name?.trim() ||
    shortNpub(note.npub);
  const visibleReplies = (note.replies ?? []).filter((r) => !mutedPubkeys.has(r.pubkey));
  const sats =
    note.amountMsat && note.amountMsat > 0
      ? Math.round(note.amountMsat / 1000)
      : null;
  const { body: contentBody, images: contentImages } = extractImages(
    stripNostrUris(note.content),
  );

  const [composerMode, setComposerMode] = useState<'reply' | 'quote' | null>(null);
  const [composerDraft, setComposerDraft] = useState('');
  const [composerState, setComposerState] = useState<ActionState>('idle');
  const [composerErr, setComposerErr] = useState<string | null>(null);

  const alreadyReposted = repostedIds?.has(note.id) ?? false;
  const [repostState, setRepostState] = useState<ActionState>(
    alreadyReposted ? 'done' : 'idle',
  );
  const [repostErr, setRepostErr] = useState<string | null>(null);

  // Promote idle → done if the persisted set arrives after mount (login race
  // or async useViewerReposts resolution). Don't downgrade — once the user has
  // pressed repost in this session we always show 'done'.
  useEffect(() => {
    if (alreadyReposted && repostState === 'idle') setRepostState('done');
  }, [alreadyReposted, repostState]);

  const [zapOpen, setZapOpen] = useState(false);
  const router = useRouter();

  function openShow(p: Podcast) {
    selectPodcast(p);
    if (typeof window === 'undefined') return;
    // `selectedPodcast` is read by <HomePage>, and <HomePage> renders at `/`
    // only. This card also renders on /npub/<npub>, where setting the store
    // changes nothing you can see — the tap scrolled to the top and did
    // otherwise NOTHING, with no error to notice. The selection is already in
    // the (in-memory) store and survives a client-side navigation, so go to the
    // view that reads it.
    if (window.location.pathname !== '/') {
      // Record where we're leaving from, AFTER selectPodcast (which clears it),
      // so the show page's back control offers a return here instead of "back
      // to results" — a results list a visitor who arrived on /npub/<npub> has
      // never seen. The label can't be derived from the path, so it's named.
      useApp.getState().setShowOrigin({ path: window.location.pathname, label: 'boosts' });
      router.push('/');
    }
    window.scrollTo({ top: 0 });
  }

  /**
   * Open the boosted episode. Deliberately the same three steps
   * <FavoriteEpisodesList> takes, for the same reasons spelled out there: the
   * show goes up FIRST (it's what's on screen while the feed loads, it's where
   * we stay if the guid isn't in the feed, and `selectPodcast` clears
   * `selectedEpisode` so opening the episode before it would undo itself), the
   * real Episode comes out of `/api/feed` rather than the PI record this line
   * was labelled from (only the feed route carries the value block, show notes
   * and transcripts an episode page needs), and a second tap during the fetch
   * wins over a slow response.
   *
   * `episode` here is PI's indexed record — good enough to print a title and to
   * name a guid, not good enough to hand to the player or the boost modal.
   */
  async function openBoostedEpisode(p: Podcast, guid: string) {
    openShow(p);
    const loaded = await loadEpisodeFromFeed(p.id, guid);
    if (!loaded) return;
    const selected = useApp.getState().selectedPodcast;
    if (!selected || selected.id !== p.id) return;
    syncSelectedPodcast(loaded.podcast);
    if (loaded.episode) openEpisode(loaded.episode);
  }

  function openComposer(mode: 'reply' | 'quote') {
    setComposerMode((curr) => (curr === mode ? null : mode));
    setComposerErr(null);
    setComposerState('idle');
  }

  function closeComposer() {
    setComposerMode(null);
    setComposerDraft('');
    setComposerErr(null);
    setComposerState('idle');
  }

  async function onSendComposer() {
    if (!identity || !composerMode) return;
    if (composerMode === 'reply' && !composerDraft.trim()) return;
    setComposerState('busy');
    setComposerErr(null);
    try {
      if (composerMode === 'reply') {
        await publishReply({
          parent: note.rawEvent,
          content: composerDraft.trim(),
          relays: resolvePublishRelays(identity),
        });
      } else {
        await publishQuoteRepost({
          parent: note.rawEvent,
          comment: composerDraft,
          relays: resolvePublishRelays(identity),
        });
      }
      setComposerState('done');
      closeComposer();
    } catch (e) {
      setComposerErr(getErrorMessage(e, `${composerMode} failed`));
      setComposerState('error');
    }
  }

  async function onRepost() {
    if (!identity || repostState === 'busy' || repostState === 'done') return;
    setRepostState('busy');
    setRepostErr(null);
    try {
      await publishRepost({
        parent: note.rawEvent,
        relays: resolvePublishRelays(identity),
      });
      setRepostState('done');
    } catch (e) {
      setRepostErr(getErrorMessage(e, 'repost failed'));
      setRepostState('error');
    }
  }

  // Filter applied AFTER all hooks have run so the hook count stays
  // consistent across mute toggles. Returning null here is safe because every
  // hook above is already executed; the parent (feed surface or another
  // NoteCard's reply list) also filters so we usually don't even reach this.
  if (mutedPubkeys.has(note.pubkey)) return null;

  // Hoisted out of the JSX so the guid narrowing survives into the click
  // handler's closure — TS drops property narrowing on a parameter inside a
  // callback, and an episode with no guid can't be looked up in the feed.
  const episodeGuid = episode?.guid;

  function onMute() {
    if (!identity) return;
    const ok =
      typeof window !== 'undefined' &&
      window.confirm(
        `Mute ${name}? Their notes won't appear in your feed. You can unmute from the account menu.`,
      );
    if (!ok) return;
    mutePubkey(note.pubkey);
  }

  return (
    <div>
    <article className="card p-3 flex gap-3">
      <Avatar
        pubkey={note.pubkey}
        picture={note.author?.picture}
        name={note.author?.display_name || note.author?.name}
        className="w-9 h-9 rounded-full border border-bone/20 flex-shrink-0 text-sm"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <a
            href={`https://njump.me/${note.npub}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-display text-sm text-bone hover:text-bolt truncate"
            title={note.npub}
          >
            {name}
          </a>
          <FollowButton pubkey={note.pubkey} />
          <span className="text-muted">· {timeAgo(note.createdAt)}</span>
          {note.isBoost && sats !== null && (
            <span className="stamp text-bolt border-bolt/60">⚡ {sats} sats</span>
          )}
          {note.isBoost && sats === null && (
            <span className="stamp text-bolt border-bolt/60">⚡ boost</span>
          )}
          {note.client && <span className="text-muted">via {note.client}</span>}
        </div>

        {podcast && (
          <div className="flex items-center gap-2 mt-1.5 text-[11px] text-muted">
            {podcast.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={podcast.image}
                alt=""
                className="w-4 h-4 object-cover border border-bone/20 flex-shrink-0"
              />
            ) : null}
            <span className="truncate">
              <span className="text-nostr">→</span>{' '}
              <button
                type="button"
                onClick={() => openShow(podcast)}
                className="text-bone hover:text-bolt hover:underline underline-offset-2"
              >
                {podcast.title}
              </button>
              {/* The episode replaces the show author rather than joining it:
                  three parts on one truncating line means the episode — the
                  more specific of the two, and the only one that's a link —
                  is the part that gets cut off. */}
              {episodeGuid && episode?.title ? (
                <>
                  {' · '}
                  <button
                    type="button"
                    onClick={() => openBoostedEpisode(podcast, episodeGuid)}
                    className="text-muted hover:text-bolt hover:underline underline-offset-2"
                    title={episode.title}
                  >
                    {episode.title}
                  </button>
                </>
              ) : podcast.author ? (
                <span className="text-muted"> · {podcast.author}</span>
              ) : null}
            </span>
          </div>
        )}

        {contentBody && (
          <p className="text-sm text-bone whitespace-pre-wrap break-words mt-1.5">
            {linkify(contentBody)}
          </p>
        )}

        {contentImages.length > 0 && (
          <div className="mt-2 flex flex-col gap-2">
            {contentImages.map((src) => (
              <a
                key={src}
                href={src}
                target="_blank"
                rel="noopener noreferrer"
                className="block"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={src}
                  alt=""
                  loading="lazy"
                  // A boost note's image is ARTWORK, not a photo the author
                  // chose to show: every boost carries one (lib/nostr/
                  // boost-notes.ts names a 4:1 banner, and other boost clients
                  // do the same), so it is sized to the COLUMN — full width,
                  // short — rather than to itself. Left at the 320px cap a
                  // hand-written note gets, a scrolling feed becomes a stack of
                  // squares with the sats, the show and the message pushed
                  // apart. `object-contain` keeps a foreign client's
                  // differently-shaped banner from being cropped, and the cap
                  // still bounds a square one. A note somebody wrote by hand
                  // keeps the large size — there the picture IS the post.
                  className={`rounded-lg border border-bone/15 object-contain ${
                    note.isBoost ? 'w-full max-h-56' : 'max-w-full w-auto max-h-80'
                  }`}
                />
              </a>
            ))}
          </div>
        )}

        <div className="flex items-center gap-3 mt-2 text-[11px] flex-wrap">
          {identity ? (
            <>
              <button
                onClick={() => openComposer('reply')}
                className="text-muted hover:text-nostr"
                aria-label="Reply"
                title="Reply"
              >
                💬 reply
              </button>
              <button
                onClick={onRepost}
                disabled={repostState === 'busy' || repostState === 'done'}
                className={
                  repostState === 'done'
                    ? 'text-nostr disabled:opacity-100'
                    : 'text-muted hover:text-nostr disabled:opacity-60'
                }
                aria-label="Repost"
                title={repostState === 'done' ? 'Already reposted' : 'Repost'}
              >
                {repostState === 'done' ? '🔁 reposted' : repostState === 'busy' ? '🔁 …' : '🔁 repost'}
              </button>
              <button
                onClick={() => openComposer('quote')}
                className="text-muted hover:text-nostr"
                aria-label="Quote"
                title="Quote repost"
              >
                ↗ quote
              </button>
              <button
                onClick={onMute}
                className="text-muted hover:text-red-400"
                aria-label="Hide author"
                title="Hide this author from your feed"
              >
                🚫 hide
              </button>
              <button
                onClick={() => setZapOpen(true)}
                className="text-muted hover:text-bolt"
                aria-label="Zap"
                title="Zap (NIP-57)"
              >
                ⚡ zap
              </button>
            </>
          ) : (
            <span className="text-muted">sign in to reply / repost / quote / zap</span>
          )}
          <span className="flex-1" />
          <a
            href={`https://njump.me/${note.nevent}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted hover:text-nostr"
          >
            view on nostr →
          </a>
        </div>

        {repostErr && <p className="text-[11px] text-red-400 mt-1">{repostErr}</p>}

        {composerMode && identity && (
          <div className="mt-2 border-t border-bone/15 pt-2">
            <div className="text-[10px] uppercase tracking-widest text-muted mb-1">
              {composerMode === 'reply' ? 'replying' : 'quoting'} ↩ {name}
            </div>
            <textarea
              value={composerDraft}
              onChange={(e) => setComposerDraft(e.target.value)}
              placeholder={
                composerMode === 'reply'
                  ? 'reply on Nostr…'
                  : 'add a comment (optional) — the original note is auto-attached'
              }
              rows={3}
              className="input w-full resize-y text-sm"
            />
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={onSendComposer}
                disabled={
                  composerState === 'busy' ||
                  (composerMode === 'reply' && !composerDraft.trim())
                }
                className="btn text-xs disabled:opacity-50"
              >
                {composerState === 'busy'
                  ? 'sending…'
                  : composerMode === 'reply'
                    ? 'send reply'
                    : 'send quote'}
              </button>
              <button onClick={closeComposer} className="btn-ghost text-xs">
                cancel
              </button>
              {composerErr && <span className="text-[11px] text-red-400">{composerErr}</span>}
            </div>
          </div>
        )}

        {zapOpen && identity && (
          <ZapDialog
            note={note}
            identity={identity}
            onClose={() => setZapOpen(false)}
          />
        )}
      </div>
    </article>
    {visibleReplies.length > 0 && (
      <div className={`mt-3 border-l-2 border-nostr/30 space-y-3 ${depth < 2 ? 'ml-4 pl-2 sm:ml-6 sm:pl-3' : 'ml-2 pl-2'}`}>
        {visibleReplies.map((r) => (
          <NoteCard key={r.id} note={r} repostedIds={repostedIds} depth={depth + 1} />
        ))}
      </div>
    )}
    </div>
  );
}

/**
 * Memoized: feed surfaces re-render wholesale when podcast metadata resolves
 * or `boostsTick` bumps, but note object identities are stable across those
 * renders, so memo skips repainting untouched cards. Store-driven values
 * (identity, mutes) are read via `useApp` selectors inside the component and
 * bypass memo correctly. Caveat: `repostedIds` must keep being REPLACED, not
 * mutated in place (see useViewerReposts), or memoized cards won't update.
 */
export const NoteCard = memo(NoteCardImpl);

function ZapDialog({
  note,
  identity,
  onClose,
}: {
  note: DiscoveredNote;
  identity: NonNullable<ReturnType<typeof useApp.getState>['identity']>;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(100);
  const [comment, setComment] = useState('');
  const [state, setState] = useState<ActionState>('idle');
  const [err, setErr] = useState<string | null>(null);
  // NoteCard renders inside feeds, which sit in the layout's `relative z-0`
  // content wrapper, so this dialog's z-index couldn't rise above the
  // body-level mini-player (z-30) without escaping it. <ModalShell> owns the
  // portal that does the escaping.

  const lud = note.author?.lud16 || note.author?.lud06;
  const canZap = !!lud;

  async function onZap() {
    if (!canZap) return;
    setState('busy');
    setErr(null);
    try {
      await sendZap({
        recipientPubkey: note.pubkey,
        recipientLud16: note.author?.lud16,
        recipientLud06: note.author?.lud06,
        amountSats: amount,
        comment: comment.trim() || undefined,
        eventId: note.id,
        relays: resolvePublishRelays(identity),
      });
      setState('done');
      setTimeout(onClose, 800);
    } catch (e) {
      setErr(getErrorMessage(e, 'zap failed'));
      setState('error');
    }
  }

  const zapTarget = note.author?.display_name || note.author?.name || shortNpub(note.npub, 6);
  // htmlFor/id — both fields were bare siblings, so neither had an accessible
  // name, on the dialog that sends the zap.
  const amountId = useId();
  const commentId = useId();

  return (
    // Not dismissable while paying — this is a real Lightning send.
    <ModalShell
      onClose={onClose}
      label={`Zap ${zapTarget}`}
      className="p-4 max-w-sm w-full"
      dismissable={state !== 'busy'}
    >
        <header className="flex items-center justify-between mb-3">
          <h3 className="font-display text-lg">⚡ Zap {zapTarget}</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:text-bone text-xl leading-none"
          >
            ×
          </button>
        </header>
        {!canZap && (
          <p className="text-sm text-red-400">
            This author has no Lightning address on their Nostr profile, so they can&apos;t receive zaps.
          </p>
        )}
        {canZap && (
          <>
            <label htmlFor={amountId} className="block text-[11px] uppercase tracking-widest text-muted mb-1">amount (sats)</label>
            <input
              id={amountId}
              type="number"
              min={1}
              step={1}
              value={amount}
              // Math.round as well as the clamp: the field accepts decimals, and
              // a fractional sat is not a thing that can be sent.
              onChange={(e) => setAmount(Math.max(1, Math.round(Number(e.target.value) || 0)))}
              className="input w-full mb-3"
            />
            <div className="flex gap-2 mb-3">
              {[21, 100, 500, 1000].map((n) => (
                <button
                  key={n}
                  onClick={() => setAmount(n)}
                  className="btn-ghost text-xs flex-1"
                >
                  {n}
                </button>
              ))}
            </div>
            <label htmlFor={commentId} className="block text-[11px] uppercase tracking-widest text-muted mb-1">comment (optional)</label>
            <input
              id={commentId}
              type="text"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="great post"
              className="input w-full mb-3"
            />
            <button
              onClick={onZap}
              disabled={state === 'busy' || state === 'done'}
              className="btn-bolt w-full"
            >
              {state === 'busy' ? 'paying…' : state === 'done' ? 'zapped ⚡' : `Send ${amount} sats`}
            </button>
            {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
          </>
        )}
    </ModalShell>
  );
}
