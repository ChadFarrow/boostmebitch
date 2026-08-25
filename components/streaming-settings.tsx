'use client';
import { useEffect, useRef, useState } from 'react';
import type { Podcast } from '@/lib/types';
import { storage, subscribeStreamRate, type StreamedEntry, type StreamMode } from '@/lib/storage';
import { timeAgo } from '@/lib/format';
import {
  streamShowKey,
  streamingStatus,
  subscribeStreaming,
  type StreamingStatus,
} from '@/lib/v4v/streaming';
import { STREAM_AMOUNT_MAX_SATS, STREAM_RATE_MAX_PER_MIN } from '@/lib/v4v/stream-ledger';
import { canSignUnattended } from '@/lib/nostr/signer';

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
 * The amount and its unit, as one control. Commits on blur and Enter; never
 * touches the switch.
 *
 * The unit is a picker where the static "sats / min" text used to be, rather
 * than a second toggle beside the on/off switch. An amount and its unit read as
 * one setting; two switches read as two settings that might disagree — and this
 * panel already carries an on/off switch plus, at show scope, a "use default"
 * escape.
 *
 * The two numbers are stored SEPARATELY (`bmb:stream_rate`, `bmb:stream_amount`)
 * and this component is handed whichever is in force, so switching the unit
 * never destroys the other one — the same discipline that keeps the on/off
 * switch from wiping the rate. The ceiling follows the unit too, since a
 * per-track amount is bounded differently from a per-minute rate.
 *
 * **The 16px font floor on mobile is required, not a style choice.** iOS Safari
 * zooms the whole viewport when an input smaller than 16px takes focus, and
 * this app sets no `maximumScale` (deliberately — that would kill pinch-zoom
 * for everyone). At `text-xs` the page lurched on every tap of this field and
 * scrolled the switch out of view mid-edit, which reads as the control
 * fighting you. Desktop keeps the compact size from `sm:` up. **The `<select>`
 * carries the same floor for the same reason.**
 */
function RateField({
  value,
  mode,
  onCommit,
  onModeChange,
  dimmed = false,
}: {
  value: number;
  mode: StreamMode;
  onCommit: (n: number) => void;
  onModeChange: (m: StreamMode) => void;
  dimmed?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  const max = mode === 'track' ? STREAM_AMOUNT_MAX_SATS : STREAM_RATE_MAX_PER_MIN;

  // Another surface (the other scope's control, a second wallet-modal open) can
  // change this underneath us; re-sync when it does. `mode` is a dep because
  // flipping the unit swaps in an entirely different remembered number.
  useEffect(() => setDraft(String(value)), [value, mode]);

  function commit() {
    const n = Number(draft);
    // An empty or junk field reverts rather than being read as an amount — this
    // number is paid with no prompt.
    if (!draft || !Number.isFinite(n) || n < 1) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.floor(n));
    setDraft(String(clamped));
    onCommit(clamped);
  }

  return (
    <span className={`inline-flex items-center gap-1.5 ${dimmed ? 'opacity-60' : ''}`}>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        aria-label={mode === 'track' ? 'Sats per track' : 'Sats per minute'}
        className="input !py-1 !px-2 !w-20 sm:!w-16 min-h-[44px] sm:min-h-0 text-[16px] sm:text-xs text-right tabular-nums"
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
      <span className="text-[11px] text-muted">sats /</span>
      <select
        aria-label="Streaming unit"
        className="input !py-1 !pl-2 !pr-6 !w-auto min-h-[44px] sm:min-h-0 text-[16px] sm:text-xs"
        value={mode}
        onChange={(e) => onModeChange(e.target.value as StreamMode)}
      >
        <option value="rate">minute</option>
        <option value="track">track</option>
      </select>
    </span>
  );
}

/** Everything the sentence under the control depends on. */
interface StreamRateView {
  /** Show scope (an override) rather than the global default. */
  perShow: boolean;
  /** Show scope with no opinion of its own — inheriting the global setting. */
  following: boolean;
  on: boolean;
  mode: StreamMode;
  rate: number;
  amount: number;
  globalOn: boolean;
  globalRate: number;
  /** Shows with an explicit per-show ON override. Global scope only. */
  showsOn: number;
}

/**
 * The sentence under the switch.
 *
 * A pure function rather than an IIFE inside the component, because every branch
 * here is a PROMISE ABOUT SPENDING and the rules it encodes are the subtle ones
 * in `lib/storage.ts` — the tri-state, and the fact that a per-show override
 * outranks the global switch. Pulling it out means the copy rules can be read
 * without reading JSX, and exercised directly if they keep growing.
 *
 * Two of these strings exist because the earlier wording was wrong in the
 * expensive direction; see the notes on each.
 */
