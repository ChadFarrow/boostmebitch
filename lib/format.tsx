'use client';
import { Fragment, type ReactNode } from 'react';
import confetti from 'canvas-confetti';

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

/** Human-readable relative timestamp. Accepts unix seconds. */
export function timeAgo(unixSec: number): string {
  const diff = Date.now() / 1000 - unixSec;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixSec * 1000).toLocaleDateString();
}

// ─── HTML stripping ───────────────────────────────────────────────────────────

export function stripHtml(s: string): string {
  return s
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

/** Brand-coloured confetti burst: bolt yellow, nostr magenta, bone. */
export function fireConfetti(): void {
  const colors = ['#fae500', '#ff2d92', '#f5f1e8'];
  confetti({ particleCount: 80, spread: 70, startVelocity: 55, origin: { y: 0.7 }, colors });
  setTimeout(() => {
    confetti({ particleCount: 50, spread: 100, startVelocity: 45, origin: { y: 0.7 }, colors });
  }, 200);
}
