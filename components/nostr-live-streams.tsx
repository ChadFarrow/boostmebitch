'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  fetchNostrLiveStreams,
  resolveStreamV4V,
  shapeLiveStreams,
  streamAddrOf,
  streamToEpisode,
  streamToPodcast,
  streamNaddr,
  type NostrLiveStream,
} from '@/lib/nostr/live-streams';
import { fetchProfilesFor, indexedLiveStreams, LIVE_STREAM_RELAYS } from '@/lib/nostr';
import type { Event } from 'nostr-tools';
import { hasValueRecipients } from '@/lib/util';
import { storage } from '@/lib/storage';
import { useApp } from '@/lib/store';
import type { Episode, Podcast, ValueBlock } from '@/lib/types';
import { BoostModal } from './boost-modal';
import { LiveCard, LIVE_GRID } from './live-card';
import { fmtLiveTime } from '@/lib/format';
import type { ProfileMetadata } from '@/lib/nostr/auth';

interface ResolvedStream {
  stream: NostrLiveStream;
  profile: ProfileMetadata | null;
  value: ValueBlock | null;
}

type StreamFilter = 'live' | 'radio' | 'upcoming';

// Perpetual "24/7" radio-style streams (24/7 Vapor Funk Radio, 24/7 Chiptune…)
// have no distinct NIP-53 field, so detect them by the title convention. Splits
// the always-on stations out of the genuinely-live-event row.
function is247(stream: NostrLiveStream): boolean {
  return /\b24\s*[/\-]\s*7\b/i.test(stream.title ?? '');
}

