# Community Playlists — listeners make musicL playlists on BMB

**Date:** 2026-11-12
**Status:** Approved by Chad, 2026-11-12

## Intent

Today the only playlists in BMB are ones somebody else built: ChadF's music-show
playlists (his publisher feed) and seven hand-picked "Community playlists" hosted
elsewhere (`COMMUNITY_PLAYLIST_URLS` in `lib/curated-playlists.ts`). A listener
who wants to put songs together has to go to another site.

This feature lets any signed-in listener build a playlist of songs inside BMB and
publish it. A published playlist is a real Podcasting 2.0 `musicL` feed: anyone
can play it in BMB, and any Podcasting 2.0 app can subscribe to its address. A
boost on a song still pays that song's artist, never the playlist maker.

## Decisions Chad made (2026-11-12)

These are settled. Do not revisit them in the plan.

1. **Entry point:** a MAKE PLAYLIST button next to BROWSE PLAYLISTS in the home
   page's Playlists section (PR #533 moved BROWSE PLAYLISTS into that section).
2. **Public:** every published playlist is public. Anyone can see and play it.
3. **BMB hosts the feed.** Not MSP — MSP stays for music albums and tracks only.
4. **Every feed address is on boostmebuddy.com**, whichever site the playlist was
   made on, because podcast apps and Podcast Index display the address and the
   other domain contains "bitch". Both deploys therefore save to ONE shared store.
5. **Ownership is a Nostr key.** No edit tokens (Chad rejected them). The maker
   signs in; only that key can edit or delete the playlist. **Only BMB's Google
   sign-in mints a new key** (`google-auth-panel.tsx`, backed up to Drive under a
   PIN); every other method — NIP-07, a bunker, Amber, the sign-in modal's
   "Generate" (a `nostrconnect://` pairing, not a key generator) — needs a key the
   listener already has. The session said otherwise at first; corrected after the
   builder check.
6. **Songs only.** No albums, no podcast episodes. No "add whole album" button.
7. **Songs come from two places:** a music search (album → its songs, one ADD
   per song) and the listener's own favorited songs.
