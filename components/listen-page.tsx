'use client';

// The /listen route's body: UP NEXT (the listen queue) and HISTORY (what this
// device played for a minute), as two underline tabs.
//
// WHY TWO TABS ON ONE ROUTE. The queue drains each episode as it ends, and the
// thing listeners asked for on 2026-10-01 was the other half — "queue up
// several episodes and then go back and boost after they listen to a few". The
// history is that half, so it sits beside the queue rather than on a route of
// its own. Tabs rather than one long page because a full queue is fifty rows,
// and a history under it would be fifty rows down. UP NEXT is FIRST and the
// page opens on it: "queue should still be at the top".
//
// It is the one surface that has to say something when a list is EMPTY. The
// lists render nothing in that case, and a route somebody navigated to
// deliberately cannot answer with a blank page.
//
// **The mount gate is what makes that claim honest, for BOTH lists.** The
// store seeds `listenQueue` and `playHistory` from localStorage at module
// scope, so the server always renders them empty and the client's first render
// may not. Claiming "nothing queued" from the server's answer is both a
// hydration mismatch and a lie to anybody who has a queue — and so is a count
// in a tab label. There is no network read to wait for here, so the wait is
// exactly one tick.

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { clearShowSelection, useApp } from '@/lib/store';
import { QueueList } from './lists/queue-list';
import { HistoryList } from './lists/history-list';
import { UnderlineTabs, tabPanelProps } from './underline-tabs';

type Tab = 'next' | 'history';

export function ListenPage() {
  const count = useApp((s) => s.listenQueue.length);
  const heard = useApp((s) => s.playHistory.length);
  const [mounted, setMounted] = useState(false);
  const [tab, setTab] = useState<Tab>('next');
  const idBase = useId();
  useEffect(() => { setMounted(true); }, []);

  const label = (word: string, n: number) => (mounted && n > 0 ? `${word} · ${n}` : word);

  return (
    // The old `max-w-3xl` measure up to lg:; from lg: the page's full width,
    // like every other route under this header. At 768px on a 1280px page the
    // queue sat in the left half with the right half empty.
    <div className="max-w-3xl lg:max-w-none">
      <div>
        <h1 className="headline text-3xl sm:text-5xl">listen<span className="text-bolt">.</span></h1>
        <p className="text-muted text-sm mt-2">
          What plays next, and what you already heard — so you can go back and boost it.
          Kept on this device.
        </p>
      </div>

      <UnderlineTabs
        className="mt-6"
        idBase={idBase}
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'next', label: label('Up Next', count) },
          { id: 'history', label: label('History', heard) },
        ]}
      />

      <div {...tabPanelProps(idBase, tab)} className="mt-5">
        {/* Before the first client tick the store's answer is the SERVER's, so
            neither branch below may run: an empty page is wrong for anybody
            holding a queue, and the empty state is a claim. */}
        {!mounted ? null
          : tab === 'next' ? (count > 0 ? <QueueList /> : <EmptyQueue />)
            : heard > 0 ? <HistoryList /> : <EmptyHistory />}
      </div>
    </div>
  );
}

function EmptyQueue() {
  return (
    <div className="card p-6">
      <p className="font-display text-xl">Nothing queued.</p>
      <p className="text-muted text-sm mt-2">
        Open an episode and press <span className="text-bone">＋ QUEUE</span> to
        line it up here. It plays after whatever is playing now, and each item
        keeps its own show — so you can mix them.
      </p>
      <p className="text-muted text-xs mt-3">
        The queue lives on this device only, and it is not part of your favorites.
      </p>
      {/* `clearShowSelection`, like every other page's home link. The store is
          module-level and outlives the route change, so without it somebody who
          opened a show, emptied their queue and pressed this lands on `/`
          re-opened to that show, with the URL mirror rewriting the bar. */}
      <Link href="/" onClick={clearShowSelection} className="btn-ghost btn-compact mt-4 inline-flex">
        ← FIND SOMETHING TO PLAY
      </Link>
    </div>
  );
}

function EmptyHistory() {
  return (
    <div className="card p-6">
      <p className="font-display text-xl">Nothing heard yet.</p>
      <p className="text-muted text-sm mt-2">
        Episodes you play for a minute show up here, so you can boost them later.
      </p>
      <p className="text-muted text-xs mt-3">
        Podcast episodes only — not music tracks or live shows. The history lives
        on this device only.
      </p>
      <Link href="/" onClick={clearShowSelection} className="btn-ghost btn-compact mt-4 inline-flex">
        ← FIND SOMETHING TO PLAY
      </Link>
    </div>
  );
}