export function NostrLiveStreams() {
  const [resolved, setResolved] = useState<ResolvedStream[]>([]);
  const [loading, setLoading] = useState(true);
  const [boostTarget, setBoostTarget] = useState<{ episode: Episode; podcast: Podcast } | null>(null);
  const play = useApp((s) => s.play);
  const router = useRouter();
  const mountedRef = useRef(true);
  const lastLoadRef = useRef(0);
  // Every kind:30311 event either pass has seen, keyed by NIP-33 address.
  //
  // The union is by ADDRESS, not by event id, and that is the difference from
  // the note feeds. A note is immutable, so unioning by id is right there; a
  // live activity is REPLACEABLE, so the index and the relays routinely hold
  // two versions of one broadcast and an id union would render the same show
  // twice — once as it was an hour ago and once as it is now. `shapeLiveStreams`
  // keeps the newest per address, so re-shaping the accumulated set is what
  // makes a second source additive instead of duplicative.
  const seenRef = useRef<Map<string, Event>>(new Map());
  // V4V blocks already resolved, by NIP-33 address. `resolveStreamV4V` costs a
  // relay round trip per zap-split recipient, so re-running it on every commit
  // would pay the whole bill again — and the early paint below would blank a
  // boost button that was working a moment ago.
  const valueRef = useRef<Map<string, ValueBlock | null>>(new Map());
  // Which group the single row shows. Falls back to the first non-empty group
  // (see `active` below) when the selected one has nothing.
  const [filter, setFilter] = useState<StreamFilter>('live');

  useEffect(() => {
    mountedRef.current = true;
    load();
    // Refetch is gated on visibility + a minimum interval. fetchNostrLiveStreams
    // is a kind:30311 querySync across ~12 relays; polling it every 60 s and on
    // every window.focus regardless of whether the tab is even visible (or
    // anything changed) was pure waste. Skip while backgrounded; on the
    // interval tick / focus / becoming-visible, only reload if it's been a
    // while since the last one.
    const REFRESH_MIN_MS = 45_000;
    const maybeLoad = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (Date.now() - lastLoadRef.current < REFRESH_MIN_MS) return;
      load();
    };
    const timer = setInterval(maybeLoad, 60_000);
    document.addEventListener('visibilitychange', maybeLoad);
    window.addEventListener('focus', maybeLoad);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', maybeLoad);
      window.removeEventListener('focus', maybeLoad);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Merge one source's answer into what is on screen, and resolve it. */
  async function commit(streams: NostrLiveStream[]) {
    if (!streams.length || !mountedRef.current) return;
    for (const s of streams) {
      const addr = streamAddrOf(s.rawEvent);
      const prev = seenRef.current.get(addr);
      if (!prev || s.rawEvent.created_at > prev.created_at) seenRef.current.set(addr, s.rawEvent);
    }
    const merged = shapeLiveStreams([...seenRef.current.values()]);

    // PAINT FIRST, with whatever is already known, and enrich underneath.
    //
    // This is the whole point of reading the index. It answers in tens of
    // milliseconds, and everything below this line is relay traffic:
    // `resolveStreamV4V` fetches a profile per zap-split recipient and
    // deliberately retries cached misses, so a row of 23 streams is dozens of
    // round trips. Resolving before painting spent the index's entire advantage
    // and then some — measured at 7.3s to first row against a 56ms index
    // response. A card renders from the event itself; the profile is a nicer
    // name and avatar, and `value` only gates the BOOST button.
    const paint = () => merged.map((stream) => ({
      stream,
      profile: storage.profile.get(stream.pubkey) ?? null,
      value: valueRef.current.get(streamAddrOf(stream.rawEvent)) ?? null,
    }));
    setResolved(paint());
    // `loading` means "nothing to show yet", not "a fetch is running" — the
    // same rule `useNostrFeed` follows.
    setLoading(false);

    // Host profiles: name, avatar, LN address. The index pass has already put
    // the ones it carried into `storage.profile`, so this only chases whatever
    // it did not know about.
    //
    // ONE batched query, never a `fetchProfile` per host. `fetchProfile` opens
    // a subscription per relay — that per-relay accounting is what its
    // `trustworthy` flag is for — so a row of twenty-odd streams was ~5x that
    // many concurrent REQs across five sockets. Relays cap subscriptions per
    // connection and drop the overflow silently, so the hosts that lost the
    // race did not resolve late, they did not resolve at all, and this `await`
    // then sat on the slowest of them: a bare npub where a name should be, for
    // the full window, on the first thing the home page paints.
    // `fetchProfilesFor` serves cached hits and cached misses without touching
    // the network, so passing the whole list every time costs nothing.
    //
    // Asked against LIVE_STREAM_RELAYS rather than the defaults, because that
    // is where these particular kind:0s are: a zap.stream or nostr.wine host
    // need not publish a profile to a podcast listener's relay set, and
    // `resolveStreamV4V` already falls back to exactly this union one pubkey at
    // a time. Costs no new sockets — the kind:30311 query that produced these
    // streams opened them a moment ago and the shared pool keeps them warm.
    await fetchProfilesFor([...new Set(merged.map((s) => s.pubkey))], LIVE_STREAM_RELAYS);
    if (!mountedRef.current) return;
    setResolved(paint());

    // Then V4V, which is the expensive half. Only for streams whose block we
    // have not resolved yet — a second commit from the slower source must not
    // re-pay for the ones the first already answered.
    const pending = merged.filter((s) => !valueRef.current.has(streamAddrOf(s.rawEvent)));

    // Their zap-split recipients first, in ONE query for the whole row.
    // `resolveStreamV4V` resolves a NIP-53 `zap` tag's pubkey to an lnaddress
    // through its kind:0, one pubkey at a time — and this loop runs it across
    // every stream at once, so a row where several broadcasts carry splits was
    // dozens of single-author lookups, each fanning out per relay. They are all
    // known here, before any of them is needed. What is left for the per-pubkey
    // path afterwards is the case it genuinely exists for: a recipient carrying
    // its own relay hint, and a cached MISS, which that function deliberately
    // retries because an lud16 is what gates the BOOST button.
    const zapRecipients = [...new Set(
      pending.flatMap((s) => s.zapWeights.filter((z) => z.weight > 0).map((z) => z.pubkey)),
    )];
    if (zapRecipients.length) await fetchProfilesFor(zapRecipients, LIVE_STREAM_RELAYS);

    await Promise.all(
      pending.map(async (stream) => {
        valueRef.current.set(streamAddrOf(stream.rawEvent), await resolveStreamV4V(stream));
      }),
    );

    if (!mountedRef.current) return;
    setResolved(paint());
  }

  async function load() {
    lastLoadRef.current = Date.now(); // stamp at entry so overlapping triggers debounce

    // The two passes run TOGETHER, and the index never replaces the relays.
    // It holds what it has seen since it was deployed; the relays hold whatever
    // each of them kept, and only they carry a broadcast published in the
    // seconds since the last index write. Awaiting the index first would make a
    // merely-slow index worse than none, and letting it substitute for the
    // relay pass would drop streams it has not crawled.
    const indexPass = indexedLiveStreams()
      .then((streams) => (streams ? commit(streams) : undefined))
      .catch(() => { /* the index is never a reason to fail this row */ });

    try {
      await commit(await fetchNostrLiveStreams());
    } catch {
      // silently ignore — live streams section just stays empty / stale
    } finally {
      await indexPass;
      if (mountedRef.current) setLoading(false);
    }
  }

  if (loading && !resolved.length) {
    return (
      <section>
        <h3 className="font-display text-lg mb-3 text-bone/70">
          <span className="text-nostr animate-bolt">●</span> Live on Nostr
        </h3>
        <div className={LIVE_GRID}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-28 card animate-pulse opacity-40" />
          ))}
        </div>
      </section>
    );
  }

  if (!resolved.length) return null;

  // Split into their own rows so live streams aren't buried behind a long list
  // of upcoming ones, and so perpetual 24/7 stations don't crowd out genuine
  // live events. (fetchNostrLiveStreams already sorts upcoming-soonest /
  // live-newest within each group.)
  const live = resolved.filter((r) => r.stream.status === 'live' && !is247(r.stream));
  const radio = resolved.filter((r) => r.stream.status === 'live' && is247(r.stream));
  const upcoming = resolved.filter((r) => r.stream.status === 'planned');

  const renderCard = ({ stream, profile, value }: ResolvedStream) => {
    // Play instantly (the card already has the resolved data); a card click
    // (expand) also navigates to the dedicated /stream/<naddr> page so the URL
    // reflects it and a refresh restores the stream. The PLAY button stays in
    // the mini-bar (no navigation).
    const start = (expand: boolean) => {
      play(streamToEpisode(stream, value), streamToPodcast(stream, profile));
      if (expand) router.push(`/stream/${streamNaddr(stream.pubkey, stream.dTag)}`);
    };
    return (
      <StreamCard
        key={stream.id}
        stream={stream}
        profile={profile}
        value={value}
        onPlay={() => start(false)}
        onOpen={() => start(true)}
        onBoost={() => {
          const podcast = streamToPodcast(stream, profile);
          podcast.value = value;
          setBoostTarget({ episode: streamToEpisode(stream, value), podcast });
        }}
      />
    );
  };

  // Only offer tabs that have streams; keep them in a stable order. The active
  // tab falls back to the first available when the selected group is empty
  // (e.g. `filter` defaults to 'live' but there are only upcoming streams).
  const tabs = (
    [
      { key: 'live', label: 'Live', icon: '●', items: live },
      { key: 'radio', label: '24/7', icon: '📻', items: radio },
      { key: 'upcoming', label: 'Upcoming', icon: '◷', items: upcoming },
    ] as const
    // Live and Upcoming are the two states every broadcast is in, so they stay
    // on screen with a count of 0 rather than vanishing — a hidden tab and a
    // tab reading `0` look the same from the reader's side only if you already
    // know the tab exists. 24/7 is a SUBDIVISION of live rather than a state of
    // its own, so it earns its place only when something is in it. The RSS
    // strip on `/live` follows the same rule for the same reason; this section
    // renders nothing at all when every group is empty, so a row of zeroes is
    // never what greets anybody.
  ).filter((t) => t.items.length > 0 || t.key !== 'radio');
  const active = tabs.find((t) => t.key === filter) ?? tabs[0];

  return (
    <section>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <h3 className="font-display text-lg flex items-center gap-2">
          <span className="text-nostr animate-bolt text-sm">●</span>
          Live on Nostr
        </h3>
        {/* One row, tab-selected — saves the vertical space of stacked sections. */}
        <div className="inline-flex gap-1">
          {tabs.map((t) => {
            const on = active.key === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setFilter(t.key)}
                aria-pressed={on}
                className={`btn-ghost !px-2.5 !py-1 text-xs ${on ? '!border-nostr text-nostr' : 'text-muted'}`}
              >
                <span aria-hidden className="mr-1">{t.icon}</span>
                {t.label} <span className="opacity-60">{t.items.length}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* A GRID, NOT A RAIL, AND THE REASON CHANGED RATHER THAN BEING FORGOTTEN.
          This was a horizontal `overflow-x-auto` row for as long as it was ONE
          section of the home page, competing with a search box and a feed —
          there, hiding cards off the side was the right trade. It now lives on
          `/live`, whose entire job is listing what is on, beside a section of
          `<podcast:liveItem>` rows in a grid. Two containers for the same kind
          of object read as two different kinds of thing, which is how this was
          reported: "one is a list and one is a row".

          Deleted with the rail: `overscroll-x-contain` (there is no sideways
          gesture left to contain, so it guarded nothing) and
          `useHorizontalWheelScroll` (it existed because a mouse has no sideways
          wheel and the off-screen cards were otherwise unreachable — a grid
          leaves nothing off-screen). The hook itself stays; `<Podroll>` is
          still a rail and still needs it. */}
      <div className={LIVE_GRID}>{active.items.map(renderCard)}</div>

      {boostTarget && (
        <BoostModal
          episode={boostTarget.episode}
          podcast={boostTarget.podcast}
          onClose={() => setBoostTarget(null)}
        />
      )}
    </section>
  );
}

