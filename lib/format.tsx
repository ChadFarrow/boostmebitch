'use client';
import { Fragment, type ReactNode } from 'react';
import {
  boostSoundPlan,
  hasAudioSessionSupport,
  isExclusiveAudioPlatform,
  type BoostSoundPlan,
} from './boost-sound';

// ─── Time formatting ──────────────────────────────────────────────────────────

/** Format seconds as h:mm:ss / m:ss. Returns '' for invalid/zero values. */
export function fmtDuration(t: number): string {
  if (!isFinite(t) || t <= 0) return '';
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60).toString().padStart(2, '0');
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s}`;
  return `${m}:${s}`;
}

/** Format seconds as h:mm:ss / m:ss. Returns '0:00' for invalid values. */
export function fmt(t: number): string {
  if (!isFinite(t)) return '0:00';
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60).toString().padStart(2, '0');
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s}`;
  return `${m}:${s}`;
}

/** Time-of-day clock, e.g. "3:45 PM". Accepts unix seconds. */
export function fmtClock(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Clock time for today, else "Mon D <clock>". Accepts unix seconds. */
export function fmtLiveTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? fmtClock(unixSec)
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${fmtClock(unixSec)}`;
}

/** Human-readable relative timestamp. Accepts unix seconds. */
export function timeAgo(unixSec: number): string {
  const diff = Date.now() / 1000 - unixSec;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixSec * 1000).toLocaleDateString();
}

// ─── Link parsing & rendering ─────────────────────────────────────────────────

const LINK_RE = /(https?:\/\/[^\s]+)/gi;
const NOSTR_URI_RE =
  /nostr:n(?:event|ote|pub|profile|addr)1[023456789acdefghjklmnpqrstuvwxyz]+/gi;
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|bmp)(\?[^\s]*)?$/i;

/** Peel trailing grammar punctuation off a URL token. */
export function splitTrailingPunct(token: string): { token: string; trailing: string } {
  let trailing = '';
  while (token.length > 0 && /[.,;:!?)\]]$/.test(token)) {
    trailing = token.slice(-1) + trailing;
    token = token.slice(0, -1);
  }
  return { token, trailing };
}

/** Remove nostr: bech32 URIs from text and clean up leftover whitespace. */
export function stripNostrUris(text: string): string {
  return text
    .replace(NOSTR_URI_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Turn bare http(s) URLs in plain text into anchor elements.
 * `linkClassName` defaults to `'text-nostr'`; pass `'text-bolt'` for boost cards.
 */
export function linkify(text: string, linkClassName = 'text-nostr'): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text)) !== null) {
    if (m.index > cursor) parts.push(text.slice(cursor, m.index));
    const { token, trailing } = splitTrailingPunct(m[0]);
    parts.push(
      <a
        key={`l-${m.index}`}
        href={token}
        target="_blank"
        rel="noopener noreferrer"
        className={`${linkClassName} break-all hover:underline underline-offset-2`}
      >
        {token}
      </a>,
    );
    if (trailing) parts.push(<Fragment key={`t-${m.index}`}>{trailing}</Fragment>);
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/** Extract image URLs from text, returning cleaned body and image list. */
export function extractImages(text: string): { body: string; images: string[] } {
  const images: string[] = [];
  const body = text.replace(LINK_RE, (m) => {
    const { token, trailing } = splitTrailingPunct(m);
    if (IMAGE_EXT_RE.test(token)) {
      if (!images.includes(token)) images.push(token);
      return trailing;
    }
    return m;
  });
  return {
    body: body.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    images,
  };
}

// ─── UI ───────────────────────────────────────────────────────────────────────

/**
 * Brand-coloured confetti burst: bolt yellow, nostr magenta, bone.
 *
 * `canvas-confetti` is dynamic-imported so it stays out of the initial bundle —
 * format.tsx sits on the critical render path (imported by player, note cards,
 * live chat), but confetti only ever fires after a successful boost. Same
 * lazy-load pattern as hls.js and the Spark SDK.
 */
export function fireConfetti(): void {
  const colors = ['#fae500', '#ff2d92', '#f5f1e8'];
  void import('canvas-confetti').then(({ default: confetti }) => {
    confetti({ particleCount: 80, spread: 70, startVelocity: 55, origin: { y: 0.7 }, colors });
    setTimeout(() => {
      confetti({ particleCount: 50, spread: 100, startVelocity: 45, origin: { y: 0.7 }, colors });
    }, 200);
  }).catch(() => {}); // a missing/blocked confetti module is a silent no-op
}

let boostAudio: HTMLAudioElement | null = null;
let boostAudioPrimed = false;

function ensureBoostAudio(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null;
  if (!boostAudio) {
    boostAudio = new Audio('/boost.mp3');
    boostAudio.preload = 'auto';
  }
  return boostAudio;
}

type AudioSessionish = { type?: string };

/** The document's audio session, when the browser exposes one. */
function audioSession(): AudioSessionish | null {
  if (!hasAudioSessionSupport()) return null;
  return (navigator as Navigator & { audioSession?: AudioSessionish }).audioSession ?? null;
}

/** How to handle the ping right now, given live playback state. */
function planFor(appIsPlaying: boolean): BoostSoundPlan {
  return boostSoundPlan({
    appIsPlaying,
    hasAudioSession: hasAudioSessionSupport(),
    exclusiveAudioPlatform: isExclusiveAudioPlatform(),
  });
}

/**
 * Borrow a mixable `transient` session for the duration of one play(), and
 * return the restore. No-op for every plan but `'transient'` — `'as-is'` means
 * "don't touch the document's session", and retyping it while OUR player holds
 * it would demote our own playback (a transient session is what stops audio on
 * screen lock).
 *
 * The type has to be set BEFORE play(), because the session is created when
 * the element starts playing — that ordering is the whole point.
 */
function borrowTransientSession(plan: BoostSoundPlan): () => void {
  const noop = () => {};
  if (plan !== 'transient') return noop;
  const session = audioSession();
  const previousType = session?.type;
  if (!session || previousType === undefined) return noop;
  try { session.type = 'transient'; } catch { return noop; }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    try { session.type = previousType; } catch { /* ignore */ }
  };
}

/**
 * Unlock the boost sound within a user gesture so a LATER programmatic
 * play() isn't blocked by mobile autoplay policy. `playBoostSound()` fires
 * only after the async Lightning payment resolves — seconds after the tap —
 * by which point iOS Safari has expired the button's transient activation
 * and rejects an unprimed play(). iOS only permits play() on an element that
 * has already played inside a real gesture, so we do a silent (muted)
 * play+pause here. Call synchronously at the top of a boost click handler,
 * BEFORE any await. Desktop doesn't need this, but priming is harmless there.
 *
 * **The pause is synchronous — the element must never actually reach
 * "playing".** WebKit grants the element its permanent gesture unlock when
 * `play()` is *called* inside the activation, not when the returned promise
 * resolves, so pausing in the same turn keeps the unlock while leaving the
 * media element at a standstill. Letting it truly start (pausing in `.then()`,
 * as this did originally) is what put a SECOND live media element on the page
 * at tap time, and that is audible in three separate ways:
 *
 *  1. iOS arbitrates concurrent media elements — a second one starting can
 *     duck or interrupt our own podcast. Reported as a hit "when I clicked the
 *     button" on a boost sent while listening in-app, where the audio-session
 *     plan is `'as-is'` and nothing is retyped, so the session was never the
 *     whole story.
 *  2. `muted` is not reliably honored for `<audio>` on iOS, so "silent" wasn't
 *     guaranteed to be silent.
 *  3. A fast payment races it: `playBoostSound` unmutes and plays, then the
 *     prime's late `.then()` fires `pause()` + `currentTime = 0` and chops the
 *     ping it exists to enable.
 *
 * The sync `pause()` rejects the play promise with `AbortError`; that rejection
 * is expected and swallowed. Worst case on a browser that ties the unlock to
 * actual playback: the later ping is blocked and we lose the sound — strictly
 * better than interrupting what the user is listening to.
 *
 * `appIsPlaying` is the live value at tap time (`useApp.getState().isPlaying`),
 * and gates the session handling exactly as it does for the ping: `'skip'`
 * primes nothing (that platform never gets the ping anyway), `'transient'`
 * primes under a borrowed transient session.
 */
export function primeBoostSound(opts: { appIsPlaying: boolean }): void {
  const audio = ensureBoostAudio();
  if (!audio || boostAudioPrimed) return;
  const plan = planFor(opts.appIsPlaying);
  if (plan === 'skip') return;

  const restore = borrowTransientSession(plan);
  try {
    audio.muted = true;
    // Swallow the AbortError the synchronous pause below provokes. Nothing to
    // clean up in either arm — the pause already ran.
    void audio.play()?.catch(() => {});
    audio.pause();
    audio.currentTime = 0;
    audio.muted = false;
    boostAudioPrimed = true;
  } catch {
    audio.muted = false;
  } finally {
    restore();
  }
}

/**
 * Short celebratory sound on a successful boost. Silent no-op if the asset
 * can't load.
 *
 * `appIsPlaying` must be the LIVE value at call time (read it via
 * `useApp.getState().isPlaying`, not a value captured during render) — this
 * fires seconds after the tap, once the payment resolves, and a stale `false`
 * would retype the audio session out from under a podcast that started
 * playing in the meantime.
 *
 * See `lib/boost-sound.ts` for why the plan differs by state; the short
 * version is that an unmuted ping on an otherwise-idle page takes an
 * exclusive `playback` session and permanently kills the user's music app.
 */
export function playBoostSound(opts: { appIsPlaying: boolean }): void {
  const audio = ensureBoostAudio();
  if (!audio) return;
  const plan = planFor(opts.appIsPlaying);
  if (plan === 'skip') return;

  // Restores whatever the page had, so a podcast started later doesn't inherit
  // a transient session (which is exactly what stops audio on screen lock).
  const restore = borrowTransientSession(plan);

  try {
    audio.muted = false;
    audio.currentTime = 0;
    void audio
      .play()
      .then(() => {
        // `ended` is the accurate signal; the timeout is a backstop for a
        // stalled decode, which would otherwise leave the session retyped.
        audio.addEventListener('ended', restore, { once: true });
        setTimeout(restore, 5000);
      })
      .catch(() => restore());
  } catch {
    restore();
  }
}