function streamRateDescription(v: StreamRateView): string {
  // Per-track pays when the payment TARGET changes, so a show that never
  // switches target has nothing to trigger on and streams nothing at all.
  // Saying so is the same obligation the global switch carries: a settings
  // screen must never let a user believe money is moving when it isn't.
  const trackCaveat =
    ' Only pays on shows that switch payment target (live V4V shows, music albums) — an ordinary podcast streams nothing in this mode.';

  if (v.following) {
    if (!v.globalOn) return 'Follows your default: streaming off.';
    return v.mode === 'track'
      ? `Follows your default: ${v.amount.toLocaleString()} sats per target change, after 30 seconds.${trackCaveat}`
      : `Follows your default: ${v.globalRate.toLocaleString()} sats/min.`;
  }
  if (v.perShow && !v.on) {
    // The ONLY place the "explicitly off outranks the global rate" rule becomes
    // legible to a human. It has to be here. (Coloured too — see `pinnedOff`.)
    return 'Never streams this show, even if your default is on.';
  }
  if (!v.on) {
    // A per-show override outranks this switch, so "nothing is sent" is a
    // promise the global control is not able to keep. Saying it anyway while a
    // show streams in the mini-bar is the worst kind of wrong: the one screen
    // the user checks to find out whether they're spending money tells them
    // they aren't.
    if (v.showsOn > 0) {
      return v.showsOn === 1
        ? 'Off by default — but 1 show you turned on individually still streams.'
        : `Off by default — but ${v.showsOn} shows you turned on individually still stream.`;
    }
    return 'Off — nothing is sent while you listen. Boosts are unaffected.';
  }
  if (v.mode === 'track') {
    // "each track" was wrong, and wrong in the expensive direction: what
    // triggers a payment is the payment TARGET changing, and on a live show the
    // host's segments between songs are targets of their own, so an interstitial
    // earns the full amount exactly like a song. A line implying otherwise
    // understates the hourly cost.
    const per = `${v.amount.toLocaleString()} sats each time the paid target changes, once it has run 30 seconds`;
    return v.perShow
      ? `Sends ${per} on this show, overriding your default.${trackCaveat}`
      : `Sends ${per} — every track, plus any host segment between them on a live show. Length doesn't matter beyond that: a two-minute song and a six-minute one earn the same, and anything the host flicks past earns nothing.${trackCaveat}`;
  }
  if (v.perShow) {
    return `Streams ${v.rate.toLocaleString()} sats/min for this show, overriding your default.`;
  }
  return `Pays the value split while you listen — batched about every 10 minutes. ~${(
    v.rate * 60
  ).toLocaleString()} sats/hour.`;
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
/**
 * Opt in to publishing a kind:3369 value-playback receipt for each streaming
 * settle.
 *
 * GLOBAL only — deliberately not offered per show. It is a disclosure decision
 * about the listener, and a per-show version would present as a choice about
 * one podcast while the thing being decided is whether this device publishes a
 * listening log at all.
 *
 * The copy names the DISCLOSURE, not the mechanism. "Share streaming payments
 * to Nostr" is true and understates it by a wide margin: what goes out is a
 * public, timestamped record of what was played, when, and for how much, one
 * event per settle, permanently.
 *
 * Two states withhold silently, and both are spelled out on screen rather than
 * left to be discovered. A signer that cannot be asked unattended (Amber,
 * bunker) publishes nothing at all, and "Anonymous" in the boost share picker
 * publishes nothing either — the event is signed, so the signature is the
 * pubkey and there is no quieter version to send. A switch that reads ON while
 * nothing is ever published is the failure this repo keeps re-learning: a
 * silent correct decision is indistinguishable from a broken one.
 */
function StreamReceipts() {
  const [on, setOn] = useState(() => storage.streamReceipts.get());
  const [landed, setLanded] = useState(true);
  // Read after mount: both depend on browser state the server render has no
  // view of, so deriving them during render is a hydration mismatch.
  const [canSign, setCanSign] = useState(true);
  const [anonymous, setAnonymous] = useState(false);
  useEffect(() => {
    setCanSign(canSignUnattended());
    setAnonymous(storage.shareNostr.get() && storage.shareNostrAs.get() === 'site');
  }, []);

  function change(v: boolean) {
    setOn(v);
    // A control with no local state renders whatever reads back, so a write
    // that never reached disk would freeze the switch with no error anywhere.
    setLanded(storage.streamReceipts.set(v));
  }

  return (
    <div className="mt-4 pt-3 border-t border-line">
      <div className="flex flex-wrap items-center gap-3">
        <StreamSwitch on={on} onChange={change} />
        <span className="text-[11px] uppercase tracking-widest text-muted">
          Publish receipts to Nostr
        </span>
      </div>
      <p className="text-[11px] text-muted mt-2">
        Publishes one event for each streaming payment, naming the show or track,
        the amount and the time. No client shows these in a feed, but they are
        public and permanent: together they are a timestamped record of what you
        listened to.
      </p>
      {on && anonymous && (
        <p className="text-[11px] text-nostr mt-2">
          Nothing is published while boosts are set to Anonymous. The receipt is
          signed by your key, so there is no anonymous version of it to send.
        </p>
      )}
      {on && !anonymous && !canSign && (
        <p className="text-[11px] text-nostr mt-2">
          Nothing is published with your current sign-in. Amber and remote
          signers ask for approval on every signature, which a payment on a timer
          cannot do. A browser extension or a key stored here can.
        </p>
      )}
      {!landed && (
        <p className="text-[11px] text-bolt/80 mt-2">
          Storage is restricted or full — this setting works now but won&apos;t
          survive a reload.
        </p>
      )}
    </div>
  );
}

export function StreamRate({
  podcast,
  onDone,
}: {
  podcast?: Podcast;
  onDone?: () => void;
}) {
  const showKey = podcast ? streamShowKey(podcast) : null;

  const read = () => ({
    globalOn: storage.streaming.isOn(),
    globalRate: storage.streaming.getRemembered(),
    showOn: showKey ? storage.streaming.getShowOn(showKey) : null,
    showRate: showKey ? storage.streaming.getShowRemembered(showKey) : null,
    // The unit and the per-track amount resolve show → global → default, the
    // same chain as the rate, so the control and the engine can't disagree.
    mode: storage.streaming.getEffectiveMode(showKey),
    amount: storage.streaming.getEffectiveAmount(showKey),
    // Only the global control needs this, and only to avoid lying — see below.
    showsOn: showKey ? 0 : storage.streaming.showsExplicitlyOn(),
    // The switch couldn't be written to disk (storage blocked or full). It
    // still works for this session off the memory mirror, but saying nothing
    // would let the user discover on their next visit that streaming quietly
    // turned itself back off.
    ephemeral: storage.streaming.isEphemeral(showKey),
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
    if (showKey) storage.streaming.setShowOn(showKey, v);
    else storage.streaming.setOn(v);
  }
  function setRate(n: number) {
    if (s.mode === 'track') {
      if (showKey) storage.streaming.setShowAmount(showKey, n);
      else storage.streaming.setAmount(n);
      return;
    }
    if (showKey) storage.streaming.setShowRate(showKey, n);
    else storage.streaming.setRate(n);
  }
  function setMode(m: StreamMode) {
    if (showKey) storage.streaming.setShowMode(showKey, m);
    else storage.streaming.setMode(m);
  }
  // The number the field shows follows the unit — two separate remembered
  // values, so flipping back and forth never loses either.
  const amount = s.mode === 'track' ? s.amount : rate;

  const description = streamRateDescription({
    perShow: !!showKey,
    following,
    on,
    mode: s.mode,
    rate,
    amount: s.amount,
    globalOn: s.globalOn,
    globalRate: s.globalRate,
    showsOn: s.showsOn,
  });

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
            onClick={() => storage.streaming.setShowOn(showKey, null)}
            aria-pressed={following}
            className={`btn-ghost !px-2.5 !py-1 min-h-[44px] sm:min-h-0 text-[11px] ${
              following ? '!border-bolt text-bolt' : ''
            }`}
          >
            Use default
          </button>
        )}
        <StreamSwitch on={on} onChange={setOn} dimmed={following} />
        <RateField
          value={amount}
          mode={s.mode}
          onCommit={setRate}
          onModeChange={setMode}
          dimmed={following}
        />
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
              onClick={() => storage.streaming.setShowOn(showKey!, null)}
              className="underline underline-offset-2 hover:text-bone"
            >
              Follow my default instead
            </button>
          </>
        )}
      </p>
      {!showKey && <StreamReceipts />}
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
      className="btn-ghost btn-compact"
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
/**
 * What a failed settle can honestly say about the sats.
 *
 * Shared by <StreamMeter> and <StreamPulse> because they make the same claim in
 * two places, and a claim about money that is maintained twice is one that will
 * eventually be true in one place and false in the other.
 *
 * "nothing was sent" is only available in the third case, and getting there
 * takes two checks rather than one:
 *   - Turning streaming off FORCE-settles, and a force settle flushes every
 *     accrued bucket in one batch. Bucket 1 paying and bucket 2 failing leaves
 *     an error beside sats that are already gone.
 *   - A wallet that never answered has not refused (CLAUDE.md's
 *     NwcIndeterminateError rule). The engine still counts it as a failure, on
 *     purpose; the copy must not promote that to a statement of fact.
 * Both are silent by construction — nothing on screen distinguishes them from a
 * clean failure — which is exactly why the honest wording has to be derived
 * rather than assumed.
 */
