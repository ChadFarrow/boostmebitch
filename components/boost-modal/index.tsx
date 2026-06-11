'use client';
import { useEffect, useMemo, useState } from 'react';
import type { Episode, Podcast, Boostagram, StoredBoost } from '@/lib/types';
import { useApp } from '@/lib/store';
import { sendBoost, splitSats, pickRail, type BoostResult, type Rail } from '@/lib/v4v/boost';
import { subscribeNwc } from '@/lib/v4v/nwc';
import { subscribeSpark } from '@/lib/v4v/spark';
import { publishBoostNote, resolvePublishRelays, recordLastRail } from '@/lib/nostr';
import { storage } from '@/lib/storage';
import { getErrorMessage } from '@/lib/util';
import { fireConfetti } from '@/lib/format';
import { BoltIcon } from '../icons';
import { BoostModalBalance } from '../wallet-balance';
import { AmountInput, MIN_BOOST_SATS } from './amount-input';
import { MessageInput } from './message-input';
import { SenderName } from './sender-name';
import { SplitsPreview, LightningStatus } from './splits-preview';
import { PublishStatus, type PublishState } from './publish-status';

interface Props {
  podcast: Podcast;
  episode?: Episode;       // omit for show-level boosts
  positionSec?: number;    // only meaningful when episode is present
  onClose: () => void;
}

