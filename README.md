# Boost Me Bitch — Podcast Boost Station

Search, listen, and boost Podcasting 2.0 shows over Lightning.
Sign in with Nostr (NIP-07). Pay via NWC (NIP-47), WebLN, or Lightning Address.
**Boosts publish a kind:1 note to Nostr** with NIP-73 podcast refs so they land in the social graph.
Favorite shows sync across any Nostr-aware client via NIP-51.

Live at <https://boostmebitch.vercel.app>.

```
Stack:    Next.js 15 · React 19 · Tailwind · Zustand
Wallets:  @getalby/sdk (NWC) · window.webln · LNURL-pay
Identity: nostr-tools + window.nostr (NIP-07 / NIP-65 / NIP-51)
Publish:  nostr-tools SimplePool → user's NIP-65 write relays
Data:     Podcast Index API (server-side proxy)
Deploy:   Vercel zero-config
```

---

## Setup

```bash
npm install
cp .env.example .env.local
# add your Podcast Index key + secret
npm run dev
```

Get keys at <https://api.podcastindex.org/>.

## Deploy to Vercel

```bash
vercel
# add env vars in dashboard:
#   PODCAST_INDEX_KEY
#   PODCAST_INDEX_SECRET
#   APP_NAME=boostmebitch        (optional — User-Agent default)
```

The Podcast Index credentials live in API routes (`app/api/search/route.ts`, `app/api/feed/route.ts`, `app/api/by-guid/route.ts`) so they never reach the browser.

---

## Architecture

```
app/
  api/search/    → /search/byterm                (PI proxy)
  api/feed/      → /podcasts/byfeedid + /episodes/byfeedid
  api/by-guid/   → /podcasts/byguid              (favorites hydration)
  layout.tsx     → site-wide bg art layer + OG metadata
  page.tsx       → search + favorites panel + episode list + sticky player
components/
  nostr-auth         → NIP-07 sign-in, kind:0 / kind:10002 / kind:30003 hydration
  search-bar         → debounced query
  lists              → search results, favorites panel, episode list,
                       PodcastRow (shared row), FavHeart toggle
  player             → bottom-fixed audio + per-episode boost trigger
  icons              → BoltIcon (SVG; used on yellow buttons)
  boost-modal/
    index            → orchestrator: state + go() + modal chrome
    rail-picker      → NWC / WebLN selector + paste-URI flow
    amount-input     → numeric field + 4 preset buttons
    message-input    → boostagram textarea (200 chars)
    sender-name      → From input + signed-as indicator
    nostr-share-toggle → opt-in checkbox + relay-source label
    splits-preview   → per-recipient list with ✓/✗
    publish-status   → idle / publishing / done / error states
lib/
  pi.ts          → Podcast Index server client (SHA1 auth, buildPodcast factory)
  store.ts       → Zustand: identity + current episode + favorites
  storage.ts     → typed localStorage accessors for every bmb:* key
  types.ts       → shared types (Podcast, Episode, ValueBlock, Boostagram,
                   BoostResult, FavoritePodcast)
  util.ts        → getErrorMessage(e, fallback)
  nostr/
    index.ts        → barrel re-export
    auth.ts         → loginWithExtension, shortNpub, identity types,
                      window.nostr / window.webln globals
    pool.ts         → withPool(relays, fn) — SimplePool lifecycle wrapper
    publish.ts      → signAndPublish(template, relays) — used by both
                      boost notes and favorites
    profile.ts      → fetchProfile (kind:0)
    relays.ts       → DEFAULT_RELAYS, fetchRelayList (kind:10002),
                      resolvePublishRelays
    boost-notes.ts  → publishBoostNote (kind:1), formatContent,
                      podcastLandingUrl
    favorites.ts    → fetchFavoriteGuids / publishFavorites (kind:30003),
                      schedulePublishFavorites (debounced)
  v4v/
    boost.ts     → orchestrator: split sats, pick rail, fire payments,
                   per-recipient customKey/customValue routing
    nwc.ts       → NIP-47 via @getalby/sdk
    webln.ts     → window.webln
    lnaddr.ts    → LNURL-pay invoice fetch (for type=lnaddress)
public/
  hero.jpg       → 16:9 collage art, used as fixed bg + OG image
```

---

## Boost flow

There are two entry points:

- **⚡ BOOST in the player** — boosts the currently-playing episode. `ts` carries the playback position.
- **⚡ BOOST on the show header** — boosts the channel-level value block without playing anything (`ts: 0`, no episode-level fields in the boostagram).

