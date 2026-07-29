// How to play the boost celebration ping without stealing the user's music.
//
// The problem this exists to solve: an unmuted `<audio>` play() on a page that
// isn't otherwise playing gets `navigator.audioSession.type = 'auto'`, which
// the user agent resolves to **`playback`** for a media element — and per the
// Audio Session spec a playback session "should not mix with other playback
// audio." So a two-second celebration ping claimed an EXCLUSIVE session,
// iOS interrupted Apple Music / Spotify, and whether the other app ever comes
// back is the other app's decision — in practice it doesn't. The user's music
// just stops, permanently, because they sent a boost.
//
// The spec's own description of `transient` is this feature verbatim:
// "Transient audio, such as a notification ping. They usually should play on
// top of playback audio (and maybe also 'duck' persistent audio)."
//
// The catch is that the type is **document-scoped**, not per-element — one
// switch for the whole page. BMB is itself a media player whose podcast
// playback needs a real `playback` session (survive screen lock, ignore the
// ringer switch), so we must not retype the session while our own audio is
// running. Hence the split below.

export type BoostSoundPlan =
  /** Play it as-is; don't touch the document's audio session. */
  | 'as-is'
  /** Borrow a mixable `transient` session for the ping, then restore. */
  | 'transient'
  /** Don't play it at all. */
  | 'skip';

/**
 * Decide how (or whether) to play the ping.
 *
 * - **Our player is already playing** → `'as-is'`. We already hold the audio
 *   session; any third-party audio was interrupted by the podcast itself,
 *   legitimately, and the ping adds no new interruption. Re-typing the
 *   document session here would demote OUR OWN playback to a transient one,
 *   which is what actually breaks podcasts on lock.
 * - **Idle, and the API exists** → `'transient'`. Ducks rather than seizes, so
 *   the user's music resumes on its own.
 * - **Idle, no API, desktop** → `'as-is'`. Desktop OSes let pages mix audio
 *   freely; there is no exclusive session to steal, so there is nothing to
 *   protect the user from. Skipping here would silence the ping for every
 *   Chrome and Firefox user (neither implements the API at all) to fix a
 *   problem those browsers don't have.
 * - **Idle, no API, mobile** → `'skip'`. This is the case with no good move:
 *   mobile OSes enforce exclusive audio (iOS audio sessions, Android audio
 *   focus) and we have no way to ask for a mixable one, so the only
 *   alternative is permanently killing the user's music for a celebration
 *   sound. Losing the ping is strictly the cheaper outcome. In practice this
 *   is a narrow band — iOS has had the API since 16.4 — mostly older iOS and
 *   Chrome on Android.
 */
export function boostSoundPlan(o: {
  appIsPlaying: boolean;
  hasAudioSession: boolean;
  /** Platform enforces exclusive audio (mobile), so an unmixable ping evicts other apps. */
  exclusiveAudioPlatform: boolean;
}): BoostSoundPlan {
  if (o.appIsPlaying) return 'as-is';
  if (o.hasAudioSession) return 'transient';
  return o.exclusiveAudioPlatform ? 'skip' : 'as-is';
}

/**
 * Whether this platform enforces exclusive audio, i.e. whether an unmixable
 * ping can evict another app's playback.
 *
 * Coarse by necessity — there's no feature test for "the OS has audio focus."
 * Being wrong is cheap in both directions: a false positive drops a ding on a
 * device that has the API anyway (so it never reaches this branch), and a
 * false negative only matters on a mobile browser predating iOS 16.4.
 * iPadOS reporting itself as a Mac doesn't matter here for the same reason.
 */
export function isExclusiveAudioPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (typeof uaData?.mobile === 'boolean') return uaData.mobile;
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

/** Whether this browser exposes the Audio Session API at all. */
export function hasAudioSessionSupport(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'audioSession' in navigator &&
    !!(navigator as Navigator & { audioSession?: { type?: string } }).audioSession
  );
}