export function BoostModal({ episode, podcast, positionSec = 0, onClose }: Props) {
  const identity = useApp((s) => s.identity);
  const bumpBoosts = useApp((s) => s.bumpBoosts);
  const [sats, setSats] = useState(0);
  const [msg, setMsg] = useState('');
  const [name, setName] = useState('');
  const [rail, setRail] = useState<Rail | null>(null);

  const [results, setResults] = useState<BoostResult[]>([]);
  const [running, setRunning] = useState(false);
  const [paymentDone, setPaymentDone] = useState(false);

  const [shareNostr, setShareNostr] = useState(() => storage.shareNostr.get());
  const [pubState, setPubState] = useState<PublishState>({ kind: 'idle' });

  // Keep rail in sync if wallet connects/disconnects while the modal is open.
  useEffect(() => {
    const bump = () => setRail(pickRail());
    const unsubNwc = subscribeNwc(bump);
    const unsubSpark = subscribeSpark(bump);
    return () => { unsubNwc(); unsubSpark(); };
  }, []);

  function handleShareNostrChange(v: boolean) {
    setShareNostr(v);
    storage.shareNostr.set(v);
  }

  const relays = useMemo(() => resolvePublishRelays(identity), [identity]);

  useEffect(() => {
    // pickRail() honors the stored rail pref when that rail is still
    // connected/enabled, else falls back to NWC > Spark > WebLN priority.
    setRail(pickRail());
    setName((current) => {
      if (current) return current;                              // preserve typing
      const stored = storage.senderName.get();
      if (stored) return stored;                                // saved override
      return identity?.profile?.display_name
          || identity?.profile?.name
          || '';
    });
  }, [identity?.profile?.display_name, identity?.profile?.name]);

  const isShowBoost = !episode;
  const value = (episode?.value ?? podcast.value)!;
  const splits = useMemo(() => splitSats(sats, value.recipients), [sats, value.recipients]);

  async function go() {
    if (!rail) return;
    if (name) storage.senderName.set(name);

    const boostagram: Boostagram = {
      app_name: 'BoostMeBitch',
      app_version: '0.1.0',
      podcast: podcast.title,
      feedID: podcast.id,
      url: podcast.url,
      ts: episode ? Math.floor(positionSec) : 0,
      value_msat_total: sats * 1000,
      message: msg || undefined,
      sender_name: name || undefined,
      sender_id: identity?.pubkey,
      action: 'boost',
      uuid: crypto.randomUUID(),
      remote_feed_guid: podcast.podcastGuid,
      ...(episode && {
        episode: episode.title,
        itemID: episode.id,
        episode_guid: episode.guid,
        remote_item_guid: episode.guid,
      }),
    };

    setRunning(true);
    setResults([]);
    let collected: BoostResult[] = [];
    try {
      collected = await sendBoost({
        value,
        totalSats: sats,
        boostagram,
        rail,
        onProgress: (res) => setResults((prev) => [...prev, res]),
      });
      setResults(collected);
      if (collected.some((r) => r.ok)) fireConfetti();
    } catch (e) {
      alert(getErrorMessage(e, 'boost failed'));
      setRunning(false);
      return;
    }
    setPaymentDone(true);
    setRunning(false);

    const anyPaid = collected.some((r) => r.ok);

    // Remember the rail that actually paid as the user's preference (local +
    // synced to Nostr) so it's preselected here and on their other devices.
    if (anyPaid && rail) recordLastRail(rail, identity);

    // Persist the boost locally so the user's "view" surface (the global feed)
    // can render it. Logged regardless of rail; the Nostr publish step below
    // patches in `noteId` for dedupe against the relay-discovered version.
    if (anyPaid) {
      const stored: StoredBoost = {
        uuid: boostagram.uuid!,
        ts: Date.now(),
        podcastTitle: podcast.title,
        podcastId: podcast.id,
        podcastGuid: podcast.podcastGuid,
        podcastImage: episode?.image ?? podcast.image,
        episodeTitle: episode?.title,
        episodeGuid: episode?.guid,
        sats,
        message: msg || undefined,
        senderName: name || undefined,
        legs: collected.map((r) => ({
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

    // Publish to Nostr if signed in & opted in. Gate on at least one successful
    // leg — failed-only boosts shouldn't pollute the network.
    if (shareNostr && identity && anyPaid) {
      setPubState({ kind: 'publishing' });
      try {
        const note = await publishBoostNote({
          podcast,
          episode,
          boostagram,
          results: collected,
          relays,
        });
        setPubState({ kind: 'done', note });
        storage.boosts.update(identity.npub, boostagram.uuid!, { noteId: note.id });
        bumpBoosts();
      } catch (e) {
        setPubState({ kind: 'error', message: getErrorMessage(e, 'publish failed') });
      }
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-ink/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="card w-full max-w-xl bg-ink relative max-h-[92vh] overflow-y-auto">
        <button
          onClick={onClose}
          className="absolute top-2 right-3 text-muted hover:text-bone text-lg z-10"
          aria-label="Close"
        >×</button>

        <div className="p-5 border-b border-bone/15">
          <div className="stamp text-bolt border-bolt/60 mb-2">
            {isShowBoost ? '⚡ BOOST SHOW' : '⚡ BOOST'}
          </div>
          <h3 className="font-display text-2xl leading-tight">
            {episode?.title ?? podcast.title}
          </h3>
          {episode && (
            <p className="text-xs text-muted mt-1">{podcast.title} · @ {Math.floor(positionSec)}s</p>
          )}
        </div>

        <div className="p-5 space-y-4">

          {!rail && (
            <div className="text-[11px] text-nostr/80">
              No wallet connected — set one up in the account menu (top right).
            </div>
          )}
          <AmountInput sats={sats} onChange={setSats} />
          <MessageInput value={msg} onChange={setMsg} />
          <SenderName value={name} onChange={setName} />
          <label
            className={`card flex items-start gap-3 p-3 cursor-pointer transition ${
              !identity ? 'opacity-40 cursor-not-allowed' : ''
            } ${shareNostr && identity ? '!border-nostr/60' : ''}`}
          >
            <input
              type="checkbox"
              checked={shareNostr && !!identity}
              disabled={!identity}
              onChange={(e) => handleShareNostrChange(e.target.checked)}
              className="accent-nostr mt-0.5"
            />
            <div className="flex-1 text-xs">
              <div className="text-bone flex items-center gap-2">
                <span className={shareNostr && identity ? 'text-nostr' : 'text-muted'}>◆</span>
                {identity && !shareNostr ? 'Private boost — Lightning only' : 'Share boost on Nostr'}
              </div>
              {!identity && (
                <div className="text-muted mt-0.5 leading-relaxed">
                  Sign in with Nostr to enable.
                </div>
              )}
            </div>
          </label>
          <SplitsPreview recipients={value.recipients} splits={splits} results={results} />
          <LightningStatus results={results} totalRecipients={value.recipients.length} />
          <PublishStatus state={pubState} />
        </div>

        <div className="flex justify-between items-center gap-3 p-5 border-t border-bone/15 sticky bottom-0 bg-ink">
          <button onClick={onClose} className="btn-ghost">{paymentDone ? 'Close' : 'Cancel'}</button>
          <div className="flex items-center gap-3">
            {!paymentDone && rail && <BoostModalBalance amountSats={sats} rail={rail} />}
            {!paymentDone && sats < MIN_BOOST_SATS && (
              <span className="text-[11px] text-muted">min {MIN_BOOST_SATS} sats</span>
            )}
            {!paymentDone && (
              <button
                onClick={go}
                disabled={running || !rail || sats < MIN_BOOST_SATS}
                className="btn-bolt disabled:opacity-40"
              >
                <BoltIcon />
                {running ? 'sending…' : `Send ${sats} sat`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