Either path opens the same modal:

1. Modal computes splits from `episode.value.recipients` (or `podcast.value.recipients` for show-level).
2. User picks rail — NWC takes priority if a URI is saved, else WebLN.
3. For each recipient:
   - `type=node` → keysend with TLV record `7629169` containing the boostagram JSON.
     Per-recipient `customKey`/`customValue` from the value block (e.g. shared-node sub-account routing for `getalby.com`) is attached as a separate TLV record.
   - `type=lnaddress` → LNURL-pay invoice fetch, then pay via the chosen rail.
4. Per-recipient progress + errors render live; bolt-yellow / nostr-magenta confetti fires when at least one leg succeeds.
5. **If signed in with Nostr and at least one payment landed**, a kind:1 note is signed via NIP-07 and broadcast to the user's NIP-65 write relays.

### WebLN customRecords vs NWC tlv_records

These look symmetric but the wire formats are different:

- **WebLN** (`weblnKeysend`): `customRecords` values are **plain UTF-8 strings**. The Alby/Mutiny extensions hex-encode internally before transmission. Pre-hexing here causes double-encoding and Helipad can't `JSON.parse` the boostagram.
- **NWC** (`pay_keysend`): `tlv_records` values are **hex-encoded** per NIP-47 spec.

`tlvHexFor` (NWC path) and `recordsForKeysend` (WebLN path) in `lib/v4v/boost.ts` apply the right encoding for each rail.

---

## Boostagram TLV (record 7629169)

Castamatic-shape Podcasting 2.0 fields, plus Nostr-aware additions:

| Field | Source | Notes |
| --- | --- | --- |
| `app_name` | hard-coded | `"BoostMeBitch"` |
| `app_version` | hard-coded | `"0.1.0"` |
| `podcast`, `episode` | feed metadata | `episode` omitted on show-level boosts |
| `feedID`, `itemID` | Podcast Index | `itemID` omitted on show-level boosts |
| `url` | feed metadata | RSS feed URL (Helipad reads this) |
| `ts` | playback position | `0` on show-level boosts |
| `value_msat`, `value_msat_total` | per-leg / total | both in millisats |
| `message` | user input | optional; omitted when empty |
| `sender_name` | Nostr `display_name` / `name` | auto-filled at login, user-editable |
| `sender_id` | Nostr pubkey hex | omitted when not signed in |
| `action` | hard-coded | `"boost"` |
| `uuid` | `crypto.randomUUID()` | one per boost — Helipad groups multi-leg boosts by this |
| `name` | per-recipient (set in `payOne`) | recipient label, e.g. `"Spencer"` |
| `remote_feed_guid` | `<podcast:guid>` | NIP-73 canonical feed ID |
| `episode_guid`, `remote_item_guid` | RSS `<guid>` | both set so any aggregator key works |

The shape is designed to drop into Helipad / Fountain / Castamatic / BoostBot ingestion without further mapping.

---

## Nostr boost note (kind:1)

| Tag | Value |
| --- | --- |
| `i`, `k` | `podcast:guid:<feed-guid>` + `k=podcast:guid` (NIP-73) |
| `i`, `k` | `podcast:item:guid:<item-guid>` + `k=podcast:item:guid` (NIP-73, omitted on show-level boosts) |
| `r` | `https://pod.link/<itunesId>` if known, else PI page, else RSS URL |
| `amount` | total millisats *intended* (not sum of successful legs) |
| `client` | `BoostMeBitch` |
| `t` | `boostagram` + `value4value` |

Auto-formatted body:

```
⚡ Boost ⚡

[boostagram message, if any]

Boosted 500 sats → [podcast title]
📻 [episode title]               # omitted on show-level boosts

https://pod.link/<itunesId>
```

After publish, the modal shows accepted/total relay counts and a `view note ↗` link to njump.me.

### Why pod.link for the link

`pod.link/<itunesId>` is a smart-link service that auto-routes a click to the visitor's preferred podcast app (Apple Podcasts, Castamatic, Fountain, Overcast, …). Far better landing experience than a raw RSS URL. iTunes IDs come from Podcast Index. `lib/nostr/boost-notes.ts:podcastLandingUrl` falls back to `podcastindex.org/podcast/<feedId>` if there's no iTunes ID, then RSS as a last resort.

### Where it publishes

`resolvePublishRelays(identity)` resolves the publish target in this order:

1. Manual override at `localStorage.bmb:relays` (JSON array) — used as an escape hatch, no UI yet.
2. The user's NIP-65 (kind:10002) write relays, fetched at login.
3. `DEFAULT_RELAYS`:
   ```
   wss://relay.damus.io
   wss://relay.primal.net
   wss://nos.lol
   wss://relay.nostr.band
   ```

Capped at 20 relays to keep publish latency bounded.

---

## Favorites (NIP-51 kind:30003)

Heart icons next to each podcast row toggle a per-user favorites set. Storage is split:

- **Authoritative source:** a NIP-51 kind:30003 ("bookmark set") event with `d`-tag `boostmebitch:favorites` and one `i: podcast:guid:<guid>` + `k: podcast:guid` per favorite. Visible in any NIP-51-aware client (Habla, Nostrudel) under your bookmark sets.
- **Local cache:** `localStorage.bmb:favorites:<npub>` (or `:guest`) holds the full `FavoritePodcast` metadata so the "Favorites" panel renders instantly without re-resolving GUIDs against PI.

Toggle UX is optimistic — Zustand + localStorage update immediately. The Nostr publish is debounced 1.5s via `schedulePublishFavorites` so rapid hearting collapses into a single signing prompt.

On login the cache is reconciled with the Nostr event using last-write-wins on `created_at` vs the newest local `addedAt`. Unknown GUIDs get resolved through the new `/api/by-guid` route (which proxies Podcast Index `/podcasts/byguid`).

---

## Setup checklist for a real boost

You need:

- A NIP-07 extension (Alby, nos2x) **or** any signer your browser surfaces as `window.nostr`. Required for sign-in and boost-note signing.
- A Lightning wallet that supports **either**:
  - **NWC** with TLV passthrough — Alby Hub on a real LND, ideally. Some hosted NWC services strip TLVs and Helipad receives bare keysends with no metadata; if that happens to you, switch to WebLN.
  - **WebLN** with `keysend` — Alby browser extension.
- (Optional) A NIP-65 (kind:10002) relay list event published to one of the default relays so your boost notes land where your followers actually look. Without one, we publish to the four defaults.

---

## Swapping in `v4v-toolkit`

`lib/v4v/*` and `lib/nostr/` are the only files that talk to wallets / signers. Components import only from these entry points, so swapping is contained:

- `lib/v4v/boost.ts` → `v4v-toolkit`'s boost orchestrator if it exposes one (`splitSats`, `sendBoost`).
- `lib/v4v/nwc.ts` → if `v4v-toolkit` ships an NWC client, replace `@getalby/sdk` imports.
- `lib/v4v/lnaddr.ts` → use `v4v-toolkit`'s LNURL helper if available.
- `lib/nostr/` submodules → drop in `v4v-toolkit`'s NIP-07 / NIP-19 / publish helpers; the `index.ts` barrel keeps callers stable.

---

## Notes

- **Background art** (`public/hero.jpg`) is rendered as a fixed full-viewport `<Image fill />` behind everything, with a 75% ink overlay. Same file doubles as the Open Graph image via `app/layout.tsx` metadata. The `bg-ink` fallback lives on `<html>`, not `<body>` — putting it on `<body>` would propagate to the canvas and paint over the fixed image layer.
- **Boost button glyph** is an inline SVG (`components/icons.tsx:BoltIcon`), not the `⚡` emoji. The colored emoji is invisible on the yellow `btn-bolt` background.
- `<img>` (not `next/image`) for podcast artwork — `next.config.mjs` allows all HTTPS hosts, but per-feed image origins make `next/image` configuration painful. The hero asset uses `next/image` because it's a single known local file.
- Player uses native HTML5 `<audio>` — same enclosure URL the RSS feed advertises.
- NWC URI is stored in `localStorage` only on the device. Nothing persists server-side.
- Nostr publish is opt-in per-boost (defaults to on when signed in). Lightning is sent first, publish only fires if at least one payment landed — no false "I boosted" notes.
- `nostr-tools` is bundled for `nip19`, `SimplePool`, and event types.
- `canvas-confetti` fires bolt-yellow / nostr-magenta / bone particles when a boost lands.

## Roadmap-ish

- Streaming sats per minute (the obvious next feature)
- Settings panel for relay-list management
- Helipad-style boost log view fed by your own boost notes
- Episode chapters via `podcast:chapters`
- Manage NIP-51 categories so favorites can split into "podcasts I host", "music I love", etc.
