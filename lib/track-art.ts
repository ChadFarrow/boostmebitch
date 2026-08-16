'use client';
import { useEffect, useState } from 'react';
import { splitAtPosition } from './util';
import type { Episode, ValueTimeSplit } from './types';

/**
 * This episode's `<podcast:valueTimeSplit>` windows, RESOLVED — each carrying
 * the track's own title, cover, value block and parent-feed ids, fetched from
 * the artist's feed via the remote item.
 *
 * Two things read it, and they are the same claim made twice:
 *
 * - **`splitArtAt`** (below) — the cover of whatever is playing this second,
 *   the pre-recorded twin of `useLiveBlockImage`. A live Split Kit show has
 *   shown the record actually playing since `live-value.ts` shipped, and the
 *   reason given there is not decoration: it is the one thing on screen that
 *   makes a redirected payment self-evident. A pre-recorded episode redirects
 *   exactly the same way — press BOOST inside a window and `<BoostModal>` pays
 *   the artist, not the show (CLAUDE.md boost invariant 0.5) — and showed the
 *   episode cover throughout, so the screen said "the show" while the money
 *   said "the song".
 * - **`<EpisodeContents>`** — the same windows as rows, so the tracks a show
 *   played can be seeked to and favorited individually. That list also shows the
 *   episode's chapters, interleaved by timestamp, but the two are merged and
 *   never mapped: a heart binds to a window and a chapter row has none.
 *
 * **A window is not a chapter.** They look alike and they are not the same
 * thing. On *Mutton, Mead & Music* 150 the chapters JSON carries 25 entries
 * against 15 windows: ten are the show's own talk breaks, two songs share a
 * `28:20` start with one of them, and a talk break at `33:49` falls *inside* the
 * 28:21–33:50 window. Homegrown Hits 146 is worse — its windows overlap, so
 * "the window covering this chapter" hands three named songs another song's
 * identifiers. So there is no reliable chapter→track mapping to hang per-track
 * UI off — and plenty of Split Kit shows publish windows and no chapters JSON at
 * all. The window is also the authoritative one: it is what decides who gets
 * paid, and it is the only one of the two carrying a `feedGuid`/`itemGuid` pair,
 * which is exactly what naming a track on another device takes.
 *
 * One fetch per episode. The endpoint is the same one both boost modals use and
 * it answers with a one-hour CDN cache, so opening a played-before episode
 * costs nothing. Resolution is best-effort by design: Podcast Index hasn't
 * crawled every album feed, so an unresolved window keeps its `remoteItem` and
 * loses only its title/art — still seekable, still favoritable.
 *
 * Live items are excluded: they have no time base for a window to anchor to,
 * and `useLiveBlockImage` already covers them.
 */
export function useResolvedSplits(episode: Episode | undefined): ValueTimeSplit[] | null {
  const feedId = episode?.feedId;
  const episodeId = episode?.id;
  // The windows themselves ride on the episode, so "does this episode redirect
  // at all" is known synchronously and the overwhelming majority of episodes
  // never issue a request.
  const hasWindows =
    episode?.liveStatus !== 'live' && !!episode?.valueTimeSplits?.length && !!feedId && !!episodeId;

  const [splits, setSplits] = useState<ValueTimeSplit[] | null>(null);

  useEffect(() => {
    if (!hasWindows) {
      setSplits(null);
      return;
    }
    let cancelled = false;
    setSplits(null);
    fetch(`/api/value-splits?feedId=${feedId}&episodeId=${episodeId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setSplits((data?.splits as ValueTimeSplit[]) ?? null);
      })
      .catch(() => {
        // Neither consumer is worth surfacing an error for: the cover falls
        // back, and the track list simply doesn't appear.
        if (!cancelled) setSplits(null);
      });
    return () => { cancelled = true; };
  }, [hasWindows, feedId, episodeId]);

  return splits;
}

/**
 * The cover of the track a window is redirecting to at `positionSec`.
 *
 * **Follows the position live; it does NOT freeze.** `useActiveSplit` freezes
 * because a boost aimed at a song must not land on the show because the song
 * ended while the user was typing. This is artwork: the honest thing for it to
 * do is track what is playing, and a frozen hero would keep showing the last
 * song's cover for the rest of the episode.
 *
 * Same window rule the boost path pays by (`splitAtPosition`, pinned by
 * `check:vts`), so the art on screen and the recipient of a boost pressed at
 * that second can never disagree about which song is playing.
 */
export function splitArtAt(
  splits: ValueTimeSplit[] | null,
  positionSec: number,
): string | undefined {
  return splitAtPosition(splits, positionSec)?.image || undefined;
}

/**
 * Which feed-supplied artwork the players show for the moment being played.
 *
 * Both surfaces — the mini-bar thumbnail and the always-mounted fullscreen hero
 * — call this rather than composing the chain themselves. The gate is the
 * reason: `artOk` applied to one surface only is no gate at all, because either
 * fetch alone is enough to starve the enclosure (see docs/ui.md, "Artwork must
 * never outrank the audio"), and two hand-written chains is how one surface
 * comes to be gated and the other not.
 *
 * Precedence — payment target first, then the show's own chaptering:
 *
 * 1. `liveBlockImage` — the record a live Split Kit show is playing now.
 * 2. `splitImage` — the track a `<podcast:valueTimeSplit>` is redirecting to.
 * 3. `chapterImage` — the active chapter's `img`.
 *
 * The redirect outranks the chapter because it names the song *authoritatively*:
 * the art comes from the artist's own feed via the remote item, whereas a
 * chapter `img` is whatever the host illustrated that stretch of audio with —
 * routinely the show's own cover, and routinely absent. The two also disagree
 * about boundaries (this episode's chapter starts 11 s after its window does),
 * and it is the window that decides who gets paid.
 *
 * Returns undefined when there is nothing feed-supplied to show or the gate is
 * shut, so each caller keeps its own tail (`|| episode.image || …`) — those
 * differ per surface, and `||` is deliberate throughout: Podcast Index returns
 * `""` for an absent image, and `'' ?? x` is `''`.
 */
export function nowPlayingArt(opts: {
  liveBlockImage?: string | null;
  splitImage?: string;
  chapterImage?: string;
  /** False when the buffer can't afford heavy third-party artwork. */
  artOk: boolean;
}): string | undefined {
  const { liveBlockImage, splitImage, chapterImage, artOk } = opts;
  // The live block is exempt from the gate for the same reason it outranks
  // everything: it changes once per record rather than once per ⏭, so it can't
  // be the thing hammering the audio's own origin.
  if (liveBlockImage) return liveBlockImage;
  if (!artOk) return undefined;
  return splitImage || chapterImage || undefined;
}
