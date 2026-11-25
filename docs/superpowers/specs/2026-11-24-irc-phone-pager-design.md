# The IRC chat on a phone: a pager you flick (design)

**Status:** approved by Chad on 2026-11-24 (he picked "B" from the clickable
mockup). Builds on #646 (`feat/irc-chat`, parked, beta only).

## Why

Chad, on his iPhone during MMO (2026-11-24): "The IRC chat on Boost Me Bitch
mobile is only basically two lines." His screenshot: the cover, a two-line
title, the LIVE row, the transport and BOOST, and the splits row fill the
full-screen player, and the message list gets about 100 CSS px. `e2e:irc`
measured 244 px at 390 x 844, because emulation spends no safe areas, the
fixture title is one line, and the fixture has no value block.

He named Podverse's player as the model: "a player and then you just kinda
flick … while still playing."

## Approaches (Chad saw all three as a clickable mockup)

- **A. A CHAT button** opens the chat over most of the screen, with a small
  bar (art, play/pause, BOOST) on top. Small cost, one press each way.
- **B. A pager (picked).** PLAYER · CHAT · PLAYED · ABOUT side by side; flick
  or tap the strip. Play/pause, the LIVE state and BOOST stay pinned at the
  bottom on every page. Medium cost.
- **C. Chat first.** A's two views, but a live show opens on the chat.
  Smallest cost.

## Goals

- On a phone, the chat list gets the screen: about 450 px or more on a
  393 x 852 iPhone with its safe areas, against about 100 px today.
- Flick or tap between the pages. Audio never stops or reloads, and the IRC
  session never leaves or joins again because of a page change.
- Play/pause, GO LIVE / TAP TO RESUME and BOOST are on screen on every page.

## Non-goals

- The computer layout (`sm:` and up) does not change.
- Normal episodes, music and Nostr live streams do not change.
- No change to the IRC session, the hold, or what the chat keeps (Chad's
  second ask — stay in the channel while another show plays — waits for his
  yes).

## Design

- **Only below `sm:` and only with the IRC chat** (`showIrc`: live, or joined and since ended). A media query
  (`(min-width: 640px)`) picks the tree; from `sm:` up the existing tree
  renders, unchanged.
- **`<IrcChat>` lives in a reverse portal** (`react-reverse-portal`, already
  used for the video): one `InPortal`, and an `OutPortal` in whichever tree
  shows. Unmounting it sends `QUIT`, so neither a page change nor a rotation
  across 640 px may unmount it.
- **The pager is a CSS scroll-snap row** (`snap-x snap-mandatory`,
  `snap-always`), so the flick is the browser's own. The strip above it is
  `<UnderlineTabs>`: a tap scrolls to the page, a scroll moves the underline.
  Pages: PLAYER (cover or video, title, splits), CHAT, PLAYED (only with
  rows), ABOUT (only with content). Off-screen pages are `inert`.
- **It opens on PLAYER**, the art first, like a normal live page; the listener
  flicks to CHAT (Chad, 2026-11-24, after the first build opened on CHAT: "I
  want the [art] to be the first thing people see"). A turn of the phone keeps
  the page; another show opens on PLAYER again. The `sm:` tabs keep CHAT first.
- **The pinned bar** is `<TransportControls size="lg" playOnly>`,
  `<LiveEdge variant="mini">` and BOOST. It hides while the composer has
  focus, so the composer sits at the overlay's bottom edge as it does today
  (the geometry iOS already handles with the keyboard up).
- **The cover on the PLAYER page** is capped by the height left on the page,
  not by the fixed 12.5rem the tabs layout used.

## Risk

A flick that starts at the very edge of the screen is the system Back gesture
in Safari and on Android. The open player is a history entry (#556), so that
Back closes the player; the audio and the chat go on. The iOS app has no edge
Back gesture.

## Verification

`e2e:irc -- --browser`, plus a section that stands up Chad's screen: 393 x 852,
`Emulation.setSafeAreaInsetsOverride` 59/34, the MMO channel, a two-line title
and a three-recipient value block. Measured before and after: the list height,
no sideways overflow, 24 x 24 targets, a flick each way and a tap on the strip,
no `QUIT` and no second `JOIN` at the fake server, one media element with no
new `loadstart`, and the bar hidden while typing. The 1280 x 800 checks must
stay green.
