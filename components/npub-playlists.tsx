'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { COMMUNITY_PLAYLISTS_ON } from '@/lib/curated-playlists';
import { fetchCommunityPlaylists } from '@/lib/community/client';
import type { CommunityPlaylistSummary } from '@/lib/community/rules';
import { communityPlaylistToPodcast } from '@/lib/util';
import type { Podcast } from '@/lib/types';
import { PodcastResults } from './lists';

/**
 * The community playlists one npub made, on its `/npub/<npub>` page.
 *
 * **It ships with community playlists, and not before.** The whole section sits
 * behind `COMMUNITY_PLAYLISTS_ON`, the same switch as the maker and the list —
 * off, it renders nothing and asks nothing, so the main site keeps today's
 * page until the feature launches (Chad, 2026-11-19: "add this to the beta
 * feature for playlist so that feature ships with playlists").
 *
 * **Only playlists made HERE.** The maker's key is a column in our own store, so
 * `?owner=` answers exactly. A playlist another app published that names this
 * npub in a `<podcast:txt purpose="npub">` cannot be found from the npub:
 * Podcast Index does not search by key, and reading every curated feed to look
 * would be a fan-out on every visit. The description says "made on this site"
 * so the list never reads as everything the person made.
 *
 * **`null` is "no answer", never "no playlists"** — `fetchCommunityPlaylists`
 * keeps the two apart and so does this. An empty answer is a fact from our own
 * store, and the section then renders NOTHING: most npubs never made one, and a
 * heading over "none" on every boost page is noise. A FAILED read renders the
 * heading with a RETRY, because hiding it would make the same silent claim.
 * Nothing renders while loading either — no heading that may vanish a moment
 * later, and the store answers in milliseconds.
 *
 * **Muting the npub hides its playlists here**, as it hides the npub's own
 * boosts in the "sent" section beside this one, and says so in the same words.
 */
export function NpubPlaylists(props: { pubkey: string; npub: string; muted: boolean }) {
  // The switch is a build-time constant, so the section either exists for the
  // life of the bundle or not at all; the split keeps the hooks unconditional.
  return COMMUNITY_PLAYLISTS_ON ? <NpubPlaylistsSection {...props} /> : null;
}

const COLLAPSE_KEY = 'npub:playlists';

function NpubPlaylistsSection({ pubkey, npub, muted }: { pubkey: string; npub: string; muted: boolean }) {
  const [rows, setRows] = useState<CommunityPlaylistSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const bodyId = useId();
  const [collapsed, setCollapsed] = useState(false);
  const selectPodcast = useApp((s) => s.selectPodcast);
  const setShowOrigin = useApp((s) => s.setShowOrigin);
  const router = useRouter();
  // Each load takes a number, and only the newest may write: one npub's late
  // answer must never paint on another npub's page. Today Next mounts a NEW
  // page for each npub, which already drops the late answer — measured: the
  // e2e's late-answer check passes with this guard removed. It stays for the
  // day this component is reused across npubs, where nothing else would.
  const gen = useRef(0);

  const load = useCallback(async () => {
    const mine = ++gen.current;
    setLoading(true);
    const list = await fetchCommunityPlaylists(pubkey);
    if (mine !== gen.current) return;
    setLoading(false);
    // A failed RETRY keeps the rows already on screen, and `failed` clears only
    // on an answer, so the RETRY line does not vanish while it is asking again.
    if (list === null) {
      setFailed(true);
    } else {
      setFailed(false);
      setRows(list);
    }
  }, [pubkey]);

  useEffect(() => {
    setRows(null);
    setFailed(false);
    void load();
    // Invalidates the load in flight. `gen` is a counter, not a DOM node, so
    // reading `.current` at cleanup time is the point.
    const counter = gen;
    return () => { counter.current++; };
  }, [load]);

  useEffect(() => {
    setCollapsed(storage.sectionCollapsed.get().includes(COLLAPSE_KEY));
  }, []);

  function toggle() {
    const next = new Set(storage.sectionCollapsed.get());
    if (!next.delete(COLLAPSE_KEY)) next.add(COLLAPSE_KEY);
    storage.sectionCollapsed.set([...next]);
    setCollapsed(next.has(COLLAPSE_KEY));
  }

  /**
   * Set the store, THEN navigate to `/` — the same handoff `/playlists` uses,
   * never `router.push('/?podcast=…')`. The origin goes on AFTER
   * `selectPodcast`, which clears it; "boosts" is the label `<NoteCard>` gives
   * this page, so both ways off it come back with the same words.
   */
  function openPlaylist(p: Podcast) {
    selectPodcast(p);
    setShowOrigin({ path: `/npub/${npub}`, label: 'boosts' });
    router.push('/');
  }

  if (rows === null && !failed) return null;
  if (rows !== null && rows.length === 0 && !failed) return null;

  const count = rows?.length ?? null;
  const byUrl = new Map((rows ?? []).map((r) => [r.feedUrl, r]));
  const feeds = (rows ?? []).map(communityPlaylistToPodcast);

  return (
    <section data-npub-playlists>
      <header className="flex items-center justify-between border-b border-bone/15 pb-2 mb-3 gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          className="flex items-center gap-2 min-w-0 text-left hover:opacity-80"
        >
          <span aria-hidden className="text-bone/60 text-sm">{collapsed ? '▸' : '▾'}</span>
          <span className="min-w-0">
            <h2 className="font-display text-2xl">
              <span className="text-bolt">♫</span> Playlists
            </h2>
          </span>
          {count !== null && <span className="text-xs text-muted shrink-0">({count})</span>}
        </button>
      </header>
      <div id={bodyId}>
        {!collapsed && (
          <>
            <p className="text-xs text-muted leading-relaxed mb-3">
              Community playlists this npub made in this app. Every track lives in its own
              artist&apos;s feed, so a boost pays the artist, not the list.
            </p>
            {failed && (
              <p className="text-sm py-2 flex flex-wrap items-center gap-3" data-npub-playlists-failed>
                <span className="text-muted">couldn&apos;t load this npub&apos;s playlists just now</span>
                <button
                  type="button"
                  onClick={() => void load()}
                  disabled={loading}
                  className="btn-ghost btn-compact"
                >
                  {loading ? 'loading…' : '↻ RETRY'}
                </button>
              </p>
            )}
            {muted && feeds.length > 0 ? (
              <p className="text-sm text-muted">
                you have muted this npub, so its playlists are hidden here. Unmute to see them.
              </p>
            ) : feeds.length > 0 ? (
              <PodcastResults
                feeds={feeds}
                selected={null}
                onSelect={openPlaylist}
                // Podcast Index was never asked about these rows: they come from
                // our own store, so `isPreview` says nothing about PI.
                piUnasked
                meta={(p) => {
                  const n = p.url ? byUrl.get(p.url)?.songCount : undefined;
                  if (n === undefined) return null;
                  return n === 1 ? '1 track' : `${n.toLocaleString()} tracks`;
                }}
              />
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
