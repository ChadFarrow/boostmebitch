'use client';
import { useState } from 'react';
import { SearchBar } from '@/components/search-bar';
import { PodcastResults, EpisodeList } from '@/components/lists';
import { Player } from '@/components/player';
import { NostrAuth } from '@/components/nostr-auth';

import type { Podcast } from '@/lib/types';

export default function Home() {
  const [feeds, setFeeds] = useState<Podcast[]>([]);
  const [selected, setSelected] = useState<Podcast | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');

  return (
    <main className="min-h-screen pb-32">
      {/* Header */}
      <header className="border-b border-bone/15 sticky top-0 z-20 bg-ink/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center gap-4">
          <div className="flex items-baseline gap-2">
            <span className="text-bolt text-2xl">⚡</span>
            <h1 className="font-display text-2xl">PV4V</h1>
            <span className="text-[10px] text-muted uppercase tracking-widest hidden sm:inline">
              boost station
            </span>
          </div>
          <div className="flex-1" />
          <NostrAuth />
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-7xl mx-auto px-4 pt-10 pb-6">
        <div className="grid lg:grid-cols-[1fr_auto] gap-4 items-end">
          <h2 className="headline text-5xl sm:text-6xl lg:text-7xl">
            search<span className="text-bolt">.</span>{' '}
            listen<span className="text-bolt">.</span>{' '}
            <span className="text-bolt animate-bolt">boost</span><span className="text-bone">.</span>
          </h2>
          <p className="text-xs text-muted max-w-xs lg:text-right">
            Podcasting 2.0 over Lightning. NIP-07 sign-in.
            Splits respected. Boostagrams included.
          </p>
        </div>
        <div className="mt-8 max-w-xl">
          <SearchBar
            onResults={(f, q) => { setFeeds(f); setQuery(q); if (!f.length) setSelected(null); }}
            onLoading={setLoading}
          />
        </div>
      </section>

      {/* Results grid */}
      <section className="max-w-7xl mx-auto px-4 pt-2">
        {(loading || feeds.length > 0 || selected) ? (
          <div className="grid lg:grid-cols-[minmax(0,360px)_1fr] gap-6">
            <aside className="card p-3 max-h-[70vh] overflow-y-auto">
              <div className="text-[11px] uppercase tracking-widest text-muted mb-2 px-1">
                {loading ? 'searching…' : query ? `${feeds.length} feeds` : 'feeds'}
              </div>
              <PodcastResults
                feeds={feeds}
                selected={selected?.id ?? null}
                onSelect={setSelected}
              />
            </aside>
            <section className="card p-4 min-h-[40vh]">
              <EpisodeList feedId={selected?.id ?? null} />
            </section>
          </div>
        ) : (
          <EmptyState />
        )}
      </section>

      <Player />
    </main>
  );
}

function EmptyState() {
  return (
    <div className="grid sm:grid-cols-3 gap-4 mt-6">
      {[
        { n: '01', t: 'Search', d: 'Powered by the Podcast Index. V4V-enabled feeds get a yellow stamp.' },
        { n: '02', t: 'Listen', d: 'Full-fidelity playback from the original enclosure URL.' },
        { n: '03', t: 'Boost', d: 'Splits go out via NWC or WebLN. Boostagrams ride along in TLV 7629169.' },
      ].map((step) => (
        <article key={step.n} className="card p-4">
          <div className="font-mono text-bolt text-sm">{step.n}</div>
          <div className="font-display text-xl mt-1">{step.t}</div>
          <p className="text-xs text-muted mt-1.5 leading-relaxed">{step.d}</p>
        </article>
      ))}
    </div>
  );
}
