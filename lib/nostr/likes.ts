import type { Event, EventTemplate } from 'nostr-tools';
import { clientTag } from '../brand';
import { siteLandingUrl } from './boost-notes';
import { collectEventsDetailed } from './event-queries';
import {
  DELETION_KIND,
  EXTERNAL_REACTION_KIND,
  LIKE_READ_LIMIT,
  itemLikeTarget,
  likeTags,
  unlikeTags,
} from './like-tally';
import { assertPublished, signAndPublish, type PublishedNote } from './publish';
import { DEFAULT_RELAYS } from './relays';

/**
 * The episode like's relay half: one read, and the two publishers. The rules
 * are in `like-tally.ts`, which `check:likes` pins; this file moves bytes.
 * → docs/nostr.md, "Episode likes".
 */

export interface EpisodeLikesRead {
  /** Every kind:17 AND kind:5 the read returned, deduped by id. The tally
   *  decides what counts — this does not filter. */
  events: Event[];
  /** Every relay that connected answered. A count from an incomplete read is a
   *  lower bound, which is why the tile never prints a zero. */
  complete: boolean;
}

/**
 * Every like and every unlike filed under one episode.
 *
 * **One filter for both kinds**, which works only because `unlikeTags` puts
 * the item's `i` tag on the deletion. `DEFAULT_RELAYS` is where Fountain's
 * likes are — relay.fountain.fm held 62 events for one episode on 2026-10-02
 * where the other three held one between them — and it is normally part of
 * where this app's own go, since `resolvePublishRelays` unions it in. Its doc
 * names the four narrow cases where it is not; for a like the cost is a tile
 * that reads un-liked and a second like on the next press, never a lost one.
 *
 * `collectEventsDetailed` and not the feed path, because this is a COUNT: it
 * waits for every relay instead of exiting on a quiet timer, which would
 * truncate the set.
 *
 * **The viewer's own likes get a second, narrow read when the first one
 * filled the cap.** Their like may sit past the 500th event, and without it in
 * hand the tile cannot offer to take it back.
 */
export async function fetchEpisodeLikes(
  itemGuid: string,
  viewer: string | null,
  relays: string[] = DEFAULT_RELAYS,
): Promise<EpisodeLikesRead> {
  const kinds = [EXTERNAL_REACTION_KIND, DELETION_KIND];
  const target = itemLikeTarget(itemGuid);
  const all = await collectEventsDetailed(relays, { kinds, '#i': [target], limit: LIKE_READ_LIMIT });
  const byId = new Map(all.events.map((e) => [e.id, e]));
  if (viewer && all.events.length >= LIKE_READ_LIMIT) {
    const mine = await collectEventsDetailed(relays, { kinds, authors: [viewer], '#i': [target] });
    for (const e of mine.events) byId.set(e.id, e);
  }
  return { events: [...byId.values()], complete: all.complete };
}

/**
 * Like an episode: a kind:17 `+` in Fountain's shape, so Fountain counts it.
 *
 * `feedGuid` is the item's PARENT feed — `episode.podcastGuid` first, as
 * `<FavEpisodeHeart>` resolves it — because a playlist that lists a track is not
 * the show it belongs to. **Asserted, not merely awaited**: the caller records
 * the returned event as the viewer's like, and a like no relay holds is one the
 * next read takes back.
 */
export async function publishEpisodeLike(args: {
  itemGuid: string;
  feedGuid: string;
  relays: string[];
}): Promise<PublishedNote> {
  const { itemGuid, feedGuid, relays } = args;
  const template: EventTemplate = {
    kind: EXTERNAL_REACTION_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: '+',
    tags: [
      ...likeTags({
        itemGuid,
        feedGuid,
        itemHint: siteLandingUrl(feedGuid, itemGuid),
        showHint: siteLandingUrl(feedGuid),
      }),
      // The attribution belongs on every event this app publishes or on none;
      // see `CLIENT_TAG` in interactions.ts.
      clientTag(),
    ],
  };
  return assertPublished(await signAndPublish(template, relays), 'like');
}

/**
 * Take a like back: a NIP-09 deletion of every standing like the viewer holds
 * for this episode — Fountain publishes each one twice, so one id is not enough.
 *
 * A relay that honors NIP-09 drops the likes; one that does not keeps them, and
 * the tally discounts them because the deletion carries the item `i` tag.
 * **Fountain itself never deletes a like**, so whether its app honors this is
 * not something this code can decide.
 */
export async function publishEpisodeUnlike(args: {
  itemGuid: string;
  likeIds: readonly string[];
  relays: string[];
}): Promise<PublishedNote> {
  const { itemGuid, likeIds, relays } = args;
  const template: EventTemplate = {
    kind: DELETION_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [...unlikeTags(likeIds, itemGuid), clientTag()],
  };
  return assertPublished(await signAndPublish(template, relays), 'unlike');
}
