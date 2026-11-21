# IRC chat beside an RSS live stream, through a gateway on Chad's box

Chad, 2026-11-19: *"keep the Nostr chat on the Nostr stream and try to add an IRC
chat … to the RSS-based streams."* 2026-11-21: *"we just need a web interface for
zero node basically. And then just know which channel on there these shows are. So
we can maybe just log the user into those channels automatically when they bring up
that show live on the site."* Then: *"when I add the IRC, I just want to do it
similar to how the Noster chat is … on desktop, it's video or whatever to the left,
and then chat to the right. And then on mobile, however the chat works for Nostr …
someone just puts in their username, and then they're in."*

## Why

The Podcasting 2.0 live shows chat on ZeroNode (`irc.zeronode.net`), each in its own
channel. A listener has no simple web way in: Kiwi IRC "has had a bunch of issues",
and each show runs its own web client (chat.candr.space, chat.mmo.show,
chat.behindthesch3m3s.com are each a The Lounge). boostmebitch already plays the
show's `<podcast:liveItem>` stream, so the chat belongs beside it, the way the
kind:1311 chat sits beside a Nostr stream. Success: a listener opens a live show on
either site, types a nick, presses JOIN and talks in the show's channel, with no
account, and neither boostmebitch nor the gateway keeps anything about them after
they leave.

## What exists today (read / measured, 2026-11-21)

- **Nostr chat.** `components/fullscreen-player.tsx` swaps the right pane for
  `<LiveChat>` when `liveStreamId` is set (an HLS stream whose guid is a NIP-33 id):
  title, `<LiveEdge>`, a BOOST/♡/SHARE row, then the chat filling the height. Below
  `sm:` the scroll row is `overflow-hidden` so the chat fills what is left. The pane
  mounts under the `everOpened` gate and keeps its state across close/reopen.
- **RSS live item.** `episode.liveStatus === 'live'` (`isLive`) takes the ordinary
  right pane: title, `<LiveEdge>`, transport, BOOST, then a scroll body holding
  `<LivePlayedTracks>` (played songs, a ♡ on each) and `<EpisodeInfoPanel>`
  (About).
- **ZeroNode** runs InspIRCd 4 (`002`/`004` on `sparrow.zeronode.net`). It has a
  WebSocket module, but no port of `irc.zeronode.net` (443, 6697, 6699, 7000, 7443,
  8000, 8080, 8097, 8443, 9000) answered a WebSocket upgrade, and no `ws.`, `wss.`,
  `websocket.`, `webirc.`, `kiwi.` or `web.` host exists. A browser cannot open raw
  IRC, so a chat panel needs a WebSocket gateway.
- **chat.candr.space** (repo thelounge-candr) is Chad's public The Lounge for
  ZeroNode, with WEBIRC: ZeroNode sees each visitor's own address, so its limit of 3
  connections per address applies per visitor and a ban lands on the visitor. Every
  new WEBIRC connection still counts once against the box's IPv4 address at connect
  time, before WEBIRC moves it — that is why IPv4's third slot must stay free
  (thelounge-candr `docs/zeronode.md`). The box has 960 MB shared by both Lounges,
  the bots and ZNC.
- **kiwiirc/webircgateway** (Apache-2.0, last push 2025-03-01, no tagged releases, no
  Dockerfile in the repo) bridges a WebSocket to IRC. Its config has a fixed
  `[upstream.N]` with `webirc = "<password>"`, `protocol = "tcp4"`, `throttle`,
  `[gateway] enabled = false` (no open proxy to other networks),
  `[allowed_origins]`, `[reverse_proxies]` (whose `X-Forwarded-For` it trusts) and
  `[clients] username/realname` overrides.

## Chad's decisions

1. **A chat panel in boostmebitch that looks like the Nostr chat** — not a frame of a
   web client.
2. **The WebSocket comes from a gateway on Chad's box**, with WEBIRC, in
   thelounge-candr (question 1, answer A). A ZeroNode WebSocket later would change
   only the address.
