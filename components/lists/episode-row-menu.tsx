'use client';
import { createPortal } from 'react-dom';
import type { Episode, Podcast } from '@/lib/types';
import { downloadManager } from '@/lib/downloads/download-manager';
import { useAnchoredMenu } from '../use-anchored-menu';
import { FavEpisodeHeart, canFavoriteEpisode, useEpisodeFavorited } from '../fav-heart';
import { DownloadButton, DownloadMark } from '../download-button';

/**
 * The episode row's `⋯` below lg: — FAV and DOWNLOAD, as the same `.tile`s
 * the episode page's action row draws, in a menu.
 *
 * WHY A MENU. On one line the title column paid for every button: ⚡,
 * DOWNLOAD and ♡ at 44px each left it 108px at 390px ("Episode 459 ..."), and
 * from sm: the words took it to 91px at 640. Only BOOST stays on the row.
 *
 * THE TILES ARE THE SHARED CONTROLS, not menu items that re-implement them.
 * `<FavEpisodeHeart>` carries the container-is-not-the-parent rule and the
 * favorites sync; `<DownloadButton>` the five states and the error sentence.
 * A second copy of either in menu-item form is exactly where those would
 * drift. The menu stays open after a press, so the tile's own state change —
 * heart filled, the progress fill — is the confirmation.
 *
 * ITS CLICKS STOP AT THE MENU. React propagates a synthetic event through a
 * PORTAL to the component that rendered it, so a press on the menu's padding
 * would reach the row's `<li onClick>` and open the episode. The tiles stop
 * their own; the container stops the rest.
 */
export function EpisodeRowMenu({
  episode,
  podcast,
  className = '',
}: {
  episode: Episode;
  podcast?: Podcast | null;
  /** On the trigger — the row hides it from lg:, where the controls are inline. */
  className?: string;
}) {
  const { open, setOpen, triggerRef, menuRef, at } = useAnchoredMenu();
  // NO TRIGGER WHEN THE MENU WOULD BE EMPTY — a `⋯` that opens onto nothing is
  // a dead control. Asked through each control's own refusal, never a copy of
  // it: an unresolved playlist row has no enclosure, so DOWNLOAD refuses it,
  // while its heart may still render off the remote item's guids.
  if (
    !canFavoriteEpisode(episode, podcast) &&
    !downloadManager.canDownload(episode)
  ) return null;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={(ev) => {
          ev.stopPropagation();
          setOpen((v) => !v);
        }}
        // BOOST's height beside it — 44px below sm:, `.btn-bolt`'s 38px from
        // sm: — and narrower than it, because this is the lesser control.
        className={`inline-flex items-center justify-center w-9 min-h-[44px] sm:min-h-[38px] flex-shrink-0 border transition ${
          open ? 'border-bone bg-bone/5 text-bone' : 'border-bone/40 text-bone/70 hover:border-bone hover:text-bone'
        } ${className}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ${episode.title}`}
        title="More actions"
      >
        <span aria-hidden className="text-lg leading-none">⋯</span>
      </button>
      {open && at && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Actions for ${episode.title}`}
          onClick={(ev) => ev.stopPropagation()}
          className="fixed w-60 max-w-[calc(100vw-1rem)] card bg-ink p-2 z-40 shadow-xl grid grid-cols-[repeat(auto-fit,minmax(56px,1fr))] gap-2"
          style={{ top: at.top, bottom: at.bottom, right: at.right }}
        >
          {/* The episode page's order. */}
          <FavEpisodeHeart episode={episode} podcast={podcast} size="tile" />
          <DownloadButton episode={episode} podcast={podcast} size="tile" />
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * What the `⋯` menu hides, said on the row's date line: favorited,
 * downloaded or downloading. Without it a phone showed the state of neither
 * until the menu was opened, and a download running for minutes showed its
 * progress nowhere. Each reads the SAME expression as its control.
 * Nothing for an episode in none of those states — a mark on every row would
 * be noise.
 */
export function EpisodeRowMarks({ episode }: { episode: Episode }) {
  const fav = useEpisodeFavorited(episode);
  return (
    <>
      {fav && (
        <span className="text-nostr whitespace-nowrap">
          <span aria-hidden>· ♥</span>
          <span className="sr-only">favorited</span>
        </span>
      )}
      <DownloadMark episode={episode} />
    </>
  );
}
