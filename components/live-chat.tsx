'use client';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { nip19, type Event } from 'nostr-tools';
import { subscribeLiveChat, publishLiveChat, LIVE_STREAM_RELAYS } from '@/lib/nostr';
import { fetchProfile } from '@/lib/nostr';
import type { ProfileMetadata } from '@/lib/nostr/auth';
import { storage } from '@/lib/storage';
import { useApp } from '@/lib/store';
import { getErrorMessage } from '@/lib/util';
import { fmtClock, splitTrailingPunct } from '@/lib/format';
import { Avatar } from './avatar';

const MAX_MESSAGES = 200;

type Profiles = Record<string, ProfileMetadata | null>;

// nostr: mentions worth resolving to a name (NIP-27 npub/nprofile).
const MENTION_RE = /nostr:n(?:pub|profile)1[023456789acdefghjklmnpqrstuvwxyz]+/gi;
// Any nostr: URI or http(s) link — for inline rendering.
const TOKEN_RE = /nostr:n(?:pub|profile|event|ote|addr)1[023456789acdefghjklmnpqrstuvwxyz]+|https?:\/\/[^\s]+/gi;

function authorName(p: ProfileMetadata | null | undefined, pubkey: string) {
  return p?.display_name?.trim() || p?.name?.trim() || `${pubkey.slice(0, 8)}…`;
}

function shortNpub(bech: string) {
  return bech.length > 16 ? `${bech.slice(0, 10)}…${bech.slice(-4)}` : bech;
}

// Parse a kind:9735 zap receipt (a boost from Fountain / zap.stream / any NIP-57
// client). The zapper, amount, and comment live in the embedded zap request
// (the `description` tag), not on the receipt itself.
function zapInfo(e: Event): { pubkey: string; sats: number; comment: string } | null {
  const desc = e.tags.find((t) => t[0] === 'description')?.[1];
  if (!desc) return null;
  try {
    const req = JSON.parse(desc) as { pubkey?: unknown; content?: unknown; tags?: string[][] };
    if (typeof req.pubkey !== 'string') return null;
    const amount = req.tags?.find((t) => t[0] === 'amount')?.[1];
    const msat = amount ? parseInt(amount, 10) : NaN;
    return {
      pubkey: req.pubkey,
      sats: Number.isFinite(msat) ? Math.floor(msat / 1000) : 0,
      comment: typeof req.content === 'string' ? req.content : '',
    };
  } catch {
    return null;
  }
}

// The display author of a chat item — the zapper for a zap receipt, else the
// event author. Used for profile resolution and mute filtering.
function itemAuthor(e: Event): string {
  return e.kind === 9735 ? zapInfo(e)?.pubkey ?? e.pubkey : e.pubkey;
}

// Pubkeys mentioned in a message body (so we can resolve their names too).
function mentionedPubkeys(content: string): string[] {
  const out: string[] = [];
  for (const tok of content.match(MENTION_RE) ?? []) {
    try {
      const d = nip19.decode(tok.slice(6));
      if (d.type === 'npub') out.push(d.data);
      else if (d.type === 'nprofile') out.push(d.data.pubkey);
    } catch { /* ignore malformed */ }
  }
  return out;
}

