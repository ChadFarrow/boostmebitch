'use client';

/**
 * The IRC chat beside an opted-in RSS live stream (docs/irc.md).
 *
 * The listener types a nick and talks in the show's ZeroNode channel through
 * Chad's gateway. It looks like `<LiveChat>` on purpose (Chad, 2026-11-21: "I
 * just want to do it similar to how the Nostr chat is"): the same label row,
 * list, row shape and composer.
 *
 * LITTLE IS KEPT. The nick is stored (`storage.ircNick`), so the box is filled
 * next time. The rows live in this component and, for a refresh, in this tab
 * only (`storage.ircHold`, with the hold token): a refresh is a drop (Chad,
 * 2026-11-22), so the next page resumes the held session and shows the rows
 * again. IRC has no history: a listener sees what is said after they join.
 *
 * ONE IRC CONNECTION, NEVER REGISTERED TWICE BY ITSELF. Each is a slot in
 * ZeroNode's limit of 3 per address at the gateway. A drop or a refresh
 * reopens only the SOCKET, to the session the hold service holds
 * (`lib/irc/client.ts`); without a hold service a drop shows JOIN again.
 *
 * No report, no hide, no word filter (Chad: "all of these chats have
 * moderators in them that can kick people. So it's up to the podcaster").
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { openIrcSession, IRC_GATEWAY_URL, type IrcHold, type IrcSession } from '@/lib/irc/client';
import { isValidNick, nickColor, MAX_NICK_LENGTH, MIN_NICK_LENGTH, type IrcEvent, type IrcSavedRow } from '@/lib/irc/protocol';
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

// Written out whole so Tailwind finds each class; index = `nickColor(nick)`.
const NICK_CLASSES = [
  'text-nick-0', 'text-nick-1', 'text-nick-2', 'text-nick-3', 'text-nick-4',
  'text-nick-5', 'text-nick-6', 'text-nick-7', 'text-nick-8', 'text-nick-9',
];
/** One color per person; your own name stays in the text color, so you find it. */
const nameColor = (from: string | undefined, self: boolean | undefined) => (self ? 'text-bone' : NICK_CLASSES[nickColor(from ?? '')]);
const NICK_TAKEN = 'That nick is taken. Try another.';

type Phase = 'idle' | 'connecting' | 'joined' | 'kicked' | 'closed';

/** `notice` is the panel's own line (joined, kicked); it has no nick. */
interface Row extends IrcSavedRow {
  id: number;
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
  /** The hold service holds the session while its socket is away (docs/irc.md): after a drop, or after a refresh. */
  const [away, setAway] = useState<null | 'lost' | 'refresh'>(null);

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
  /** The rows as of the last IRC line: set at once, so a save matches the client's `seq`. */
  const rowsRef = useRef<Row[]>([]);
  /** The nick the session joined with (or was renamed to). */
  const nickRef = useRef('');

  // The stored nick, read after mount: storage is not there on the server.
  useEffect(() => {
    setNickDraft((d) => d || storage.ircNick.get(npub) || '');
  }, [npub]);

  const addRows = useCallback((add: Omit<Row, 'id'>[]) => {
    if (!add.length) return;
    const next = [...rowsRef.current, ...add.map((r) => ({ ...r, id: nextId.current++ }))];
    rowsRef.current = next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next;
    setRows(rowsRef.current);
  }, []);
  const notice = useCallback(
    (text: string) => addRows([{ kind: 'notice', text, time: Math.floor(Date.now() / 1000) }]),
    [addRows],
  );

  // Leaving on purpose ends the held session too, so its saved copy goes. A
  // session still being resumed is not dropped from storage: React's
  // development double mount quits it at once, and the second mount resumes.
  const quit = useCallback(() => {
    const s = sessionRef.current;
    sessionRef.current = null;
    if (s?.hold()) storage.ircHold.clear();
    s?.quit();
  }, []);

  /** Save the held session for a refresh in this tab; nothing without a hold service. */
  const save = useCallback(() => {
    const h = sessionRef.current?.hold();
    const p = phaseRef.current;
    if (!h || (p !== 'joined' && p !== 'kicked')) return;
    storage.ircHold.set({
      channel, nick: nickRef.current, token: h.token, holdS: h.holdS, seq: h.seq, at: Date.now(), phase: p,
      rows: rowsRef.current.map(({ id: _id, ...r }) => r),
    });
  }, [channel]);

