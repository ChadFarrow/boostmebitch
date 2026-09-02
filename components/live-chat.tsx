'use client';
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Event } from 'nostr-tools';
import { subscribeLiveChat, publishLiveChat, LIVE_STREAM_RELAYS } from '@/lib/nostr';
import { fetchProfilesFor } from '@/lib/nostr';
import { parseZapReceipt, zapSats } from '@/lib/nostr/zap-receipt';
import type { ProfileMetadata } from '@/lib/nostr/auth';
import { storage } from '@/lib/storage';
import { useApp } from '@/lib/store';
import { getErrorMessage } from '@/lib/util';
import { fmtClock, mentionedPubkeys, renderNostrText } from '@/lib/format';
import { Avatar } from './avatar';

const MAX_MESSAGES = 200;

type Profiles = Record<string, ProfileMetadata | null>;


function authorName(p: ProfileMetadata | null | undefined, pubkey: string) {
  return p?.display_name?.trim() || p?.name?.trim() || `${pubkey.slice(0, 8)}…`;
}

// The display author of a chat item — the zapper for a zap receipt, else the
// event author. Used for profile resolution and mute filtering.
//
// `parseZapReceipt` (lib/nostr/zap-receipt.ts) replaced a private `zapInfo`
// that lived here: the boost explorer needs the same parse, and a second copy
// is how one surface comes to name a different sender for the same zap.
function itemAuthor(e: Event): string {
  return e.kind === 9735 ? parseZapReceipt(e)?.zapper ?? e.pubkey : e.pubkey;
}

// One chat row: avatar + name + timestamp + content. `badge` (a zap amount
// stamp) also tints the row, so the same row renders both messages and boosts.
//
// memo()'d: <LiveChat> re-renders on every keystroke in its composer, and
// without this every visible row reconciled with it — each one re-running
// renderNostrText(), which is a global regex scan plus an nip19.decode() per
// mention. `content` and `badge` are elements built fresh by the parent each
// render, so this only skips rows whose props are otherwise unchanged when the
// parent memoizes those too; the win that matters is the common case where the
// message list itself hasn't moved.
const ChatRow = memo(function ChatRow({
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
});

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
        const z = parseZapReceipt(m);
        if (z) { consider(z.zapper); for (const pk of mentionedPubkeys(z.comment)) consider(pk); }
      } else {
        consider(m.pubkey);
        for (const pk of mentionedPubkeys(m.content)) consider(pk);
      }
    }
    if (Object.keys(seed).length) setProfiles((p) => ({ ...p, ...seed }));
    if (!toFetch.length) return;
    for (const pk of toFetch) attempted.current.add(pk);
    // ONE query for everyone this pass learned about, not one per author.
    // `fetchProfile` opens a subscription per relay, and a busy chat introduces
    // people in bursts — a room of thirty participants was thirty lookups
    // across six relays, which relays cap and silently drop, so the names that
    // lost the race never arrived at all. The broad live-stream relay set is
    // still what it asks: chat participants' profiles (and their lud16) often
    // live on zap.stream/nostr.wine rather than a viewer's default relays.
    fetchProfilesFor(toFetch, LIVE_STREAM_RELAYS).then((found) => {
      setProfiles((prev) => {
        const next = { ...prev };
        // `null`, not absent, for the ones nobody held — `consider` above skips
        // a pubkey already in `profiles`, and leaving it out would make every
        // later message re-offer an author this pass already answered for.
        for (const pk of toFetch) next[pk] = found.get(pk) ?? null;
        return next;
      });
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

  // Both memoized on `messages`, because they used to be recomputed in the
  // render body and this component re-renders on EVERY KEYSTROKE in the
  // composer below (setDraft). `parseZapReceipt` runs JSON.parse over a zap request
  // blob, so an untouched typing pass was re-parsing up to MAX_MESSAGES of
  // them, per character, to arrive at the number it already had.
  const visible = useMemo(
    () => messages.filter((m) => !mutedPubkeys.has(itemAuthor(m))),
    [messages, mutedPubkeys],
  );

  // Total sats zapped to this stream — sum of every kind:9735 receipt (not the
  // mute-filtered list; muting an author doesn't un-raise the stream's sats).
  const totalSats = useMemo(
    () => messages.reduce((n, m) => {
      if (m.kind !== 9735) return n;
      const z = parseZapReceipt(m);
      return z ? n + zapSats(z) : n;
    }, 0),
    [messages],
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
        // `overscroll-contain`: on mobile the live layout makes the overlay's
        // own row `overflow-hidden`, so this list is the outermost scroller in
        // the player and a swipe past its end would chain straight to the
        // document — which on iOS drags the fixed overlay off the screen.
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-3 pr-1"
      >
        {visible.length === 0 ? (
          <p className="text-xs text-muted">No messages yet.</p>
        ) : (
          visible.map((m) => {
            // Zap receipt (boost) — same row with a bolt amount badge.
            if (m.kind === 9735) {
              const z = parseZapReceipt(m);
              if (!z) return null;
              return (
                <ChatRow
                  key={m.id}
                  pubkey={z.zapper}
                  profile={profiles[z.zapper]}
                  timestamp={m.created_at}
                  badge={
                    <span className="stamp text-bolt border-bolt/60 bg-bolt/10 text-[10px] px-1 py-0 mr-1.5">
                      ⚡ {zapSats(z).toLocaleString()} sats
                    </span>
                  }
                  content={
                    z.comment ? (
                      <span className="text-bone/90 break-words whitespace-pre-wrap">{renderNostrText(z.comment, profiles)}</span>
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
                  <span className="text-bone/90 break-words whitespace-pre-wrap">{renderNostrText(m.content, profiles)}</span>
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
