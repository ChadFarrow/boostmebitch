'use client';
import { memo } from 'react';
import { shortNpub, zapSats, type ReceivedZap } from '@/lib/nostr';
import { useApp } from '@/lib/store';
import { linkify, timeAgo } from '@/lib/format';
import type { Episode, Podcast } from '@/lib/types';
import { Avatar } from './avatar';

/**
 * One NIP-57 zap receipt, rendered as a boost.
 *
 * Visual sibling of <BoostCard> and <NoteCard> so the received list reads as
 * one stream rather than two feeds stapled together. It cannot BE <BoostCard>:
 * that one draws the signed-in user's own avatar out of `identity`
 * (boost-card.tsx:30-40), which on someone else's page would put the viewer's
 * face on a stranger's payment.
 *
 * The `zap` stamp beside the amount is load-bearing. A receipt and a kind:1
 * boostagram look identical once rendered, but they carry different evidence —
 * the receipt is the settled payment, the note is the sender's claim about one
 * — and a reader comparing this page against their wallet needs to know which
 * they are looking at.
 *
 * Memoized like <NoteCard>, for the same reason: the parent re-renders
 * wholesale as podcast metadata resolves. So `mutedPubkeys` is read with a
 * `useApp` selector INSIDE the component — a mute applied by the parent's props
 * alone would be skipped by memo.
 */
function ZapReceiptCardImpl({
  zap,
  podcast,
  episode,
}: {
  zap: ReceivedZap;
  podcast?: Podcast | null;
  episode?: Episode | null;
}) {
  const mutedPubkeys = useApp((s) => s.mutedPubkeys);
  if (mutedPubkeys.has(zap.zapper)) return null;

  const name =
    zap.zapperProfile?.display_name?.trim() ||
    zap.zapperProfile?.name?.trim() ||
    shortNpub(zap.zapperNpub);
  const sats = zapSats(zap);

  return (
    <article className="card p-3 flex gap-3 border-bolt/40">
      <Avatar
        pubkey={zap.zapper}
        picture={zap.zapperProfile?.picture}
        name={name}
        className="w-9 h-9 rounded-full border border-bone/20 flex-shrink-0 text-sm"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <a
            href={`https://njump.me/${zap.zapperNpub}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-display text-sm text-bone hover:text-bolt truncate"
            title={zap.zapperNpub}
          >
            {name}
          </a>
          <span className="text-muted">· {timeAgo(zap.createdAt)}</span>
          {sats > 0 && (
            <span className="stamp text-bolt border-bolt/60">⚡ {sats.toLocaleString()} sats</span>
          )}
          <span className="stamp text-muted border-bone/20">zap</span>
        </div>
        {/* Third-party text. `linkify` emits React elements — never
            dangerouslySetInnerHTML, and never a bare href: React does not block
            a `javascript:` URL, it only warns in dev. */}
        {zap.comment.trim() && (
          <p className="text-sm mt-1.5 whitespace-pre-wrap break-words">
            {linkify(zap.comment.trim())}
          </p>
        )}
        {podcast && (
          <p className="text-xs text-muted mt-1.5 truncate">
            → {podcast.title}
            {episode?.title && <span className="text-bone/60"> · {episode.title}</span>}
          </p>
        )}
      </div>
    </article>
  );
}

export const ZapReceiptCard = memo(ZapReceiptCardImpl);
