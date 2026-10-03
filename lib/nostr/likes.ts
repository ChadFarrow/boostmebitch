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
  viewerLikeRelays,
} from './like-tally';
import { assertPublished, signAndPublish, type PublishedNote } from './publish';
import { DEFAULT_RELAYS } from './relays';

/**
 * The episode like's relay half: one read, and the two publishers. The rules
 * are in `like-tally.ts`, which `check:likes` pins; this file moves bytes.
 * → docs/nostr.md, "Episode likes".
 */

/**
 * How a like or unlike is published: **resolved on the FIRST relay that
 * accepts** (`settle: 'first'`). The tile changes only once this resolves, and
 * waiting on all of the up-to-20 publish relays let the slowest one hold it for
 * seconds after another had already stored the event. One acceptance is what
 * `assertPublished` asks for; the rest finish in the background.
 */
function likePublishOpts(signal: AbortSignal | undefined, onSigned: (() => void) | undefined) {
  return { signal, onSigned, settle: 'first' as const };
}

export interface EpisodeLikesRead {
  /** Every kind:17 AND kind:5 the read returned, deduped by id. The tally
   *  decides what counts — this does not filter. */
  events: Event[];
  /**
   * Every relay the read ASKED connected and answered. A count from an
   * incomplete read is a lower bound, which is why the tile never prints a zero
   * and prints `N+` for one.
   *
   * **Stricter than `collectEventsDetailed`'s `complete`**, which leaves a relay
   * that never connected out of the denominator — right for "is this empty set
   * real", wrong for a COUNT whose data sits almost entirely on ONE relay: with
   * relay.fountain.fm unreachable the other three answer, that `complete` is
   * true, and an episode 49 people liked reads as an exact 1.
   */
  complete: boolean;
}

/**
 * Every like and every unlike filed under one episode.
 *
 * **One filter for both kinds**, which works only because `unlikeTags` puts
 * the item's `i` tag on the deletion. `DEFAULT_RELAYS` is where Fountain's
 * likes are — relay.fountain.fm held 62 events for one episode on 2026-10-02
 * where the other three held one between them — so the COUNT reads those and
 * nothing wider.
 *
 * `collectEventsDetailed` and not the feed path, because this is a COUNT: it
 * waits for every relay instead of exiting on a quiet timer, which would
 * truncate the set.
 *
 * **The viewer's own likes get a second, narrow read, IN PARALLEL with the
 * count**, for two reasons. The count stops at 500 events, and the viewer's
 * like may sit past the 500th — without it in hand the tile cannot offer to
 * take it back. And the viewer PUBLISHES to `ownRelays`, which a `bmb:relays`
 * override or the 20-relay cap can leave short of a default, so their like or
 * unlike may sit only where the count never looks (`viewerLikeRelays`). It used
 * to run only after a capped count, in series: two full windows on the
 * episodes that most need it, and no answer at all for an override.
 */
export async function fetchEpisodeLikes(
  itemGuid: string,
  viewer: string | null,
  ownRelays: readonly string[] = [],
): Promise<EpisodeLikesRead> {
  const relays = DEFAULT_RELAYS;
  const kinds = [EXTERNAL_REACTION_KIND, DELETION_KIND];
  const target = itemLikeTarget(itemGuid);
  const [all, mine] = await Promise.all([
    collectEventsDetailed(relays, { kinds, '#i': [target], limit: LIKE_READ_LIMIT }),
    // A failure here must not take the COUNT down with it: without the viewer's
    // own events the tile can still show the number, as it did before.
    viewer
      ? collectEventsDetailed(viewerLikeRelays(relays, ownRelays), { kinds, authors: [viewer], '#i': [target] })
        .catch(() => null)
      : null,
  ]);
  const byId = new Map(all.events.map((e) => [e.id, e]));
  for (const e of mine?.events ?? []) byId.set(e.id, e);
  return { events: [...byId.values()], complete: all.complete && all.reached === relays.length };
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
  /** Stops the wait for the signer; see `signAndPublish`. */
  signal?: AbortSignal;
  /** The signer has answered; only the relays are left. */
  onSigned?: () => void;
}): Promise<PublishedNote> {
  const { itemGuid, feedGuid, relays, signal, onSigned } = args;
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
  return assertPublished(await signAndPublish(template, relays, likePublishOpts(signal, onSigned)), 'like');
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
  /** Stops the wait for the signer; see `signAndPublish`. */
  signal?: AbortSignal;
  /** The signer has answered; only the relays are left. */
  onSigned?: () => void;
}): Promise<PublishedNote> {
  const { itemGuid, likeIds, relays, signal, onSigned } = args;
  const template: EventTemplate = {
    kind: DELETION_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [...unlikeTags(likeIds, itemGuid), clientTag()],
  };
  return assertPublished(await signAndPublish(template, relays, likePublishOpts(signal, onSigned)), 'unlike');
}
