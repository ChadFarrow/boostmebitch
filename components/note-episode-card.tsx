'use client';
import { useState } from 'react';
import { useApp } from '@/lib/store';
import { loadEpisodeFromFeed } from '@/lib/podcast-meta';
import { fmtDate, fmtDuration } from '@/lib/format';
import type { Episode, Podcast } from '@/lib/types';
import { PodcastCover } from './podcast-cover';
import { FavEpisodeHeart } from './fav-heart';
import { BoostModal } from './boost-modal';
import { BoltIcon } from './icons';

/**
 * The episode a note is *about*, unfurled under the note's own words.
 *
 * A note that links an episode used to render as a 16px thumbnail beside one
 * truncating line of 11px grey text, with the raw URL repeated underneath in
 * magenta. Every fact was already on screen and none of it read as an episode
 * you could do anything with. This is that same data, drawn as the thing it is.
 *
 * **It is deliberately not shown for every podcast-tagged note.** 171 of 243
 * cards on the live global feed carry NIP-73 podcast tags, so unfurling all of
 * them turns the feed into a wall of artwork and pushes each author's actual
 * sentence below the fold. The discriminator is `episodeLinkInNote`
 * (`lib/util.ts`): the note put a link to this episode in its own text, which is
 * the author saying "this is what I am pointing at". Everything else keeps the
 * one-line label.
 *
 * ── Why PLAY and BOOST both wait on `/api/feed` ──────────────────────────────
 *
 * `episode` here is Podcast Index's *indexed* record, resolved from the note's
 * guids by `useNoteMeta`. It is good enough to print a title, a date and a
 * cover, and it is NOT good enough to play or to boost: only `/api/feed` applies
 * the `e.value ?? podcast.value` channel fallback, so the PI record routinely
 * carries no value block at all. Opening the boost modal with it produces a
 * BOOST button with no recipients — a payment surface that cannot pay, which
 * looks like our bug and is really a missing fetch.
 *
 * So both actions go through {@link hydrate} first and are disabled until it
 * answers. That is the same rule the boost modal states for a valueTimeSplit
 * target: a control that spends money stays disabled while the thing it would
 * spend on is still resolving. It is a money gate, not a spinner. A failed
 * hydrate says so on the card rather than falling back to the thin record,
 * because a boost modal listing nobody is worse than a button that admits it
 * could not load.
 *
 * `loadEpisodeFromFeed` goes through `loadFeed`, which coalesces a request
 * already in flight, so PLAY-then-BOOST on one card costs one feed download and
 * two cards for the same show cost one between them.
 *
 * OPEN is handed down as `onOpen` rather than re-implemented: `<NoteCard>`
 * already owns that sequence (select the show first, then load the real episode,
 * then open it) and its ordering constraints are written up there.
 */
