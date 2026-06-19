# Boost Me Bitch — Podcast Boost Station

Search, listen, and **boost** Podcasting 2.0 shows — and **watch + boost Nostr live streams** — over Lightning.
Sign in with Nostr (NIP-07, Amber, or a NIP-46 bunker). Pay via **NWC, Spark, WebLN, or Lightning Address**.
**Boosts publish a kind:1 note** to Nostr with NIP-73 podcast refs; **live-stream boosts go out as real NIP-57 zaps** so they show up as boosts in Fountain / tunestr / zap.stream.
Favorite shows and mute accounts sync across any Nostr-aware client via NIP-51. Installable PWA, light + dark.

Live at <https://boostmebitch.vercel.app>.

```
Stack:    Next.js 15 · React 19 · Tailwind · Zustand
Wallets:  @getalby/sdk (NWC) · @buildonspark/spark-sdk (Spark) · window.webln · LNURL-pay / NIP-57 zaps
Identity: nostr-tools + window.nostr (NIP-07 / Amber NIP-55 / NIP-46 bunker / NIP-65 / NIP-51)
Video:    hls.js + react-reverse-portal (HLS live streams)
Data:     Podcast Index API (server-side proxy) + Nostr relays
Deploy:   Vercel zero-config
```

---

## Setup

```bash
npm install
cp .env.example .env.local
# add your Podcast Index key + secret  (the Spark rail needs NO API key)
npm run dev
```

Get Podcast Index keys at <https://api.podcastindex.org/>.

Checks (no test runner): `npm run typecheck` (`tsc --noEmit`, strict) · `npm run lint` (ESLint 9 flat config) · `npm run build`.

## Deploy to Vercel

```bash
vercel
# env vars in the dashboard:
#   PODCAST_INDEX_KEY
#   PODCAST_INDEX_SECRET
#   APP_NAME=boostmebitch        (optional — User-Agent default)
#   BOOSTBOX_URL / BOOSTBOX_API_KEY   (optional — BoostBox LNURL metadata proxy)
```

Podcast Index credentials live only in API routes (`app/api/*`) so they never reach the browser. The Spark SDK talks straight to Spark's signing operators, so it needs no key.

---

## Features

- **Search** Podcast Index and play any episode (native HTML5 `<audio>`, no proxy).
- **V4V boosts** over three rails — **NWC** (NIP-47), **Spark**, or **WebLN** — to keysend nodes *or* Lightning addresses, with per-recipient value splits and a Podcasting 2.0 boostagram.
- **Nostr live streams** — a "Live on Nostr" row of kind:30311 streams; watch HLS video in-app; **live chat** (kind:1311) and **boosts/zaps** (kind:9735) rendered together; a shareable `/stream/<naddr>` page.
- **Boost-all tracks** — split a boost across every `valueTimeSplit` remote item on a music episode.
- **Favorites** (NIP-51 kind:30003) and **mutes** (NIP-51 kind:10000) that sync across Nostr clients.
- **Discussion threads** (`podcast:socialInteract`) and global / per-podcast / per-episode **Nostr feeds**.
- **Music albums** render as albums (play overlay, tracklist, track order).
- **Installable PWA**, **light/dark** themes.

---

## Architecture