3. **An opt-in list of shows, each with its channel** — not every feed with a chat
   tag (*"I don't know if I want to use this for every show"*). All on
   `irc.zeronode.net`; a `LIST` on 2026-11-21 showed each channel:

   | Show | `podcastGuid` | Channel |
   |---|---|---|
   | Homegrown Hits | `ac746d09-7c3b-5bcd-b28a-f12d6456ca8f` | `#HomegrownHits` |
   | Podcasting 2.0 | `917393e3-1b1e-5cef-ace4-edaa54e1f810` | `#Podcasting20` |
   | Behind the SchƎmƎs | `e0ac9365-689c-5043-8804-15b9dfcc545a` | `#greenroom` |
   | MMO | `31740861-81e8-5dda-8801-a2abb2634271` | `#MMO` |
   | Chad and Reeds | `7c6f7875-2b73-491e-b32c-e2c8d6e91d53` | `#candr` |
   | Lightning Thrashes | `d5e73072-64a2-56a3-9dcd-4a00bfe561d5` | `#SirLibre` |
   | the v4vmusic Show | `c1959795-28f1-502d-ad3e-70abf5a034a9` | `#v4vmusicShow` (not the empty `#V4VMUSIC`) |
   | RevDoc's Revival | `45b899bb-cbef-57b5-ab14-04aaf49e3ac3` | `#VoidZero` |
   | Hyper SpaceOut | `c42a0900-c20e-59a2-a13b-c23b5c04e11f` | `#HyperSpaceOut` |
   | Bowl After Bowl | `2d418249-453a-5714-8abc-5b657570b641` | `#BowlAfterBowl` |
   | Into The Doerfel-Verse | `41aace28-8679-5ef1-9958-75cf76c2b5f0` | `#DoerfelVerse` |
   | Accidentally Interesting | `89bf141a-f4cf-575c-b09a-75dbce16332c` | `#OffTopic` |

   Guids are the feeds' own `<podcast:guid>`, except Podcasting 2.0, whose feed
   carries none; its guid is the one the repo's scripts already use. A `MODE` query
   (no JOIN) on 2026-11-21 showed every channel as `+rnt`, plus `+P` on `#greenroom`
   and `#bowlafterbowl` and `+A` on `#voidzero`: none is `+R`, `+M`, `+m`, `+i` or
   `+k`, so a guest with no account can join and talk in all 12. A ban aimed at
   webchat hosts would not show there; the manual test catches it.
