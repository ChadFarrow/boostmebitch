'use client';
import { useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { requestFavoritesSync } from '@/lib/nostr';
import { MAX_OPML_BYTES, opmlUrlVariants, parseOpml, type OpmlFeed } from '@/lib/feed-xml';
import {
  podcastLookupAnswered, resetPiBreaker, resolvePodcastByFeedUrl, warmPodcastCache,
} from '@/lib/podcast-meta';
import { getErrorMessage, mapLimit } from '@/lib/util';
import { favoriteFromPodcast } from '@/components/fav-heart';
import type { FavoritePodcast } from '@/lib/types';

/**
 * OPML import of SHOW favorites — the subscription list every other podcast
 * app writes. Episode and track favorites do not travel: OPML has no standard
 * way to name one. (Export is a separate, later change.)
 *
 * Works signed in and signed out; the store has a guest bucket.
 *
 * Four rules the import keeps, each because the store is what gets published
 * to the shared kind:10333 event:
 *
 *  - **Preview, then write.** Nothing reaches the store until the user presses
 *    `add N shows`, after seeing what was found.
 *  - **Never while the account's list is still loading.** Painting into the
 *    store before hydration is how a planner mistakes the new entries — or the
 *    missing old ones — for a local change.
 *  - **A feed Podcast Index cannot find is REPORTED, never dropped unseen.**
 *    A favorite is keyed by `podcastGuid`, so an unindexed feed cannot be
 *    saved; the preview lists it by name.
 *  - **"Could not ask" is not "not found".** The resolvers return `null` for an
 *    open breaker, a 5xx, a 429/408 and offline too; `podcastLookupAnswered`
 *    separates those, so an outage is reported as one and can be retried
 *    rather than reading as a file full of unindexed feeds.
 */
/** Podcast Index lookups in flight at once. The warm pass does the bulk. */
const RESOLVE_FANOUT = 4;

interface ImportPlan {
  add: FavoritePodcast[];
  already: number;
  /** Podcast Index answered: it does not hold this feed. */
  notFound: OpmlFeed[];
  /** Podcast Index holds the feed but gives it no `podcast:guid` to key a favorite by. */
  noGuid: OpmlFeed[];
  /** Nothing answered (breaker open, 5xx, 429/408, offline) — retryable, says nothing about the feed. */
  unreachable: OpmlFeed[];
  skipped: number;
}

/**
 * Resolve each feed URL and sort it into the preview's buckets. Nothing here
 * touches the store; `apply()` is the only writer.
 */
async function planImport(feeds: OpmlFeed[], skipped: number): Promise<ImportPlan> {
  // The batch route splits its list on commas, so a URL holding one goes
  // through the single lookup below instead of the warm pass.
  await warmPodcastCache(feeds.filter((f) => !f.url.includes(',')).map((f) => `url:${f.url}`));
  const found = await mapLimit(feeds, RESOLVE_FANOUT, (f) =>
    resolvePodcastByFeedUrl(f.url).catch(() => null));
  // PI matches the feed URL EXACTLY, and the file's spelling is not always
  // PI's: a space written `%20`, or the reverse. Only an ANSWERED miss is
  // retried — "could not ask" stays in its own bucket — and in series per
  // feed, so the fan-out stays RESOLVE_FANOUT.
  await mapLimit(feeds.map((f, i) => ({ f, i })), RESOLVE_FANOUT, async ({ f, i }) => {
    if (found[i] || !podcastLookupAnswered({ feedUrl: f.url })) return;
    for (const alt of opmlUrlVariants(f.url)) {
      const p = await resolvePodcastByFeedUrl(alt).catch(() => null);
      if (p) {
        found[i] = p;
        return;
      }
    }
  });
  const current = useApp.getState().favorites;
  const next: ImportPlan = { add: [], already: 0, notFound: [], noGuid: [], unreachable: [], skipped };
  const planned = new Set<string>();
  feeds.forEach((f, i) => {
    const p = found[i];
    const guid = p?.podcastGuid;
    if (!p) {
      (podcastLookupAnswered({ feedUrl: f.url }) ? next.notFound : next.unreachable).push(f);
    } else if (!guid) {
      next.noGuid.push(f);
    } else if (current[guid] || planned.has(guid)) {
      next.already++;
    } else {
      planned.add(guid);
      next.add.push(favoriteFromPodcast(p, guid));
    }
  });
  return next;
}

/**
 * `standalone`: signed out, this is the only control on its row and sits beside
 * the page's `.btn-ghost` actions, where a `.btn-mini` reads as disabled.
 * Signed in it stays `.btn-mini`, one of the privacy row's family (docs/ui.md).
 */
export function OpmlImport({ standalone = false }: { standalone?: boolean }) {
  const identity = useApp((s) => s.identity);
  // Signed in, the account's list must have landed first (see the header).
  const waiting = useApp((s) => !!s.identity && (s.favoritesSync === 'idle' || s.favoritesSync === 'loading'));
  const addFavorite = useApp((s) => s.addFavorite);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  // Kept so the unreachable rows can be retried without choosing the file again.
  const [parsedFeeds, setParsedFeeds] = useState<{ feeds: OpmlFeed[]; skipped: number } | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'no'; text: string } | null>(null);

  async function chosen(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setPlan(null);
    setMsg(null);
    try {
      if (file.size > MAX_OPML_BYTES) {
        setMsg({ tone: 'no', text: 'this file is too large to be a subscription list' });
        return;
      }
      const parsed = parseOpml(await file.text());
      if (!parsed.ok) {
        setMsg({ tone: 'no', text: parsed.error });
        return;
      }
      if (!parsed.feeds.length) {
        setMsg({ tone: 'no', text: 'the file lists no podcast feeds' });
        return;
      }
      setParsedFeeds({ feeds: parsed.feeds, skipped: parsed.skipped });
      setPlan(await planImport(parsed.feeds, parsed.skipped));
    } catch (e) {
      setMsg({ tone: 'no', text: getErrorMessage(e, 'the file could not be read') });
    } finally {
      setBusy(false);
      // Cleared so choosing the same file again still fires `change`.
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function retryUnreachable() {
    if (!parsedFeeds) return;
    setBusy(true);
    setMsg(null);
    try {
      // An explicit retry is what `resetPiBreaker` exists for: it also drops
      // the negatives an open breaker left behind.
      resetPiBreaker();
      setPlan(await planImport(parsedFeeds.feeds, parsedFeeds.skipped));
    } catch (e) {
      setMsg({ tone: 'no', text: getErrorMessage(e, 'the lookup failed') });
    } finally {
      setBusy(false);
    }
  }

  function apply() {
    if (!plan) return;
    // The button is disabled on the same condition, but a read can START
    // between render and press — a degraded read retries on window `focus`,
    // which closing the file picker fires. Painting into the store under an
    // in-flight hydrate is what the header's second rule forbids.
    const s = useApp.getState();
    if (s.identity && (s.favoritesSync === 'idle' || s.favoritesSync === 'loading')) {
      setMsg({ tone: 'no', text: 'your favorites are still loading — press add again once they have' });
      return;
    }
    const current = s.favorites;
    // One entry at a time through the same action the heart uses. An entry
    // that appeared since the preview is left as it is.
    let added = 0;
    for (const fav of plan.add) {
      if (current[fav.podcastGuid]) continue;
      addFavorite(fav);
      added++;
    }
    if (added) requestFavoritesSync(identity);
    setPlan(null);
    setMsg({ tone: 'ok', text: `added ${added} show${added === 1 ? '' : 's'}` });
  }

  return (
    <span className="flex flex-col items-start gap-1">
      <input
        ref={fileRef}
        type="file"
        // NO `accept`. iOS greys out any file whose type it cannot match to
        // the list, and `.opml` has no system type there — a podcast app that
        // claims the extension owns it — so a real Fountain export could not be
        // chosen at all. `parseOpml` checks the bytes and says why it refuses,
        // which is the actual boundary; a filter was only ever a convenience.
        className="hidden"
        onChange={(e) => chosen(e.target.files?.[0])}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy || waiting || !!plan}
        className={`${standalone ? 'btn-ghost text-xs' : 'btn-mini'} disabled:opacity-50`}
        title="Add the shows in an OPML file from another podcast app to your favorites."
      >
        {busy ? 'looking up shows…' : '⇩ import OPML'}
      </button>
      {waiting && !busy && (
        <span className="text-[11px] text-muted">waiting for your favorites to load</span>
      )}
      {plan && (
        <span className="flex max-w-prose flex-col items-start gap-1 text-[11px] text-muted">
          <span>
            {plan.add.length} new · {plan.already} already saved · {plan.notFound.length} not
            found in Podcast Index
            {plan.noGuid.length ? ` · ${plan.noGuid.length} with no podcast:guid` : ''}
            {plan.unreachable.length
              ? ` · ${plan.unreachable.length} not looked up (Podcast Index did not answer)`
              : ''}
            {plan.skipped ? ` · ${plan.skipped} skipped (not an http or https feed URL)` : ''}
          </span>
          <FeedDetails label="not in Podcast Index" feeds={plan.notFound} />
          <FeedDetails label="in Podcast Index but with no podcast:guid" feeds={plan.noGuid} />
          <FeedDetails label="not looked up — try again" feeds={plan.unreachable} />
          <span className="flex gap-2">
            {plan.add.length > 0 && (
              <button type="button" onClick={apply} disabled={busy || waiting} className="btn text-xs disabled:opacity-50">
                add {plan.add.length} show{plan.add.length === 1 ? '' : 's'}
              </button>
            )}
            {plan.unreachable.length > 0 && (
              <button type="button" onClick={retryUnreachable} disabled={busy} className="btn-ghost text-xs disabled:opacity-50">
                {busy ? 'looking up…' : 'try again'}
              </button>
            )}
            <button type="button" onClick={() => { setPlan(null); setParsedFeeds(null); }} className="btn-ghost text-xs">
              {plan.add.length ? 'cancel' : 'close'}
            </button>
          </span>
        </span>
      )}
      {msg && (
        <span className={`text-[11px] ${msg.tone === 'ok' ? 'text-muted' : 'text-bone'}`}>
          {msg.tone === 'ok' ? msg.text : `nothing imported — ${msg.text}`}
        </span>
      )}
    </span>
  );
}

function FeedDetails({ label, feeds }: { label: string; feeds: OpmlFeed[] }) {
  if (!feeds.length) return null;
  return (
    <details>
      <summary className="btn-inline cursor-pointer">{label} ({feeds.length})</summary>
      <ul className="mt-1 list-disc pl-4">
        {feeds.map((f) => (
          <li key={f.url} className="break-all">{f.title ? `${f.title} — ${f.url}` : f.url}</li>
        ))}
      </ul>
    </details>
  );
}
