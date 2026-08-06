'use client';
import { useEffect, useRef, useState } from 'react';
import type { Podcast } from '@/lib/types';
import { storage, subscribeStreamRate, type StreamedEntry } from '@/lib/storage';
import { timeAgo } from '@/lib/format';
import { streamShowKey, streamingStatus, subscribeStreaming } from '@/lib/v4v/streaming';
import { STREAM_RATE_MAX_PER_MIN } from '@/lib/v4v/stream-ledger';

/**
 * On/off switch.
 *
 * Local to this file rather than exported: there is exactly one consumer, and
 * the repo's rule (see the <FavHeart> note in CLAUDE.md) is to extract at two
 * surfaces, not one. Nothing reusable exists to lean on — <VideoToggle> is a
 * bespoke segmented control, <ThemeToggle> is an icon button, and the pickers
 * are pill rows — so a small bespoke switch is both necessary and consistent.
 * Tokens only, no new colors, no new globals.css class for a single use.
 *
 * **`min-h-[44px]` is the tap target, not decoration — don't collapse it back
 * to the pill's own height.** The switch graphic is 20px tall, and a 20px
 * target is under half Apple's 44pt minimum: a mouse hits it every time and a
 * thumb does not, so the control read as completely dead on a phone while
 * working perfectly on a desktop. Reported exactly that way, from both
 * surfaces at once, which is the tell that it's the shared control and not
 * either screen. The padding grows the hit area without touching the graphic;
 * it deliberately does NOT use a negative margin to claw the space back,
 * because the reclaimed strip would sit over the "Follow my default instead"
 * button directly below and start stealing ITS taps.
 */
function StreamSwitch({
  on,
  onChange,
  dimmed = false,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  /** Rendering an inherited value rather than this scope's own opinion. */
  dimmed?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`inline-flex items-center gap-2 min-h-[44px] py-2 ${dimmed ? 'opacity-60' : ''}`}
    >
      <span
        className={`relative w-9 h-5 rounded-full border transition-colors ${
          on ? 'border-bolt bg-bolt/20' : 'border-bone/40 bg-bone/5'
        }`}
      >
        <span
          className={`absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full transition-all ${
            on ? 'left-[18px] bg-bolt' : 'left-[3px] bg-muted'
          }`}
        />
      </span>
      <span
        className={`text-xs font-mono uppercase tracking-wider ${on ? 'text-bolt' : 'text-muted'}`}
      >
        {on ? 'On' : 'Off'}
      </span>
    </button>
  );
}

/**
 * The sats/min field. Commits on blur and Enter; never touches the switch.
 *
 * **The 16px font floor on mobile is required, not a style choice.** iOS Safari
 * zooms the whole viewport when an input smaller than 16px takes focus, and
 * this app sets no `maximumScale` (deliberately — that would kill pinch-zoom
 * for everyone). At `text-xs` the page lurched on every tap of this field and
 * scrolled the switch out of view mid-edit, which reads as the control
 * fighting you. Desktop keeps the compact size from `sm:` up.
 */
function RateField({
  value,
  onCommit,
  dimmed = false,
}: {
  value: number;
  onCommit: (n: number) => void;
  dimmed?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));

  // Another surface (the other scope's control, a second wallet-modal open) can
  // change this underneath us; re-sync when it does.
  useEffect(() => setDraft(String(value)), [value]);

  function commit() {
    const n = Number(draft);
    // An empty or junk field reverts rather than being read as a rate — this
    // number is multiplied by time and paid with no prompt.
    if (!draft || !Number.isFinite(n) || n < 1) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(STREAM_RATE_MAX_PER_MIN, Math.floor(n));
    setDraft(String(clamped));
    onCommit(clamped);
  }

  return (
    <span className={`inline-flex items-center gap-1.5 ${dimmed ? 'opacity-60' : ''}`}>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        aria-label="Sats per minute"
        className="input !py-1 !px-2 !w-20 sm:!w-16 min-h-[44px] sm:min-h-0 text-[16px] sm:text-xs text-right tabular-nums"
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
      <span className="text-[11px] text-muted">sats / min</span>
    </span>
  );
}