4. **Only beside a `<podcast:liveItem>` stream that is live** (*"this is meant to be
   a live chat. So if they don't use the lit tag, then we don't know when they're
   live"*). So Nick the Rat Radio (`#SewerChat`, no live item) is not on the list,
   and LINUX Unplugged gets no chat window.
5. **Layout: tabs under BOOST** (question 2, answer A). Computer: stream or cover on
   the left; on the right the existing RSS-live header (title, LIVE, transport,
   BOOST — ♡ and SHARE stay in the ⋯ menu, as today), then **CHAT · PLAYED ·
   ABOUT**, CHAT open first. Phone: *"however the chat works for Nostr"* (see the
   player item below). The listener stays in the channel while PLAYED or ABOUT is
   open.
6. **Both brands** (question 3, answer B). Buddy is family-friendly in name only.
7. **No REPORT, no HIDE, no word filter.** *"all of these chats have moderators in
   them that can kick people. So it's up to the podcaster for that. I'm just showing
   it."*
8. **Join is a nick and nothing else.** No account, no NickServ.
9. **Nothing kept.** *"people would just log in and then it would all be lost when
   they close the window."*

## Approaches considered

- **A frame of chat.candr.space with `?join=`** — least work, and The Lounge 4.5.2
  takes `?join=` and `?nick=` even with `lockNetwork`. Rejected: it does not look like
  the Nostr chat, it is cramped on a phone (candr.space opens it in a new tab for that
  reason), and 4.5.2 has no URL setting that connects at once.
- **A panel speaking The Lounge's own socket.io events** — no new server. Rejected:
  those events are The Lounge's internal client protocol and change between versions.
- **A panel on a ZeroNode WebSocket** — no box involved, each browser connects from
  its own address. Not possible today (no port answers); the ZeroNode admins would
  have to open one. Kept as a later swap: the panel is the same code.
- **A panel on a WebSocket gateway on Chad's box (chosen).** In Chad's control now,
  WEBIRC already works from that box, the gateway is a small Go program.

## The design — thelounge-candr (a separate repo: its agent or Chad makes this change)

1. **A new container `irc-gateway`** running webircgateway built from a pinned commit
   (multi-stage Go build → a small runtime image; there is no official image or
   release). `mem_limit` about 64 MB. Port bound to `127.0.0.1` only, as the Lounges
   are.
2. **Config** (`gateway/config.conf` in the repo, the password outside git):
   - `[upstream.1]`: `irc.zeronode.net`, port `6697`, `tls = true`,
     `protocol = "tcp4"` (ZeroNode's WEBIRC block covers the box's IPv4 address
     only), `throttle = 2`, `webirc` = the same password `thelounge-public` uses
     (`/opt/thelounge/public.env`; one WEBIRC block is an address plus a password, so
     a second program on that address uses the same block). How the password reaches
     the config without git (an env substitution, or a file generated at start) is the
     thelounge-candr agent's call.
   - `[gateway] enabled = false` — the gateway connects to ZeroNode only.
   - `[allowed_origins]`: `https://boostmebitch.com`, `https://www.boostmebitch.com`,
     `https://boostmebuddy.com`, `https://www.boostmebuddy.com` (also the iOS app's
     origin), and the beta host in boostmebitch `docs/ops.md`. Nothing else; never
     empty (empty allows every site).
   - `[reverse_proxies]`: only the address Caddy reaches the container from.
   - `[clients] realname` set to say where the user came from, so ZeroNode's
     operators can tell; it serves both brands, so a word that names neither is
     the agent's call.
   - A per-address connection limit and the `throttle` value are the agent's call.
   - `[transports]`: `websocket` only.
3. **A new Caddy site** (for example `irc-ws.candr.space`; the name is the agent's
   call) proxying to the container. **No `trusted_proxies` in that block** — the same
   rule as chat.candr.space: otherwise a visitor sends their own `X-Forwarded-For`
   and gets someone else banned. Chad adds the DNS record.
4. **Nothing kept.** No Caddy access log for that site. The gateway's log level as
   low as it allows, and a Docker log size limit, because its connection lines carry
   visitors' addresses. The thelounge-candr agent checks what Caddy and Docker keep
   today for chat.candr.space too (Chad's question, still open there).
5. **Docs there:** the ZeroNode table gains the gateway — every BMB chatter also needs
   IPv4's third slot free for the moment they connect; the gateway must never be
   given IPv6. A restart of `irc-gateway` drops every BMB chatter: no deploy during a
   show. A deploy of `thelounge-public` no longer affects BMB chatters.
6. **Done when** a browser WebSocket test from an allowed origin registers a nick and
   joins a test channel with the visitor's own cloak (`/whois`), and a test from another origin is refused.

## The design — boostmebitch

1. **The list** — `lib/irc/shows.ts`, an import-free leaf: the table above as
   `podcastGuid → { channel }`, and `ircChannelFor(podcastGuid)` (lowercase compare).
   A new show is a one-line PR. The feed's `<podcast:chat>` is not read.
2. **The gateway address** — `NEXT_PUBLIC_IRC_GATEWAY_URL` on both Vercel projects.
   Unset means no chat anywhere: the kill switch, and the state of every deploy until
   the gateway is live.
3. **The protocol code** — `lib/irc/protocol.ts`, an import-free leaf: parse a line
   (tags, prefix, command, params), strip mIRC colour/format codes, recognise a CTCP
   `ACTION`, build outgoing lines, check a nick, split a long message so each line
   fits 512 bytes. **Building a line removes every CR and LF from the listener's
   text**, so typed text can never become a second IRC command. Pinned by a new
   `check:irc` with the usual must-still-work half.
4. **The client** — `lib/irc/client.ts`, browser-only: open the WebSocket only when
   the listener presses JOIN; `NICK`/`USER`; on `001` `JOIN` the show's channel;
   answer `PING`; `433` (nick in use) returns to the nick form with the reason; a
   `KICK` of the listener, an `ERROR` or a close shows ZeroNode's own text and a JOIN
   button — no automatic reconnect (each attempt costs the box's IPv4 slot for a
   moment, and a loop would hit ZeroNode's connect limits). `QUIT` when the panel
   unmounts or the page hides for good.
5. **The panel** — `components/irc-chat.tsx`, the look of `<LiveChat>`: rows of nick,
   time (`fmtClock`) and text, the same scroll behaviour, a composer at the bottom,
   at most 200 lines in memory. Text renders as text; links go through
   `<LinkedText>` (`httpUrl`). `/me` and `/nick` work; another `/` command is not
   sent and the panel says so. Before JOIN: a nick box and JOIN. The panel says once
   that IRC keeps no history, so it starts empty; a channel set to replay lines on
   join (InspIRCd `+H`) fills it. One line under the nick box says IRC is public:
   the channel can log what is written (bots and bouncers do), and ZeroNode sees the
   listener's address. **The composer and the nick box refuse an `nsec`**
   (`looksLikeSecretKey`, with a rendered refusal): their text leaves for a third
   party, the rule in `CLAUDE.md`'s security section.
6. **The player** — in `fullscreen-player.tsx`, when `isLive`, no `liveStreamId`,
   the gateway URL is set and `ircChannelFor(podcast.podcastGuid)` names a channel:
   the scroll body becomes `<UnderlineTabs>` CHAT · PLAYED · ABOUT over a body that
   fills the height (phone: the Nostr branch's `overflow-hidden` row). PLAYED holds
   `<LivePlayedTracks>`, ABOUT holds `<EpisodeInfoPanel>`; a tab with nothing to show
   is left out. `<IrcChat>` stays mounted while another tab shows (hidden, not
   unmounted) and lives under the `everOpened` gate, so closing the player keeps the
   listener in the channel while the stream plays. A new episode unmounts it (QUIT).
   Once the listener has joined, the panel stays when the feed marks the item ended,
   so nobody is cut off mid-sentence; it leaves with the episode. Every other live
   show and every Nostr stream renders as today.
   **Phone, below `sm:`.** The Nostr branch fits because its media is a 16:9 video
   and its pane has one action row. The RSS-live pane has a square cover (at least
   11rem, up to the full width) and BOOST on its own line, which leaves about 110 px
   for messages at 390×844. So while the chat tabs show, below `sm:` only: the cover
   is capped at about the height the Nostr video takes there, and the transport and
   BOOST share one row. The builder measures under CDP device emulation that the
   message list gets at least the room the Nostr chat gets, and leaves the cover rule
   of every other episode (the "A GAP IS THE COVER'S SIZE" comment) as it is.
7. **Storage** — the nick only, on the device, through a new `storage.ircNick`
   accessor (`bmb:irc_nick`). No chat line touches storage.
8. **Docs** — a new `docs/irc.md` with the reasoning, listed in `CLAUDE.md`'s
   read-before-edit table with `check:irc` in the check table (inside
   `check:claudemd`'s budget).

## Non-goals

No chat for a show off the list or with no live item; no Nostr chat from a feed's
`<podcast:chat protocol="nostr">`; private messages, NickServ, channel switching and
a user list; chat history; moderation tools (REPORT, HIDE, filters); a chat on
ordinary episodes.

## Anti-goals

- A gateway that reaches any network but ZeroNode, or accepts any origin.
- A gateway that makes every visitor share the box's address (one ban hits all).
- Any chat line kept by boostmebitch (server or device) or by the gateway. What a
  channel's own bots log is the channel's business — and Chad's own candr-boost
  already writes every `#candr` line to `/opt/bots/candr-notes/chat.jsonl` (his
  choice, 2026-11-17).
- An automated test that joins or writes in a real show channel.
- A layout that loses BOOST or the played songs' hearts.

## Risks

- **Apple Guideline 1.2.** The chat shows in the iOS app (Buddy). Apple asks a chat
  app for report, block and filter. Chad chose none: moderation is the channel's.
  A review may refuse; then this comes back to Chad.
- **ZeroNode** may object to a second WEBIRC program on the same block; telling its
  operators is Chad's call.
- **Load.** Each chatter is one WEBIRC connection plus the gateway's small share of
  960 MB; tens are fine, hundreds need a measurement.
- **Three tabs on one home address** hit ZeroNode's per-address limit; the panel
  shows ZeroNode's refusal as is.

## Calls I made (Claude)

- The list is keyed by `podcastGuid` and does not read `<podcast:chat>`: every
  listed show already has its channel in the list, and MMO's channel is only in a
  non-spec attribute.
- The env variable as the switch, so the BMB PR can merge before the gateway exists.
- No automatic reconnect; join/part/quit lines hidden; only `/me` and `/nick`.
- The nick is remembered on the device; it is not filled from a Nostr profile.
- The phone layout above: a smaller cover and one row for transport and BOOST, only
  while the chat shows.
- The one-line privacy note under the nick box, and the panel staying after the feed
  marks the show ended.
- Tests use a local fake IRC server behind a local webircgateway (or a WebSocket fake
  of it), never ZeroNode; one manual test in `#candr` with Chad, and the phone
  keyboard on his iPhone and Pixel go on his To do list.

## Left to the builder

The gateway host name; the colour of nicks; the exact nick rule; whether the header
shows the channel's user count; how the client detects a page closing for good.
