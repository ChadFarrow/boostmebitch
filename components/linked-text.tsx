'use client';

import { Fragment } from 'react';
import { httpUrl, splitOnBareUrls } from '@/lib/util';

/**
 * Plain text with its bare http(s) URLs rendered as real links.
 *
 * The counterpart to `sanitizeShowNotes`' server-side linkify pass, for the two
 * surfaces that render a `stripHtml`'d description instead of the notes HTML —
 * the fullscreen player's About pane and the episode page's no-`contentEncoded`
 * fallback. Both showed a feed's "Links:" block as text you could only select
 * and paste. Split logic is shared (`splitOnBareUrls`) so a link that is
 * clickable on the episode page is clickable in the player too.
 *
 * Renders React elements, never `dangerouslySetInnerHTML` — the text is
 * third-party and this origin holds a spending credential. The href still goes
 * through `httpUrl`, because React does NOT block a `javascript:` href (it only
 * warns in dev); `splitOnBareUrls` already anchors on http(s), so this is the
 * second lock rather than the only one.
 *
 * The caller owns whitespace: put this inside a `whitespace-pre-wrap` container
 * so the feed's own line breaks survive.
 */
export function LinkedText({ text }: { text: string }) {
  const segs = splitOnBareUrls(text);
  return (
    <>
      {segs.map((seg, i) => {
        // Even indices are the text between links; odd are the URLs.
        if (i % 2 === 0) return <Fragment key={i}>{seg}</Fragment>;
        const href = httpUrl(seg);
        if (!href) return <Fragment key={i}>{seg}</Fragment>;
        return (
          <a
            key={i}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            // A URL has no spaces to wrap at, so without break-words a long one
            // pushes the pane sideways or is clipped by its overflow-x-hidden.
            // Matches `.show-notes a` in globals.css, the HTML-notes equivalent.
            className="text-bolt underline underline-offset-2 break-words hover:opacity-80"
          >
            {seg}
          </a>
        );
      })}
    </>
  );
}
