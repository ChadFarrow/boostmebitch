'use client';

/**
 * The IRC chat beside an opted-in RSS live stream (docs/irc.md).
 *
 * The listener types a nick and talks in the show's ZeroNode channel through
 * Chad's gateway. It looks like `<LiveChat>` on purpose (Chad, 2026-11-21: "I
 * just want to do it similar to how the Nostr chat is"): the same label row,
 * list, row shape and composer.
 *
 * NOTHING IS KEPT. The rows live in this component's state and go when it
 * unmounts or the tab closes; only the nick is stored (`storage.ircNick`), so
 * the box is filled next time. IRC has no history either: a listener sees what
 * is said after they join, and the panel says so.
 *
 * ONE CONNECTION, AND IT IS NEVER REOPENED BY ITSELF. Each connection is a slot
 * in ZeroNode's limit of 3 per address at the gateway, so a drop shows JOIN
 * again and waits for a press (`lib/irc/client.ts`).
 *
 * No report, no hide, no word filter (Chad: "all of these chats have
 * moderators in them that can kick people. So it's up to the podcaster").
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { openIrcSession, IRC_GATEWAY_URL, type IrcSession } from '@/lib/irc/client';
import { isValidNick, MAX_NICK_LENGTH, MIN_NICK_LENGTH, type IrcEvent } from '@/lib/irc/protocol';
import { looksLikeSecretKey, textHoldsSecret } from '@/lib/nostr/npub-input';
import { storage } from '@/lib/storage';
import { useApp } from '@/lib/store';
import { fmtClock } from '@/lib/format';
import { LinkedText } from './linked-text';

/** The rows kept on screen; older ones are dropped. */
const MAX_ROWS = 200;
/** The composer's limit, as `<LiveChat>`'s. Longer text is cut into several lines anyway. */
const CHAT_MAX = 500;

const PRIVACY = 'IRC is public: the channel can keep a log of what you write, and ZeroNode sees your IP address.';
const SECRET = 'That looks like a Nostr secret key (nsec). It was not sent.';
const WALLET = 'That looks like a wallet connection string. It was not sent.';
const BAD_NICK = `Use ${MIN_NICK_LENGTH} to ${MAX_NICK_LENGTH} letters, digits, _ or -, and start with a letter.`;
const NICK_TAKEN = 'That nick is taken. Try another.';

type Phase = 'idle' | 'connecting' | 'joined' | 'kicked' | 'closed';

interface Row {
  id: number;
  /** `notice` is the panel's own line (joined, kicked); it has no nick. */
  kind: 'message' | 'notice';
  from?: string;
  text: string;
  action?: boolean;
  self?: boolean;
  time: number;
}

/** The refusal for text that must not leave the device, or null when it may. */
function secretRefusal(text: string): string | null {
  if (/nostr\+walletconnect:/i.test(text)) return WALLET;
  return textHoldsSecret(text) || looksLikeSecretKey(text) ? SECRET : null;
}

