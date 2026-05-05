'use client';
import { useEffect, useMemo, useState } from 'react';
import confetti from 'canvas-confetti';
import type { Episode, Podcast, Boostagram, StoredBoost } from '@/lib/types';
import { useApp } from '@/lib/store';
import { sendBoost, splitSats, pickRail, type BoostResult, type Rail } from '@/lib/v4v/boost';
import { hasNwc, subscribeNwc } from '@/lib/v4v/nwc';
import { hasSpark, subscribeSpark } from '@/lib/v4v/spark';
import { hasWebln } from '@/lib/v4v/webln';
import { publishBoostNote, resolvePublishRelays } from '@/lib/nostr';
import { storage } from '@/lib/storage';
import { getErrorMessage } from '@/lib/util';
import { BoltIcon } from '../icons';
import { BoostModalBalance } from '../wallet-balance';
import { AmountInput } from './amount-input';
import { MessageInput } from './message-input';
import { SenderName } from './sender-name';
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
  const bumpBoosts = useApp((s) => s.bumpBoosts);
  const [sats, setSats] = useState(500);
  const [msg, setMsg] = useState('');
  const [name, setName] = useState('');
  const [rail, setRail] = useState<Rail | null>(null);

  const [results, setResults] = useState<BoostResult[]>([]);
  const [running, setRunning] = useState(false);
  const [paymentDone, setPaymentDone] = useState(false);

  const [shareNostr, setShareNostr] = useState(() => storage.shareNostr.get());
  const [pubState, setPubState] = useState<PublishState>({ kind: 'idle' });

  // Re-render when any rail's connect state flips (user enables WebLN, etc.)
  // so the picker reflects current availability. Polled directly via the
  // has*() helpers — they're cheap and there's no risk of staleness.
  const [, setRailTick] = useState(0);
  useEffect(() => {
    const bump = () => setRailTick((t) => t + 1);
    const unsubNwc = subscribeNwc(bump);
    const unsubSpark = subscribeSpark(bump);
    return () => { unsubNwc(); unsubSpark(); };
  }, []);
  const availableRails: Rail[] = [];
  if (hasNwc()) availableRails.push('nwc');
  if (hasSpark()) availableRails.push('spark');
  if (hasWebln()) availableRails.push('webln');

  function handleShareNostrChange(v: boolean) {
    setShareNostr(v);
    storage.shareNostr.set(v);
  }

  const relays = useMemo(() => resolvePublishRelays(identity), [identity]);

  useEffect(() => {
    // Prefer the user's stored rail pref when it's still available; otherwise
    // fall back to pickRail()'s priority order. We only honor the pref if the
    // rail is actually connected/enabled — a stale pref pointing at a
    // disconnected wallet would leave the user with a non-functional Send.
    const pref = storage.railPref.get();
    const prefAvailable =
      (pref === 'nwc' && hasNwc())
      || (pref === 'spark' && hasSpark())
      || (pref === 'webln' && hasWebln());
    setRail(prefAvailable ? pref : pickRail());
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
    const canPublishNostr = shareNostr && !!identity;
    if (!rail && !canPublishNostr) return;
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
    if (rail) {
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
    } else {
      // Nostr-only boost: no wallet connected, but the user still wants to
      // share the boost note. Skip Lightning entirely; treat as zero legs.
      fireConfetti();
    }
    setPaymentDone(true);
    setRunning(false);

    const anyPaid = collected.some((r) => r.ok);

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

    // Publish to Nostr if signed in & opted in. When a wallet was used, gate
    // on at least one successful leg — failed-only boosts shouldn't pollute
    // the network with a "Boosted N sats" note that didn't actually pay. When
    // no wallet is connected, this is a deliberate Nostr-only boost.
    if (shareNostr && identity && (rail ? anyPaid : true)) {
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
          {/* Rail picker: only shown when 2+ rails are available. Single-rail
              users never see it. WebLN sits last in pickRail() priority but
              with Alby installed users often want to opt into it per-boost,
              so the picker is the override path. */}
          {availableRails.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="text-muted uppercase tracking-widest">Pay via</span>
              {availableRails.map((r) => {
                const label = r === 'nwc' ? 'NWC' : r === 'spark' ? 'Spark' : 'WebLN';
                const active = rail === r;
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => { setRail(r); storage.railPref.set(r); }}
                    className={`px-2 py-1 rounded border transition ${
                      active
                        ? 'border-bolt bg-bolt/10 text-bolt'
                        : 'border-bone/20 text-muted hover:border-bone/40 hover:text-bone'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          {!rail && (
            <div className="text-[11px] text-nostr/80">
              {shareNostr && identity
                ? 'No wallet connected — this will be a Nostr-only boost (no Lightning payment).'
                : 'No wallet connected — set one up in the account menu (top right).'}
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
            {!paymentDone && (
              <button
                onClick={go}
                disabled={running || (!rail && !(shareNostr && identity))}
                className="btn-bolt disabled:opacity-40"
              >
                <BoltIcon />
                {running
                  ? 'sending…'
                  : rail
                  ? `Send ${sats} sat`
                  : 'Post boost note'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
