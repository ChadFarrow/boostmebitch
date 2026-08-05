'use client';
import { useEffect, useState } from 'react';
import type { Podcast } from '@/lib/types';
import { storage, subscribeStreamRate } from '@/lib/storage';
import {
  resolveStreamRate,
  streamShowKey,
  streamingStatus,
  subscribeStreaming,
} from '@/lib/v4v/streaming';

// Rate presets. Deliberately small numbers: at 10 sats/min an hour of listening
// is 600 sats, which is roughly what people actually stream. The custom field
// exists for everyone else.
const PRESETS = [1, 5, 10, 25] as const;

/**
 * "Stream ⟶ off / 1 / 5 / 10 / 25 / custom sats per minute."
 *
 * Two scopes from one component. `podcast` omitted = the global default (the
 * wallet modal); `podcast` given = that show's override, which can be set to
 * **0 to mean "never stream this show"** — a state the global rate must not be
 * able to override, and the reason `null` (follow the global) and `0` are
 * distinct here rather than collapsed into a falsy check.
 */
export function StreamRate({
  podcast,
  onDone,
}: {
  podcast?: Podcast;
  onDone?: () => void;
}) {
  const showKey = podcast ? streamShowKey(podcast) : null;
  const read = () => (showKey ? storage.streamRate.getShow(showKey) : storage.streamRate.get());
  const [rate, setRate] = useState<number | null>(read);
  const [custom, setCustom] = useState('');

  // Any surface can change these (the other scope's control, another tab's
  // engine); re-read rather than trusting mount-time state.
  useEffect(() => subscribeStreamRate(() => setRate(read())), [showKey]);  // eslint-disable-line react-hooks/exhaustive-deps

  function apply(v: number | null) {
    if (showKey) storage.streamRate.setShow(showKey, v);
    else storage.streamRate.set(v ?? 0);
    setRate(v);
    setCustom('');
  }

  // The global rate has no "follow" state, so its off IS 0/absent.
  const globalRate = storage.streamRate.get() ?? 0;
  const effective = podcast ? resolveStreamRate(podcast) : globalRate;
  const isOff = showKey ? rate === 0 : !rate;
  const isFollowing = showKey && rate === null;

  return (
    <div>
      <p className="text-[11px] uppercase tracking-widest text-muted mb-1.5">
        {podcast ? 'Stream this show (sats / min)' : 'Streaming sats (sats / min)'}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => apply(showKey ? 0 : null)}
          aria-pressed={isOff}
          className={`btn-ghost !px-3 text-xs ${isOff ? '!border-bolt text-bolt' : ''}`}
        >
          Off
        </button>
        {showKey && (
          <button
            onClick={() => apply(null)}
            aria-pressed={!!isFollowing}
            className={`btn-ghost !px-3 text-xs ${isFollowing ? '!border-bolt text-bolt' : ''}`}
          >
            Default{globalRate ? ` (${globalRate})` : ' (off)'}
          </button>
        )}
        {PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => apply(p)}
            aria-pressed={rate === p}
            className={`btn-ghost !px-3 text-xs ${rate === p ? '!border-bolt text-bolt' : ''}`}
          >
            {p}
          </button>
        ))}
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          aria-label="Custom sats per minute"
          placeholder="custom"
          className="input !py-1 !px-2 text-xs w-20"
          value={custom}
          onChange={(e) => setCustom(e.target.value.replace(/\D/g, ''))}
          onBlur={() => { if (custom) apply(Number(custom)); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && custom) apply(Number(custom)); }}
        />
      </div>
      <p className="text-[11px] text-muted mt-1.5">
        {effective > 0
          ? `Pays the value split automatically while you listen — batched about every 10 minutes. ~${(effective * 60).toLocaleString()} sats/hour.`
          : 'Off — nothing is sent while you listen. Boosts are unaffected.'}
      </p>
      {onDone && (
        <button onClick={onDone} className="text-[11px] text-muted hover:text-bone mt-2">
          Done
        </button>
      )}
    </div>
  );
}

/**
 * Live readout of what streaming is doing right now — accrued-but-unsent sats
 * and when they go out.
 *
 * Not decoration. Streaming spends money on a timer with no confirmation step;
 * without a meter the only evidence it exists is a wallet balance that drifts
 * down, which is indistinguishable from a bug. The failure line is the same
 * argument: a wallet that can't pay must say so here rather than quietly
 * accruing forever.
 */
export function StreamMeter({ className = '' }: { className?: string }) {
  const [status, setStatus] = useState(streamingStatus);

  // The engine notifies once per tick while accruing, and on every transition,
  // so this stays live without a timer of its own.
  useEffect(() => subscribeStreaming(() => setStatus(streamingStatus())), []);

  if (!status.active && !status.lastError) return null;

  const mins = Math.ceil(status.msUntilSettle / 60_000);
  return (
    <div className={`text-[11px] ${className}`}>
      <span className="text-bolt">≋ streaming {status.ratePerMin} sats/min</span>
      {status.active && (
        <span className="text-muted">
          {/* Naming the track is the visible proof that a music show's
              per-track value splits are being followed — otherwise "streaming"
              looks identical whether the artist is being paid or not. */}
          {status.currentTrack && <> · to <span className="text-bone">{status.currentTrack}</span></>}
          {' · '}
          {status.accruedSats} sat{status.accruedSats === 1 ? '' : 's'} accrued
          {status.settling
            ? ' · sending…'
            : status.msUntilSettle > 0
              ? ` · next in ${mins}m`
              : ' · due'}
        </span>
      )}
      {status.lastError && (
        <div className="text-nostr mt-0.5 break-words">
          ⚠ {status.lastError}
          {status.stopped && ' — streaming paused for this episode. Change the rate to retry.'}
        </div>
      )}
    </div>
  );
}