/**
 * "Streaming sats — [on/off] [N] sats/min."
 *
 * Two scopes from one component. `podcast` omitted = the global default (the
 * wallet modal); `podcast` given = that show's override, which carries a third
 * state — **explicitly off, which must outrank a global rate raised later** —
 * plus a "use default" escape back to following the global.
 *
 * The rate field stays live while the switch is off, on purpose: that is what
 * makes "turning it off didn't lose my number" visible, and it lets a user set
 * a rate before committing to it.
 */
export function StreamRate({
  podcast,
  onDone,
}: {
  podcast?: Podcast;
  onDone?: () => void;
}) {
  const showKey = podcast ? streamShowKey(podcast) : null;

  const read = () => ({
    globalOn: storage.streamRate.isOn(),
    globalRate: storage.streamRate.getRemembered(),
    showOn: showKey ? storage.streamRate.getShowOn(showKey) : null,
    showRate: showKey ? storage.streamRate.getShowRemembered(showKey) : null,
    // Only the global control needs this, and only to avoid lying — see below.
    showsOn: showKey ? 0 : storage.streamRate.showsExplicitlyOn(),
    // The switch couldn't be written to disk (storage blocked or full). It
    // still works for this session off the memory mirror, but saying nothing
    // would let the user discover on their next visit that streaming quietly
    // turned itself back off.
    ephemeral: storage.streamRate.isEphemeral(showKey),
  });
  const [s, setS] = useState(read);

  // Any surface can change these — the other scope's control, another instance
  // of this one — so re-read rather than trusting mount-time state.
  useEffect(() => subscribeStreamRate(() => setS(read())), [showKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const following = !!showKey && s.showOn === null;
  // While following, the controls show the INHERITED value, muted — so the user
  // can see what this show is actually doing without having to opt in first.
  const on = showKey ? (following ? s.globalOn : s.showOn === true) : s.globalOn;
  const rate = showKey ? (following ? s.globalRate : s.showRate ?? s.globalRate) : s.globalRate;

  function setOn(v: boolean) {
    if (showKey) storage.streamRate.setShowOn(showKey, v);
    else storage.streamRate.setOn(v);
  }
  function setRate(n: number) {
    if (showKey) storage.streamRate.setShowRate(showKey, n);
    else storage.streamRate.setRate(n);
  }

  const description = (() => {
    if (following) {
      return s.globalOn
        ? `Follows your default: ${s.globalRate.toLocaleString()} sats/min.`
        : 'Follows your default: streaming off.';
    }
    if (showKey && !on) {
      // The ONLY place the "explicitly off outranks the global rate" rule
      // becomes legible to a human. It has to be here.
      return 'Never streams this show, even if your default is on.';
    }
    // (see `overriding` below — this state is coloured, not just worded)
    if (!on) {
      // A per-show override outranks this switch, so "nothing is sent" is a
      // promise the global control is not able to keep. Saying it anyway while
      // a show streams in the mini-bar is the worst kind of wrong: the one
      // screen the user checks to find out whether they're spending money
      // tells them they aren't.
      if (s.showsOn > 0) {
        return s.showsOn === 1
          ? 'Off by default — but 1 show you turned on individually still streams.'
          : `Off by default — but ${s.showsOn} shows you turned on individually still stream.`;
      }
      return 'Off — nothing is sent while you listen. Boosts are unaffected.';
    }
    if (showKey) {
      return `Streams ${rate.toLocaleString()} sats/min for this show, overriding your default.`;
    }
    return `Pays the value split while you listen — batched about every 10 minutes. ~${(
      rate * 60
    ).toLocaleString()} sats/hour.`;
  })();

  // A show that is explicitly OFF looks identical to one that is merely off,
  // yet it is the one state the global switch cannot undo — so it reads as
  // "streaming is off here" when it actually means "this show is pinned off
  // forever". Colour it as the standing exception it is, and label the escape
  // hatch, since [Use default] is the only way out and nothing said so.
  const pinnedOff = !!showKey && !following && !on;

  return (
    <div>
      <p className="text-[11px] uppercase tracking-widest text-muted mb-2">
        {podcast ? 'Stream this show' : 'Streaming sats'}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {showKey && (
          <button
            type="button"
            onClick={() => storage.streamRate.setShowOn(showKey, null)}
            aria-pressed={following}
            className={`btn-ghost !px-2.5 !py-1 min-h-[44px] sm:min-h-0 text-[11px] ${
              following ? '!border-bolt text-bolt' : ''
            }`}
          >
            Use default
          </button>
        )}
        <StreamSwitch on={on} onChange={setOn} dimmed={following} />
        <RateField value={rate} onCommit={setRate} dimmed={following} />
      </div>
      {s.ephemeral && (
        <p className="text-[11px] text-bolt/80 mt-2">
          Storage is restricted or full — this setting works now but won&apos;t
          survive a reload.
        </p>
      )}
      <p className={`text-[11px] mt-2 ${pinnedOff ? 'text-nostr' : 'text-muted'}`}>
        {description}
        {pinnedOff && (
          <>
            {' '}
            <button
              type="button"
              onClick={() => storage.streamRate.setShowOn(showKey!, null)}
              className="underline underline-offset-2 hover:text-bone"
            >
              Follow my default instead
            </button>
          </>
        )}
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
 * The `≋ STREAM` button and its panel, wired together.
 *
 * Three surfaces open this same show-scoped control — the show header, the
 * episode page and the fullscreen player — and each grew its own copy of the
 * state, the button and the panel. That's three places for the label, the aria
 * wiring and the panel's placement to drift apart, on a control whose whole job
 * is to start spending money unattended.
 *
 * Button and panel come back SEPARATELY because only the wiring is shared:
 * every surface puts the button in a different flex row and the panel at a
 * different point in the document (below the header, after the value split,
 * above the meter). Returning one element containing both would force a layout
 * on all three that fits none of them.
 */
export function useStreamPanel(podcast: Podcast | null | undefined, enabled: boolean) {
  const [open, setOpen] = useState(false);
  const button = enabled && podcast ? (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      className="btn-ghost"
      aria-expanded={open}
      title="Stream sats per minute while this show plays"
    >
      ≋ STREAM
    </button>
  ) : null;
  const panel = open && podcast ? (
    <StreamRate podcast={podcast} onDone={() => setOpen(false)} />
  ) : null;
  return { button, panel };
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

  // The engine notifies on every real state change — NOT every tick — so this
  // stays live without a timer of its own and without repainting sixty times a
  // minute for a user who never opens the fullscreen player. (<FullscreenPlayer>
  // is always mounted, just translated off-screen, so this component is too.)
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
          {/* Only ever offer a remedy that can actually work. 'rail-cannot-pay'
              is a capability gap, so "change the rate to retry" would loop the
              user through the identical failure. */}
          {status.stoppedReason === 'failures'
            && ' — streaming paused for this episode. Change the rate or connect a wallet to retry.'}
          {status.stoppedReason === 'rail-cannot-pay'
            && ' — connect NWC or a WebLN extension to stream this show.'}
        </div>
      )}
    </div>
  );
}

/**
 * The mini-player's streaming indicator.
 *
 * A separate leaf from <StreamMeter> so it can live inside <Player> without
 * <Player> subscribing to anything: it reads the engine's own observable, so an
 * update re-renders these ~20 lines and nothing else. <Player> owns the
 * fullscreen player, the chapters/transcript fetches and the reverse-portal
 * <video>, and its per-field store selectors exist precisely to keep that
 * subtree off the 1 Hz path — a hook there would undo that.
 *
 * It exists because the mini-bar is where most listening happens. Without it a
 * user who never opens the fullscreen player has no signal at all that money is
 * leaving their wallet.
 */
export function StreamPulse() {
  const [s, setS] = useState(streamingStatus);
  useEffect(() => subscribeStreaming(() => setS(streamingStatus())), []);

  // Costs a streaming-off user nothing at all.
  if (!s.active && !s.stopped && !s.lastError) return null;

  // The failure state is never hidden at any width — it's the one thing a user
  // has to be able to see.
  if (s.stopped || s.lastError) {
    return (
      <span
        className="text-[11px] text-nostr shrink-0"
        title={`Streaming stopped: ${s.lastError ?? 'payment failed'}`}
      >
        ⚠ ≋
      </span>
    );
  }
  return (
    <span
      className={`text-[11px] text-bolt shrink-0 tabular-nums ${s.settling ? 'animate-bolt' : ''}`}
      title={
        `Streaming ${s.ratePerMin} sats/min · ${s.accruedSats} accrued`
        + (s.currentTrack ? ` · to ${s.currentTrack}` : '')
        + (s.settling ? ' · sending…' : '')
      }
    >
      ≋ {s.accruedSats}
    </span>
  );
}

/**
 * "What has streaming actually cost me" — the `bmb:streamed:<npub>` log.
 *
 * NWC and WebLN wallets have their own transaction history, and Spark's lives
 * inside the SDK — but none of them carry podcast context. This log is the only
 * record anywhere that says WHICH show and WHICH track a payment went to, which
 * is the question a listener actually has. It also records the failure that
 * stopped streaming for an item, so "why is nothing being sent?" is answerable.
 */
export function StreamedLog({ npub }: { npub?: string | null }) {
  const [entries, setEntries] = useState<StreamedEntry[]>([]);
  const [expanded, setExpanded] = useState(false);
  const sentRef = useRef(streamingStatus().sessionSentSats);

  useEffect(() => {
    setEntries(storage.streamed.get(npub));
    // Re-read only when a settle actually landed. The engine notifies on every
    // real status change (track name, accrual, countdown), and re-parsing
    // localStorage for a countdown tick would be pointless work.
    return subscribeStreaming(() => {
      const sent = streamingStatus().sessionSentSats;
      if (sent === sentRef.current) return;
      sentRef.current = sent;
      setEntries(storage.streamed.get(npub));
    });
  }, [npub]);

  if (entries.length === 0) return null;

  const total = entries.reduce((sum, e) => sum + (e.ok ? e.sats : 0), 0);

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full text-[11px] uppercase tracking-widest text-bone/60 mb-2 flex items-center justify-between gap-2 hover:text-bone"
      >
        <span>
          Streamed ({entries.length}) · {total.toLocaleString()} sats
        </span>
        <span aria-hidden className="text-bone/60">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <ul className="space-y-1.5 max-h-48 overflow-y-auto">
          {entries.map((e, i) => (
            <li
              key={`${e.ts}-${i}`}
              className={`flex items-center gap-2 text-xs ${e.ok ? '' : 'text-nostr'}`}
              title={e.ok ? undefined : e.error}
            >
              <span className="truncate flex-1 min-w-0">
                {e.podcastTitle}
                {e.episodeTitle && <span className="text-muted"> · {e.episodeTitle}</span>}
              </span>
              <span className={`shrink-0 tabular-nums ${e.ok ? 'text-bolt' : ''}`}>
                {e.ok ? `${e.sats.toLocaleString()} sats` : 'failed'}
              </span>
              {/* timeAgo takes unix SECONDS; StreamedEntry.ts is unix MS.
                  Getting this wrong doesn't throw — every row would just
                  silently render a 1970 date. */}
              <span className="shrink-0 text-muted">{timeAgo(Math.floor(e.ts / 1000))}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
