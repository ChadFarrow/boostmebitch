'use client';
import { useSyncExternalStore } from 'react';
import { downloadManager } from './download-manager';

/**
 * Subscribe to the download engine.
 *
 * Returns its version counter, which is a re-render trigger and nothing else —
 * callers read what they actually need off `downloadManager` directly. That
 * keeps the snapshot a primitive: `useSyncExternalStore` compares snapshots by
 * `Object.is`, so returning an object or an array here would re-render every
 * subscriber on every tick and warn about an unstable snapshot in dev.
 *
 * The server snapshot is `0` because none of this exists outside a browser.
 * A surface that shows a list must still gate its empty copy on
 * `downloadManager.ready()` — a version of 0 means "nothing has happened yet",
 * not "there is nothing here".
 */
export function useDownloadsVersion(): number {
  return useSyncExternalStore(
    downloadManager.subscribe,
    downloadManager.getVersion,
    () => 0,
  );
}
