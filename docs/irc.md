# IRC chat beside an RSS live stream

Core rules live in [`../CLAUDE.md`](../CLAUDE.md); this file holds the reasoning.
The design is [`superpowers/specs/2026-11-21-irc-live-chat-design.md`](superpowers/specs/2026-11-21-irc-live-chat-design.md).

A listener on a live show from the opt-in list (`lib/irc/shows.ts`) types a nick
and talks in the show's ZeroNode channel, in a panel that looks like the Nostr
live chat. No account, and nothing kept: not by this app, and by Chad's box only
for the 5 minutes it holds a dropped connection (below).

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
a **hold service** on Chad's box (repo **thelounge-candr**) stands between Caddy
and `webircgateway` at the same address, and keeps each listener's IRC
connection open for **300 s** after their browser drops (Chad's choice). It is
not a backlog: a listener sees only what was said since they joined.

**The wire contract.** One IRC line per text frame, both ways, as before. A line
that starts `HOLD ` belongs to the service: it never reaches ZeroNode, and the
page never hands it to the reducer. `seq` counts every other line the service
sent toward the page in this session, from 1.

| Direction | Line | When |
| --- | --- | --- |
| service → page | `HOLD TOKEN <token> <seconds>` | The first frame of a new session. `<token>` is at least 128 random bits, base64url; `<seconds>` is the hold (300). |
| page → service | `HOLD RESUME <token> <seq>` | The first frame of a socket that resumes. `<seq>` is the last line the page received. |
| service → page | `HOLD RESUMED <nick> <channel> <missed>` | The session is held. Then every kept line after `<seq>`, in order, then live lines. `<channel>` is `*` when the nick is in none (kicked); `<missed>` counts the lines after `<seq>` the service no longer has. |
| service → page | `HOLD GONE :<reason>` | The token is unknown or expired, or the session's IRC connection ended. Then the service closes the socket. |

**What the service does.**
- **It holds on every close of the browser socket except after a `QUIT`.** A
  `QUIT` from the page ends the session at once, as `send_quit_on_client_close`
  does today.
- **While held it answers `PING` with `PONG`** — the page is not there to — and
  keeps every other line.
- **It keeps lines while the page is attached too**, in a ring per session
  numbered by `seq`: a phone that changes network leaves a socket the server
  still thinks is open, and whatever is written into it is lost. The page asks
  for those lines back by `seq`. The ring is bounded (lines and bytes); what
  falls out is counted in `<missed>`. Each kept line is tagged `@time=<ISO 8601
  UTC>` when it arrives, unless it carries a time tag already: the reducer reads
  it (`timeOf`), so a replayed line shows when it was said.
- **A resume takes over.** An older socket still attached to the session is
  closed with code `4001` (`resumed elsewhere`).
- **After 300 s with no resume it sends `QUIT` upstream** and forgets the
  session. If ZeroNode closes first, the session ends there, and a resume gets
  `HOLD GONE`.
- **The rules of the gateway stay.** `Origin` is checked against the same list
  on every socket, resumes included; the visitor address comes only from Caddy;
  no token and no line's text is logged; tokens compare in constant time; the
  number of held sessions is bounded.

**What the page does** (`lib/irc/client.ts`).
- **It resumes only after a `HOLD TOKEN`**, so against a gateway with no hold
  service it behaves as before, and either side can deploy first.
- **On a drop it tries to resume** — after 1 s, 2 s and 4 s, then every 15 s,
  and at once on `online` and when the tab becomes visible — until the hold runs
  out. A resume never registers on IRC: it sends `HOLD RESUME` and nothing
  else. So the page still cannot spend a ZeroNode slot by itself; after `HOLD
  GONE` or the deadline it shows JOIN AGAIN, as before.
- **The rows stay on screen while it reconnects**, and the composer waits.
- **The token lives in memory only.** A reload or a closed tab sends `QUIT`
  (`pagehide`) and ends the session at once. A tab that iOS discards with no
  `pagehide` leaves its nick held until the hold runs out.

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

- **Type a nick and you are in.** No account. The nick is the only thing
  stored (`storage.ircNick`, per npub like `bmb:sender_name`); the rows live in
  component state and go with it. **At most 17 characters** (`MAX_NICK_LENGTH`):
  ZeroNode's `005` says `NICKLEN=17` (seen live by the gateway agent), and a
  longer nick comes back as 432, which the panel would show as "taken". **At
  least 2** (`MIN_NICK_LENGTH`, ours: IRC allows one). The listener always types
  a name; the panel makes up no guest names (Chad, 2026-11-21).
- **One connection, never reopened by itself.** A drop or an `ERROR` shows JOIN
  again; a refused JOIN (banned, invite only) closes the connection at once, so
  it does not hold a slot — the first JOIN and a JOIN AGAIN after a kick alike.
  A taken nick is fixed on the SAME connection (`ircNick`), and a KICK keeps the
  connection for JOIN AGAIN. A gateway that takes the socket and never
  welcomes is given up after 20 s (`IRC_REGISTER_TIMEOUT_MS`), so "Joining…" is
  never a screen with no way out.
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
  frame on a phone, where it is the screen's lower half, as `<LiveChat>` is.
- **It leaves when it goes**: `QUIT :bye` on unmount (the player's SHOW
  changed, or the show ended and was never joined) and on a `pagehide` that is
  not `persisted`. The panel is keyed by channel, so a new live episode of the
  same show keeps the session. Switching to PLAYED or ABOUT does not unmount it,
  and another show opens on CHAT whatever tab was left open.
- **A secret is refused before it leaves**, in the nick box and the composer:
  `textHoldsSecret` (every run of letters and digits, and NWC strings). IRC
  is public and logged; a key typed there is burnt.
- **Only `/me` and `/nick` work.** Any other `/command` is answered on screen
  and never sent: a typed `/join` or `/msg NickServ` would act as the listener.
- **200 rows, 500 characters.** The list keeps the newest 200; a long message
  is cut into ≤ 350-byte lines by the codec.
- **No report, no hide, no word filter.** Chad: the channels have moderators who
  can kick, "so it's up to the podcaster for that. I'm just showing it."

## Testing

`npm run check:irc` pins the codec, the session reducer, the show list and the
gateway switch. `npm run e2e:irc` drives the real client against
`scripts/irc-fake-server.mjs`; `-- --browser` drives the panel too, against a
dev server started with `NEXT_PUBLIC_IRC_GATEWAY_URL=ws://127.0.0.1:6790/`
(the fake listens there). Neither reaches ZeroNode: the real gateway and the
real network are tested on the deploy, with Chad.
