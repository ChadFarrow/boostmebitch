'use client';
import { useEffect, useMemo, useState } from 'react';
import confetti from 'canvas-confetti';
import type { Episode, Podcast, Boostagram } from '@/lib/types';
import { useApp } from '@/lib/store';
import { sendBoost, splitSats, pickRail, type BoostResult, type Rail } from '@/lib/v4v/boost';
import { hasNwc, saveNwcUri, clearNwcUri } from '@/lib/v4v/nwc';
import { hasWebln as hasWeblnFn } from '@/lib/v4v/webln';
import { publishBoostNote, resolvePublishRelays, type PublishedNote } from '@/lib/nostr';
import { BoltIcon } from './icons';

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

type PublishState =
  | { kind: 'idle' }
  | { kind: 'publishing' }
  | { kind: 'done'; note: PublishedNote }
  | { kind: 'error'; message: string };

export function BoostModal({ episode, podcast, positionSec = 0, onClose }: Props) {
  const identity = useApp((s) => s.identity);
  const [sats, setSats] = useState(500);
  const [msg, setMsg] = useState('');
  const [name, setName] = useState('');
  const [rail, setRail] = useState<Rail | null>(null);
  const [nwcUri, setNwcUri] = useState('');

  const [results, setResults] = useState<BoostResult[]>([]);
  const [running, setRunning] = useState(false);
  const [paymentDone, setPaymentDone] = useState(false);

  const [shareNostr, setShareNostr] = useState(true);
  const [pubState, setPubState] = useState<PublishState>({ kind: 'idle' });

  const relays = useMemo(() => resolvePublishRelays(identity), [identity]);
  const relaySource: 'override' | 'nip65' | 'default' =
    typeof window !== 'undefined' && localStorage.getItem('bmb:relays')
      ? 'override'
      : identity?.writeRelays?.length
        ? 'nip65'
        : 'default';

  useEffect(() => {
    setRail(pickRail());
    setName((current) => {
      if (current) return current;                                  // preserve typing
      const stored = localStorage.getItem('bmb:sender_name');
      if (stored) return stored;                                    // saved override
      return identity?.profile?.display_name
          || identity?.profile?.name
          || '';
    });
  }, [identity?.profile?.display_name, identity?.profile?.name]);

  const isShowBoost = !episode;
  const value = (episode?.value ?? podcast.value)!;
  const splits = useMemo(() => splitSats(sats, value.recipients), [sats, value.recipients]);

  function connectNwc() {
    const uri = nwcUri.trim();
    if (!uri.startsWith('nostr+walletconnect://')) {
      alert('Paste a nostr+walletconnect:// URI');
      return;
    }
    saveNwcUri(uri);
    setRail('nwc');
    setNwcUri('');
  }

  async function go() {
    if (!rail) return;
    if (name) localStorage.setItem('bmb:sender_name', name);

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
    } catch (e: any) {
      alert(e?.message ?? 'boost failed');
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
      } catch (e: any) {
        setPubState({ kind: 'error', message: e?.message ?? 'publish failed' });
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
          {/* Rail picker */}
          <div>
            <label className="text-[11px] uppercase tracking-widest text-muted">Pay with</label>
            <div className="flex gap-2 mt-1.5 flex-wrap">
              <button
                onClick={() => hasNwc() && setRail('nwc')}
                disabled={!hasNwc()}
                className={`btn-ghost ${rail === 'nwc' ? '!border-bolt !text-bolt' : ''} disabled:opacity-30`}
              >NWC {hasNwc() ? '✓' : ''}</button>
              <button
                onClick={() => hasWeblnFn() && setRail('webln')}
                disabled={!hasWeblnFn()}
                className={`btn-ghost ${rail === 'webln' ? '!border-bolt !text-bolt' : ''} disabled:opacity-30`}
              >WebLN {hasWeblnFn() ? '✓' : ''}</button>
            </div>

            {!hasNwc() && (
              <div className="mt-3 flex gap-2">
                <input
                  className="input"
                  placeholder="nostr+walletconnect://… (paste from Alby Hub)"
                  value={nwcUri}
                  onChange={(e) => setNwcUri(e.target.value)}
                />
                <button onClick={connectNwc} className="btn-ghost">Save</button>
              </div>
            )}
            {hasNwc() && rail === 'nwc' && (
              <button onClick={() => { clearNwcUri(); setRail(pickRail()); }} className="text-[11px] text-muted hover:text-nostr mt-2">
                disconnect NWC
              </button>
            )}
          </div>

          {/* Amount */}
          <div>
            <label className="text-[11px] uppercase tracking-widest text-muted">Sats</label>
            <div className="flex gap-2 mt-1.5">
              <input
                type="number"
                min={1}
                className="input flex-1"
                value={sats}
                onChange={(e) => setSats(Math.max(1, Number(e.target.value) || 0))}
              />
              {[100, 500, 1000, 5000].map((n) => (
                <button key={n} onClick={() => setSats(n)} className="btn-ghost !px-3">{n}</button>
              ))}
            </div>
          </div>

          {/* Message */}
          <div>
            <label className="text-[11px] uppercase tracking-widest text-muted">Boostagram</label>
            <textarea
              className="input mt-1.5 resize-none"
              rows={2}
              maxLength={200}
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              placeholder="optional message…"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] uppercase tracking-widest text-muted">From</label>
              <input
                className="input mt-1.5"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="anon"
              />
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-widest text-muted">Signed as</label>
              <div className="input mt-1.5 truncate text-muted">
                {identity ? <span className="text-nostr">◆ nostr</span> : 'not signed in'}
              </div>
            </div>
          </div>

          {/* Nostr publish toggle */}
          <label
            className={`card flex items-start gap-3 p-3 cursor-pointer transition ${
              !identity ? 'opacity-40 cursor-not-allowed' : ''
            } ${shareNostr && identity ? '!border-nostr/60' : ''}`}
          >
            <input
              type="checkbox"
              checked={shareNostr && !!identity}
              disabled={!identity}
              onChange={(e) => setShareNostr(e.target.checked)}
              className="accent-nostr mt-0.5"
            />
            <div className="flex-1 text-xs">
              <div className="text-bone flex items-center gap-2">
                <span className="text-nostr">◆</span>
                Share boost on Nostr
              </div>
              <div className="text-muted mt-0.5 leading-relaxed">
                {identity ? (
                  <>
                    Publishes a kind:1 note tagged with NIP-73 podcast refs to {relays.length} relays.
                    {relaySource === 'nip65' && (
                      <span className="text-nostr/80"> · using your NIP-65 list</span>
                    )}
                    {relaySource === 'default' && (
                      <span className="text-muted/70"> · using defaults (no NIP-65 found)</span>
                    )}
                  </>
                ) : (
                  'Sign in with Nostr to enable.'
                )}
              </div>
            </div>
          </label>

          {/* Splits preview */}
          <div className="card p-3">
            <div className="text-[11px] uppercase tracking-widest text-muted mb-2">Recipients</div>
            <ul className="text-xs space-y-1 max-h-40 overflow-y-auto">
              {value.recipients.map((r, i) => {
                const res = results[i];
                return (
                  <li key={i} className="flex justify-between gap-3 items-center">
                    <span className="truncate">
                      <span className="text-muted mr-1">{r.fee ? 'fee' : '·'}</span>
                      {r.name || r.address.slice(0, 10) + '…'}
                    </span>
                    <span className="tabular-nums flex items-center gap-2">
                      {res?.ok && <span className="text-bolt">✓</span>}
                      {res && !res.ok && <span className="text-nostr">✗</span>}
                      {splits[i]} sat
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Status rows */}
          {results.length > 0 && (
            <div className="text-xs text-muted">
              ⚡ Lightning: {results.filter((r) => r.ok).length}/{value.recipients.length} sent
              {results.some((r) => !r.ok) && (
                <details className="mt-1">
                  <summary className="text-nostr cursor-pointer">errors</summary>
                  <ul className="mt-1 space-y-0.5">
                    {results.filter((r) => !r.ok).map((r, i) => (
                      <li key={i}>{r.recipient.name || 'recipient'}: {r.error}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          {pubState.kind === 'publishing' && (
            <div className="text-xs text-nostr">◆ Publishing to nostr…</div>
          )}
          {pubState.kind === 'done' && (
            <div className="text-xs space-y-1">
              <div className="text-nostr">
                ◆ Published to {pubState.note.acceptedRelays.length}/
                {pubState.note.acceptedRelays.length + pubState.note.failedRelays.length} relays
              </div>
              <a
                href={`https://njump.me/${pubState.note.nevent}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted hover:text-nostr underline underline-offset-2"
              >
                view note ↗
              </a>
            </div>
          )}
          {pubState.kind === 'error' && (
            <div className="text-xs text-nostr">◆ Publish failed: {pubState.message}</div>
          )}
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