export function NoteEpisodeCard({
  podcast,
  episode,
  href,
  onOpenShow,
  onOpenEpisode,
}: {
  podcast: Podcast;
  episode: Episode;
  /** The URL the note itself used to point at this episode. */
  href: string;
  /**
   * Two destinations, not one. The show name and the episode title are
   * different places, exactly as they are in the one-line label this card
   * replaces — collapsing them onto a single handler would quietly delete the
   * only route to the show from a note about one of its episodes.
   */
  onOpenShow: () => void;
  onOpenEpisode: () => void;
}) {
  const play = useApp((s) => s.play);
  const [busy, setBusy] = useState<null | 'play' | 'boost'>(null);
  const [err, setErr] = useState<string | null>(null);
  const [boostFor, setBoostFor] = useState<{ episode: Episode; podcast: Podcast } | null>(null);

  /**
   * The real episode, out of the show's own feed. Returns null when the feed
   * could not be read or no longer carries this guid — a show that dropped the
   * item from its feed is a real and ordinary state, and the card says so
   * instead of pretending with the indexed record.
   */
  async function hydrate(): Promise<{ episode: Episode; podcast: Podcast } | null> {
    if (!episode.guid) return null;
    const loaded = await loadEpisodeFromFeed(podcast.id, episode.guid);
    if (!loaded?.episode) return null;
    return { episode: loaded.episode, podcast: loaded.podcast };
  }

  async function run(kind: 'play' | 'boost') {
    if (busy) return;
    setBusy(kind);
    setErr(null);
    try {
      const full = await hydrate();
      if (!full) {
        setErr('could not load this episode from its feed');
        return;
      }
      if (kind === 'play') play(full.episode, full.podcast);
      else setBoostFor(full);
    } catch {
      setErr('could not load this episode from its feed');
    } finally {
      setBusy(null);
    }
  }

  const host = hostOf(href);

  return (
    <div className="mt-2 border border-line rounded bg-ink/40 overflow-hidden">
      <div className="flex gap-3 p-2.5">
        {/* Always both URLs — PI mirrors RSS <image> as `image` and
            <itunes:image> as `artwork` and they routinely disagree. The
            episode's own art wins when it has any, which for a music feed is
            the track cover rather than the album's. */}
        <PodcastCover
          image={episode.image || podcast.image}
          artwork={podcast.artwork}
          title={episode.title}
          seed={episode.guid ?? podcast.podcastGuid ?? String(podcast.id)}
          className="w-16 h-16 sm:w-20 sm:h-20 object-cover border border-bone/20 flex-shrink-0"
          lowPriority
        />
        <div className="min-w-0 flex-1">
          {/* `min-h-[24px]` is WCAG 2.5.8 and it is here because this control
              failed it. At `text-[10px]` the line box is 15px, so the button
              looked finished and was 9px short — the violation a review cannot
              see, because nothing about the rendering is wrong. Measured at
              390px under CDP device emulation; a narrow window would have
              reported the desktop layout cropped and told us nothing. */}
          <button
            type="button"
            onClick={onOpenShow}
            className="flex items-center min-h-[24px] text-left text-[10px] tracking-wider uppercase text-muted hover:text-bolt max-w-full"
            title={podcast.title}
          >
            <span className="truncate">{podcast.title}</span>
          </button>
          <button
            type="button"
            onClick={onOpenEpisode}
            className="block text-left font-display text-sm text-bone hover:text-bolt leading-snug line-clamp-2"
            title={episode.title}
          >
            {episode.title}
          </button>
          <div className="text-[11px] text-muted mt-0.5 flex items-center gap-1.5 flex-wrap">
            {episode.datePublished ? <span>{fmtDate(episode.datePublished)}</span> : null}
            {episode.duration ? (
              <>
                {episode.datePublished ? <span aria-hidden>·</span> : null}
                <span>{fmtDuration(episode.duration)}</span>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap px-2.5 pb-2.5">
        <button
          type="button"
          onClick={() => run('play')}
          disabled={busy !== null}
          className="btn-ghost disabled:opacity-50"
          aria-label={`Play ${episode.title}`}
        >
          {busy === 'play' ? '…' : '▶'} PLAY
        </button>
        <button type="button" onClick={onOpenEpisode} className="btn-ghost">
          OPEN
        </button>
        {/* The heart runs off the indexed record on purpose: a favorite is the
            two guids plus a label, all of which PI already answered with, so it
            must not wait on a feed download the way the two spending controls
            do. <FavEpisodeHeart> renders nothing without both guids. */}
        <FavEpisodeHeart episode={episode} podcast={podcast} size="sm" />
        <button
          type="button"
          onClick={() => run('boost')}
          disabled={busy !== null}
          className="btn-ghost text-bolt border-bolt/50 disabled:opacity-50"
          aria-label={`Boost ${episode.title}`}
        >
          {busy === 'boost' ? '…' : <BoltIcon />} BOOST
        </button>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-ghost ml-auto text-muted hover:text-bone"
          title={href}
        >
          {host} ↗
        </a>
      </div>

      {err && (
        <p role="status" className="px-2.5 pb-2.5 text-[11px] text-nostr">
          {err}
        </p>
      )}

      {boostFor && (
        <BoostModal
          episode={boostFor.episode}
          podcast={boostFor.podcast}
          onClose={() => setBoostFor(null)}
        />
      )}
    </div>
  );
}

/**
 * The link's host, for the outbound button's label — "fountain.fm ↗" rather
 * than a second copy of the full URL, which is the thing this card exists to
 * get out of the note body. `www.` goes because it is never the part a reader
 * is identifying the destination by.
 */
function hostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return 'open';
  }
}