// Render chat content: npub/nprofile mentions → @name (resolved from `profiles`,
// falling back to a short npub), http links → anchors, other nostr: refs dropped.
function renderContent(content: string, profiles: Profiles): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;
  let i = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(content)) !== null) {
    if (m.index > cursor) parts.push(content.slice(cursor, m.index));
    const tok = m[0];
    if (tok.startsWith('nostr:')) {
      const bech = tok.slice(6);
      let pubkey: string | null = null;
      try {
        const d = nip19.decode(bech);
        if (d.type === 'npub') pubkey = d.data;
        else if (d.type === 'nprofile') pubkey = d.data.pubkey;
      } catch { /* leave as text below */ }
      if (pubkey) {
        const p = profiles[pubkey];
        const name = p?.display_name?.trim() || p?.name?.trim() || shortNpub(bech);
        parts.push(<span key={`m-${i}`} className="text-bolt">@{name}</span>);
      }
      // non-profile nostr refs (nevent/note/naddr) are dropped
    } else {
      const { token, trailing } = splitTrailingPunct(tok);
      parts.push(
        <a key={`l-${i}`} href={token} target="_blank" rel="noopener noreferrer" className="text-nostr break-all hover:underline underline-offset-2">{token}</a>,
      );
      if (trailing) parts.push(<Fragment key={`t-${i}`}>{trailing}</Fragment>);
    }
    cursor = m.index + tok.length;
    i++;
  }
  if (cursor < content.length) parts.push(content.slice(cursor));
  return parts;
}

// One chat row: avatar + name + timestamp + content. `badge` (a zap amount
// stamp) also tints the row, so the same row renders both messages and boosts.
function ChatRow({
  pubkey,
  profile,
  timestamp,
  content,
  badge,
}: {
  pubkey: string;
  profile?: ProfileMetadata | null;
  timestamp: number;
  content: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <div className={`flex gap-2 text-sm ${badge ? 'bg-bolt/5 rounded -mx-1 px-1 py-0.5' : ''}`}>
      <Avatar
        pubkey={pubkey}
        picture={profile?.picture}
        name={profile?.name}
        className="w-6 h-6 rounded-full flex-shrink-0 mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <span className="text-xs font-display text-bolt mr-1.5">{authorName(profile, pubkey)}</span>
        {badge}
        <span className="text-[10px] text-muted font-mono mr-1.5" title={new Date(timestamp * 1000).toLocaleString()}>
          {fmtClock(timestamp)}
        </span>
        {content}
      </div>
    </div>
  );
}

// Append a chat message to the list, de-duped by id, sorted oldest-first, capped.
function mergeMessage(prev: Event[], e: Event): Event[] {
  if (prev.some((m) => m.id === e.id)) return prev;
  const next = [...prev, e].sort((a, b) => a.created_at - b.created_at);
  return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
}

