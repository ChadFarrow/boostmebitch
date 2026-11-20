import { after } from 'next/server';
import { BRAND } from '../brand';
import { COMMUNITY_FEED_ORIGIN } from '../curated-playlists';
import { archiveDispatchBase } from './rules';

// SERVER-ONLY. After a playlist is published, edited or deleted, asks GitHub to
// run `.github/workflows/playlist-archive.yml`, which copies every playlist feed
// to the repo's `playlists` branch (docs/feeds.md, "The GitHub copy"; Chad,
// 2026-11-19: "when someone hits publish, it saves to the Boost Me Bitch repo").
//
// IT SENDS NO PLAYLIST. The workflow copies everything on each run, so this is a
// bare "run now": no id, no title, nothing from the user reaches GitHub or the
// workflow's inputs. Without it the 15-minute schedule still copies.
//
// THE TOKEN MAY ONLY START WORKFLOWS. `GITHUB_ARCHIVE_TOKEN` is a fine-grained
// token with "Actions: write" on this one repo, so a leak cannot push code. The
// push is made by the workflow's own one-run token (docs/ops.md, "The GitHub
// copy of the playlists").
//
// OFF unless the token is set AND the feed origin is the real one, so a local or
// preview server never asks GitHub to copy feeds it does not serve. A test points
// `PLAYLIST_ARCHIVE_API` at a stub, and only a loopback address is accepted
// there, so that variable can never send the token anywhere else.
//
// It never throws, and a response never waits for it.

const REPO = 'ChadFarrow/boostmebitch';
const WORKFLOW = 'playlist-archive.yml';

/** The GitHub API base to send to, or null when this server must not send. */
function archiveApiBase(): string | null {
  return archiveDispatchBase(process.env.PLAYLIST_ARCHIVE_API, COMMUNITY_FEED_ORIGIN);
}

function enabled(): boolean {
  return !!process.env.GITHUB_ARCHIVE_TOKEN && archiveApiBase() !== null;
}

/** One `workflow_dispatch` on `main`. Logs a refusal; never throws. */
export async function requestPlaylistArchive(): Promise<void> {
  const token = process.env.GITHUB_ARCHIVE_TOKEN;
  const base = archiveApiBase();
  if (!token || !base) return;
  try {
    const r = await fetch(`${base}/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': BRAND.userAgent,
      },
      body: JSON.stringify({ ref: 'main' }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    // 204 is GitHub's success. 401: the token expired or is wrong; 403/404: it
    // lacks "Actions: write" on this repo, or the workflow is not on `main` yet.
    if (r.status !== 204) console.warn('[playlist-archive] workflow_dispatch answered', r.status);
    await r.body?.cancel().catch(() => {});
  } catch (e) {
    console.warn('[playlist-archive] workflow_dispatch failed:', e instanceof Error ? e.message : e);
  }
}

/**
 * Run `requestPlaylistArchive` after the response is sent (`after()` keeps the
 * serverless function alive for it). Never throws; outside a request scope it
 * falls back to fire-and-forget.
 */
export function requestPlaylistArchiveAfter(): void {
  if (!enabled()) return;
  const run = () => requestPlaylistArchive().catch(() => {});
  try {
    after(run);
  } catch {
    void run();
  }
}
