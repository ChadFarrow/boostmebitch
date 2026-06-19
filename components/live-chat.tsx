'use client';
import { useEffect, useRef, useState } from 'react';
import type { Event } from 'nostr-tools';
import { subscribeLiveChat, publishLiveChat } from '@/lib/nostr';
import { fetchProfile } from '@/lib/nostr';
import type { ProfileMetadata } from '@/lib/nostr/auth';
import { storage } from '@/lib/storage';
import { useApp } from '@/lib/store';
import { getErrorMessage } from '@/lib/util';

const MAX_MESSAGES = 200;

function authorName(p: ProfileMetadata | null | undefined, pubkey: string) {
  return p?.display_name?.trim() || p?.name?.trim() || `${pubkey.slice(0, 8)}…`;
}

function fmtChatTime(unixSec: number) {
  return new Date(unixSec * 1000).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function LiveChat({ streamId }: { streamId: string }) {
  const identity = useApp((s) => s.identity);
  const mutedPubkeys = useApp((s) => s.mutedPubkeys);
  const setSignInOpen = useApp((s) => s.setSignInOpen);

  const [messages, setMessages] = useState<Event[]>([]);
  const [profiles, setProfiles] = useState<Record<string, ProfileMetadata | null>>({});
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
      setMessages((prev) => {
        if (prev.some((m) => m.id === e.id)) return prev;
        const next = [...prev, e].sort((a, b) => a.created_at - b.created_at);
        return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
      });
    });
    return unsub;
  }, [streamId]);

  // Resolve author profiles (name + avatar). Seed from cache synchronously,
  // fetch the rest once each. fetchProfile writes through storage.profile.
  useEffect(() => {
    const seed: Record<string, ProfileMetadata | null> = {};
    const toFetch: string[] = [];
    for (const m of messages) {
      if (m.pubkey in profiles || attempted.current.has(m.pubkey)) continue;
      const cached = storage.profile.get(m.pubkey);
      if (cached !== undefined) seed[m.pubkey] = cached;
      else toFetch.push(m.pubkey);
    }
    if (Object.keys(seed).length) setProfiles((p) => ({ ...p, ...seed }));
    toFetch.forEach((pk) => {
      attempted.current.add(pk);
      fetchProfile(pk).then((p) => setProfiles((prev) => ({ ...prev, [pk]: p })));
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
      setMessages((prev) =>
        prev.some((m) => m.id === event.id)
          ? prev
          : [...prev, event].sort((a, b) => a.created_at - b.created_at),
      );
    } catch (e) {
      setErr(getErrorMessage(e, 'failed to send'));
      // Restore the text so it isn't lost — but not over a new draft they've
      // already started typing.
      setDraft((d) => d || content);
    } finally {
      setSending(false);
    }
  }

  const visible = messages.filter((m) => !mutedPubkeys.has(m.pubkey));

  return (
    <div className="flex flex-col h-full min-h-0">
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
            const p = profiles[m.pubkey];
            return (
              <div key={m.id} className="flex gap-2 text-sm">
                {p?.picture ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.picture}
                    alt=""
                    className="w-6 h-6 rounded-full object-cover flex-shrink-0 mt-0.5 bg-bone/10"
                  />
                ) : (
                  <div className="w-6 h-6 rounded-full flex-shrink-0 mt-0.5 bg-bone/10" />
                )}
                <div className="min-w-0 flex-1">
                  <span className="text-xs font-display text-bolt mr-1.5">
                    {authorName(p, m.pubkey)}
                  </span>
                  <span className="text-[10px] text-muted font-mono mr-1.5" title={new Date(m.created_at * 1000).toLocaleString()}>
                    {fmtChatTime(m.created_at)}
                  </span>
                  <span className="text-bone/90 break-words whitespace-pre-wrap">{m.content}</span>
                </div>
              </div>
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