```
app/
  api/search/            → /search/byterm                      (PI proxy)
  api/feed/              → /podcasts/byfeedid + /episodes/byfeedid + RSS enrichment
  api/by-guid/           → /podcasts/byguid                     (favorites hydration)
  api/value-splits/      → resolve valueTimeSplit remote items  (PI + RSS fallback)
  api/publisher/         → publisher feed → album children
  api/lightning/boostbox → BoostBox LNURL metadata proxy
  layout.tsx             → bg art layer + OG metadata + FOUC theme blocker + <Player>
  page.tsx               → search, favorites, live-streams row, global feed; URL-restored views
  stream/[naddr]/        → standalone live-stream page (opens the layout player)
components/
  player · fullscreen-player · transport-controls   → shared <audio>/<video>, mini + fullscreen
  nostr-live-streams · live-chat                     → kind:30311 cards, kind:1311/9735 chat
  wallet-modal · nwc-wallet · spark-wallet · webln-wallet · wallet-balance
  nostr-auth/  (index · sign-in-modal · login-methods · account-menu · muted-accounts)
  global/podcast/episode-nostr-feed · nostr-note-card · episode-social-thread · discussion-view
  boost-modal/ (index · amount-input · message-input · sender-name · splits-preview · publish-status)
  boost-all-modal · boost-card · lists · search-bar · podcast-cover · avatar · icons · theme-toggle
lib/
  pi.ts          → Podcast Index server client (SHA1 auth, RSS enrichment)
  store.ts       → Zustand: identity, current, player/view state, favorites, mutes
  storage.ts     → typed localStorage accessors for every bmb:* key
  types.ts · util.ts  (isMusicMedium, hasValueRecipients, isHlsUrl, fnvHash, getErrorMessage)
  format.tsx     → fmt/fmtDuration/fmtClock/fmtLiveTime/timeAgo, linkify, confetti
  nostr/
    auth · signer · amber · bunker        → NIP-07 / NIP-55 / NIP-46 sign-in + window.nostr swap
    pool · publish · relays · profile     → SimplePool wrapper, signAndPublish, relay sets, kind:0
    discover · event-queries · use-feed   → feed assembly, queries, stale-while-revalidate hook
    boost-notes · interactions            → kind:1 boost notes, replies/reposts
    favorites · mutes · *-hydrator        → NIP-51 kind:30003 / kind:10000
    live-streams · live-chat              → kind:30311 streams, kind:1311 chat + kind:9735 zaps
    wallet-backup · settings-backup       → NIP-44 encrypted-to-self (Spark seed, NWC, settings)
  v4v/
    boost.ts     → orchestrator: split sats, pick rail, keysend/lnaddress, TLV routing
    zap.ts       → NIP-57 zap (kind:9734 → kind:9735 receipt) — used for note + live-stream boosts
    nwc.ts · spark.ts · webln.ts          → the three rails
    lnaddr.ts · bolt11.ts · boostbox.ts · wallets.ts
public/
  hero.jpg · manifest.json · sw.js · icons/ · splash/
```

`lib/v4v/*` and `lib/nostr/` are the **only** files that talk to wallets / signers; components import them through the `lib/nostr/` barrel and the `lib/v4v/*` entry points, so the toolkit can be swapped without touching `components/`.

---

## Boost flow

Entry points: **⚡ BOOST in the player** (current episode, `ts` = playback position), **⚡ BOOST on the show header** (channel-level value block, `ts: 0`), **⚡ per-track** on music rows, and **⚡ BOOST N TRACKS** (boost-all). All open a modal that computes splits from the value block and pays.

**Rail.** `pickRail()` honors the user's last-used rail (`storage.railPref`), else priority **NWC > Spark > WebLN**. Per recipient:

- **`type=node`** → keysend with TLV record `7629169` carrying the boostagram JSON. Per-recipient `customKey`/`customValue` (e.g. shared-node sub-account routing for getalby.com) is a separate TLV record. (Spark can't keysend — node legs are rejected on the Spark rail.)
- **`type=lnaddress`** → LNURL-pay invoice fetch (amount-verified against the BOLT11 before paying), then pay via the chosen rail.

Per-recipient progress + errors render live; confetti fires when a leg lands. **If signed in and at least one payment landed**, a kind:1 boost note is published.

**Live-stream boosts → real zaps.** When you boost a Nostr live stream signed-in, with an active signer and a host whose Lightning address supports NIP-57 (checked *before* paying, so no double-pay), the boost is sent as a real **zap** (`sendZap`, `lib/v4v/zap.ts`) tagged to the stream — the recipient's LN service then publishes a kind:9735 receipt that renders as a boost in Fountain / tunestr / zap.stream **and** in BMB's chat. Otherwise it falls back to a normal boostagram payment plus a kind:1311 "⚡ Boosted N sats" chat line.

### WebLN customRecords vs NWC tlv_records

These look symmetric but the wire formats differ:

- **WebLN** (`weblnKeysend`): `customRecords` values are **plain UTF-8 strings** — the extension hex-encodes internally. Pre-hexing double-encodes and Helipad can't `JSON.parse` the boostagram.
- **NWC** (`pay_keysend`): `tlv_records` values are **hex-encoded** per NIP-47.

`tlvHexFor` (NWC) and `recordsForKeysend` (WebLN) in `lib/v4v/boost.ts` apply the right encoding per rail.

---

## Nostr live streams (NIP-53)

A **"Live on Nostr"** row surfaces kind:30311 streams (`fetchNostrLiveStreams`), dropping stale `live` events (no `ended` update within 2h) and sorting upcoming-first then newest. Everything is the shared NIP-53 standard, so it interoperates with **Fountain, tunestr, and zap.stream** — only relay coverage varies.

- **HLS video** plays in-app via `hls.js` (dynamic-imported; native HLS on Safari). A single `<video>` lives in a **reverse portal** so it moves between the mini-bar and the fullscreen pane without remounting (audio keeps playing when collapsed). Non-HLS media stays on the native `<audio>`.
- **Dedicated route** `/stream/<naddr>` — a shareable page that fetches the stream and opens the player, so a refresh restores it. `<Player>` is mounted in the root layout, so playback survives the browse ↔ stream navigation.
- **Live chat** subscribes to **kind:1311** (chat) **and kind:9735** (zap receipts / boosts) for the stream. Both render in one row list; zaps get a `⚡ N sats` badge, and a **total-sats-zapped** line shows at the top. New messages re-sync periodically and on focus (relay subscriptions go stale when a device backgrounds). Signed-in users can post (kind:1311).

---

## Boostagram TLV (record 7629169)

Podcasting 2.0 fields, plus Nostr-aware additions — drops into Helipad / Fountain / Castamatic ingestion without mapping:

| Field | Source | Notes |
| --- | --- | --- |
| `app_name`, `app_version` | hard-coded | `"BoostMeBitch"`, `"0.1.0"` |
| `podcast`, `episode` | feed / stream | `episode` omitted on show-level boosts |
| `feedID`, `itemID` | Podcast Index | omitted on show-level boosts |
| `url` | feed metadata | RSS feed URL (Helipad reads this) |
| `ts` | playback position | `0` on show-level / live boosts |
| `value_msat`, `value_msat_total` | per-leg / total | both in millisats |
| `message` | user input | optional |
| `sender_name` | Nostr `display_name` / `name` | auto-filled at login, editable |
| `sender_id` | Nostr pubkey hex | omitted when not signed in |
| `action`, `uuid` | hard-coded / `crypto.randomUUID()` | one uuid per boost — Helipad groups legs by it |
| `remote_feed_guid`, `remote_item_guid` | `<podcast:guid>` / item guid | NIP-73 refs; carry the **stream** for live-stream / boost-all legs |

We emit the boostagram in TLV `7629169` only — never a separate `696969` sender record (it collides with shared-node sub-account routing). LNURL legs put the boostagram message in the LUD-21 `comment`; BoostBox legs prepend their `rss::payment::boost` desc.

---

## Nostr boost note (kind:1)

| Tag | Value |
| --- | --- |
| `i`, `k` | `podcast:guid:<feed-guid>` + `k=podcast:guid` (NIP-73) |
| `i`, `k` | `podcast:item:guid:<item-guid>` + `k=podcast:item:guid` (omitted on show-level boosts) |
| `r` | listen link (`pod.link/<itunesId>` → PI page → RSS) **and** a `boostmebitch.com/?podcast=<guid>` deep link |
| `amount` | total millisats *intended* (not sum of successful legs) |
| `client` | `BoostMeBitch` |
| `t` | `boostagram` + `value4value` |

`pod.link/<itunesId>` smart-links a click to the visitor's podcast app; `lib/nostr/boost-notes.ts:podcastLandingUrl` falls back to PI then RSS.

**Where it publishes.** `resolvePublishRelays(identity)`: a manual `localStorage.bmb:relays` override, else the user's NIP-65 (kind:10002) write relays **unioned with the defaults** (so a note still lands when the write relays are dead/AUTH-gated). Capped at 20. Defaults:

```
wss://relay.damus.io · wss://relay.primal.net · wss://nos.lol · wss://relay.nostr.band · wss://relay.fountain.fm
```

---

## Wallets

Configured in the account menu's **wallet modal** (`components/wallet-modal.tsx`); a balance chip reads the active rail.

- **NWC** (NIP-47, `@getalby/sdk`) — paste a connection URI. Optionally **back it up encrypted to Nostr** (kind:30078, NIP-44 to-self) so it restores on other devices; opt-in and deletable.
- **Spark** (`@buildonspark/spark-sdk`) — paste/create/restore a seed; **no API key**. The mnemonic is stored **encrypted to Nostr** (kind:30078) for silent restore. Account number matches Primal/BlitzWallet so the same seed shows the same balance.
- **WebLN** — the injected extension (Alby), enabled on demand (we never call `wl.enable()` speculatively).

---

## Signers

`window.nostr` is the single interface; three paths feed it (swapped by `lib/nostr/signer.ts`):

- **NIP-07** browser extension (Alby, nos2x, nostash on iOS).
- **Amber** (NIP-55) on Android — `nostrsigner:` URL scheme + clipboard round-trip.
- **NIP-46 bunker / `nostrconnect://`** remote signer (nsec.app, Clave, Amber-as-bunker, Primal).

One **"Sign in with Nostr"** button opens a two-tab modal (Extension / Remote signer). `nostr-tools` is pinned to **exactly `2.19.4`** — `2.20.0+`'s NIP-46 rewrite breaks the `nostrconnect://` handshake on our relays.

---

## Favorites + Mutes (NIP-51)

- **Favorites** (kind:30003, `d:boostmebitch:favorites`) — ♡ on a podcast row. One `i: podcast:guid:<guid>` per favorite; visible in any NIP-51 client. Optimistic + debounced publish; a per-npub localStorage cache renders the Favorites panel instantly.
- **Mutes** (kind:10000) — 🚫 on a note card. Interoperates with Damus/Amethyst; new mutes go to the private (NIP-04-encrypted) list, and an unreadable private blob from another client is preserved verbatim. Filtered at render time across all feeds.

---

## PWA + themes

Installable (`public/manifest.json` + `public/sw.js` + `<SwRegister>`); the service worker has **no precaching** (hashed bundle URLs would go stale) — its empty `fetch` handler just enables the install prompt. Light/dark via role-based CSS tokens (`--ink`, `--bone`, `--bolt`, …) flipped on `:root[data-theme='light']`; a FOUC blocker sets the theme before first paint.

---

## Notes / gotchas

- The page background lives on `<html>`, not `<body>` (a `<body>` bg paints over the fixed hero image). `html, body` use `overflow-x: clip` (not `hidden`) so the sticky header actually sticks.
- Podcast artwork uses `<img>` (not `next/image`) — arbitrary per-feed hosts. The local hero uses `next/image`.
- Boost button glyph is an inline SVG (`BoltIcon`) — the `⚡` emoji is invisible on the yellow `btn-bolt`.
- Native HTML5 `<audio>` plays the enclosure URL directly; the one exception is HLS (`.m3u8`) live streams, which go through `<video>` + `hls.js`.
- Wallet creds + Spark seed live in `localStorage` (and, opt-in, encrypted on Nostr) — nothing wallet-related is sent to our server.
- Nostr publish is opt-in per boost; **Lightning is sent first**, the note/zap only fires after a payment lands — no false "I boosted" posts.

## Roadmap-ish

- Relay-list management UI (the `bmb:relays` override has no UI yet).
- Helipad-style boost-log view fed by your own boost notes.
- NIP-51 favorite categories ("podcasts I host", "music I love").