function sentClause(s: StreamingStatus): string {
  if (s.lastErrorSentSats > 0) {
    return `${s.lastErrorSentSats.toLocaleString()} sat${
      s.lastErrorSentSats === 1 ? '' : 's'
    } had already been sent when this failed`;
  }
  if (s.lastErrorIndeterminate) {
    return 'your wallet never answered, so these sats may or may not have been sent';
  }
  return 'nothing was sent';
}

export function StreamMeter({ className = '' }: { className?: string }) {
  const [status, setStatus] = useState(streamingStatus);

  // The engine notifies on every real state change — NOT every tick — so this
  // stays live without a timer of its own and without repainting sixty times a
  // minute for a user who never opens the fullscreen player. (<FullscreenPlayer>
  // is always mounted, just translated off-screen, so this component is too.)
  useEffect(() => subscribeStreaming(() => setStatus(streamingStatus())), []);

  if (!status.active && !status.lastError) return null;

  const mins = Math.ceil(status.msUntilSettle / 60_000);
  // A resolved rate of 0 means streaming is OFF for what's playing, so the only
  // reason this component is on screen is a settle that failed on the way out —
  // turning streaming off force-settles the time already listened, and that
  // last payment can fail like any other. Saying "streaming 0 sats/min" there
  // claims a live rate for a show that has none; it also read identically for a
  // show still streaming at 10 that had merely given up, which is the one
  // distinction this line has to make.
  const off = status.ratePerMin === 0;
  const amountLabel =
    status.mode === 'track'
      ? `${status.amountPerTrack.toLocaleString()} sats/track`
      : `${status.ratePerMin} sats/min`;
  return (
    <div className={`text-[11px] ${className}`}>
      <span className="text-bolt">
        {off
          ? '≋ streaming off for this show'
          : status.active
            ? `≋ streaming ${amountLabel}`
            : `≋ streaming paused · ${amountLabel}`}
      </span>
      {/* Track mode with nothing to pay for. The rate path always accrues, so a
          rising number is its own proof it's working; this mode can sit at zero
          forever on a show with no per-track splits, and silence there reads as
          "working" too. */}
      {status.trackModeIdle && (
        <span className="text-muted"> · no per-track splits on this show — nothing is sent</span>
      )}
      {status.active && !status.trackModeIdle && (
        <span className="text-muted">
          {/* Naming the track is the visible proof that a music show's
              per-track value splits are being followed — otherwise "streaming"
              looks identical whether the artist is being paid or not. The art
              is the same argument in one glance: it's the artist's own cover,
              pushed with the block, so a wrong target is obvious immediately.
              <img> not next/image — the host is whatever the block names. */}
          {status.blockImage && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={status.blockImage}
              alt=""
              className="inline-block w-4 h-4 rounded-sm object-cover align-text-bottom mr-1 ml-1"
            />
          )}
          {status.currentTrack && <> · to <span className="text-bone">{status.currentTrack}</span></>}
          {' · '}
          {status.accruedSats} sat{status.accruedSats === 1 ? '' : 's'} accrued
          {status.settling
            ? ' · sending…'
            /* A live block settles when the host moves on, which is minutes
               sooner than the interval — so showing the interval countdown
               answers "when does my money move?" with a number that is almost
               never the answer. Name the edge instead. */
            : status.settlesOnBlockChange
              ? ' · sends when the block changes'
              : status.msUntilSettle > 0
                ? ` · next in ${mins}m`
                : ' · due'}
        </span>
      )}
      {status.lastError && (
        <div className="text-nostr mt-0.5 break-words">
          ⚠ {status.lastError}
          {/* Only ever offer a remedy that can actually work — and with
              streaming off there is nothing to remedy, so the retry copy is
              worse than none: it asks the user to re-arm spending they have
              already turned off, over an error they did nothing to cause.
              What they need to know instead is what happened to the sats and
              that nothing further will be attempted — and the first half is
              `sentClause`'s job, because a force settle can fail AFTER paying.
              'rail-cannot-pay' is a capability gap, so "change the rate to
              retry" would loop the user through the identical failure. */}
          {off
            ? ` — ${sentClause(status)}. Streaming is off for this show, so nothing further will be tried.`
            : status.stoppedReason === 'failures'
              ? ' — streaming paused for this episode. Change the rate or connect a wallet to retry.'
              : status.stoppedReason === 'rail-cannot-pay'
                ? ' — connect NWC or a WebLN extension to stream this show.'
                : null}
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
    const failure = s.lastError ?? 'payment failed';
    return (
      <span
        className="text-[11px] text-nostr shrink-0"
        title={
          // Same distinction <StreamMeter> makes: with streaming off for this
          // show, "stopped" reads as something the user has to go and restart.
          s.ratePerMin === 0
            ? `Streaming payment failed: ${failure} — ${sentClause(s)}, and streaming is off for this show.`
            : `Streaming stopped: ${failure}`
        }
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
