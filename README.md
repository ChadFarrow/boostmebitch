# PV4V — Podcast Boost Station

Search, listen, and boost Podcasting 2.0 shows over Lightning.
Sign in with Nostr (NIP-07). Pay via NWC (NIP-47), WebLN, or Lightning Address.
**Boosts publish a kind:1 note to Nostr** with NIP-73 podcast refs so they land in the social graph.

```
Stack:    Next.js 15 · React 19 · Tailwind · Zustand
Wallets:  @getalby/sdk (NWC) · window.webln · LNURL-pay
Identity: nostr-tools + window.nostr
Publish:  nostr-tools SimplePool → multi-relay
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
```

The Podcast Index credentials live in API routes (`app/api/search/route.ts`, `app/api/feed/route.ts`) so they never reach the browser.

---

## Architecture

```
app/
  api/search/  → /search/byterm  (PI proxy)
  api/feed/    → /podcasts/byfeedid + /episodes/byfeedid
  page.tsx     → search + episode panel + sticky player
components/
  nostr-auth   → NIP-07 sign-in
  search-bar   → debounced query
  lists        → results + episode list
  player       → bottom-fixed audio + boost trigger
  boost-modal  → rail picker, splits preview, boostagram, send, nostr publish
lib/
  pi.ts        → Podcast Index server client (SHA1 auth)
  nostr.ts     → window.nostr wrapper, npub encoding, boost-note publish
  store.ts     → Zustand: identity + current episode + position
  types.ts     → shared types (Podcast, Episode, ValueBlock, Boostagram, BoostResult)
  v4v/
    boost.ts   → orchestrator: split sats, pick rail, fire payments
    nwc.ts     → NIP-47 via @getalby/sdk
    webln.ts   → window.webln
    lnaddr.ts  → LNURL-pay invoice fetch (for type=lnaddress)
```

### Boost flow

1. User clicks ⚡ BOOST on the player.
2. Modal computes splits from `episode.value.recipients` (falls back to channel-level value if episode has none).
3. User picks rail — NWC takes priority if a URI is saved, else WebLN.
4. For each recipient:
   - `type=node` → keysend with TLV record `7629169` containing the boostagram JSON.
   - `type=lnaddress` → LNURL-pay invoice fetch, then pay via the chosen rail.
5. Per-recipient progress + errors render live.
6. **If signed in with Nostr and at least one payment landed**, a kind:1 note is signed via NIP-07 and broadcast to the configured relays.

### Nostr boost note

Built in `lib/nostr.ts` → `publishBoostNote()`. Kind:1 event with:

| Tag | Value |
| --- | --- |
| `i`, `k` | `podcast:guid:<feed-guid>` + `k=podcast:guid` (NIP-73) |
| `i`, `k` | `podcast:item:guid:<item-guid>` + `k=podcast:item:guid` (NIP-73) |
| `r`     | RSS feed URL |
| `amount` | total sats sent, in millisats |
| `client` | `PV4V` |
| `t`     | `boostagram`, `value4value` |

Content is auto-formatted as:

```
⚡ Boost ⚡

[boostagram message]

Boosted 500 sats → [podcast title]
📻 [episode title]

[feed url]
```

After publish, the modal shows accepted/total relay counts and a `view note ↗` link to njump.me.

### Boostagram fields (TLV 7629169)

Standard Podcasting 2.0 fields, plus `sender_id` carrying the user's nostr pubkey when signed in. Payload is identical to what Helipad / Fountain emit, so existing BoostBot / Helipad ingestion will work.

### Default relays

```
wss://relay.damus.io
wss://relay.primal.net
wss://nos.lol
wss://relay.nostr.band
```

Override at runtime by writing to `localStorage.pv4v:relays` as a JSON array. (Could expose a settings UI; left as an exercise.)

---

## Swapping in `v4v-toolkit`

The `lib/v4v/` folder + `lib/nostr.ts` are structured so you can replace internals with `v4v-toolkit` calls without touching components. Likely swap points:

- `lib/v4v/boost.ts` → `v4v-toolkit`'s boost orchestrator if it exposes one (`splitSats`, `sendBoost`).
- `lib/v4v/nwc.ts` → if `v4v-toolkit` ships an NWC client, replace `@getalby/sdk` imports.
- `lib/v4v/lnaddr.ts` → use `v4v-toolkit`'s LNURL helper if available.
- `lib/nostr.ts` → drop in `v4v-toolkit`'s NIP-07 / NIP-19 / publish helpers.

The component layer only imports from `lib/v4v/boost.ts`, `lib/v4v/nwc.ts`, and `lib/nostr.ts`, so the swap is contained.

---

## Notes

- Uses `<img>` not `next/image` for podcast art to avoid configuring every host.
- Player uses native HTML5 `<audio>` — same enclosure URL the RSS feed advertises.
- NWC URI is stored in `localStorage` only on the device. Nothing persists server-side.
- Nostr publish is opt-in per-boost (defaults to on when signed in). Lightning is sent first, publish only fires if at least one payment landed — no false "I boosted" notes.
- `nostr-tools` is bundled for `nip19`, `SimplePool`, and event types.

## Roadmap-ish

- Streaming sats per minute (the obvious next feature)
- Settings panel for relay list management
- Helipad-style boost log view fed by your own boost notes
- Episode chapters via `podcast:chapters`