  const onEvent = useCallback((e: IrcEvent) => {
    switch (e.type) {
      case 'joined':
        setPhase('joined');
        setNickTaken(false);
        setErr(null);
        setNickDraft(e.nick);
        nickRef.current = e.nick;
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
        nickRef.current = e.to;
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
  // was never joined). When the PAGE goes, a held session is saved and kept,
  // not quit: the page cannot tell a refresh from a closed tab, and a refresh
  // is a drop (Chad, 2026-11-22). A closed tab's session ends when the hold
  // runs out. Without a hold service the page quits, as before. A page kept in
  // the back/forward cache (`persisted`) is not leaving. A hidden tab saves
  // too: a phone may discard it, and its reload is a refresh.
  useEffect(() => {
    const onHide = (ev: PageTransitionEvent) => {
      save();
      if (!ev.persisted && !sessionRef.current?.hold()) quit();
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') save(); };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      quit();
    };
  }, [quit, save]);

  const open = useCallback((nick: string, resume?: IrcHold) => {
    const session = openIrcSession({
      url: IRC_GATEWAY_URL,
      nick,
      channel,
      onEvent,
      resume,
      onLink: (l) => {
        if (sessionRef.current !== session) return;
        setAway(l.kind === 'lost' ? 'lost' : null);
        if (l.kind === 'back') {
          notice(l.missed > 0
            ? `Reconnected. ${l.missed} line${l.missed === 1 ? '' : 's'} from while you were away could not be kept.`
            : 'Reconnected; nothing was missed.');
        }
      },
      onClose: (reason) => {
        if (sessionRef.current !== session) return;
        sessionRef.current = null;
        storage.ircHold.clear();
        setAway(null);
        setPhase('closed');
        setNickTaken(false);
        // A reason that is already a sentence is shown as it is.
        setErr((prev) => prev ?? (/[.]$/.test(reason) ? reason : `Disconnected (${reason}).`));
      },
    });
    sessionRef.current = session;
  }, [channel, onEvent, notice]);

  // A refresh: this tab saved a held session for this channel, so show its
  // rows and resume it, with no JOIN (docs/irc.md, "A refresh is a drop").
  useEffect(() => {
    const saved = storage.ircHold.get();
    if (!saved || saved.channel.toLowerCase() !== channel.toLowerCase() || sessionRef.current) return;
    if (Date.now() > saved.at + saved.holdS * 1000) { storage.ircHold.clear(); return; }
    rowsRef.current = saved.rows.map((r, i) => ({ ...r, id: i }));
    nextId.current = rowsRef.current.length;
    setRows(rowsRef.current);
    nickRef.current = saved.nick;
    setNickDraft(saved.nick);
    setPhase(saved.phase);
    phaseRef.current = saved.phase;
    setAway('refresh');
    onJoinedRef.current?.();
    open(saved.nick, { token: saved.token, seq: saved.seq, holdS: saved.holdS });
  }, [channel, open]);

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
    storage.ircHold.clear();
    setPhase('connecting');
    setNickTaken(false);
    open(nick);
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
        // `overscroll-y-contain` for `<LiveChat>`'s reason: below sm: the
        // player's row is `overflow-hidden`, so this is the outermost scroller.
        // The VERTICAL axis only: on a phone the list sits in a page of
        // `<LiveChatPager>`, and a sideways flick that starts on the messages
        // must reach the pager. `overscroll-contain` set both axes, and
        // Chromium then ended the scroll chain here, so the flick did nothing.
        className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain space-y-3 pr-1"
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
                  * <span className={`font-display font-bold not-italic ${nameColor(r.from, false)}`}>{r.from}</span> <LinkedText text={r.text} />
                </span>
              ) : (
                <>
                  <span data-irc-from className={`text-sm font-display font-bold mr-1.5 ${nameColor(r.from, r.self)}`}>{r.from}</span>
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
              {away === 'refresh' ? 'Reconnecting to the chat…' : 'Connection lost. Reconnecting…'}
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
              disabled={!!away}
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
              disabled={!!away || !draft.trim()}
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
