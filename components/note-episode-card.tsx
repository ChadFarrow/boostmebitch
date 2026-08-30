'use client';
import { fmtDate, fmtDuration } from '@/lib/format';
import type { Episode, Podcast } from '@/lib/types';
import { PodcastCover } from './podcast-cover';
import { FavEpisodeHeart } from './fav-heart';

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
 * ── It POINTS at the episode. It does not play or pay for one ───────────────
 *
 * The row is OPEN, the favorite heart, and the outbound link — nothing that
 * needs a feed download and nothing that spends money. It shipped with PLAY and
 * BOOST as well, and at 390px those four controls wrapped into a ragged
 * 2 / 2 / 1 block with the host link stranded on a line of its own. OPEN
 * reaches the episode page, which already carries a full-size PLAY and BOOST,
 * so the card was offering a second, smaller copy of both one tap earlier.
 *
 * **A spending or playing control put back here CANNOT use the `episode`
 * prop.** That is Podcast Index's *indexed* record, resolved from the note's
 * guids by `useNoteMeta`: good enough for a title, a date and a cover, and not
 * good enough to play or to boost. Only `/api/feed` applies the
 * `e.value ?? podcast.value` channel fallback, so the PI record routinely
 * carries no value block at all, and a boost modal opened with it lists no
 * recipients — a payment surface that cannot pay, which reads as our bug and is
 * really a missing fetch. The removed version fetched the real episode through
 * `loadEpisodeFromFeed` first and kept both controls DISABLED until it
 * answered, because a control that spends money must not be pressable while the
 * thing it would spend on is still resolving. Any replacement inherits that.
 *
 * The heart is exempt and always was: a favorite is the two guids plus a label,
 * all of which the indexed record already carries.
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
        <button type="button" onClick={onOpenEpisode} className="btn-ghost">
          OPEN
        </button>
        {/* `size="md"` because the controls beside it are plain .btn-ghost.
            'sm' is the LIST-ROW chip: no `py`, `text-xs`, and no `min-h` from
            sm: up, so it sits ~9px shorter than OPEN and drops its word below
            sm: — one lone glyph beside two labelled controls. 'md' is the
            variant dimensioned to .btn-ghost, which is why the show header and
            <EpisodeDetailView> already pass it in exactly this cluster.
            <FavEpisodeHeart> renders nothing without both guids. */}
        <FavEpisodeHeart episode={episode} podcast={podcast} size="md" />
        {/* `ml-auto` only once there is room for one line. Below sm: the row
            wraps, and a right-aligned item on a wrapped line is alone on it —
            the stranded FOUNTAIN.FM line that made this row look broken on a
            390px screen. Flowing left, the wrap is even. */}
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-ghost sm:ml-auto text-muted hover:text-bone"
          title={href}
        >
          {host} ↗
        </a>
      </div>
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
