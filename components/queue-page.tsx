'use client';

// The /queue route's body.
//
// It is the one surface that has to say something when the queue is EMPTY. The
// panel itself renders nothing in that case, which is right where it sits under
// other content — but a route somebody navigated to deliberately cannot answer
// with a blank page.
//
// **The mount gate is what makes that claim honest.** The store seeds
// `listenQueue` from localStorage at module scope, so the server always renders
// an empty queue and the client's first render may not. Claiming "nothing
// queued" from the server's answer is both a hydration mismatch and a lie to
// anybody who has a queue. There is no network read to wait for here, so the
// wait is exactly one tick.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { clearShowSelection, useApp } from '@/lib/store';
import { QueueList } from './lists/queue-list';
import { LISTEN_QUEUE_CAP } from '@/lib/util';

export function QueuePage() {
  const count = useApp((s) => s.listenQueue.length);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  return (
    <>
      <h1 className="headline text-3xl sm:text-5xl">up next<span className="text-bolt">.</span></h1>
      <p className="text-muted text-sm mt-2">
        Episodes you lined up, in the order they will play. Kept on this device
        {mounted && count > 0 ? ` · ${count} of ${LISTEN_QUEUE_CAP}` : ''}.
      </p>

      <div className="mt-6">
        {/* Before the first client tick the store's answer is the SERVER's, so
            neither branch below may run: an empty page is wrong for anybody
            holding a queue, and the empty state is a claim. */}
        {!mounted ? null : count > 0 ? <QueueList /> : <EmptyQueue />}
      </div>
    </>
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
