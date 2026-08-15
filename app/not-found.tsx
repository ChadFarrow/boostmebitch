// 404. Without this file Next serves its unstyled default, which drops the user
// out of the app's look entirely — and the routes most likely to 404 here are
// shared deep links (/stream/<naddr>, /live/<npub>) whose identifier went stale,
// i.e. exactly the case where a stranger's first sight of this app is the error
// page.
//
// A server component: nothing here needs state, and the layout — hero, header,
// <Player> — still renders around it, so the visitor lands somewhere they can
// keep using rather than at a dead end. <Link> rather than <a> so going home
// is a client transition that keeps playback alive.

import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="min-h-screen px-4 pt-[env(safe-area-inset-top)]">
      <div className="max-w-xl mx-auto pt-24">
        <div className="card p-5">
          <div className="stamp text-muted border-muted/40 mb-2">404</div>
          <h1 className="font-display text-2xl">Nothing here</h1>
          <p className="text-sm text-muted mt-2">
            That link doesn&apos;t point at anything we can find. If it was a live
            stream or a shared episode, it may have ended or the feed may have
            moved.
          </p>
          <div className="mt-4">
            <Link href="/" className="btn">← back to home</Link>
          </div>
        </div>
      </div>
    </main>
  );
}
