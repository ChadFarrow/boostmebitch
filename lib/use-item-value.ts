'use client';

import { useEffect, useMemo, useState } from 'react';
import { loadItemValue } from './podcast-meta';
import type { Episode, ItemPayment, Podcast } from './types';
import { valueNotRead } from './util';

/**
 * `episode`, with its payee filled in from its own feed when nothing has read one
 * yet (`valueNotRead`). For a surface holding one item on screen. A list asks on
 * the press instead, because a page spans dozens of feeds, and `<Player>` writes
 * the answer into the store because the streaming engine reads it there.
 */
export function useItemValue(
  episode: Episode | null | undefined,
  podcast: Podcast | null | undefined,
): Episode | null | undefined {
  const unread = !!episode && valueNotRead(episode);
  const guid = episode?.guid;
  const feedGuid = episode?.podcastGuid;
  const feedId = episode?.feedId ?? 0;
  const medium = podcast?.medium;
  // The feed AND the guid: a guid is only unique inside its feed.
  const key = `${feedGuid ?? feedId}:${guid}`;
  const [answer, setAnswer] = useState<{ key: string; payment: ItemPayment } | null>(null);

  useEffect(() => {
    if (!unread || !guid) return;
    let cancelled = false;
    void loadItemValue({ guid, podcastGuid: feedGuid, feedId }, { medium }).then((payment) => {
      if (!cancelled) setAnswer({ key, payment });
    });
    return () => { cancelled = true; };
  }, [unread, guid, feedGuid, feedId, medium, key]);

  return useMemo(() => {
    if (!episode || !unread || answer?.key !== key || !answer?.payment.read) return episode;
    return { ...episode, value: answer.payment.value, valueTimeSplits: answer.payment.valueTimeSplits };
  }, [episode, unread, key, answer]);
}
