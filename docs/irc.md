# IRC chat beside an RSS live stream

Core rules live in [`../CLAUDE.md`](../CLAUDE.md); this file holds the reasoning.
The design is [`superpowers/specs/2026-11-21-irc-live-chat-design.md`](superpowers/specs/2026-11-21-irc-live-chat-design.md).

A listener on a live show from the opt-in list (`lib/irc/shows.ts`) types a nick
and talks in the show's ZeroNode channel, in a panel that looks like the Nostr
live chat. No account, and nothing kept: not by this app, not by the gateway.

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

## The codec: one typed message is one command

`lib/irc/protocol.ts` is an import-free leaf, pinned by `check:irc`.

- **CR and LF end an IRC command.** `cleanOutgoing` turns every CR, LF and NUL
  into a space before any line is built. A panel that wrote
  `PRIVMSG #chan :${text}` would let a pasted "hi\r\nJOIN #x" — or "\r\nQUIT", or a
  line to NickServ — run as the listener, with their real address behind it.
- **512 bytes per line, prefix included, and the server adds the prefix.** A
  text chunk is at most 400 UTF-8 bytes, cut at the last space, else on a code
  point boundary: a split inside a character prints mojibake on every other
  client.
- **A line from the server over 8191 bytes is dropped**, IRCv3's ceiling with
  tags: a WebSocket frame is a third-party body like any other.
- **Text renders as text.** mIRC formatting is stripped; links go through
  `<LinkedText>`, so only `http(s)` becomes an `<a>`.
