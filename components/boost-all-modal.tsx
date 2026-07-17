'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Episode, Podcast, Boostagram, ValueTimeSplit, StoredBoost } from '@/lib/types';
import { useApp } from '@/lib/store';
import { sendBoost, pickRail, type Rail } from '@/lib/v4v/boost';
import { hasNwc, subscribeNwc } from '@/lib/v4v/nwc';
import { hasSpark, subscribeSpark } from '@/lib/v4v/spark';
import { hasWebln } from '@/lib/v4v/webln';
import { publishBoostNote, publishBoostNoteViaSite, resolvePublishRelays, recordLastRail } from '@/lib/nostr';
import { storage } from '@/lib/storage';
import { getErrorMessage, hasValueRecipients } from '@/lib/util';
import { fireConfetti, playBoostSound, primeBoostSound } from '@/lib/format';
import { BoltIcon } from './icons';
import { AmountInput, MIN_BOOST_SATS } from './boost-modal/amount-input';
import { MessageInput } from './boost-modal/message-input';
import { SenderName } from './boost-modal/sender-name';
import { PublishStatus, type PublishState } from './boost-modal/publish-status';
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
  const [totalSplits, setTotalSplits] = useState(0);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');

  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [progress, setProgress] = useState<TrackProgress[]>([]);

  const [shareNostr, setShareNostr] = useState(() => storage.shareNostr.get());
  const [pubState, setPubState] = useState<PublishState>({ kind: 'idle' });
  const relays = useMemo(() => resolvePublishRelays(identity), [identity]);

  function handleShareNostrChange(v: boolean) {
    setShareNostr(v);
    storage.shareNostr.set(v);
  }

  // Set on unmount so the in-flight loop bails before firing more sends or
  // calling setState on an unmounted component. The current track's send
  // can't be aborted (Lightning is fire-and-forget), but its storage.boosts
  // log still records — money moved, the user should see it later.
  //
  // Reset on mount so React 18 StrictMode's mount→unmount→mount cycle in dev
  // doesn't leave cancelled=true permanently from the intermediate cleanup.
  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    return () => { cancelled.current = true; };
  }, []);

  // Sync rail if wallet connects/disconnects while modal is open.
  useEffect(() => {
    const bump = () => setRail(pickRail());
    const unsubNwc = subscribeNwc(bump);
    const unsubSpark = subscribeSpark(bump);
    return () => { unsubNwc(); unsubSpark(); };
  }, []);

  useEffect(() => {
    // pickRail() honors the stored rail pref when that rail is still
    // connected/enabled, else falls back to NWC > Spark > WebLN priority.
    setRail(pickRail());
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
        const all = (data.splits as ValueTimeSplit[]) ?? [];
        const resolved = all.filter((s) => hasValueRecipients(s.value));
        setSplits(resolved);
        setTotalSplits(all.length);
        setLoadState('ready');
      })
      .catch(() => setLoadState('error'));
  }, [episode.feedId, episode.id]);

  // Recomputed every render so newly-connected wallets show up in the picker
  // without a remount. The subscribeNwc/subscribeSpark useEffect above already
  // triggers a re-render via setRail(pickRail()) when state changes.
  const availableRails: Rail[] = [];
  if (hasNwc()) availableRails.push('nwc');
  if (hasSpark()) availableRails.push('spark');
  if (hasWebln()) availableRails.push('webln');

  const total = sats * splits.length;

  async function go() {
    if (!rail || !splits.length) return;
    // Unlock the success sound NOW, inside the tap — the actual play() fires
    // after the async per-track payments, past the gesture window on mobile.
    primeBoostSound();
    if (name) storage.senderName.set(name);

    setRunning(true);
    setProgress([]);

    // Local success tracker — `progress` state has stale-closure issues
    // across awaits, and we need the final list immediately for the
    // post-loop Nostr publish.
    const successfulIdx: number[] = [];
    // The host show's value block (preferred per-episode, falls back to feed-level).
    const hostValue = episode.value ?? podcast.value;

    for (let i = 0; i < splits.length; i++) {
      if (cancelled.current) return;
      const split = splits[i];
      // Spec: remotePercentage is the share that goes to the remote (track)
      // recipients; (100 − remotePercentage) goes to the host show.
      // Default 100 (all to track) when missing.
      const remotePct = Math.min(100, Math.max(0, split.remotePercentage ?? 100));
      const trackSats = Math.floor((sats * remotePct) / 100);
      const showLegSats = sats - trackSats;
      // Boostagram shape for valueTimeSplits: HOST episode in primary fields
      // (the album/playlist the listener is playing), TRACK in remote_*. The
      // recipient artist sees `podcast`/`episode` describing the listener's
      // context and `remote_*` identifying which track triggered the boost.
      const trackBoostagram: Boostagram = {
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
        value_msat_total: trackSats * 1000,
        message: msg || undefined,
        sender_name: name || undefined,
        sender_id: identity?.pubkey,
        action: 'boost',
        uuid: crypto.randomUUID(),
      };
      let trackOk = false;
      try {
        if (trackSats > 0) {
          const results = await sendBoost({
            value: split.value!,
            totalSats: trackSats,
            boostagram: trackBoostagram,
            rail,
          });
          trackOk = results.some((r) => r.ok);
          if (trackOk) {
            const stored: StoredBoost = {
              uuid: trackBoostagram.uuid!,
              ts: Date.now(),
              podcastTitle: podcast.title,
              podcastId: podcast.id,
              podcastGuid: podcast.podcastGuid,
              podcastImage: split.image ?? episode.image ?? podcast.image,
              episodeTitle: episode.title,
              episodeGuid: episode.guid,
              sats: trackSats,
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
            successfulIdx.push(i);
          }
        }
      } catch (e) {
        if (cancelled.current) return;
        setProgress((prev) => [
          ...prev,
          { index: i, ok: false, error: getErrorMessage(e, 'boost failed') },
        ]);
        continue;
      }

      // Per-track host leg. Each one carries the same remote_* tags as its
      // sibling track leg so the host can see which track triggered it in
      // their boostagram log. Skip if remotePct === 100 (no host share),
      // hostValue is missing, or showLegSats rounded to 0.
      if (showLegSats > 0 && hasValueRecipients(hostValue) && !cancelled.current) {
        const hostBoostagram: Boostagram = {
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
          value_msat_total: showLegSats * 1000,
          message: msg || undefined,
          sender_name: name || undefined,
          sender_id: identity?.pubkey,
          action: 'boost',
          uuid: crypto.randomUUID(),
        };
        try {
          const hostResults = await sendBoost({
            value: hostValue!, // guaranteed by hasValueRecipients(hostValue) above
            totalSats: showLegSats,
            boostagram: hostBoostagram,
            rail,
          });
          if (hostResults.some((r) => r.ok)) {
            const stored: StoredBoost = {
              uuid: hostBoostagram.uuid!,
              ts: Date.now(),
              podcastTitle: podcast.title,
              podcastId: podcast.id,
              podcastGuid: podcast.podcastGuid,
              podcastImage: episode.image ?? podcast.image,
              episodeTitle: episode.title,
              episodeGuid: episode.guid,
              sats: showLegSats,
              message: msg || undefined,
              senderName: name || undefined,
              legs: hostResults.map((r) => ({
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
        } catch {
          // Host leg failure is non-fatal — the track leg may have already paid.
        }
      }

      if (cancelled.current) return;
      setProgress((prev) => [...prev, { index: i, ok: trackOk }]);
    }

    setRunning(false);
    setDone(true);

    if (successfulIdx.length > 0) {
      fireConfetti();
      playBoostSound();
    }
    if (successfulIdx.length > 0 && rail) recordLastRail(rail, identity);

    // Single summary note covering all successful tracks. Gated on the
    // share-on-Nostr toggle and at least one paid leg — matches BoostModal's
    // "don't pollute the network with failed-only boosts" rule.
    if (cancelled.current) return;
    if (!shareNostr || successfulIdx.length === 0) return;

    const totalSats = successfulIdx.length * sats;
    const trackList = successfulIdx
      .map((i) => splits[i].title)
      .filter((t): t is string => !!t);

    const summaryBoostagram: Boostagram = {
      app_name: 'BoostMeBitch',
      app_version: '0.1.0',
      podcast: podcast.title,
      feedID: podcast.id,
      url: podcast.url,
      episode: episode.title,
      itemID: episode.id,
      episode_guid: episode.guid,
      ts: 0,
      value_msat_total: totalSats * 1000,
      message: msg || undefined,
      sender_name: name || undefined,
      sender_id: identity?.pubkey,
      action: 'boost',
      uuid: crypto.randomUUID(),
    };

    const lines: string[] = ['⚡ Boost ⚡', ''];
    if (msg.trim()) lines.push(msg.trim(), '');
    const sender = name.trim();
    lines.push(
      `${sender ? `${sender} boosted` : 'Boosted'} ${successfulIdx.length} track${successfulIdx.length === 1 ? '' : 's'} on ${podcast.title} for ${totalSats} sats`,
    );
    if (trackList.length) {
      lines.push('');
      for (const t of trackList) lines.push(`• ${t}`);
    }
    const contentOverride = lines.join('\n');

    setPubState({ kind: 'publishing' });
    try {
      // Signed in → user's own key; signed out → the site's Nostr identity.
      const note = identity
        ? await publishBoostNote({
            podcast, episode, boostagram: summaryBoostagram, results: [], relays, contentOverride,
          })
        : await publishBoostNoteViaSite({
            podcast, episode, boostagram: summaryBoostagram, results: [], contentOverride,
          });
      if (cancelled.current) return;
      setPubState({ kind: 'done', note });
    } catch (e) {
      if (cancelled.current) return;
      setPubState({ kind: 'error', message: getErrorMessage(e, 'publish failed') });
    }
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
              No wallet connected — connect one with ⚡ Connect wallet (top right).
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
            <p className="text-muted text-sm">
              {totalSplits > 0
                ? `${totalSplits} track${totalSplits === 1 ? '' : 's'} listed in the RSS feed, but Podcast Index couldn't resolve any of their value blocks.`
                : 'No resolvable value blocks found for this episode.'}
            </p>
          )}
          {loadState === 'ready' && splits.length > 0 && (
            <div>
              <p className="text-[11px] uppercase tracking-widest text-muted mb-2">
                Tracks ({splits.length}
                {totalSplits > splits.length && ` of ${totalSplits} — ${totalSplits - splits.length} unresolved`})
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
              <label
                className={`card flex items-start gap-3 p-3 cursor-pointer transition ${
                  shareNostr ? '!border-nostr/60' : ''
                }`}
              >
                <input
                  type="checkbox"
                  checked={shareNostr}
                  onChange={(e) => handleShareNostrChange(e.target.checked)}
                  className="accent-nostr mt-0.5"
                />
                <div className="flex-1 text-xs">
                  <div className="text-bone flex items-center gap-2">
                    <span className={shareNostr ? 'text-nostr' : 'text-muted'}>◆</span>
                    Share boost on Nostr
                  </div>
                  <div className="text-muted mt-0.5 leading-relaxed">
                    {!shareNostr
                      ? 'Lightning only — nothing posted publicly.'
                      : identity
                        ? 'One summary note will be posted to your Nostr feed.'
                        : "One summary note posted from boostmebitch.com's Nostr account."}
                  </div>
                </div>
              </label>
            </>
          )}

          {done && (
            <div className="text-sm text-muted">
              {progress.filter((p) => p.ok).length} of {splits.length} tracks boosted successfully.
            </div>
          )}

          <PublishStatus state={pubState} />

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
