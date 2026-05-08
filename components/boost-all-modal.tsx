'use client';
import { useEffect, useMemo, useState } from 'react';
import type { Episode, Podcast, Boostagram, ValueTimeSplit, StoredBoost } from '@/lib/types';
import { useApp } from '@/lib/store';
import { sendBoost, pickRail, type Rail } from '@/lib/v4v/boost';
import { hasNwc, subscribeNwc } from '@/lib/v4v/nwc';
import { hasSpark, subscribeSpark } from '@/lib/v4v/spark';
import { hasWebln } from '@/lib/v4v/webln';
import { storage } from '@/lib/storage';
import { getErrorMessage } from '@/lib/util';
import { BoltIcon } from './icons';
import { AmountInput, MIN_BOOST_SATS } from './boost-modal/amount-input';
import { MessageInput } from './boost-modal/message-input';
import { SenderName } from './boost-modal/sender-name';
import { PodcastCover } from './podcast-cover';

interface Props {
  podcast: Podcast;
  episode: Episode;
  onClose: () => void;
}

interface TrackProgress {
  index: number;
  ok: boolean;
  error?: string;
}

export function BoostAllModal({ podcast, episode, onClose }: Props) {
  const identity = useApp((s) => s.identity);
  const bumpBoosts = useApp((s) => s.bumpBoosts);
  const [sats, setSats] = useState(100);
  const [msg, setMsg] = useState('');
  const [name, setName] = useState('');
  const [rail, setRail] = useState<Rail | null>(null);

  const [splits, setSplits] = useState<ValueTimeSplit[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');

  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [progress, setProgress] = useState<TrackProgress[]>([]);

  // Sync rail if wallet connects/disconnects while modal is open.
  useEffect(() => {
    const bump = () => setRail(pickRail());
    const unsubNwc = subscribeNwc(bump);
    const unsubSpark = subscribeSpark(bump);
    return () => { unsubNwc(); unsubSpark(); };
  }, []);

  useEffect(() => {
    const pref = storage.railPref.get();
    const prefAvailable =
      (pref === 'nwc' && hasNwc())
      || (pref === 'spark' && hasSpark())
      || (pref === 'webln' && hasWebln());
    setRail(prefAvailable ? pref : pickRail());
    setName((cur) => {
      if (cur) return cur;
      const stored = storage.senderName.get();
      if (stored) return stored;
      return identity?.profile?.display_name || identity?.profile?.name || '';
    });
  }, [identity?.profile?.display_name, identity?.profile?.name]);

  // Fetch resolved value splits for this episode.
  useEffect(() => {
    setLoadState('loading');
    fetch(`/api/value-splits?feedId=${episode.feedId}&episodeId=${episode.id}`)
      .then((r) => r.json())
      .then((data) => {
        const resolved = (data.splits as ValueTimeSplit[]).filter(
          (s) => s.value?.recipients?.length,
        );
        setSplits(resolved);
        setLoadState('ready');
      })
      .catch(() => setLoadState('error'));
  }, [episode.feedId, episode.id]);

  const availableRails = useMemo(() => {
    const rails: Rail[] = [];
    if (hasNwc()) rails.push('nwc');
    if (hasSpark()) rails.push('spark');
    if (hasWebln()) rails.push('webln');
    return rails;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const total = sats * splits.length;

  async function go() {
    if (!rail || !splits.length) return;
    if (name) storage.senderName.set(name);

    setRunning(true);
    setProgress([]);

    for (let i = 0; i < splits.length; i++) {
      const split = splits[i];
      // Boostagram shape for valueTimeSplits: HOST episode in primary fields
      // (the album/playlist the listener is playing), TRACK in remote_*. The
      // recipient artist sees `podcast`/`episode` describing the listener's
      // context and `remote_*` identifying which track triggered the boost.
      const boostagram: Boostagram = {
        app_name: 'BoostMeBitch',
        app_version: '0.1.0',
        podcast: podcast.title,
        feedID: podcast.id,
        url: podcast.url,
        episode: episode.title,
        itemID: episode.id,
        episode_guid: episode.guid,
        remote_feed_guid: split.remoteItem?.feedGuid,
        remote_item_guid: split.remoteItem?.itemGuid,
        ts: 0,
        value_msat_total: sats * 1000,
        message: msg || undefined,
        sender_name: name || undefined,
        sender_id: identity?.pubkey,
        action: 'boost',
        uuid: crypto.randomUUID(),
      };
      try {
        const results = await sendBoost({
          value: split.value!,
          totalSats: sats,
          boostagram,
          rail,
        });
        const ok = results.some((r) => r.ok);
        if (ok) {
          const stored: StoredBoost = {
            uuid: boostagram.uuid!,
            ts: Date.now(),
            podcastTitle: podcast.title,
            podcastId: podcast.id,
            podcastGuid: podcast.podcastGuid,
            podcastImage: split.image ?? episode.image ?? podcast.image,
            episodeTitle: episode.title,
            episodeGuid: episode.guid,
            sats,
            message: msg || undefined,
            senderName: name || undefined,
            legs: results.map((r) => ({
              recipient: r.recipient.address,
              recipientName: r.recipient.name,
              sats: r.sats,
              ok: r.ok,
              error: r.error,
              boostboxUrl: r.boostboxUrl,
            })),
          };
          storage.boosts.add(identity?.npub, stored);
          bumpBoosts();
        }
        setProgress((prev) => [...prev, { index: i, ok }]);
      } catch (e) {
        setProgress((prev) => [
          ...prev,
          { index: i, ok: false, error: getErrorMessage(e, 'boost failed') },
        ]);
      }
    }

    setRunning(false);
    setDone(true);
  }

  const RAIL_LABELS: Record<Rail, string> = { nwc: 'NWC', spark: 'Spark', webln: 'WebLN' };

  return (
    <div className="fixed inset-0 z-40 bg-ink/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="card w-full max-w-xl bg-ink relative max-h-[92vh] overflow-y-auto">
        <button
          onClick={onClose}
          className="absolute top-2 right-3 text-muted hover:text-bone text-lg z-10"
          aria-label="Close"
        >×</button>

        <div className="p-5 border-b border-bone/15">
          <div className="stamp text-bolt border-bolt/60 mb-2">⚡ BOOST ALL TRACKS</div>
          <h3 className="font-display text-2xl leading-tight">{episode.title}</h3>
          <p className="text-xs text-muted mt-1">{podcast.title}</p>
        </div>

        <div className="p-5 space-y-4">

          {!rail && (
            <div className="text-[11px] text-nostr/80">
              No wallet connected — set one up in the account menu (top right).
            </div>
          )}

          {availableRails.length >= 2 && (
            <div>
              <p className="text-[11px] uppercase tracking-widest text-muted mb-1.5">Pay via</p>
              <div className="flex gap-2">
                {availableRails.map((r) => (
                  <button
                    key={r}
                    onClick={() => setRail(r)}
                    className={`btn-ghost !px-3 text-xs ${rail === r ? '!border-bolt text-bolt' : ''}`}
                  >
                    {RAIL_LABELS[r]}
                  </button>
                ))}
              </div>
            </div>
          )}

          <AmountInput sats={sats} onChange={setSats} />

          {loadState === 'loading' && (
            <p className="text-muted text-sm">Loading tracks…</p>
          )}
          {loadState === 'error' && (
            <p className="text-nostr/80 text-sm">Could not load track data. Try again later.</p>
          )}
          {loadState === 'ready' && splits.length === 0 && (
            <p className="text-muted text-sm">No resolvable value blocks found for this episode.</p>
          )}
          {loadState === 'ready' && splits.length > 0 && (
            <div>
              <p className="text-[11px] uppercase tracking-widest text-muted mb-2">
                Tracks ({splits.length})
              </p>
              <ul className="space-y-2">
                {splits.map((split, i) => {
                  const result = progress.find((p) => p.index === i);
                  return (
                    <li key={i} className="card p-3 flex items-center gap-3">
                      <PodcastCover
                        image={split.image}
                        title={split.title ?? `Track ${i + 1}`}
                        seed={split.remoteItem?.itemGuid ?? String(i)}
                        className="w-10 h-10 flex-shrink-0 text-xs border border-bone/20"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">
                          {split.title ?? `Track ${i + 1}`}
                        </div>
                        <div className="text-xs text-muted">
                          {split.value?.recipients?.length ?? 0} recipient
                          {(split.value?.recipients?.length ?? 0) !== 1 ? 's' : ''}
                          {split.duration ? ` · ${Math.round(split.duration / 60)}m` : ''}
                        </div>
                      </div>
                      {result && (
                        <span className={result.ok ? 'text-bolt text-sm' : 'text-nostr/80 text-sm'}>
                          {result.ok ? '✓' : '✗'}
                        </span>
                      )}
                      {running && !result && i >= (progress.length) && (
                        <span className="text-muted text-xs animate-pulse">…</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {loadState === 'ready' && splits.length > 0 && (
            <>
              <MessageInput value={msg} onChange={setMsg} />
              <SenderName value={name} onChange={setName} />
            </>
          )}

          {done && (
            <div className="text-sm text-muted">
              {progress.filter((p) => p.ok).length} of {splits.length} tracks boosted successfully.
            </div>
          )}

        </div>

        <div className="flex justify-between items-center gap-3 p-5 border-t border-bone/15 sticky bottom-0 bg-ink">
          <button onClick={onClose} className="btn-ghost">{done ? 'Close' : 'Cancel'}</button>
          <div className="flex items-center gap-3">
            {!done && loadState === 'ready' && splits.length > 0 && (
              <>
                {total > 0 && (
                  <span className="text-bolt text-sm font-mono">
                    {splits.length} × {sats} = {total} sats
                  </span>
                )}
                <button
                  onClick={go}
                  disabled={running || !rail || sats < MIN_BOOST_SATS || splits.length === 0}
                  className="btn-bolt disabled:opacity-40"
                >
                  <BoltIcon />
                  {running
                    ? `${progress.length}/${splits.length}…`
                    : `Boost ${splits.length} tracks`}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
