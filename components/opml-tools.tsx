'use client';
import { useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { BRAND } from '@/lib/brand';
import { requestFavoritesSync } from '@/lib/nostr';
import { buildOpml, MAX_OPML_BYTES, opmlFilename, parseOpml, type OpmlFeed } from '@/lib/feed-xml';
import {
  resolvePodcastByFeedUrl, resolvePodcastByGuid, warmPodcastCache,
} from '@/lib/podcast-meta';
import { getErrorMessage, mapLimit } from '@/lib/util';
import { favoriteFromPodcast } from '@/components/fav-heart';
import type { FavoritePodcast } from '@/lib/types';

/**
 * OPML import and export of SHOW favorites — the subscription list every other
 * podcast app reads and writes. Episode and track favorites do not travel:
 * OPML has no standard way to name one.
 *
 * Works signed in and signed out; the store has a guest bucket.
 *
 * Three rules the import keeps, each because the store is what gets published
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
 */
export function OpmlTools() {
  return (
    <>
      <ExportOpml />
      <ImportOpml />
    </>
  );
}

/** Podcast Index lookups in flight at once. The warm pass does the bulk. */
const RESOLVE_FANOUT = 4;

function ExportOpml() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'no'; text: string } | null>(null);

  async function download() {
    setBusy(true);
    setMsg(null);
    try {
      const favs = Object.values(useApp.getState().favorites);
      // An unresolved row has no feed URL yet; ask Podcast Index for it rather
      // than leave the show out of the file.
      const missing = favs.filter((f) => !f.url).map((f) => f.podcastGuid);
      if (missing.length) await warmPodcastCache(missing);
      const rows = await mapLimit(favs, RESOLVE_FANOUT, async (f) => {
        if (f.url) return { url: f.url, title: f.title };
        const p = await resolvePodcastByGuid(f.podcastGuid).catch(() => null);
        return p?.url ? { url: p.url, title: f.title ?? p.title } : null;
      });
      const feeds = rows
        .filter((r): r is { url: string; title: string | undefined } => !!r)
        .sort((a, b) => (a.title ?? a.url).localeCompare(b.title ?? b.url));
      const lost = favs.length - feeds.length;
      if (!feeds.length) {
        setMsg({ tone: 'no', text: favs.length ? 'no saved show has a feed URL' : 'no saved shows' });
        return;
      }
      const now = new Date();
      const xml = buildOpml(feeds, { title: `${BRAND.displayName} favorites`, dateCreated: now });
      const blob = new Blob([xml], { type: 'text/x-opml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = opmlFilename(BRAND.domain, now);
      // Attached before the click: Firefox ignores a click on a detached anchor.
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setMsg({
        tone: 'ok',
        text: `exported ${feeds.length} show${feeds.length === 1 ? '' : 's'}`
          + (lost ? `; ${lost} had no feed URL and were left out` : '')
          + '. Episode favorites are not part of OPML.',
      });
    } catch (e) {
      setMsg({ tone: 'no', text: getErrorMessage(e, 'the export failed') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={download}
        disabled={busy}
        className="btn-mini disabled:opacity-50"
        title="Save your favorite shows as an OPML file other podcast apps can import."
      >
        {busy ? 'building file…' : '⇩ OPML'}
      </button>
      {msg && (
        <span className={`text-[11px] ${msg.tone === 'ok' ? 'text-muted' : 'text-bone'}`}>
          {msg.tone === 'ok' ? msg.text : `no file written — ${msg.text}`}
        </span>
      )}
    </span>
  );
}

interface ImportPlan {
  add: FavoritePodcast[];
  already: number;
  notFound: OpmlFeed[];
  skipped: number;
}

function ImportOpml() {
  const identity = useApp((s) => s.identity);
  // Signed in, the account's list must have landed first (see the header).
  const waiting = useApp((s) => !!s.identity && (s.favoritesSync === 'idle' || s.favoritesSync === 'loading'));
  const addFavorite = useApp((s) => s.addFavorite);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
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
      // The batch route splits its list on commas, so a URL holding one goes
      // through the single lookup below instead of the warm pass.
      await warmPodcastCache(parsed.feeds.filter((f) => !f.url.includes(',')).map((f) => `url:${f.url}`));
      const found = await mapLimit(parsed.feeds, RESOLVE_FANOUT, (f) =>
        resolvePodcastByFeedUrl(f.url).catch(() => null));
      const current = useApp.getState().favorites;
      const next: ImportPlan = { add: [], already: 0, notFound: [], skipped: parsed.skipped };
      const planned = new Set<string>();
      parsed.feeds.forEach((f, i) => {
        const p = found[i];
        const guid = p?.podcastGuid;
        if (!p || !guid) {
          next.notFound.push(f);
        } else if (current[guid] || planned.has(guid)) {
          next.already++;
        } else {
          planned.add(guid);
          next.add.push(favoriteFromPodcast(p, guid));
        }
      });
      setPlan(next);
    } catch (e) {
      setMsg({ tone: 'no', text: getErrorMessage(e, 'the file could not be read') });
    } finally {
      setBusy(false);
      // Cleared so choosing the same file again still fires `change`.
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function apply() {
    if (!plan) return;
    const current = useApp.getState().favorites;
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
        accept=".opml,.xml,text/x-opml,text/xml,application/xml"
        className="hidden"
        onChange={(e) => chosen(e.target.files?.[0])}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy || waiting || !!plan}
        className="btn-mini disabled:opacity-50"
        title="Add the shows in an OPML file from another podcast app to your favorites."
      >
        {busy ? 'looking up shows…' : '⇧ import OPML'}
      </button>
      {waiting && !busy && (
        <span className="text-[11px] text-muted">waiting for your favorites to load</span>
      )}
      {plan && (
        <span className="flex max-w-prose flex-col items-start gap-1 text-[11px] text-muted">
          <span>
            {plan.add.length} new · {plan.already} already saved · {plan.notFound.length} not
            found in Podcast Index
            {plan.skipped ? ` · ${plan.skipped} skipped (not an http or https feed URL)` : ''}
          </span>
          {plan.notFound.length > 0 && (
            <details>
              <summary className="btn-inline cursor-pointer">shows that cannot be added</summary>
              <ul className="mt-1 list-disc pl-4">
                {plan.notFound.map((f) => (
                  <li key={f.url} className="break-all">{f.title ? `${f.title} — ${f.url}` : f.url}</li>
                ))}
              </ul>
            </details>
          )}
          <span className="flex gap-2">
            {plan.add.length > 0 && (
              <button type="button" onClick={apply} className="btn-mini">
                add {plan.add.length} show{plan.add.length === 1 ? '' : 's'}
              </button>
            )}
            <button type="button" onClick={() => setPlan(null)} className="btn-mini">
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
