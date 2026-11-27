# IRC chat beside an RSS live stream

Core rules live in [`../CLAUDE.md`](../CLAUDE.md); this file holds the reasoning.
The design is [`superpowers/specs/2026-11-21-irc-live-chat-design.md`](superpowers/specs/2026-11-21-irc-live-chat-design.md).

A listener on a live show from the opt-in list (`lib/irc/shows.ts`) types a nick
and talks in the show's ZeroNode channel, in a panel that looks like the Nostr
live chat. No account, and little kept: Chad's box holds a dropped connection
(5 minutes, or while the show is live, below), and this device keeps the held
session's token and last 200 rows until the hold ends.

## Why a gateway, and what it may never do

A browser cannot open raw IRC, and ZeroNode (InspIRCd 4) answered no WebSocket on
any port or host name on 2026-11-21. So the panel speaks IRC lines over a
WebSocket to `webircgateway`, which runs on Chad's box beside the public The
Lounge (repo **thelounge-candr**, not this one), and the gateway holds the TLS
connection to `irc.zeronode.net:6697`.

- **WEBIRC, always.** The gateway sends each visitor's own address to ZeroNode,
  as chat.candr.space does. Without it every listener shares the box's address:
  ZeroNode's limit of 3 connections per address applies to all of them together,
  and one ban locks everyone out. Each new connection still counts once against
  the box's IPv4 address at connect time, before WEBIRC moves it — the reason
  IPv4's third slot must stay free (thelounge-candr `docs/zeronode.md`).
- **ZeroNode only.** `[gateway] enabled = false`: the gateway is not an open
  proxy to any network a page names.
- **These origins only.** `[allowed_origins]` lists the two brands' sites and
  beta. An empty list allows every website, so it is never empty.
- **The switch is ours.** `NEXT_PUBLIC_IRC_GATEWAY_URL` unset or invalid means
  no chat anywhere (`ircGatewayOk`); every deploy ran that way until the gateway
  existed. A ZeroNode WebSocket would change only that address.

## Holding a dropped connection