export function IrcChat({ channel, onJoined }: { channel: string; onJoined?: () => void }) {
  const npub = useApp((s) => s.identity?.npub);
  const [phase, setPhase] = useState<Phase>('idle');
  const [nickTaken, setNickTaken] = useState(false);
  const [nickDraft, setNickDraft] = useState('');
  const [draft, setDraft] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState<string | null>(null);
  /** The hold service holds the session while its socket is away (docs/irc.md). */
  const [away, setAway] = useState(false);

  const sessionRef = useRef<IrcSession | null>(null);
  const nextId = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const onJoinedRef = useRef(onJoined);
  onJoinedRef.current = onJoined;
  const npubRef = useRef(npub);
  npubRef.current = npub;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // The stored nick, read after mount: storage is not there on the server.
  useEffect(() => {
    setNickDraft((d) => d || storage.ircNick.get(npub) || '');
  }, [npub]);

  const addRows = useCallback((add: Omit<Row, 'id'>[]) => {
    if (!add.length) return;
    setRows((prev) => {
      const next = [...prev, ...add.map((r) => ({ ...r, id: nextId.current++ }))];
      return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next;
    });
  }, []);
  const notice = useCallback(
    (text: string) => addRows([{ kind: 'notice', text, time: Math.floor(Date.now() / 1000) }]),
    [addRows],
  );

  const quit = useCallback(() => {
    const s = sessionRef.current;
    sessionRef.current = null;
    s?.quit();
  }, []);

  const onEvent = useCallback((e: IrcEvent) => {
    switch (e.type) {
      case 'joined':
        setPhase('joined');
        setNickTaken(false);
        setErr(null);
        setNickDraft(e.nick);
        storage.ircNick.set(npubRef.current, e.nick);
        notice(`You joined ${e.channel}. IRC keeps no history, so messages show from here on.`);
        onJoinedRef.current?.();
        break;
      case 'message':
        addRows([{ kind: 'message', from: e.from, text: e.text, action: e.action, self: e.self, time: e.time }]);
        break;
      case 'nickInUse':
        setNickTaken(true);
        setErr(NICK_TAKEN);
        break;
      case 'nickChanged':
        // Only a nick the listener asked for is theirs to keep. Services
        // rename a guest on a registered nick (`Guest4821`); storing that would
        // fill the box with it next time, so say what happened instead.
        if (e.requested) {
          setNickDraft(e.to);
          storage.ircNick.set(npubRef.current, e.to);
        } else {
          notice(`The network changed your nick to ${e.to}. The nick you chose may be registered to someone.`);
        }
        break;
      case 'kicked':
        setPhase('kicked');
        notice(`${e.by} removed you from ${channel}${e.reason ? `: ${e.reason}` : '.'}`);
        break;
      case 'error':
        setErr(e.text);
        // A refused JOIN (banned, invite only…), first or after a kick, leaves
        // nothing to do on this connection, so free its slot and offer JOIN
        // again. (JOIN AGAIN sets 'connecting' too.)
        if (phaseRef.current === 'connecting') {
          quit();
          setPhase('closed');
          setNickTaken(false);
        }
        break;
    }
  }, [addRows, notice, channel, quit]);

  // Leave the channel when the panel goes (another show, the show ended and
  // was never joined) and when the tab closes. A page kept in the back/forward
  // cache (`persisted`) is not leaving.
  useEffect(() => {
    const onHide = (ev: PageTransitionEvent) => { if (!ev.persisted) quit(); };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      quit();
    };
  }, [quit]);

  function join() {
    const nick = nickDraft.trim();
    const refusal = secretRefusal(nick);
    if (refusal) { setErr(refusal); return; }
    if (!isValidNick(nick)) { setErr(BAD_NICK); return; }
    setErr(null);
    if (sessionRef.current && nickTaken) {
      sessionRef.current.nick(nick);
      return;
    }
    quit();
    setPhase('connecting');
    setNickTaken(false);
    const session = openIrcSession({
      url: IRC_GATEWAY_URL,
      nick,
      channel,
      onEvent,
      onLink: (l) => {
        if (sessionRef.current !== session) return;
        setAway(l.kind === 'lost');
        if (l.kind === 'back') {
          notice(l.missed > 0
            ? `Reconnected. ${l.missed} line${l.missed === 1 ? '' : 's'} from while you were away could not be kept.`
            : 'Reconnected; nothing was missed.');
        }
      },
      onClose: (reason) => {
        if (sessionRef.current !== session) return;
        sessionRef.current = null;
        setAway(false);
        setPhase('closed');
        setNickTaken(false);
        // A reason that is already a sentence is shown as it is.
        setErr((prev) => prev ?? (/[.]$/.test(reason) ? reason : `Disconnected (${reason}).`));
      },
    });
    sessionRef.current = session;
  }

  function send() {
    const text = draft;
    if (!text.trim() || !sessionRef.current || away) return;
    const refusal = secretRefusal(text);
    if (refusal) { setErr(refusal); return; }
    setErr(null);
    nearBottomRef.current = true;
    sessionRef.current.send(text);
    setDraft('');
  }

  // Follow new rows only when the listener is already at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [rows]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const askNick = phase === 'idle' || phase === 'closed' || (phase === 'connecting' && nickTaken);

  return (
    // A frame from sm: up, so the panel reads as a chat window beside the cover
    // (Chad, 2026-11-21); none on a phone, where it is the screen's lower half,
    // as <LiveChat> is.
    <div className="flex flex-col h-full min-h-0 sm:border sm:border-bone/10 sm:rounded sm:p-3" data-irc-chat data-irc-phase={phase}>
      <p className="text-[11px] uppercase tracking-widest text-muted mb-2 flex-shrink-0">
        IRC chat · <span className="normal-case tracking-normal text-bone/60">{channel}</span>
      </p>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-irc-list
        // `overscroll-contain` for `<LiveChat>`'s reason: below sm: the
        // player's row is `overflow-hidden`, so this is the outermost scroller.
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-3 pr-1"
      >
        {rows.length === 0 && (
          // IRC keeps no history, so before JOIN there is nothing to show; say
          // what this is instead of an empty box.
          <div data-irc-empty className="h-full flex items-center justify-center text-center px-4">
            <p className="text-xs text-muted max-w-xs">
              Live chat in {channel} on ZeroNode. Pick a nick below to join; messages show from the moment you join.
            </p>
          </div>
        )}
        {rows.map((r) =>
          r.kind === 'notice' ? (
            <p key={r.id} data-irc-row className="text-xs text-muted">{r.text}</p>
          ) : (
            <div key={r.id} data-irc-row className="text-sm min-w-0">
              {r.action ? (
                <span className="text-bone/90 break-words whitespace-pre-wrap italic">
                  <span className="text-[10px] text-muted font-mono mr-1.5" title={new Date(r.time * 1000).toLocaleString()}>
                    {fmtClock(r.time)}
                  </span>
                  * <span className="font-display text-bolt not-italic">{r.from}</span> <LinkedText text={r.text} />
                </span>
              ) : (
                <>
                  <span className={`text-xs font-display mr-1.5 ${r.self ? 'text-bone' : 'text-bolt'}`}>{r.from}</span>
                  <span className="text-[10px] text-muted font-mono mr-1.5" title={new Date(r.time * 1000).toLocaleString()}>
                    {fmtClock(r.time)}
                  </span>
                  <span className="text-bone/90 break-words whitespace-pre-wrap"><LinkedText text={r.text} /></span>
                </>
              )}
            </div>
          ),
        )}
      </div>

      <div className="flex-shrink-0 pt-3 mt-2 border-t border-bone/10 flex flex-col gap-1.5">
        {askNick ? (
          <>
          <form
            className="flex gap-2 items-center"
            onSubmit={(e) => { e.preventDefault(); join(); }}
          >
            <label className="sr-only" htmlFor="irc-nick">Your nick</label>
            <input
              id="irc-nick"
              data-irc-nick
              className="input flex-1 min-w-0"
              value={nickDraft}
              onChange={(e) => setNickDraft(e.target.value)}
              placeholder="Your nick"
              maxLength={MAX_NICK_LENGTH}
              autoComplete="nickname"
              autoCapitalize="off"
              spellCheck={false}
            />
            <button type="submit" data-irc-join className="btn-bolt text-xs">
              {nickTaken ? 'TRY' : 'JOIN'}
            </button>
          </form>
          {/* Under the nick box, where it is read before JOIN (spec); in the
              list it scrolled away as soon as rows came. */}
          <p data-irc-privacy className="text-[11px] text-muted">{PRIVACY}</p>
          </>
        ) : phase === 'connecting' ? (
          <p className="text-xs text-muted">Joining {channel}…</p>
        ) : phase === 'kicked' ? (
          <button
            type="button"
            data-irc-rejoin
            onClick={() => { setErr(null); setPhase('connecting'); sessionRef.current?.rejoin(); }}
            className="btn-mini self-start"
          >
            JOIN {channel} AGAIN
          </button>
        ) : (
          <>
          {away && (
            <p data-irc-away role="status" className="text-[11px] text-bolt">
              Connection lost. Reconnecting…
            </p>
          )}
          <div className="flex gap-2 items-end">
            <label className="sr-only" htmlFor="irc-input">Send a message</label>
            <textarea
              id="irc-input"
              data-irc-input
              className="input flex-1 min-w-0 resize-none"
              rows={1}
              value={draft}
              disabled={away}
              maxLength={CHAT_MAX}
              placeholder="Send a message…"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button
              type="button"
              data-irc-send
              onClick={send}
              disabled={away || !draft.trim()}
              className="btn-bolt text-xs disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Send
            </button>
          </div>
          </>
        )}
        {err && <p className="text-[11px] text-nostr" role="alert">⚠ {err}</p>}
      </div>
    </div>
  );
}