function StreamCard({
  stream,
  profile,
  value,
  onPlay,
  onOpen,
  onBoost,
}: {
  stream: NostrLiveStream;
  profile: ProfileMetadata | null;
  value: ValueBlock | null;
  onPlay: () => void;
  onOpen: () => void;
  onBoost: () => void;
}) {
  const current = useApp((s) => s.current);
  const isPlaying = useApp((s) => s.isPlaying);
  const togglePlay = useApp((s) => s.togglePlay);
  const isCurrentStream =
    current?.episode.guid === stream.id;
  // Only playable streams (live, with a URL) open the fullscreen player on a
  // card click; an upcoming/URL-less card click does nothing.
  const playable = stream.status !== 'planned' && !!stream.streamUrl;

  const displayName =
    profile?.display_name ?? profile?.name ?? stream.npub.slice(0, 12) + '…';
  const image = stream.image ?? profile?.picture;

  return (
    <LiveCard
      image={image}
      title={stream.title}
      seed={stream.id}
      // Art is a control only where there is something to open. An upcoming or
      // URL-less card is not one and must not take focus on the way to the
      // buttons that do work — the rule the old hand-rolled header followed,
      // now the shell's.
      onArtClick={playable ? onOpen : undefined}
      artLabel={playable ? `Open ${stream.title}` : undefined}
      badges={
        <>
          {stream.status === 'live' ? (
            <span className="stamp shrink-0 whitespace-nowrap text-nostr border-nostr/60 bg-nostr/10 animate-bolt">
              ● LIVE
            </span>
          ) : (
            <span className="stamp shrink-0 whitespace-nowrap text-bolt border-bolt/60">UPCOMING</span>
          )}
          {stream.currentViewers != null && stream.currentViewers > 0 && (
            <span className="text-[10px] text-muted font-mono">{stream.currentViewers} 👁</span>
          )}
        </>
      }
      heading={
        playable ? (
          <button
            type="button"
            onClick={onOpen}
            className="block text-left w-full truncate font-medium hover:text-bolt transition"
            title={`Open ${stream.title}`}
          >
            {stream.title}
          </button>
        ) : (
          <p className="truncate font-medium" title={stream.title}>{stream.title}</p>
        )
      }
      sub={<p className="text-muted text-xs truncate">by {displayName}</p>}
      meta={
        stream.startsAt != null ? (
          <p className={`text-xs font-mono ${stream.status === 'planned' ? 'text-bolt' : 'text-nostr'}`}>
            {stream.status === 'planned' ? 'starts' : 'started'} {fmtLiveTime(stream.startsAt)}
          </p>
        ) : undefined
      }
      extra={
        stream.hashtags.length > 0 ? (
          <div className="flex flex-wrap gap-1 mt-1">
            {stream.hashtags.slice(0, 3).map((tag) => (
              <span key={tag} className="text-[10px] text-muted font-mono bg-bone/5 px-1 rounded">
                #{tag}
              </span>
            ))}
          </div>
        ) : undefined
      }
      actions={
        <>
          {/* **Only the PAUSE case toggles.** A control drawing ❚❚ has to pause,
              and `onPlay()` there writes `isPlaying: true` over `true` — a silent
              no-op, since neither of the player's effects re-runs. But RESUME
              must NOT toggle: `onPlay()` is `play(streamToEpisode(stream, …))`,
              rebuilt from the newest kind:30311, and `togglePlay()` replays
              whatever `current.episode.enclosureUrl` was seeded with. A host who
              restarts mid-broadcast republishes the event with a new `streaming`
              tag, so the card refreshes while `current` does not, and resuming
              through the toggle re-sources a dead URL. Sending everything except
              the pause down `onPlay()` costs nothing — it is the same live edge
              either way — and removes the question. */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (isCurrentStream && isPlaying) togglePlay();
              else onPlay();
            }}
            // A stream we are PLAYING stays pressable whatever the event now
            // says. `stream.status` and `stream.streamUrl` are live-refreshed, so
            // a host republishing without a `streaming` tag mid-broadcast would
            // otherwise disable the only control that can stop the audio — while
            // it renders ❚❚ and keeps playing.
            disabled={(stream.status === 'planned' || !stream.streamUrl) && !(isCurrentStream && isPlaying)}
            className="btn-mini disabled:opacity-60 disabled:cursor-not-allowed"
            title={
              isCurrentStream && isPlaying
                ? 'Pause'
                : stream.status === 'planned'
                ? "Stream hasn't started yet"
                : !stream.streamUrl
                ? 'No stream URL'
                : isCurrentStream
                ? 'Resume'
                : 'Play stream'
            }
            // REQUIRED, like the BOOST button below: `title` is not an accessible
            // name, so without this the name is the text content — which read
            // "❚❚ PLAY", announcing a pause control as "play".
            aria-label={
              isCurrentStream && isPlaying ? 'Pause' : isCurrentStream ? 'Resume' : 'Play stream'
            }
          >
            {/* The WORD moves with the glyph. It read "❚❚ PLAY" — the icon said
                pause and the label said play, on the same control, which is the
                lie this branch exists to remove. Same vocabulary as
                <EpisodeDetailView>: PAUSE / RESUME / PLAY. */}
            {isCurrentStream && isPlaying ? '❚❚ PAUSE' : isCurrentStream ? '▶ RESUME' : '▶ PLAY'}
          </button>
          {/* hasValueRecipients, not a bare truthiness check: resolveStreamV4V can
              return a block with an empty `recipients` array, which opened the
              boost modal with nobody to pay. */}
          {hasValueRecipients(value) && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onBoost(); }}
              className="btn-bolt text-xs py-1 px-2 shrink-0 flex items-center gap-1"
              title="Boost this stream"
              // REQUIRED, not decorative — `title` is not an accessible name, so
              // without this the button reads as unlabelled and its only content
              // is an emoji whose announced name is "high voltage". Same rule
              // player.tsx and lists.tsx already spell out for their own buttons.
              aria-label="Boost this stream"
            >
              ⚡
            </button>
          )}
        </>
      }
    />
  );
}
