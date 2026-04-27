'use client';
import { useEffect, useState } from 'react';
import type { Episode, Podcast } from '@/lib/types';
import { useApp } from '@/lib/store';

export function PodcastResults({
  feeds,
  selected,
  onSelect,
}: {
  feeds: Podcast[];
  selected: number | null;
  onSelect: (p: Podcast) => void;
}) {
  if (!feeds.length) {
    return <p className="text-muted text-sm py-8 px-1">no results yet — try another phrase</p>;
  }
  return (
    <ul className="divide-y divide-bone/10">
      {feeds.map((p) => (
        <li
          key={p.id}
          onClick={() => onSelect(p)}
          className={`flex gap-3 py-3 px-1 cursor-pointer group transition ${
            selected === p.id ? 'bg-bolt/10' : 'hover:bg-bone/5'
          }`}
        >
          {p.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.image} alt="" className="w-14 h-14 object-cover border border-bone/20 flex-shrink-0" />
          ) : (
            <div className="w-14 h-14 border border-bone/20 bg-line flex-shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-display text-base leading-tight truncate">{p.title}</span>
              {p.value && (
                <span className="stamp text-bolt border-bolt/60">⚡ V4V</span>
              )}
            </div>
            <div className="text-xs text-muted truncate">{p.author}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function EpisodeList({ feedId }: { feedId: number | null }) {
  const [data, setData] = useState<{ podcast: Podcast | null; episodes: Episode[] }>({
    podcast: null, episodes: [],
  });
  const [loading, setLoading] = useState(false);
  const play = useApp((s) => s.play);
  const current = useApp((s) => s.current);

  useEffect(() => {
    if (!feedId) { setData({ podcast: null, episodes: [] }); return; }
    setLoading(true);
    fetch(`/api/feed?id=${feedId}`)
      .then((r) => r.json())
      .then((d) => setData({ podcast: d.podcast, episodes: d.episodes }))
      .finally(() => setLoading(false));
  }, [feedId]);

  if (!feedId) {
    return (
      <div className="text-muted text-sm py-12 text-center px-4 border border-dashed border-bone/15">
        select a podcast on the left to see episodes
      </div>
    );
  }
  if (loading) return <div className="text-muted text-sm py-8">loading episodes…</div>;
  if (!data.podcast) return <div className="text-muted text-sm py-8">not found</div>;

  return (
    <div>
      <header className="flex gap-4 pb-4 border-b border-bone/15">
        {data.podcast.image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={data.podcast.image} alt="" className="w-20 h-20 object-cover border border-bone/20" />
        )}
        <div className="min-w-0">
          <h2 className="font-display text-2xl leading-tight">{data.podcast.title}</h2>
          <p className="text-xs text-muted mt-1">{data.podcast.author}</p>
          {data.podcast.value && (
            <p className="stamp mt-2 text-bolt border-bolt/60">
              ⚡ {data.podcast.value.recipients.length} recipients · {data.podcast.value.method}
            </p>
          )}
        </div>
      </header>
      <ul className="divide-y divide-bone/10">
        {data.episodes.map((e) => {
          const playing = current?.episode.id === e.id;
          return (
            <li
              key={e.id}
              className={`flex gap-3 py-3 cursor-pointer group transition ${
                playing ? 'bg-bolt/10' : 'hover:bg-bone/5'
              }`}
              onClick={() => data.podcast && play(e, data.podcast)}
            >
              <button className="w-9 h-9 flex-shrink-0 border border-bone/40 group-hover:border-bolt grid place-items-center text-bone group-hover:text-bolt">
                {playing ? '❚❚' : '▶'}
              </button>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-display leading-tight truncate">{e.title}</div>
                <div className="text-[11px] text-muted flex gap-2 mt-0.5">
                  {e.datePublished && <span>{new Date(e.datePublished * 1000).toLocaleDateString()}</span>}
                  {e.duration && <span>· {Math.round(e.duration / 60)}m</span>}
                  {e.value && <span className="text-bolt">· ⚡ V4V</span>}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
