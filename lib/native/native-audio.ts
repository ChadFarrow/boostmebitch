/**
 * The JS side of the iOS `NativeAudioPlugin` (`ios/App/App/NativeAudioPlugin.swift`).
 *
 * STAGE 2 of docs/ios.md and NOT WIRED YET: nothing imports this module. The
 * web player still plays through its `<audio>` element on every platform.
 * Wire it into `components/player.tsx` only if the Stage 1 test shows the
 * WKWebView `<audio>` still loses the lock-screen entry on pause — read
 * docs/ui.md ("Players", "The lock screen is the third surface") first.
 *
 * Browser-only. `registerPlugin` is safe to call on the web: every method then
 * rejects with "not implemented", which is why callers gate on
 * `isNativeIos()` and never on the plugin's presence.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface NativeTrack {
  url: string;
  title?: string;
  artist?: string;
  album?: string;
  /** Use the `/api/art` URL, as the web lock screen does. */
  artworkUrl?: string;
  startAt?: number;
  rate?: number;
  /** Default true. */
  autoplay?: boolean;
}

export interface NativeAudioState {
  playing: boolean;
  buffering: boolean;
  position: number;
  duration: number;
  rate: number;
}

/**
 * `play`, `pause`, `seek` and the skips have ALREADY happened natively when
 * this arrives — sync the UI, do not act again. `next` and `previous` have
 * NOT: the queue lives in JS, so JS decides what plays.
 */
export interface NativeRemoteEvent {
  command: 'play' | 'pause' | 'skipForward' | 'skipBackward' | 'seek' | 'next' | 'previous';
  position?: number;
}

export interface NativeAudioPlugin {
  loadTrack(track: NativeTrack): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(opts: { position: number }): Promise<void>;
  setRate(opts: { rate: number }): Promise<void>;
  updateMetadata(meta: Pick<NativeTrack, 'title' | 'artist' | 'album' | 'artworkUrl'>): Promise<void>;
  /** Podcast: skips (e.g. 30/15). Music: both 0, which turns on ⏮/⏭. */
  setSkipIntervals(opts: { skipForward: number; skipBackward: number }): Promise<void>;
  getState(): Promise<NativeAudioState>;
  /** Removes the Now Playing entry. Call when the player closes, NEVER on pause. */
  stop(): Promise<void>;
  addListener(event: 'timeupdate' | 'state', fn: (s: NativeAudioState) => void): Promise<PluginListenerHandle>;
  addListener(event: 'loaded', fn: (d: { duration: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'ended', fn: () => void): Promise<PluginListenerHandle>;
  addListener(event: 'error', fn: (d: { message: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'remote', fn: (e: NativeRemoteEvent) => void): Promise<PluginListenerHandle>;
}

export const NativeAudio = registerPlugin<NativeAudioPlugin>('NativeAudio');

/** True only inside the Capacitor iOS app — false on the web, the PWA and the TWA. */
export function isNativeIos(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
}
