'use client';
import type { StoredBoost } from '@/lib/types';
import { useApp } from '@/lib/store';
import { shortNpub } from '@/lib/nostr';
import { linkify, timeAgo } from '@/lib/format';
import { Avatar } from './avatar';
import { PodcastCover } from './podcast-cover';
import { giphyIdFromUrl, giphyPreviewUrl } from '@/lib/giphy';

/**
 * Renders one of the user's locally-saved sent boosts. Visual sibling to
 * NoteCard so the global feed reads as a single boost stream when these are
 * intermixed. Author identity comes from the active session's profile —
 * the StoredBoost itself only carries a senderName fallback.
 *
 * **No per-recipient legs.** The card used to list every leg with ✓/?/✗ and
 * its sats, which put a payment receipt in the middle of a social feed — and
 * only on the sender's own boosts, and only until the note published and the
 * card was swapped for the Nostr one. The per-leg status is shown where it is
 * acted on, in the boost modal that sent it. `legs` is still stored.
 */
export function BoostCard({ boost }: { boost: StoredBoost }) {
  const identity = useApp((s) => s.identity);
  const profile = identity?.profile;
  const name =
    boost.senderName ||
    profile?.display_name?.trim() ||
    profile?.name?.trim() ||
    (identity ? shortNpub(identity.npub) : 'You');

  // A GIF picked in the boost modal is the message's LAST line (`withGif`).
  // Shown as the picture it is rather than a link; only a URL `giphyGifUrl`
  // built is recognised, so a stored message never puts an arbitrary `src` here.
  const lines = boost.message?.split('\n') ?? [];
  const gifId = lines.length ? giphyIdFromUrl(lines[lines.length - 1].trim()) : null;
  const text = gifId ? lines.slice(0, -1).join('\n').trim() : boost.message;

  const successLegs = boost.legs.filter((l) => l.ok);
  const sats = successLegs.length
    ? successLegs.reduce((s, l) => s + l.sats, 0)
    : boost.sats;

  return (
    <article className="card p-3 flex gap-3 border-bolt/40">
      {identity?.pubkey ? (
        <Avatar
          pubkey={identity.pubkey}
          picture={profile?.picture}
          name={name}
          className="w-9 h-9 rounded-full border border-bone/20 flex-shrink-0 text-sm"
        />
      ) : (
        <div className="w-9 h-9 rounded-full border border-bone/20 bg-line flex-shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="font-display text-sm text-bone truncate">{name}</span>
          <span className="text-muted">· {timeAgo(boost.ts / 1000)}</span>
          <span className="stamp text-bolt border-bolt/60">⚡ {sats} sats</span>
          <span className="stamp text-muted border-bone/20">sent</span>
          {boost.noteId && (
            <span className="text-muted">· also on Nostr</span>
          )}
        </div>

        <div className="flex items-center gap-2 mt-1.5 text-[11px] text-muted">
          {/* Through <PodcastCover>, like every other cover: the /api/art proxy
              first, the raw URL behind it, and an initial tile rather than a
              broken-image icon when neither loads. Nothing at all when the
              boost stored no image, as before. */}
          {boost.podcastImage ? (
            <PodcastCover
              image={boost.podcastImage}
              title={boost.podcastTitle}
              w={160}
              className="w-4 h-4 border border-bone/20 flex-shrink-0 text-[8px]"
            />
          ) : null}
          <span className="truncate">
            <span className="text-bolt">→</span>{' '}
            <span className="text-bone">{boost.podcastTitle}</span>
            {boost.episodeTitle ? (
              <span className="text-muted"> · {boost.episodeTitle}</span>
            ) : null}
          </span>
        </div>

        {text && (
          <p className="text-sm text-bone whitespace-pre-wrap break-words mt-1.5">
            {linkify(text, 'text-bolt')}
          </p>
        )}
        {gifId && (
          // eslint-disable-next-line @next/next/no-img-element -- third-party animated media
          <img
            src={giphyPreviewUrl(gifId)}
            alt="GIF"
            loading="lazy"
            // GIPHY can take a GIF down; the stored boost names it forever.
            // Hidden, as `<NoteCard>` hides a dead note image, rather than a
            // broken-image icon standing in the card for good.
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
            className="mt-1.5 h-32 w-auto max-w-full rounded border border-line object-contain"
          />
        )}

      </div>
    </article>
  );
}
