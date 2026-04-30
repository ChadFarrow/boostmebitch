'use client';
import { Fragment, type ReactNode } from 'react';
import type { StoredBoost } from '@/lib/types';
import { useApp } from '@/lib/store';
import { shortNpub } from '@/lib/nostr';
import { Avatar } from './avatar';

const LINK_RE = /(https?:\/\/[^\s]+)/gi;

function splitTrailingPunct(token: string): { token: string; trailing: string } {
  let trailing = '';
  while (token.length > 0 && /[.,;:!?)\]]$/.test(token)) {
    trailing = token.slice(-1) + trailing;
    token = token.slice(0, -1);
  }
  return { token, trailing };
}

function linkify(text: string): ReactNode[] {
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
        className="text-bolt break-all hover:underline underline-offset-2"
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

function timeAgo(unixMs: number): string {
  const diff = (Date.now() - unixMs) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixMs).toLocaleDateString();
}

function shortAddr(addr: string): string {
  if (addr.includes('@')) return addr;
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Renders one of the user's locally-saved sent boosts. Visual sibling to
 * NoteCard so the global feed reads as a single boost stream when these are
 * intermixed. Author identity comes from the active session's profile —
 * the StoredBoost itself only carries a senderName fallback.
 */
export function BoostCard({ boost }: { boost: StoredBoost }) {
  const identity = useApp((s) => s.identity);
  const profile = identity?.profile;
  const name =
    boost.senderName ||
    profile?.display_name?.trim() ||
    profile?.name?.trim() ||
    (identity ? shortNpub(identity.npub) : 'You');

  const successLegs = boost.legs.filter((l) => l.ok);
  const sats = successLegs.length
    ? successLegs.reduce((s, l) => s + l.sats, 0)
    : boost.sats;

  return (
    <article className="card p-3 flex gap-3 border-bolt/40">
      {identity?.pubkey ? (
        <Avatar
          pubkey={identity.pubkey}
          picture={profile?.picture}
          name={name}
          className="w-9 h-9 rounded-full border border-bone/20 flex-shrink-0 text-sm"
        />
      ) : (
        <div className="w-9 h-9 rounded-full border border-bone/20 bg-line flex-shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="font-display text-sm text-bone truncate">{name}</span>
          <span className="text-muted">· {timeAgo(boost.ts)}</span>
          <span className="stamp text-bolt border-bolt/60">⚡ {sats} sats</span>
          <span className="stamp text-muted border-bone/20">sent</span>
          {boost.noteId && (
            <span className="text-muted">· also on Nostr</span>
          )}
        </div>

        <div className="flex items-center gap-2 mt-1.5 text-[11px] text-muted">
          {boost.podcastImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={boost.podcastImage}
              alt=""
              className="w-4 h-4 object-cover border border-bone/20 flex-shrink-0"
            />
          ) : null}
          <span className="truncate">
            <span className="text-bolt">→</span>{' '}
            <span className="text-bone">{boost.podcastTitle}</span>
            {boost.episodeTitle ? (
              <span className="text-muted"> · {boost.episodeTitle}</span>
            ) : null}
          </span>
        </div>

        {boost.message && (
          <p className="text-sm text-bone whitespace-pre-wrap break-words mt-1.5">
            {linkify(boost.message)}
          </p>
        )}

        <ul className="mt-2 space-y-0.5 text-[11px] text-muted">
          {boost.legs.map((leg, i) => (
            <li key={i} className="flex items-center gap-2 flex-wrap">
              <span className={leg.ok ? 'text-bolt' : 'text-red-400'}>
                {leg.ok ? '✓' : '✗'}
              </span>
              <span className="text-bone">{leg.recipientName || shortAddr(leg.recipient)}</span>
              <span>· {leg.sats} sats</span>
              {leg.boostboxUrl && (
                <a
                  href={leg.boostboxUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-bolt hover:underline underline-offset-2"
                  title="View metadata on BoostBox"
                >
                  📦 boostbox
                </a>
              )}
              {leg.error && !leg.ok && (
                <span className="text-red-400/80" title={leg.error}>· {leg.error}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}