Chad, 2026-11-21: a listener whose phone or wifi drops "for a minute or two"
comes back to the same session with nothing missed, and the channel does not see
them quit and join again ("you'll see someone's name just keep disconnecting and
reconnecting"). IRC cannot do that by itself: the connection IS the session. So
a **hold service** on Chad's box (repo **thelounge-candr**, `irc-hold`) stands
between Caddy and `webircgateway` at the same address, and keeps each
listener's IRC connection open after their browser drops. It is not a backlog:
a listener sees only what was said since they joined.

**Hold while live** (Chad, 2026-11-24, during MMO: "If you're listening live in
the app, you can do other things on your phone or just lock your phone without
being disconnected from the chat. The idea is to be able to come and go in the
chat while the show's live without missing anything." He approved the plan in
`agent-dispatcher/handoffs/irc-hold-live-plan.md`). The page says `HOLD LIVE`;
the service then holds the chat until **10 minutes after BMB stops showing the
show LIVE**, at most **6 hours** after the drop, and never less than the
`<seconds>` of the token (300 s, Chad's first choice). The service alone
decides whether the show is live: it asks `/api/live-status`, so it uses the
same LIVE badge the page shows. An irc-hold without it drops `HOLD LIVE` like
every other HOLD line and holds 300 s, so either side can deploy first.

**The wire contract.** One IRC line per text frame, both ways, as before. A line
that starts `HOLD ` belongs to the service: it never reaches ZeroNode, and the
page never hands it to the reducer. `seq` counts every other line the service
sent toward the page in this session, from 1.

| Direction | Line | When |
| --- | --- | --- |
| service → page | `HOLD TOKEN <token> <seconds>` | The first frame the service sends in a new session, as soon as the page's first frame shows it is not a resume, and before any IRC line. `<token>` is at least 128 random bits, base64url; `<seconds>` is the SHORTEST hold (300). |
| page → service | `HOLD LIVE` | Once after each `HOLD TOKEN`, on every show, never as a socket's first frame (the service reads a first HOLD frame as a resume). It means "this page tries to come back until `HOLD GONE`"; it does not say the show is live. Not sent again on a resume: the service keeps it with the session. |
| page → service | `HOLD RESUME <token> <seq>` | The first frame of a socket that resumes. `<seq>` is the last line the page received. |
| service → page | `HOLD RESUMED <nick> <channel> <missed>` | The session is held. Then every kept line after `<seq>`, in order, then live lines. `<channel>` is `*` when the nick is in none (kicked); `<missed>` counts the lines after `<seq>` the service no longer has. |
| service → page | `HOLD GONE :<reason>` | The token is unknown or expired, or the session's IRC connection ended. Then the service closes the socket. The page's only sign that a hold is over. |

**What the service does.**
- **It holds on every close of the browser socket except after a `QUIT`.** A
  `QUIT` from the page ends the session at once, as `send_quit_on_client_close`
  does today.
- **While held it answers `PING` with `PONG`** — the page is not there to — and
  keeps every other line. A hold past its first 5 minutes marks the nick
  `AWAY`; the page never sees the `305`/`306` replies.
- **It keeps lines while the page is attached too**, in a ring per session
  numbered by `seq`: a phone that changes network leaves a socket the server
  still thinks is open, and whatever is written into it is lost. The page asks
  for those lines back by `seq`. The ring is bounded (2,000 lines and 384 KiB
  a chat with the new irc-hold, 500 and 128 KiB before); what falls out is
  counted in `<missed>`. Each kept line is tagged `@time=<ISO 8601 UTC>` when it
  arrives, unless it carries a time tag already: the reducer reads it
  (`timeOf`), so a replayed line shows when it was said.
- **A resume takes over.** An older socket still attached to the session is
  closed with code `4001` (`resumed elsewhere`).
- **When the hold ends it sends `QUIT` upstream** and forgets the session. If
  ZeroNode closes first, the session ends there, and a resume gets `HOLD GONE`.
- **A new chat from the same address that asks for a HELD chat's nick ends
  that held chat and gets the nick** (the new irc-hold). It covers the copies
  that do not share storage (the iOS app, Safari and the Home Screen app) on
  one network; never a chat a page is attached to.
- **The rules of the gateway stay.** `Origin` is checked against the same list
  on every socket, resumes included; the visitor address comes only from Caddy;
  no token and no line's text is logged; tokens compare in constant time; the
  number of held sessions is bounded.

**What the page does** (`lib/irc/client.ts`).
- **It resumes only after a `HOLD TOKEN`**, so against a gateway with no hold
  service it behaves as before, and either side can deploy first. It says
  `HOLD LIVE` right after the token (above).
- **On a drop it tries to resume until `HOLD GONE`**, not until `<seconds>`:
  after 1 s, 2 s and 4 s, then every 15 s, then every 60 s once it has been
  away 5 minutes, and at once on `online`, on `pageshow` and when the page
  becomes visible (`resumeWaitMs`, `check:irc`). With no answer at all it stops
  after 6 hours (`HOLD_MAX_AWAY_S`). `MAX_HOLD_S` only checks the `<seconds>`
  of the token line. A resume never registers on IRC: it sends `HOLD RESUME`
  and nothing else. So the page still cannot spend a ZeroNode slot by itself;
  after `HOLD GONE` it shows JOIN AGAIN, as before.
- **A socket that looks attached is tested when the page comes back.** A phone
  that slept or changed network keeps a socket with no close event, and the
  chat then shows nothing new. On `pageshow`, `online` and visible the page
  sends an IRC `PING`; when no frame comes back in 5 s it drops that socket at
  once (a dead network may deliver its close much later) and resumes. Only with
  a hold token: without a hold service, dropping the socket ends the chat, so a
  slow answer must not. The `PONG` is an IRC line like any other: it counts in
  `seq`.
- **The rows stay on screen while it reconnects**, and the composer waits.
- **A refresh, a lock or a closed app is a drop** (Chad, 2026-11-22: "if you
  lose connection or if you refresh the page, you should come back with your
  nick and chat"). The panel saves the token, the last line's `seq`, the nick,
  the channel and the last 200 rows (`storage.ircHold`, `bmb:irc_hold:<channel>`)
  as soon as the chat is joined or back, and again when the page hides
  (`pagehide`, and `visibilitychange` to hidden, because a phone may discard a
  hidden page). The next page on that show shows the rows and starts with
  `HOLD RESUME` (`openIrcSession`'s `resume`): no NICK, no USER, no new ZeroNode
  slot, and the lines said while it was away arrive by `seq`. The rows are
  saved and the seq read in the same handler, so they agree. After a refresh
  the panel mounts again because the player comes back on its own: the live
  item, its full-screen player and its playing state are saved beside it
  (`bmb:live_refresh`, docs/ui.md "A refresh picks a live stream back up"), so
  a refresh needs no press to return to the chat. A reopened app starts with
  no player: the chat resumes when the listener opens that show again.
- **The saved hold is in localStorage, one per channel**; it was
  sessionStorage until 2026-11-24. Chad's test at 7:32 PM that day: he joined
  #MMO as BMB, closed the app, opened it again, typed BMB, and got "That nick
  is taken". His own held chat had the nick, and the tab-scoped copy that could
  resume it had died with the app. It is cleared on `HOLD GONE`, on `QUIT` and
  when the listener leaves on purpose, never by a window that lost the session
  to a takeover (`clear` matches the token: the window that resumed it saves
  under the same key), and the page stops believing it after 6 hours
  (`holdSnapshotFresh`). A second window that resumes takes the session over
  (close `4001`), as before. **The cost, accepted in the plan:** on a shared
  computer, the next person to open that show's chat in the same browser while
  the hold lasts goes into this chat.
- **The cost of a hold: a closed app keeps the nick in the channel until the
  hold ends**: with `HOLD LIVE`, 10 minutes after the show (marked away), at
  most 6 hours; with an irc-hold that does not know it, 5 minutes. The page
  cannot tell a refresh from a closed app, so it sends no `QUIT` on `pagehide`
  while a hold token exists (Chad accepted this, 2026-11-22, and again in the
  plan). Without a hold service it still quits on `pagehide`.
- **Leaving on purpose says `QUIT`, also while away.** Another show or episode
  unmounts the panel, and it quits. When the socket is away at that moment,
  the session goes back only to say `QUIT` (a resume, then `QUIT`), or the
  service would keep the nick for the rest of the show. Two gaps: a leave
  during the FIRST resume of a saved hold sends nothing and keeps the saved
  copy (React's development double mount quits that resume at once, and the
  second mount must find it), and a leave with the network down cannot reach
  the service at all. Closing the full-screen player is not leaving: the show
  plays on in the mini-bar, and BMB has no "stop" that empties the player.
- **The saved hold is read back field by field** (`readHoldSnapshot`,
  `check:irc`): the token goes to the gateway and the rows to the screen, so a
  field of the wrong shape refuses the hold and a row of the wrong shape is
  dropped. Never put the token in a URL: the gateway logs URLs.

## The codec: one typed message is one command

`lib/irc/protocol.ts` is an import-free leaf, pinned by `check:irc`.

- **CR and LF end an IRC command.** `cleanOutgoing` turns every CR, LF and NUL
  into a space before any line is built. A panel that wrote
  `PRIVMSG #chan :${text}` would let a pasted "hi\r\nJOIN #x" — or "\r\nQUIT", or a
  line to NickServ — run as the listener, with their real address behind it.
- **`\x01` opens a CTCP, so `cleanOutgoing` removes it.** A pasted
  `\x01VERSION\x01` makes every client in the channel answer, and `\x01DCC…`
  offers a file as the listener; the composer cannot show the character. `/me`
  is the one CTCP the panel builds (`buildAction`).
- **512 bytes per line, prefix included, and the server adds the prefix.** A
  text chunk is at most 350 UTF-8 bytes (`MAX_TEXT_BYTES`), cut at the last
  space, else on a code point boundary: a split inside a character prints
  mojibake on every other client. 350, not 400: the RELAYED line carries our
  full `nick!user@host`, and a 30-character nick with a 63-character WEBIRC host
  took a 400-byte text to 531 bytes, which the server cuts (final review).
- **A line from the server over 8191 bytes is dropped**, IRCv3's ceiling with
  tags: a WebSocket frame is a third-party body like any other.
- **Text renders as text.** mIRC formatting is stripped; links go through
  `<LinkedText>`, so only `http(s)` becomes an `<a>`.

## The panel (`components/irc-chat.tsx`)

It shows beside an RSS live item from the opt-in list, while the item is live
or after the listener joined on it (`showIrc` in `<FullscreenPlayer>`; layout
in [`ui.md`](ui.md), "With the IRC chat"). A Nostr stream keeps `<LiveChat>`.

**Not on a 24/7 replay stream.** Its live item never ends and nobody is on air,
so the panel would offer a chat with nobody to talk to, all day, every day.
Chad, 2026-11-25: "thats a 24/7 replay stream so dont show a chat there".
Lightning Thrashes (`#SirLibre`) left the list that day; it has 11 shows. The
gateway's own lists (thelounge-candr) drop a channel only AFTER the page change
is deployed: a gateway that goes first leaves a page offering a chat that
its lock refuses (477). A hold a device saved for the channel is never read,
because only a mounted panel reads `bmb:irc_hold:<channel>`, and `prune` drops
it after 6 h (`e2e:irc` seeds one and checks that no socket opens).

- **Type a nick and you are in.** No account. The nick is the only thing
  stored (`storage.ircNick`, per npub like `bmb:sender_name`); the rows live in
  component state and go with it. **At most 17 characters** (`MAX_NICK_LENGTH`):
  ZeroNode's `005` says `NICKLEN=17` (seen live by the gateway agent), and a
  longer nick comes back as 432, which the panel would show as "taken". **At
  least 2** (`MIN_NICK_LENGTH`, ours: IRC allows one). The listener always types
  a name; the panel makes up no guest names (Chad, 2026-11-21).
- **One IRC connection, never registered twice by itself.** With the hold
  service, a drop shows "Reconnecting…" and the session comes back by itself
  (above): the rows stay, the composer waits with its draft, and a notice says
  whether anything was missed. A hold that ran out, an `ERROR`, or a gateway
  with no hold service shows JOIN again; a refused JOIN (banned, invite only) closes the connection at once, so
  it does not hold a slot — the first JOIN and a JOIN AGAIN after a kick alike.
  A taken nick is fixed on the SAME connection (`ircNick`), and a KICK keeps the
  connection for JOIN AGAIN. A gateway that takes the socket and never
  welcomes is given up after 20 s (`IRC_REGISTER_TIMEOUT_MS`), so "Joining…" is
  never a screen with no way out. irc-hold's nick take-back (image 5) welcomes
  up to ~7 s later than usual, because it ends the held chat first: inside the
  20 s, but a still line that long reads as stuck on a phone, so after 5 s
  (`SLOW_JOIN_MS`) it adds "Still joining. A nick that was in use a moment ago
  can take a few more seconds." (`e2e:irc` delays the fake's 001 by 7 s).
- **A taken nick on JOIN says why it may be** (Chad, 2026-11-24): "That nick is
  in use. If it was yours a moment ago, your last chat may still hold it. Try
  another nick, or wait a few minutes." With the saved hold the page resumes
  instead of meeting its own nick, so this is the case it cannot cover: another
  device, on another network. A `/nick` refused in a running chat keeps the
  short text, "That nick is taken. Try another.", as before.
- **A refused MESSAGE is shown, never dropped.** 404 (quieted, banned without a
  kick, `+m`) and 492 come back as the server's text under the composer: the
  listener's own row is otherwise the only copy, and they would talk to nobody.
- **Only a nick the listener asked for is stored.** `nickChanged.requested` is
  true for the echo of a typed `/nick`; a rename by services (a guest on a
  registered nick becomes `Guest4821`) is said in the list and is not stored,
  or the box would offer `Guest4821` next time.
- **The privacy line sits under the nick box**, where it is read before JOIN;
  in the list it scrolled away as soon as rows came.
- **It reads as a chat window before anyone has joined** (Chad, 2026-11-21: an
  empty panel "is kind of hard to tell that it's an actual chat"): a frame from
  `sm:` up, and a line in the empty list saying what it is and how to join. No
  frame on a phone, where it is a page of its own.
- **On a phone the chat is a page you flick to** (Chad, 2026-11-24: the tabs
  gave it "only basically two lines" — 74px on his iPhone, 469px now). PLAYER ·
  CHAT · PLAYED · ABOUT, opening on PLAYER (the art first), with ▶/❚❚, the LIVE state and BOOST
  pinned under every page. Layout and the reasons in [`ui.md`](ui.md), "With
  the IRC chat on a phone: a pager".
- **One color per person** (Chad, 2026-11-22: "each user has like their own
  color to their name … it helps make following the chat better"). Names are
  14px and bold. `nickColor` (`lib/irc/protocol.ts`) picks one of ten
  `--nick-N` tokens from the nick alone, case-insensitive, so every listener
  sees one nick in one color and a reload keeps it; `check:irc` pins the hash,
  because a change moves every color at once. Each token is at least 4.5:1 on
  `--ink` in its theme. Your own name stays in the text color.
- **The chat gets the room above it** (Chad, 2026-11-22): from `sm:` up, a show
  with the chat has less padding and smaller gaps above the tabs, so the chat
  is 465px tall at 1280 x 800 (405px before). Nothing moved; the phone layout
  is unchanged.
- **It leaves when it goes**: `QUIT :bye` on unmount (another show or episode,
  or the show ended and was never joined), also while the socket is away
  (above), and it forgets the saved hold. The page going away is a drop, not a
  leave (above). The panel is keyed by channel, so a new live episode of the
  same show keeps the session. Switching to PLAYED or ABOUT does not unmount it,
  and another show opens on CHAT whatever tab was left open. Neither does a
  flick between the phone's pages, nor a turn of the phone across 640px: the
  panel is rendered once into a reverse portal (`ircNode` in
  `<FullscreenPlayer>`), and each layout shows that one copy.
- **A secret is refused before it leaves**, in the nick box and the composer:
  `textHoldsSecret` (every run of letters and digits, and NWC strings). IRC
  is public and logged; a key typed there is burnt.
- **Only `/me` and `/nick` work.** Any other `/command` is answered on screen
  and never sent: a typed `/join` or `/msg NickServ` would act as the listener.
- **2,000 rows, 500 characters.** The list keeps the newest 2,000 (it was 200
  until the hold while live): a resume after a long hold can bring ~1,500
  lines, and one MMO show was ~1,350. Only the newest 200 are saved; the resume
  brings the rest by `seq`. A long message is cut into ≤ 350-byte lines by the
  codec. **Each row is memoized and the rows paint once per frame**: re-rendering
  every row per line took ~1 s a line at 2,000 rows under `next dev` (each row
  formats its time twice through `Intl`; the memo took it to ~190 ms there),
  and a resume replays ~1,500 lines in one burst. The gap between rows is
  `[&>*+*]:mt-3`, not `space-y-3`, as a precaution: Tailwind 3 writes that as a
  `~` selector, which can restyle every row when a full list drops its first
  one. It was not measured on its own (dev went 190 to 188 ms). **The follow to the
  newest line is a layout effect**: a passive one let a frame's scroll event
  measure the bottom past a burst of new rows, and the list stopped following.
  Measured with `npm run e2e:irc -- --browser <url> --perf` against `next build
  && next start`, iPhone 11 screen, CPU 4x slower: a 1,500-line resume paints in
  ~310 ms, and one new line at 2,000 rows in ~55 ms.
- **No report, no hide, no word filter.** Chad: the channels have moderators who
  can kick, "so it's up to the podcaster for that. I'm just showing it."

## Testing

`npm run check:irc` pins the codec, the session reducer, the show list and the
gateway switch. `npm run e2e:irc` drives the real client against
`scripts/irc-fake-server.mjs`; `-- --browser` drives the panel too, against a
dev server started with `NEXT_PUBLIC_IRC_GATEWAY_URL=ws://127.0.0.1:6790/`
(the fake listens there). Neither reaches ZeroNode: the real gateway and the
real network are tested on the deploy, with Chad. Its section "Chad's iPhone"
is the phone check that counts: 393 x 852 with the safe areas set, MMO's
two-line title and a value block (the 390 x 844 section above it spends no
safe areas, and passed while the phone showed two rows). `--shots <dir>` saves
the pager's four screens as PNGs. `--perf` adds the 2,000-row speed test
(above); run it against a production build, because `next dev` renders twice.

The hold while live is tested against TWO fakes, because either side may deploy
first: `scripts/irc-fake-server.mjs` with `liveHold` is the new irc-hold (a page
that said `HOLD LIVE` is held past `<seconds>`), and without it today's (`HOLD
LIVE` dropped, the hold `<seconds>`, then `HOLD GONE`). The Node half moves the
page's clock past 300 s for the resume after more than 300 s; the browser half
drives the socket test with a dispatched `pageshow` and `visibilitychange`, and
the closed app with a new tab, which has none of the old tab's sessionStorage.
