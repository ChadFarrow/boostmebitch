'use client';
import { useEffect, useMemo, useState } from 'react';
import confetti from 'canvas-confetti';
import type { Episode, Podcast, Boostagram } from '@/lib/types';
import { useApp } from '@/lib/store';
import { sendBoost, splitSats, pickRail, type BoostResult, type Rail } from '@/lib/v4v/boost';
import { publishBoostNote, resolvePublishRelays } from '@/lib/nostr';
import { storage } from '@/lib/storage';
import { getErrorMessage } from '@/lib/util';
import { BoltIcon } from '../icons';
import { RailPicker } from './rail-picker';
import { AmountInput } from './amount-input';
import { MessageInput } from './message-input';
import { SenderName } from './sender-name';
import { NostrShareToggle, type RelaySource } from './nostr-share-toggle';
import { SplitsPreview, LightningStatus } from './splits-preview';
import { PublishStatus, type PublishState } from './publish-status';

// Brand-coloured celebration: bolt yellow, nostr magenta, bone.
function fireConfetti() {
  const colors = ['#fae500', '#ff2d92', '#f5f1e8'];
  // Burst from slightly below the modal so particles rain UP across the
  // sticky header and rail picker rather than piling at the top.
  confetti({ particleCount: 80, spread: 70, startVelocity: 55, origin: { y: 0.7 }, colors });
  setTimeout(() => {
    confetti({ particleCount: 50, spread: 100, startVelocity: 45, origin: { y: 0.7 }, colors });
  }, 200);
}

interface Props {
  podcast: Podcast;
  episode?: Episode;       // omit for show-level boosts
  positionSec?: number;    // only meaningful when episode is present
  onClose: () => void;
}

export function BoostModal({ episode, podcast, positionSec = 0, onClose }: Props) {
  const identity = useApp((s) => s.identity);
  const [sats, setSats] = useState(500);
  const [msg, setMsg] = useState('');
  const [name, setName] = useState('');
  const [rail, setRail] = useState<Rail | null>(null);

  const [results, setResults] = useState<BoostResult[]>([]);
  const [running, setRunning] = useState(false);
  const [paymentDone, setPaymentDone] = useState(false);

  const [shareNostr, setShareNostr] = useState(true);
  const [pubState, setPubState] = useState<PublishState>({ kind: 'idle' });

  const relays = useMemo(() => resolvePublishRelays(identity), [identity]);
  const relaySource: RelaySource =
    storage.relays.isOverridden()
      ? 'override'
      : identity?.writeRelays?.length
        ? 'nip65'
        : 'default';

  useEffect(() => {
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
      setPaymentDone(true);
      if (collected.some((r) => r.ok)) fireConfetti();
    } catch (e) {
      alert(getErrorMessage(e, 'boost failed'));
      setRunning(false);
      return;
    } finally {
      setRunning(false);
    }

    // Publish to nostr if signed in & opted in & at least one payment landed
    if (shareNostr && identity && collected.some((r) => r.ok)) {
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
          <RailPicker rail={rail} onRailChange={setRail} />
          <AmountInput sats={sats} onChange={setSats} />
          <MessageInput value={msg} onChange={setMsg} />
          <SenderName value={name} onChange={setName} identity={identity} />
          <NostrShareToggle
            checked={shareNostr}
            onChange={setShareNostr}
            identity={identity}
            relayCount={relays.length}
            relaySource={relaySource}
          />
          <SplitsPreview recipients={value.recipients} splits={splits} results={results} />
          <LightningStatus results={results} totalRecipients={value.recipients.length} />
          <PublishStatus state={pubState} />
        </div>

        <div className="flex justify-between items-center p-5 border-t border-bone/15 sticky bottom-0 bg-ink">
          <button onClick={onClose} className="btn-ghost">{paymentDone ? 'Close' : 'Cancel'}</button>
          {!paymentDone && (
            <button onClick={go} disabled={!rail || running} className="btn-bolt disabled:opacity-40">
              <BoltIcon />
              {running ? 'sending…' : `Send ${sats} sat`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