export function LiveChat({ streamId }: { streamId: string }) {
  const identity = useApp((s) => s.identity);
  const mutedPubkeys = useApp((s) => s.mutedPubkeys);
  const setSignInOpen = useApp((s) => s.setSignInOpen);

  const [messages, setMessages] = useState<Event[]>([]);
  const [profiles, setProfiles] = useState<Profiles>({});
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const attempted = useRef<Set<string>>(new Set());

  // Subscribe to live chat for this stream. New streamId → fresh subscription
  // and a cleared message list.
  useEffect(() => {
    setMessages([]);
    attempted.current = new Set();
    const unsub = subscribeLiveChat(streamId, (e) => {
      setMessages((prev) => mergeMessage(prev, e));
    });
    return unsub;
  }, [streamId]);

  // Resolve profiles for message authors AND @-mentioned npubs (name + avatar).
  // Seed from cache synchronously, fetch the rest once each. fetchProfile writes
  // through storage.profile.
  useEffect(() => {
    const seed: Profiles = {};
    const toFetch: string[] = [];
    const consider = (pk: string) => {
      if (!pk || pk in profiles || pk in seed || attempted.current.has(pk)) return;
      const cached = storage.profile.get(pk);
      if (cached !== undefined) seed[pk] = cached;
      else toFetch.push(pk);
    };
    for (const m of messages) {
      if (m.kind === 9735) {
        const z = zapInfo(m);
        if (z) { consider(z.pubkey); for (const pk of mentionedPubkeys(z.comment)) consider(pk); }
      } else {
        consider(m.pubkey);
        for (const pk of mentionedPubkeys(m.content)) consider(pk);
      }
    }
    if (Object.keys(seed).length) setProfiles((p) => ({ ...p, ...seed }));
    toFetch.forEach((pk) => {
      attempted.current.add(pk);
      // Query the broad live-stream relay set: chat participants' profiles
      // (and their lud16) often live on zap.stream/nostr.wine, not a viewer's
      // default relays — same reason BOOST/names fail to resolve otherwise.
      fetchProfile(pk, LIVE_STREAM_RELAYS).then((p) => setProfiles((prev) => ({ ...prev, [pk]: p })));
    });
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll to the newest message, but only if the user was already at the
  // bottom (don't yank them away while they scroll back through history).
  useEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  async function send() {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setErr(null);
    setDraft(''); // clear immediately — the publish round-trip can take a beat
    nearBottomRef.current = true;
    try {
      const { event } = await publishLiveChat(streamId, content);
      setMessages((prev) => mergeMessage(prev, event));
    } catch (e) {
      setErr(getErrorMessage(e, 'failed to send'));
      // Restore the text so it isn't lost — but not over a new draft they've
      // already started typing.
      setDraft((d) => d || content);
    } finally {
      setSending(false);
    }
  }

  const visible = messages.filter((m) => !mutedPubkeys.has(itemAuthor(m)));

  // Total sats zapped to this stream — sum of every kind:9735 receipt (not the
  // mute-filtered list; muting an author doesn't un-raise the stream's sats).
  const totalSats = messages.reduce(
    (n, m) => (m.kind === 9735 ? n + (zapInfo(m)?.sats ?? 0) : n),
    0,
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {totalSats > 0 && (
        <div className="font-display text-bolt text-sm flex-shrink-0 mb-1">
          ⚡ {totalSats.toLocaleString()} sats
        </div>
      )}
      <p className="text-[11px] uppercase tracking-widest text-muted mb-2 flex-shrink-0">
        Live chat {visible.length > 0 && <span className="text-bone/60">· {visible.length}</span>}
      </p>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-1"
      >
        {visible.length === 0 ? (
          <p className="text-xs text-muted">No messages yet.</p>
        ) : (
          visible.map((m) => {
            // Zap receipt (boost) — same row with a bolt amount badge.
            if (m.kind === 9735) {
              const z = zapInfo(m);
              if (!z) return null;
              return (
                <ChatRow
                  key={m.id}
                  pubkey={z.pubkey}
                  profile={profiles[z.pubkey]}
                  timestamp={m.created_at}
                  badge={
                    <span className="stamp text-bolt border-bolt/60 bg-bolt/10 text-[10px] px-1 py-0 mr-1.5">
                      ⚡ {z.sats.toLocaleString()} sats
                    </span>
                  }
                  content={
                    z.comment ? (
                      <span className="text-bone/90 break-words whitespace-pre-wrap">{renderContent(z.comment, profiles)}</span>
                    ) : null
                  }
                />
              );
            }
            return (
              <ChatRow
                key={m.id}
                pubkey={m.pubkey}
                profile={profiles[m.pubkey]}
                timestamp={m.created_at}
                content={
                  <span className="text-bone/90 break-words whitespace-pre-wrap">{renderContent(m.content, profiles)}</span>
                }
              />
            );
          })
        )}
      </div>

      <div className="flex-shrink-0 pt-3 mt-2 border-t border-bone/10">
        {identity ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-2">
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="Send a message…"
                maxLength={500}
                className="input flex-1 text-sm py-1.5"
              />
              <button
                type="button"
                onClick={send}
                disabled={sending || !draft.trim()}
                className="btn-bolt text-xs disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {sending ? '…' : 'Send'}
              </button>
            </div>
            {err && <p className="text-[11px] text-nostr">⚠ {err}</p>}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setSignInOpen(true)}
            className="text-xs text-muted hover:text-bone text-left"
          >
            <span className="text-nostr">◆</span> Sign in with Nostr to join the chat.
          </button>
        )}
      </div>
    </div>
  );
}