8. **Playlist art:** an optional field labelled **PLAYLIST ART LINK** — an image
   URL the listener pastes. Square, 1400 × 1400 to 3000 × 3000 px, is
   preferred, not required (Chad, 2026-11-12: these feeds do not go to Apple,
   and BMB must not host listeners' pictures). The feed names the link itself.
   With no link, BMB makes the cover itself from the first four songs' covers
   (a 2 × 2 grid); BMB's own pages also fall back to it when the link breaks.
9. **Where it shows:** in the existing **Community playlists** section of
   `/playlists`, **immediately** on publish — no approval step.
10. **"ChadF's playlists" stays its own separate section**, unchanged.
11. **The maker's npub goes in the feed** as `<podcast:txt purpose="npub">npub1…</podcast:txt>`.
    It proves ownership and lets BMB find a person's playlists later, so nobody
    has to put their name in the title.
12. **Publish rules:** a title is required, and the playlist needs **at least 10
    songs**. Empty or broken playlists must not publish.
13. **No limit on how many playlists one key may publish.** Chad expects few
    users at first. The per-IP `rateLimit` every API route carries still applies.
14. **A word filter cleans the title** of offensive language. It does not block
    the publish ("I don't want to gatekeep"). The art cannot be checked
    automatically: Chad will look over new playlists himself and act after the
    fact.
15. **An admin page Chad signs into with Nostr**, with DELETE for a playlist and
    BAN for a Nostr profile (see Moderation).
16. **A boost note from a playlist song tags the maker and says which playlist it
    was heard on, with a link to it**, and keeps everything it says today about
    the track (see Boost notes from a playlist song).
17. **A boost note from a song in a BMB-made playlist uses Boost Me Buddy's words
    for everything, on both deploys**, because these playlists live on
    boostmebuddy.com and the note should be family-friendly (see Boost notes from
    a playlist song).
18. **Build and test on the beta site first.** Each piece lands as a PR, is added
    to beta.boostmebitch.com with `npm run beta -- add <PR>`, and is tested there
    by Chad before anything merges to `main`.
19. **Beta only, and no Podcast Index, for now** (Chad, 2026-11-12). The feature
    shows only on beta.boostmebitch.com until Chad turns it on for the main
    sites, even after its code merges to `main`; and no playlist is sent to
    Podcast Index — not from beta, and not from production either — until Chad
    turns that on separately. Both are switches, not code changes (see Launch
    switches).
20. **A listener can favorite a whole community playlist, and single songs in
    it** (Chad, 2026-11-12), from the playlist row, the open playlist's header,
    and each song's menu — the same hearts every other playlist has
    (`<FavHeart>` needs the playlist's `podcastGuid`; `<FavEpisodeHeart>` saves a
    song under the song's OWN feed, never the playlist). Until Podcast Index is
    told about these feeds (decision 19), other apps that read the kind:10333
    favorites list cannot resolve a favorited BMB playlist; BMB can, through its
    own guid lookup.

## Goals

- A signed-in listener can make, publish, edit and delete their own playlist.
- The published feed plays in BMB and in any Podcasting 2.0 app.
- It appears in Community playlists on both sites the moment it is published.
- Boosts and streaming sats from a playlist song pay that song's artist, exactly
  as they do from the existing community playlists.

## Non-goals

- Albums or podcast episodes inside a user playlist.
- A playlist made without signing in.
- An approval queue.
- Uploading an image file to BMB.
- Hosting on MSP, Blossom or nsite.
- Publishing the playlist as a Nostr event (MSP's kind 34139). The feed is the
  record; a Nostr copy can come later.
- A "playlists by this person" search page. The npub in the feed is there so that
  page can be built later; it is not part of this work.

## Anti-goals (a failure even if it "works")

- **A payee taken from the playlist.** The playlist is a container, not the parent
  of its songs. Its feed carries **no `<podcast:value>`**, and nothing about the
  playlist — its npub, title, art, URL or medium — may be copied onto a song or
  into a boostagram, or replace the song's own identity, link or art in a boost
  note. (The note does tag the maker and name the playlist — decision 16 — as an
  addition.) See CLAUDE.md, "A CONTAINER FEED IS NOT ALWAYS THE PARENT OF THE
  ITEMS IT LISTS", and "Only an RSS document names a payee".
- **"bitch" in any playlist feed address**, on either deploy.
- **A playlist anyone but its owner can change.**
- **A crude playlist on the family-friendly Buddy site with no way to take it
  down** (see Moderation: admin DELETE and BAN).
- **A feed address that later changes or dies while the playlist exists.** Podcast
  apps subscribe to it; treat the path shape as a permanent public contract, like
  `/api/og/boost.png`.

## The screens

A five-screen phone mockup (Chad's, private) shows this flow. In words:

1. **Home** — the Playlists section shows two buttons side by side: `♫ BROWSE
   PLAYLISTS` and `+ MAKE PLAYLIST` (the new one in the yellow "soft bolt" style,
   `.btn-bolt-soft`). Signed out, MAKE PLAYLIST opens the existing sign-in flow
   first.
2. **New playlist** (its own route) — the cover preview (the 2 × 2 grid until a
   link is given), TITLE (required), DESCRIPTION (optional), PLAYLIST ART LINK
   (optional, with the hint "Square is preferred, 1400–3000 px. Empty: BMB makes the cover from
   the first four songs."), then the song list with ↑ ↓ × per row and a
   `+ ADD SONGS` button, and a PUBLISH button pinned above the dock with "Signed in
   as [name]. Only you can change this playlist."
3. **Add songs — SEARCH tab** — a full-screen sheet with a DONE button and a
   "N in [title]" count. Tabs SEARCH | FAVORITES. The search runs the MUSIC lane
   (`/search/music/byterm`), which returns albums (feeds), not single songs — so a
   result opens the album and each song has `+ ADD` (turning into `✓ ADDED`). A
   line says "Pick songs one at a time. A whole album cannot go in."
4. **Add songs — FAVORITES tab** — the listener's favorited songs only (no albums),
   each with `+ ADD` / `✓ ADDED`.
5. **Published** — the cover, title, "by [name]", "♫ PLAYLIST · N TRACKS", PLAY /
   EDIT / SHARE, and the feed address with COPY, plus "Paste this address into any
   Podcasting 2.0 app to follow the playlist. It updates when you edit it."

## The feed document

One RSS 2.0 document per playlist, served from the boostmebuddy.com origin
(`https://www.boostmebuddy.com` — the `www` form, as `lib/brand.ts` explains). It
must be readable by `parsePlaylistRemoteItems` and the rest of BMB's existing
playlist path without changes to that path.

Channel content:

- `<title>` — the listener's title.
- `<description>` — the listener's description, or a fixed sentence when empty.
- `<podcast:medium>musicL</podcast:medium>`.
- `<podcast:guid>` — derived per the namespace rule (UUIDv5 of the feed URL with
  the scheme and trailing slashes removed, namespace
  `ead4c236-bf58-58c6-a2c6-a6b28d128cb6`). It never changes for the life of the
  playlist.
- `<podcast:txt purpose="npub">npub1…</podcast:txt>` — the owner's npub. `npub`
  is the spelling Podhome writes; `lib/feed-xml.ts` already reads it
  (`NOSTR_TXT_PURPOSES`).
- `<itunes:image href>` and `<image>` — the art link if valid, else the generated
  cover's URL (also on boostmebuddy.com).
- `<lastBuildDate>` — the later of the last publish and the last change to the feed template (`FEED_TEMPLATE_UPDATED_AT`, added 2026-11-13 so a push can update every feed at once).
- One `<podcast:remoteItem feedGuid itemGuid feedUrl medium="music"/>` per song,
  in the listener's order. No `<item>`.
- **No `<podcast:value>`.** No `<itunes:author>` (a free-text name on the Buddy
  domain is a moderation surface; the npub is the identity).

Every interpolated value is XML-escaped, attributes included (MSP shipped five
unescaped attributes once — see its CLAUDE.md).

## Songs: what may be added

A song is one item in a feed whose medium is `music`, identified by its feed's
`podcastGuid`, its own item guid, and its feed URL — the three things a
`<podcast:remoteItem>` needs. A candidate with any of the three missing cannot be
added (the same rule `<FavEpisodeHeart>` applies). Favorited **tracks inside a
`<podcast:valueTimeSplit>`** already carry a remote feed guid and item guid and are
songs too; a split whose `parentFeedGuid` is `null` (known unresolvable) is not.
Podcast episodes (`isMusicMedium` false) never appear in either tab.

## Publish rules

Checked in the browser for the message and **again on the server**, which is the
authority:

- Title: required, trimmed, non-empty. A length cap is the builder's call.
- Word filter (decision 14): the server masks offensive words in the title — and,
  as a call made in this session, the description, which podcast apps show the
  same way. Whole-word matching from a maintained library (for example
  `obscenity`), not a substring list, so a normal word that contains a bad one is
  left alone. The maker screen shows the cleaned text before PUBLISH, so nothing
  changes silently. It never refuses a publish.
- Songs: **at least 10**. An upper cap is required (it bounds feed size and any
  per-song fan-out); the number is the builder's call.
- Duplicate songs (same feed guid + item guid): the builder's call — refuse or
  collapse, but never publish a duplicate silently.
- Art link: optional. If present it must be `https://`, pass `httpUrl`, and be
  fetched once through `safeFetch` with a byte cap (`lib/capped-body.ts`); the
  image must decode (sharp), be **PNG or JPEG**, and be at least **300 px** on its
  shortest side. Any shape and transparency pass (changed 2026-11-12: Apple's
  square, no-alpha rule, podcasters.apple.com/support/5514, applies to Apple's
  directory only). A refusal names the reason on screen.

## Storage and ownership

- One store, shared by the two Vercel projects (`boostmebitch` and
  `boostmebuddy`), reached only server-side. Which store (a Vercel Blob store
  connected to both projects, a Postgres, …) is the builder's call; it needs
  per-playlist writes that cannot half-apply, and a newest-first listing.
- Each record holds: the playlist id (the feed path), the owner's pubkey, title,
  description, art link (or none), the ordered songs, created/updated times, and
  a hidden flag.
- **Every write is authorized by a NIP-98 HTTP auth event** (kind 27235) signed
  by the owner's key and checked server-side against the stored owner pubkey
  (and, on create, against the npub written into the feed). BMB has no NIP-98
  code today. Signing goes through the existing signer layer (`signEvent`) so
  every signer kind works — NIP-07, NIP-46 bunker, Amber, the local key — and
  `docs/signers.md` must be read first (Amber's `?` rule applies to the event's
  `u` tag URL).
- The owner can **edit** (the maker screen, prefilled) and **delete**. A deleted
  playlist leaves the listing; what its feed address answers afterwards is the
  builder's call (410 is the honest answer).

## Listing: Community playlists

- `/playlists` keeps its two sections. "ChadF's playlists" is untouched.
- **Community playlists** lists BMB-made playlists, **newest first**, followed by
  the existing seven `COMMUNITY_PLAYLIST_URLS`.
- Its blurb ("Built on other hosts, and mostly by other people in the V4V
  community.") is no longer true for every row and must change.
- The search box's Playlists lane (`searchCuratedPlaylists`, `lib/curated-roster.ts`)
  finds BMB-made playlists too.
- On rows the signed-in listener owns, an EDIT control.
- Both deploys show the same list (one store).

## Moderation

There is no approval. Chad asked what a "bad playlist" is; the answer recorded
in this session: crude words, an offensive art link, spam — cases only a person
can judge — plus empty or broken playlists, which the publish rules above refuse
automatically.

Chad will review new playlists himself and does not want to gatekeep (decision
14). He does not expect inappropriate content — every song is music already in
the index — but anyone can publish any music, so he wants the tools "in case I
need it". BMB has **no admin page and no notion of an admin today**. Decided
2026-11-12:

- **An admin page** (for example `/admin`, with playlists as its first and only
  section for now) that Chad signs into with Nostr. It is meant to hold later admin
  tools too. The server accepts an admin action only from an admin npub, proved by
  a NIP-98 event on that request; the page itself is harmless to anyone else.
  Where the admin npub list lives (a constant pinned by a check, or a server env
  var on both Vercel projects) is the builder's call.
- **List** every community playlist made on BMB, newest first: art, title,
  description, the maker's npub (and kind:0 name where it resolves), song count,
  published time.
- **DELETE** a playlist. It leaves the listing on both sites and its feed address
  stops serving the content (410 Gone). This replaces the HIDE idea discussed
  earlier: Chad described deleting, not hiding.
- **BAN** a Nostr profile (pubkey) from making playlists. The server refuses every
  publish and edit signed by a banned key, with a plain message. The admin page
  lists banned keys with UNBAN. Banning does not delete that person's other
  playlists by itself; the page offers deleting them in the same step (a call
  made in this session).
- Podcast Index is still told at first publish (no gatekeeping); a delete
  notifies PI too (`/hub/pubnotify`).

## Podcast Index

**Off for now (decision 19).** When Chad turns it on: on first publish the feed
is submitted to Podcast Index, and on each edit or delete PI is notified
(`/hub/pubnotify` — MSP-2.0's `api/pubnotify.ts` already does this). The builder
must confirm BMB's PI key may add feeds. A failure here never fails the publish.
Tests never submit to the real index.

## Launch switches

Two environment switches, both OFF unless set:

- `NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on` — shows the feature: the MAKE PLAYLIST
  button, `/playlists/make`, `/admin`, BMB-made rows in Community playlists and in
  the search lane, and the API and feed routes (which answer 404 when it is off).
  Set only on the boostmebitch project's Preview environment (beta) for now.
- `COMMUNITY_PI_NOTIFY=on` — lets the server tell Podcast Index. Set nowhere for
  now, and it only acts on the production Buddy feed origin even when set.

A call made in this session: playlists made on beta are test data. Their
addresses are on beta.boostmebitch.com. At launch, Chad decides whether to copy
them to the production store; a copy gets new boostmebuddy.com addresses.

## Constraints from this repo

Read `CLAUDE.md` and the `docs/` it points to before the plan. The ones this work
touches:

- **New API routes:** `rateLimit` first, `readCappedRequestJson` for bodies,
  `Cache-Control` on 200s only, `withErrorHandling` fallback messages.
- **Brand:** names come from `BRAND` (`lib/brand.ts`). The feed origin is the
  Buddy origin on **both** deploys, so it is NOT `BRAND.origin` — it needs its own
  constant, and `check:brand` should pin it.
- **Art display inside BMB** goes through `/api/art` like every cover.
- **Favorites** are read from the store (`favorites`, `favoriteEpisodes`), never
  re-fetched or re-published by this feature.
- **`lib/util.ts` stays type-only in its imports.**
- **Testing:** per `docs/testing.md`, drive it through `scripts/cdp.mjs` with a
  throwaway local key and a non-production store; mobile layout under CDP device
  emulation; every control ≥ 24 × 24.

## Boost notes from a playlist song

Decided by Chad, 2026-11-12. When a listener boosts a song they reached through a
playlist and the boost is shared to Nostr:

- **The note keeps everything it says today about the track** — the song, the
  artist, the amount, the message, the episode link and its unfurl. The playlist
  never replaces any of it (the container rule).
- **The playlist maker is tagged.** The code already does this: `previewPodcastFromChannel`
  reads `<podcast:txt purpose="npub">` into `podcast.nostrNpubs`, the playlist is
  the `podcast` handed to `<BoostModal>`, and `noteNpubs` (`lib/nostr/boost-notes.ts`)
  adds the podcast's npubs after the episode's. That stays, on a site-signed
  Anonymous note too (`mention-tags.ts`), and `check:npub` / `check:mentions`
  must stay green.
- **The note says which playlist it was heard on**, with a link that opens that
  playlist in BMB — a line such as "Heard on [playlist title] by @[maker]". The
  link uses the deploy's own `BRAND.origin`, like every other link a boost note
  carries. The title in it is the word-filtered one.
- **The playlist link must not become the note's preview.** `episodeLinkInNote`
  (`check:notelink`) decides which URL a note card unfurls to; adding a second
  URL to the body must leave the song's episode as that target. Add a vector for
  it.
- A note is a signed kind:1 that can never be edited, so the line's wording is
  part of the review.

### Buddy wording (decision 17)

For a boost from a song in a **BMB-made** playlist, every brand-specific part of
the Nostr note is the Buddy one, whichever deploy sent it:

- the BMB landing link (`bmbLandingUrl`) and the "Heard on" playlist link — on
  `https://www.boostmebuddy.com`;
- the note picture — `/api/og/boost.png` on the Buddy origin (the same permanent
  path and parameters; the Buddy deploy serves the same route);
- the default sender name — `boostmebuddy.com user`;
- the `client` tag — `BoostMeBuddy`;
- the author of a signed-out or Anonymous (site-signed) note — the Buddy site
  identity (`BRAND.siteNpub` of Buddy).

Only the Nostr note changes. The boostagram (TLV `7629169`, `app_name`) still
names the deploy that actually paid, which `lib/brand.ts` requires.

A call made in this session for the site-signed case: the bitch deploy asks the
**Buddy deploy's** `/api/nostr/site-sign` route (already public, rate-limited)
to sign, so the bitch deploy never holds the Buddy `SITE_NOSTR_SK` — the
one-key-per-deploy rule in CLAUDE.md stays true. The builder must check what that
route validates (origins, lengths) before relying on it. Which brand each note
takes must be pinned by a check (`check:brand` or `check:notelink`), because a
mistake publishes the other brand's words in a kind:1 that cannot be edited.

Boosts from ChadF's playlists and the existing seven community feeds keep the
deploy's own brand.

### Which playlists get the "Heard on" line

A call made in this session: this applies to a boost from **any** playlist
container — ChadF's, the existing seven community feeds, and BMB-made ones — not
only to BMB-made playlists. A playlist feed with no npub gets the "Heard on" line
and no tag. The boostagram (TLV) is out of scope; only the Nostr note changes.

## Calls made in this session (Chad may overrule)

- Newest first in Community playlists, above the existing seven.
- **Beta and PR previews never write to the production store.** They use a
  separate test store, never submit to Podcast Index, and give test playlists
  addresses on their own origin. Every link a boost note carries for a
  test-store playlist (the "Heard on" link, the landing link) points at that test
  origin too, never at boostmebuddy.com, where the playlist does not exist. Only the two production deploys share the
  production store and write boostmebuddy.com addresses. (beta.boostmebitch.com
  serves the `beta` branch with real data otherwise — see
  `2026-11-02-beta-site-design.md`.)
- **No new key-making sign-in.** A listener without Nostr uses Google sign-in,
  whose key is backed up; a bare generated key is lost with browser storage, and
  its owner could never edit the playlist again. Both Vercel projects need the
  Google client id for that path.
- **Build on top of PR #533**, which moved BROWSE PLAYLISTS into the Playlists
  section; it is not merged yet.
- No `<itunes:author>`; no `<podcast:value>`.
- The maker screen is its own route; ADD SONGS is a full-screen sheet.
- `.btn-bolt-soft` for MAKE PLAYLIST.

## Left to the builder

The store; the feed path shape under boostmebuddy.com (permanent once shipped);
the route for the maker screen; the title/description length caps; the song cap;
duplicate handling; how the generated cover is made, sized (it must itself meet
1400–3000 square) and refreshed when the first four songs change; caching of the
feed and the listing; what a deleted feed answers.
