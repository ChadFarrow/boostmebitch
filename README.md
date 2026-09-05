# Boost Me Bitch — Podcast Boost Station

Search, listen, and **boost** Podcasting 2.0 shows — and **watch + boost Nostr live streams** — over Lightning.
**Lightning and Nostr are two independent logins:** connect a wallet (**NWC, Spark, WebLN, or Lightning Address**) and boost with no Nostr account, or **sign in with Nostr** (NIP-07, Amber, a NIP-46 bunker, or **Continue with Google** — which generates a key for people who don't have one and backs it up, PIN-encrypted, to their own Google Drive) for the social layer.
All three Podcasting 2.0 payment modes ship: the **boost** button, **boost-all** across a music episode's tracks, and **streaming sats** — a per-minute rate or a fixed amount per track, batched and paid unattended, following `valueTimeSplit` (and, on a live show, the artist the host is broadcasting right now).
**Boosts publish a kind:1 note** to Nostr with NIP-73 podcast refs — signed by your key when signed in, or by the **app's own Nostr identity** (server-side) when you're not, so signed-out boosts still reach Nostr; **live-stream boosts go out as real NIP-57 zaps** so they show up as boosts in Fountain / tunestr / zap.stream.
Favorites, mutes and follows sync across any Nostr-aware client via NIP-51 / NIP-02. Installable PWA, light + dark.

Live at <https://boostmebitch.com>.

```
Stack:    Next.js 15 · React 19 · Tailwind · Zustand
Wallets:  @getalby/sdk (NWC) · @buildonspark/spark-sdk (Spark) · window.webln · LNURL-pay / NIP-57 zaps
Identity: nostr-tools + window.nostr (NIP-07 / Amber NIP-55 / NIP-46 bunker / local key / NIP-65 / NIP-51 / NIP-02)
Video:    hls.js + react-reverse-portal (HLS live streams)
Live V4V: socket.io-client (The Split Kit's <podcast:liveValue> push channel)
Data:     Podcast Index API (server-side proxy) + RSS + Nostr relays
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

**Checks — there is no test runner.** `npm run typecheck` (`tsc --noEmit`, strict) · `npm run lint` (ESLint 9 flat config) · `npm run build`, plus twenty-one `check:*` scripts that stand in for the tests this repo doesn't have (six of them below; `package.json` has the rest), and `npm run check:claudemd`, which guards the size of `CLAUDE.md` itself. Each imports the **real** module (`node --experimental-strip-types`) and pins a function whose silent breakage costs a user something irreversible — treat a failure as a stop, and fix the code rather than the vector:

| Command | Guards |
| --- | --- |
| `npm run check:spark` | `sparkMnemonicFromKey` / `deriveBackupKey` — change either and every derived wallet moves and every Drive backup becomes undecryptable |
| `npm run check:sanitizer` | `safeUrlAttr` — the show-notes URL scheme allowlist (this origin holds the NWC spending credential) |
| `npm run check:ssrf` | `assertSafeFetchUrl` — server-side fetch guard, including the ALLOWED half so it can't start rejecting real podcast hosts |
| `npm run check:liveblock` | `parseLiveBlock` — the Split Kit live-value payload → value block |
| `npm run check:stream` | the streaming ledger's arithmetic, settle batching, and every money constant |
| `npm run check:assetlinks` | `buildAssetLinks` — the Digital Asset Links statement that lets the Android app represent this origin, and so reach the Chrome profile holding the wallet credential |

`npm run probe:live -- <feedUrl>` is a discovery tool, not a check: it polls a feed and reports which live-value signal that publisher actually moves.

**Testing against local data.** A dev server on localhost still publishes to the public relays under whatever npub is signed in — including the kind:10333 favorites event other apps read, which is replaceable and keeps no history. Three scripts close that gap: `npm run relay` (an in-memory NIP-01 relay on `ws://127.0.0.1:7447` with real replaceable-event semantics), `npm run seed:relay -- <npub>` (copies an account's real kind:10333 into it, read-only against the public relays), and `npm run e2e:favorites` (the whole read-merge-publish loop against a throwaway key, `--headed` to watch it).

> Stop the dev server before `npm run build` — the build rewrites `.next` and the running server then serves a mismatched chunk manifest.

## Deploy to Vercel

```bash
vercel
# env vars in the dashboard:
#   PODCAST_INDEX_KEY
#   PODCAST_INDEX_SECRET
#   APP_NAME=boostmebitch             (optional — User-Agent default)
#   BOOSTBOX_URL / BOOSTBOX_API_KEY   (optional — BoostBox LNURL metadata proxy)
#   SITE_NOSTR_SK                     (optional — server-only nsec/hex; lets signed-out
#                                      boosts post a note from the app's Nostr identity)
#   NEXT_PUBLIC_GOOGLE_CLIENT_ID      (optional — unset, the Google onboarding
#                                      entry point doesn't render at all)
#   ANDROID_PACKAGE_ID                (optional — com.boostmebitch)
#   ANDROID_CERT_SHA256               (optional — the APK signing certificate's
#                                      SHA-256; unset, the statement list is
#                                      empty and no Android app verifies)
```

Podcast Index credentials live only in API routes (`app/api/*`) so they never reach the browser. The Spark SDK talks straight to Spark's signing operators, so it needs no key. `vercel.json` also carries the LNURL rewrite for our own Lightning address (see below) — **`next dev` does not apply `vercel.json`**, so that path only exists on a deploy.

## Android app (Zapstore)

The Android build is a **Trusted Web Activity** — a signed shell around `https://www.boostmebitch.com`, built by Bubblewrap from the web manifest and published to [Zapstore](https://zapstore.dev), the Nostr-native app store. There is no second copy of the app: a Vercel deploy updates the Android app at the same moment it updates the site. It fits this audience — Zapstore users sign with **Amber** (already supported over NIP-55, and Android-only) and pay over **NWC**.

`android/twa-manifest.json` is the only source file; `zapstore.yaml` is the listing; `.github/workflows/android-release.yml` builds, signs and publishes on a `v*` tag. Chrome only drops the browser URL bar if `/.well-known/assetlinks.json` names the exact package and signing certificate, which is what `ANDROID_PACKAGE_ID` and `ANDROID_CERT_SHA256` above are for — unset, that document is an empty list and no app verifies. The release workflow refuses to publish a build the live origin does not vouch for.

**The keystore and the Zapstore publishing key are not in this repo and cannot be.** [`docs/android.md`](docs/android.md) has the first-release runbook, why the origin must be `www` and not the apex, and what still needs testing on a real device.


---

## Features

- **Search** Podcast Index and play any episode (native HTML5 `<audio>`, no proxy).
- **Two independent logins** — connect a Lightning wallet and boost with **no Nostr account**, or sign in with Nostr for the social layer. One combined **"Sign in ▾"** header control (`<AuthControl>`) fronts both.
- **V4V boosts** over three rails — **NWC** (NIP-47), **Spark**, or **WebLN** — to keysend nodes *or* Lightning addresses, with per-recipient value splits and a Podcasting 2.0 boostagram. **Anonymous mode** withholds both sender fields, not just the note's signature.
- **Streaming sats** — sats per minute *or* a fixed amount per track, off by default, per-show override, batched every 10 minutes and settled per payment target.
- **Boost-all tracks** — split a boost across every `valueTimeSplit` remote item on a music episode.
- **Live value switching** — on a live show, payment follows the artist actually broadcasting, over The Split Kit's `<podcast:liveValue>` socket channel with an RSS-polling fallback.
- **Signed-out boosts still reach Nostr** — the app has its own Nostr identity that signs the kind:1 note server-side (`SITE_NOSTR_SK`), with a NIP-05 (`_@boostmebitch.com`) + kind:0 profile + kind:10002 relay list.
- **Nostr live streams** — a "Live on Nostr" row of kind:30311 streams; watch HLS video in-app; **live chat** (kind:1311) and **boosts/zaps** (kind:9735) rendered together; shareable `/stream/<naddr>` and permanent per-host `/live/<npub>` pages.
- **Chapters + transcripts** (`<podcast:chapters>` / `<podcast:transcript>`) — seek-bar ticks, chapter-stepping transport, a follow-along transcript with in-panel search.
- **Podroll** (`<podcast:podroll>`) and **funding** (`<podcast:funding>` → `⊙ SUPPORT`).
- **Favorites** (NIP-78 kind:30078, shared cross-app), **mutes** (NIP-51 kind:10000) and **follows** (NIP-02 kind:3) that sync across Nostr clients.
- **Discussion threads** (`podcast:socialInteract`) and global / per-podcast / per-episode **Nostr feeds**.
- **Music albums** render as albums (play overlay, tracklist, track order).
- **We serve a Lightning address too** — `chadf@boostmebitch.com`, LNURL + keysend.
- **Installable PWA**, **light/dark** themes.

---

## Architecture

```
app/
  api/search/            → /search/byterm                      (PI proxy + RSS-preview fallback)
  api/feed/              → /podcasts/byfeedid + /episodes/byfeedid + RSS enrichment
  api/by-guid/           → /podcasts/byguid | byfeedurl         (favorites, podroll)
  api/value-splits/      → resolve valueTimeSplit remote items  (PI + RSS fallback)
  api/live-value/        → resolve a live item's CURRENT payment target (polled)
  api/publisher/         → publisher feed → children           (capped fan-out, PI then RSS)
  api/playlist/          → any *L playlist → ONE PAGE of items   (remote items via PI batch)
  api/chapters/          → <podcast:chapters> JSON proxy        (hosts send no CORS)
  api/transcript/        → <podcast:transcript> proxy, served inert as text/plain
  api/keysend/           → .well-known/keysend probe proxy      (no CORS upstream)
  api/lightning/boostbox → BoostBox LNURL metadata proxy
  api/nostr/site-sign/   → sign a boost note as the site identity (server-only key)
  .well-known/nostr.json → NIP-05 for the site identity (_@boostmebitch.com)
  .well-known/keysend/   → OUR lightning address's keysend doc (LNURL half is a vercel.json rewrite)
  layout.tsx             → bg art layer + OG metadata + FOUC theme blocker + <Player>
  page.tsx               → search, favorites, live-streams row, global feed; URL-restored views
  stream/[naddr]/        → one broadcast, shareable            (opens the layout player)
  live/[npub]/           → a host's CURRENT broadcast          (permanent link, survives new dTags)
  privacy/               → privacy policy (linked from the layout footer — Google requires both)
components/
  player · fullscreen-player · transport-controls · video-toggle   → shared <audio>/<video>
  chapter-ui · transcript-ui · episode-detail-view · discussion-view
  nostr-live-streams · live-chat · live-now-playing                → kind:30311 / 1311 / 9735
  streaming-settings   → <StreamRate> switch + <StreamMeter> + <StreamPulse> + <StreamedLog>
  auth-control · wallet-modal · nwc-wallet · spark-wallet · webln-wallet · wallet-balance · rail-picker
  nostr-auth/  (index · sign-in-modal · login-methods · google-auth-panel · account-menu
                · muted-accounts · provision-spark · provision-profile)
  global/podcast/episode-nostr-feed · nostr-note-card · episode-social-thread · follow-button
  boost-modal/ (index · amount-input · message-input · sender-name · share-nostr-picker
                · splits-preview · publish-status)
  boost-all-modal · boost-card · lists · podroll · value-split-rows · fav-heart
  search-bar · podcast-cover · avatar · icons · theme-toggle · deferred-on-scroll
lib/
  pi.ts          → Podcast Index server client (SHA1 auth, RSS enrichment, show-notes sanitizer)
  safe-fetch.ts  → SSRF guard: hostname/IP blocklist, re-validated on EVERY redirect hop
  safe-url-attr.ts → href/src scheme ALLOWLIST for show notes (must stay an allowlist)
  rate-limit.ts  → per-IP sliding window, first line of every API route
  store.ts       → Zustand: identity, current, player/view state, favorites, mutes
  storage.ts     → typed localStorage accessors for every bmb:* key (+ quota eviction, memory mirror)
  chapters.ts · transcript.ts   → parse + hooks + the "is this podcast-only?" gates
  podcast-meta.ts → the ONE PI metadata resolver (memory + localStorage cache + circuit breaker)
  musicl-resolver.ts → RSS rescue for remote items PI hasn't indexed (publisher → album walk)
  types.ts · util.ts  (isMusicMedium, isPlaylistMedium, playsAsTracks, hasValueRecipients, isHlsUrl, fnvHash, httpUrl, recipientOrder)
  format.tsx     → fmt/fmtDuration/fmtClock/fmtLiveTime/timeAgo, linkify, confetti, boost ping
  boost-sound.ts → audio-session plan for the boost ping AND its tap-time unlock
  nostr/
    auth · signer · amber · bunker        → NIP-07 / NIP-55 / NIP-46 sign-in + window.nostr swap
    local-signer · local-key-store        → in-process signer; key at rest in IndexedDB
    google-auth · backup-crypto · drive-backup  → Google onboarding: PIN-encrypted key backup
    generated-profile · profile-words     → a kind:0 name + identicon derived from the pubkey
    pool · publish · relays · relay-health · profile
    discover · event-queries · use-feed   → feed assembly, queries, stale-while-revalidate hook
    boost-notes · interactions            → kind:1 boost notes (user + site-signed), replies/reposts
    site-key                              → server-only SITE_NOSTR_SK resolver (sign route + NIP-05)
    favorites · mutes · follows · *-hydrator    → NIP-78 kind:30078, NIP-51 kind:10000, NIP-02 kind:3
    live-streams · live-chat              → kind:30311 streams, kind:1311 chat + kind:9735 zaps
    wallet-backup · settings-backup       → NIP-44 encrypted-to-self (Spark seed, NWC, settings)
  v4v/
    boost.ts     → orchestrator: split sats, pick rail, keysend/lnaddress, TLV routing
    streaming.ts → the streaming engine (1 Hz clock, contexts, settle edges)
    stream-ledger.ts → PURE math: accrue, distribute, per-bucket settle, money constants
    live-value.ts · live-block.ts → who is playing NOW: RSS poll + Split Kit socket
    zap.ts       → NIP-57 zap (kind:9734 → kind:9735 receipt) — note + live-stream boosts
    keysend-lookup.ts → .well-known/keysend probe (the lnaddress → keysend upgrade)
    nwc.ts · spark.ts · spark-derive.ts · webln.ts   → the three rails + the derived Spark seed
    lnaddr.ts · bolt11.ts · boostbox.ts · wallets.ts
scripts/  check-*.mjs      → 21 pins (see `package.json`) + check-claudemd.mjs
          local-relay.mjs · seed-local-relay.mjs · e2e-favorites.mjs  → testing without a real account
          import-free.mjs · probe-live-item.mjs · publish-site-profile.mjs
services/
  nostr-index/   → separate Railway deployable: relay read cache (own deps + checks)
public/
  hero.jpg · manifest.json · sw.js · icons/ · splash/
```

`lib/v4v/*` and `lib/nostr/` are the **only** files that talk to wallets / signers; components import them through the `lib/nostr/` barrel and the `lib/v4v/*` entry points, so the toolkit can be swapped without touching `components/`.

**`services/nostr-index/` is a separate deployable, not part of this app.** It holds relay WebSockets open continuously — which a serverless function cannot — and caches public events so a feed costs one request instead of four serial relay stages. It has its own `package.json`, dependencies and checks, is excluded from this repo's `tsconfig.json` and `eslint.config.mjs`, and never imports from `lib/` (nor `lib/` from it). It runs on **Railway and is CLI-uploaded, so it does not deploy when you merge** — ship it with `railway up` from that directory. The app reaches it only through `lib/nostr-index-server.ts`, server-side; unset `NOSTR_INDEX_URL` and every path falls back to relays.

---

## Boost flow

Entry points: **⚡ BOOST in the player** (current episode, `ts` = playback position), **⚡ BOOST on the show header** (channel-level value block, `ts: 0`), **⚡ per-track** on any row whose track carries a value block, and **⚡ BOOST N TRACKS** (boost-all). All open a modal that computes splits from the value block and pays.

**Rail.** `pickRail()` honors the user's last-used rail (`storage.railPref`), else priority **NWC > Spark > WebLN**. Both modals show the same **rail picker** (`components/rail-picker.tsx`) whenever 2+ rails are connected — a silent pick is how a funded Spark wallet sat untouched while boosts went out of an old extension. Per recipient:

- **`type=node`** → keysend with TLV record `7629169` carrying the boostagram JSON. Per-recipient `customKey`/`customValue` (e.g. shared-node sub-account routing for getalby.com) is a separate TLV record. (Spark can't keysend — node legs are rejected on the Spark rail.)
- **`type=lnaddress`** → probes `.well-known/keysend/<name>` first, via the `/api/keysend` proxy (that endpoint carries no CORS headers, so a direct browser fetch would always fail). When the address publishes one and the rail isn't known to be keysend-incapable, the leg is paid as a real **keysend** so the boostagram rides in TLV `7629169` intact (instead of degrading to a LUD-21 comment) and the endpoint's `customKey`/`customValue` routes to the right sub-account. Wallets that are *provably* keysend-incapable (Spark, or an NWC connection whose advertised methods exclude `pay_keysend`) skip the probe and go straight to LNURL; a wallet that never advertised its methods is attempted anyway, and a NIP-47 `NOT_IMPLEMENTED` refusal — returned instead of a payment, so nothing moved — falls back to LNURL. Otherwise: LNURL-pay invoice fetch (amount-verified against the BOLT11 before paying), then pay via the chosen rail.

Per-recipient progress + errors render live; confetti fires when a leg lands. **When "Share on Nostr" is on and at least one payment landed**, a kind:1 boost note is published — signed by your own key when signed in, or by the site's Nostr identity server-side (`app/api/nostr/site-sign`, `SITE_NOSTR_SK`) when you're not.

**Anonymity is about the payment, not just the note.** The share picker's three states are **My feed / Anonymous / Don't post**. Anonymous drops `sender_id` (your pubkey — recipient aggregators resolve it to your avatar and name), drops the `reply_*` fields (a lightning address names its owner just as surely) *and* replaces `sender_name` with `boostmebitch.com user`, on every leg of every mode including boost-all's per-track, host-share and summary legs. That default name is also what a boost with an empty "From" field sends, so a recipient never renders a blank sender.

**Live-stream boosts → real zaps.** When you boost a Nostr live stream signed-in, with an active signer and a host whose Lightning address supports NIP-57 (checked *before* paying, so no double-pay), the boost is sent as a real **zap** (`sendZap`, `lib/v4v/zap.ts`) tagged to the stream — the recipient's LN service then publishes a kind:9735 receipt that renders as a boost in Fountain / tunestr / zap.stream **and** in BMB's chat. Otherwise it falls back to a normal boostagram payment plus a kind:1311 "⚡ Boosted N sats" chat line.

### WebLN customRecords vs NWC tlv_records

These look symmetric but the wire formats differ:

- **WebLN** (`weblnKeysend`): `customRecords` values are **plain UTF-8 strings** — the extension hex-encodes internally. Pre-hexing double-encodes and Helipad can't `JSON.parse` the boostagram.
- **NWC** (`pay_keysend`): `tlv_records` values are **hex-encoded** per NIP-47.

`tlvHexFor` (NWC) and `recordsForKeysend` (WebLN) in `lib/v4v/boost.ts` apply the right encoding per rail.

---

## Streaming sats

The third Podcasting 2.0 payment mode. **Off by default** — nothing is spent until the switch is flipped. It is a ledger and a clock on top of the existing engine, **not a new payment path**: settlement calls the same `sendBoost()` with an unattended `action` on the boostagram, so rails, splits, TLV and the lnaddress→keysend upgrade are untouched.

```
lib/v4v/stream-ledger.ts   pure math — accrue, distribute, per-bucket settle, every constant
lib/v4v/streaming.ts       the engine — 1 Hz timer, playback context, settle edges, refunds
components/streaming-settings.tsx   <StreamRate> · <StreamMeter> · <StreamPulse> · <StreamedLog>
```

**Two units, one switch.** `[●— ON] [10] sats/min`, or the same control set to a fixed amount **per track**. Per-minute makes a track's earnings depend on its length (a 2-minute song earns 50 where a 6-minute one earns 150); per-track pays both the same. The unit is a picker on the amount field, and the two numbers live in separate keys so flipping the unit never destroys the other one. Defaults: **10 sats/min**, **100 sats/track**.

**Where the control lives.** The `≋ STREAM` button on the show header, the episode detail page and the fullscreen player all open the *same* show-scoped setting (`useStreamPanel`); the wallet modal renders the same component at **global** scope, above the streamed log. There is no per-episode setting.

**Rate resolution: per-show override → global → off.** At show scope "no opinion" and "explicitly off" are different states — off means *never stream this show* and outranks a global rate raised later. Both halves are made visible: a pinned-off show says so and offers "Follow my default instead", and the global switch's off-state copy degrades to *"Off by default — but N show(s) you turned on individually still stream."*

**How it charges.**

| | |
| --- | --- |
| elapsed | `min(wall-clock Δ, playback-position Δ)`, capped at 5 min — wall alone bills a sleeping laptop, position alone bills a forward seek |
| accrual | unrounded msat into **per-target buckets**, so a batch spanning three tracks pays three artists |
| settle | every **10 minutes**, plus forced at pause / item change / episode end / **valueTimeSplit boundary** |
| floor | `max(10, recipientCount)` sats per bucket — a smaller balance carries rather than paying dust |
| give-up | two consecutive failures stop that item and say so; a rate change or a wallet connecting re-arms it |
| per-track | a target must be current for **30 continuous seconds** to earn, once per run |

Sats are **debited before the payment is awaited** (crediting after is a real double-spend), refunded on failure, and mirrored to `bmb:stream_pending` so closing the tab mid-window doesn't discard them. Streaming is ambient: no Nostr note, no confetti, no sound, and its history goes to `bmb:streamed:*` — never the boost log, which the global feed renders.

**`action` is per leg — `'auto'` when it pays a song, `'stream'` when it pays the show** (`streamAction`, `lib/util.ts`). `'boost'` stays reserved for the button, so neither reaches a host's boost feed; confirmed against a real Helipad, `'auto'` lands in the Stream tab flagged as an AutoBoost. Finding a music show is the hard half: every V4V one declares `<podcast:medium>podcast</podcast:medium>`, and an open `<podcast:valueTimeSplit>` is not a song either, so the live signal is Split Kit's block stamp `'music'`. One exception — BoostBox validates `action` against a strict `"boost" | "stream"` enum, so `lib/v4v/boostbox.ts` downgrades `'auto'` → `'stream'` on that (LNURL-metadata) surface only.

**Three readouts:** `<StreamMeter>` (fullscreen — rate, the block's art, the track being credited, accrued sats, countdown), `<StreamPulse>` (a `≋ N` chip on the mini-bar, so a user who never opens the player still sees money leaving), `<StreamedLog>` (the wallet modal — the only record anywhere that carries podcast context; NWC/WebLN/Spark transaction lists don't).

Skipped for Nostr kind:30311 streams (their payments are NIP-57 zaps) and for items with no value recipients.

---

## Live value — following the artist during a live show

`<podcast:valueTimeSplit>` can't do this: it anchors to offsets into a finished enclosure, and a live stream has no absolute time base. There is no live-VTS tag. What live V4V music shows actually use is a **push channel** — `<podcast:liveValue uri="…" protocol="socket.io"/>` inside the `<podcast:liveItem>`, served by [The Split Kit](https://thesplitkit.com). The host clicks a track; every app's payment target moves within a second.

```
socket 'remoteValue' → { title, image, feedGuid, itemGuid, blockGuid, eventGuid, eventAPI,
                         settings.split, value.destinations[] }   → the block now broadcasting
```

Both paths are implemented and the socket wins whenever it is delivering; the RSS fallback (polled every 20 s, `/api/live-value`) is for shows that don't run Split Kit. Its three signals resolve in precedence order: a `<podcast:remoteItem>` inside the live item → a *lone* `<podcast:valueTimeSplit>` inside it → the live item's own `<podcast:value>`, that last one only once it has been observed to **change** (a static block is indistinguishable from a show that never touches it).

The resolved target becomes an ordinary bucket in the streaming ledger, so the per-bucket settle, the track-boundary settle edge and the boostagram's `remote_feed_guid`/`remote_item_guid` shape all apply unchanged. It also swaps `episode.value`, which is what makes the **boost** button follow the artist with no extra plumbing — `<LiveNowPlaying>` names the target in the boost modal, and the block's own cover art follows onto the fullscreen pane, the mini-bar, the meter and the modal. A failed poll keeps paying the last known artist for ~1 minute, then falls back to the show's own block; `socket.io-client` is dynamic-imported so it costs nothing to anyone who never plays such a show.

**Debugging a live show:** every way this fails is silent and looks identical from outside — the target just doesn't move. `bmbLive()` in devtools reports which one it is (`notWatchingBecause`, `liveValueTag`, `socket.opened`/`delivering`, `pollFailures`, the resolved target), and `bmbLive().poll()` forces a poll. `npm run probe:live -- <feedUrl>` answers the same question for a feed you haven't played yet.

---

## Nostr live streams (NIP-53)

A **"Live on Nostr"** row surfaces kind:30311 streams (`fetchNostrLiveStreams`), dropping stale `live` events (no `ended` update within 2h) and sorting upcoming-first then newest. One tab-selected row — **Live / 24/7 / Upcoming**. Everything is the shared NIP-53 standard, so it interoperates with **Fountain, tunestr, and zap.stream** — only relay coverage varies.

- **HLS video** plays in-app via `hls.js` (dynamic-imported; native HLS on Safari). A single `<video>` lives in a **reverse portal** so it moves between the mini-bar and the fullscreen pane without remounting (audio keeps playing when collapsed). Non-HLS media stays on the native `<audio>`.
- **Two share routes.** `/stream/<naddr>` pins one broadcast; `/live/<npub>` resolves a host's *current* stream at click time, so the URL a show puts in its bio stays valid across broadcasts (each new stream gets a fresh dTag, the npub never changes) and renders a "not live / next up" placeholder when they're offline. `<Player>` is mounted in the root layout, so playback survives browse ↔ stream navigation.
- **Live chat** subscribes to **kind:1311** (chat) **and kind:9735** (zap receipts / boosts) for the stream. Both render in one row list; zaps get a `⚡ N sats` badge, and a **total-sats-zapped** line shows at the top. New messages re-sync periodically and on focus (relay subscriptions go stale when a device backgrounds). Signed-in users can post (kind:1311).

---

## Chapters + transcripts

`<podcast:chapters>` JSON and the best **timed** `<podcast:transcript>` (ranked JSON > SRT > VTT) are parsed from the RSS enrichment pass, fetched through `/api/chapters` and `/api/transcript` — many hosts serve them with no `Access-Control-Allow-Origin`, so a direct browser fetch is silently CORS-blocked. The transcript proxy always returns inert `text/plain` + `nosniff`, never the upstream Content-Type: transcript URLs come from arbitrary feeds, and a host serving `text/html` with a `<script>` would otherwise execute in *our* origin.

Both surface in three places — the episode detail page, the fullscreen player's **About / Chapters / Transcript** tab strip, and the mini-player — with seek-bar tick marks, a current-chapter label, chapter-stepping ⏮/⏭, tap-to-seek rows, and an in-panel transcript search that filters while keeping the playing line's highlight correct. `<Player>` owns the single fetch for both; the gates (`chapterUrlFor`, `transcriptSourceFor`) return empty for live streams and music feeds, so this is podcasts-only everywhere at once.

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
| `sender_name` | Nostr `display_name` / `name`, editable | falls back to `boostmebitch.com user` — and is *replaced* by it on an anonymous boost |
| `sender_id` | Nostr pubkey hex | omitted when signed out **or** anonymous |
| `reply_address` | the sender's own `lud16` | a node pubkey when the address publishes `.well-known/keysend`, else the address itself — a receiver tells them apart by the `@`. Omitted when signed out, when there is no `lud16`, **or** when anonymous. Sent from the boost modal only |
| `reply_custom_key`, `reply_custom_value` | that endpoint's routing pair | sub-account routing for a shared custodial node. Both or neither, and the key is a **number** — a receiver reading it as an integer rejects a quoted one |
| `action` | `'boost'` \| `'auto'` \| `'stream'` | `'boost'` = the button. A streaming settlement is `'auto'` when the leg pays a song and `'stream'` when it pays the show |
| `uuid` | `crypto.randomUUID()` | one uuid per boost — Helipad groups legs by it |
| `remote_feed_guid`, `remote_item_guid` | `<podcast:guid>` / item guid | NIP-73 refs; carry the **track** on boost-all and streaming legs, the **stream** on live-stream legs |
| `eventGuid`, `blockGuid`, `eventAPI` | Split Kit | only when the target came off a `<podcast:liveValue>` channel; additive, so a normal boostagram is byte-identical to before |

We emit the boostagram in TLV `7629169` only — never a separate `696969` sender record (it collides with shared-node sub-account routing). LNURL legs put the boostagram message in the LUD-21 `comment`; BoostBox legs prepend their `rss::payment::<action>` desc.

---

## Nostr boost note (kind:1)

| Tag | Value |
| --- | --- |
| `i`, `k` | `podcast:guid:<feed-guid>` + `k=podcast:guid` (NIP-73) |
| `i`, `k` | `podcast:item:guid:<item-guid>` + `k=podcast:item:guid` (omitted on show-level boosts) |
| `r` | a listen link **and** a `boostmebitch.com` deep link — both episode-specific when boosting an episode |
| `amount` | total millisats *intended* (not sum of successful legs) |
| `client` | `BoostMeBitch` |
| `t` | `boostagram` + `value4value` |

**Both `r` tags point at the episode when there is one** — a note about one episode that lands the reader on the show's front door makes them go hunting. The listen link prefers the episode's own web page (RSS `<link>`), then a URL-shaped item guid, then `pod.link/<itunesId>` → PI page → raw RSS (those last three are show-level: neither pod.link nor PI has an episode URL constructible from a guid). The BMB link is `?podcast=<guid>&episode=<guid>` — a restorable view that emits episode-level OG tags, so the unfurl carries the episode's own title and art. Everything derived from feed text goes through `httpUrl`, an http(s) allowlist, before landing in a public note.

**Who signs it.** Signed in → your own key via `window.nostr` (`signAndPublish`). Signed out → the site's own Nostr identity, signed **server-side** at `app/api/nostr/site-sign` (which validates the note is boost-shaped, and bounds tag size as well as tag count, before signing with `SITE_NOSTR_SK`) and published from the browser via `publishBoostNoteViaSite`.

**Where it publishes.** Signed in → `resolvePublishRelays(identity)`: a manual `localStorage.bmb:relays` override, else the user's NIP-65 (kind:10002) write relays **unioned with the defaults** (so a note still lands when the write relays are dead/AUTH-gated), capped at 20. Signed out (site identity) → the defaults. Defaults:

```
wss://relay.damus.io · wss://relay.primal.net · wss://nos.lol · wss://relay.fountain.fm
```

---

## Wallets

Connected from the header's **`<AuthControl>`** (the combined "Sign in ▾" login — wallet and Nostr are separate) via the **wallet modal** (`components/wallet-modal.tsx`); a balance chip reads the active rail. Signed out, **NWC + WebLN work fully**; the Spark row needs Nostr sign-in (its seed is encrypted to your key). The modal's connected view also carries the **global streaming rate control** and the **streamed-payment log**.

- **NWC** (NIP-47, `@getalby/sdk`) — paste a connection URI. Optionally **back it up encrypted to Nostr** (kind:30078, NIP-44 to-self) so it restores on other devices; opt-in and deletable.
- **Spark** (`@buildonspark/spark-sdk`) — paste/create/restore a seed; **no API key**. The mnemonic is stored **encrypted to Nostr** (kind:30078) for silent restore, so this rail requires a Nostr identity. Account number matches Primal/BlitzWallet so the same seed shows the same balance.
- **WebLN** — the injected extension (Alby), enabled on demand (we never call `wl.enable()` speculatively).

---

## Signers

`window.nostr` is the single interface; four paths feed it (swapped by `lib/nostr/signer.ts`):

- **NIP-07** browser extension (Alby, nos2x, nostash on iOS).
- **Amber** (NIP-55) on Android — `nostrsigner:` URL scheme + clipboard round-trip.
- **NIP-46 bunker / `nostrconnect://`** remote signer (nsec.app, Clave, Amber-as-bunker, Primal). One-tap hand-off on both mobiles — `nostrconnect://` into Amber on Android, `clave://connect?uri=` into Clave on iOS, the latter straight from the header dropdown so it costs one tap rather than three. A signer that queues a request for its user (Clave answers `permission denied` first and the real result after the tap) is asked again rather than reported as having refused.
- **Local key** — the only path where *we* hold the key, for users who arrive with no Nostr identity at all. See Google onboarding below.

The header's combined **"Sign in ▾"** control (`<AuthControl>`) opens a modal with **Continue with Google** above a two-tab picker (Extension / Remote signer). `nostr-tools` is pinned to **exactly `2.19.4`** — `2.20.0+`'s NIP-46 rewrite breaks the `nostrconnect://` handshake on our relays.

### Google onboarding — a key for users who have none

Ported from [Wisp](https://github.com/barrydeen/wisp). **Google is not an identity provider here — it's a zero-knowledge blob store.** The key is generated locally at random; nothing is derived from the Google account.

```
salt = HMAC-SHA256(key = "bmb-google-backup", msg = google `sub`)
key  = Argon2id(pin, salt, m=32MiB, t=3, p=1) -> 32 bytes
blob = NIP-44 v2 over the hex nsec, with that key as the conversation key
```

The blob lives in Drive **`appDataFolder`** — app-private, invisible in the user's Drive UI, opaque filename, no metadata. The npub exists only inside the ciphertext, so Google holds something it can't link to a Nostr identity. The **PIN is the only secret**; losing it loses the account, and the setup screen says so.

At rest the key is AES-GCM ciphertext in IndexedDB under a non-extractable `CryptoKey` — never `localStorage`. New accounts also get a **Spark wallet derived from the same key**, so a Google signup arrives with a working boost rail, and a **generated kind:0** — a two-word display name and an identicon, both derived from the pubkey (not from the Google account), so the user is recognizable in every Nostr client rather than a nameless npub.

Gated entirely on `NEXT_PUBLIC_GOOGLE_CLIENT_ID`: unset, the entry point doesn't render and nothing else changes. Enabling it needs a Google Cloud project with the **Drive API enabled** and both `openid` and `drive.appdata` on the consent screen. `drive.appdata` is a **non-sensitive** scope, so this needs only brand verification — no demo video, no third-party security assessment. Verification for this deployment is complete; see CLAUDE.md for the settled console state. **Google sign-in does not work on Vercel preview deployments** (`*.vercel.app` can't be an authorized domain) — test on localhost or production.

---

## Favorites, mutes, follows

- **Favorites** (kind:10333, one plain replaceable event per pubkey) — ♡ on a podcast row or an episode row. A list **shared with other podcast apps** (see [the PC 2.0 favorites spec](https://github.com/ChadFarrow/PC20-Nostr/blob/main/pc20-favorites.md)), one `i: podcast:guid:<guid>` / `podcast:item:guid:<guid>` tag per favorite, grouped under a running `medium` tag — tag ORDER is the data. Public entries are tags; a private list is the same tag array NIP-44-encrypted to self in `content`, and a `visibility` tag says which half the whole list lives in. Every publish reads first and merges, because any app may write the event and a blind publish deletes the others' entries. Deliberately **not** a NIP-51 bookmark set: podcast favorites aren't bookmarks, and a generic bookmark client editing that set would rewrite this list. A per-npub localStorage cache renders the Favorites panel instantly. `npm run check:favsync` pins the format; `npm run check:conformance` runs the spec's own vectors against it.
- **Mutes** (kind:10000) — 🚫 on a note card. Interoperates with Damus/Amethyst; new mutes go to the private (NIP-04-encrypted) list, and an unreadable private blob from another client is preserved verbatim. Filtered at render time across all feeds.
- **Follows** (NIP-02 kind:3) — `+ Follow` on note cards and on npubs in show notes, through one shared singleton (a 20-card feed does **one** kind:3 fetch, and toggles are serialized). Publishing preserves the existing content and every existing tag, changing exactly one `p`. **The invariant: never publish a list you didn't reliably fetch** — buttons stay disabled until the load is trustworthy, and an empty-base publish is re-confirmed against relays and a last-known-good cache first. A blind republish is the classic way clients nuke someone's follow list.

---

## Serving our own Lightning address

The mirror image of the boost path: `chadf@boostmebitch.com` is an address other apps pay.

- **LNURL** is a `vercel.json` **rewrite** — `/.well-known/lnurlp/:user` → an LNbits instance at `pay.boostmebitch.com` fronting the node. An edge rewrite, so the hottest path in a payment costs no lambda invocation. Not applied by `next dev`.
- **Keysend** is a route handler (`app/.well-known/keysend/[name]/route.ts`), deliberately not a static file (an extensionless file in `public/` is served as `application/octet-stream`; this has to be JSON, CORS-open and cacheable). It validates the pubkey on the way *out* against the same `/^0[23][0-9a-f]{64}$/` the reader enforces, and serves 404 rather than publishing a malformed one — a payer that trusts a bad pubkey sends a keysend that can never arrive.

The two aren't independent: discovery *starts* at lnurlp, and every BOLT11-only wallet (Spark among them) can only pay that way.

---

## PWA + themes

Installable (`public/manifest.json` + `public/sw.js` + `<SwRegister>`); the service worker has **no precaching** (hashed bundle URLs would go stale) — its empty `fetch` handler just enables the install prompt. Light/dark via role-based CSS tokens (`--ink`, `--bone`, `--bolt`, …) flipped on `:root[data-theme='light']`; a FOUC blocker sets the theme before first paint.

---

## Notes / gotchas

- **Feed content is hostile input.** Show notes render via `dangerouslySetInnerHTML`, and this origin's `localStorage` holds a budgeted NWC spending credential — so `href`/`src` go through `safeUrlAttr`, a scheme **allowlist** (it shipped as a denylist once and six vectors reached the DOM as live `javascript:`). Every server-side fetch of a feed/chapter/transcript URL goes through `safeFetch`, which re-validates **every redirect hop**. Both are pinned by `check:sanitizer` / `check:ssrf`, whose must-still-work halves are as load-bearing as the blocked ones.
- The page background lives on `<html>`, not `<body>` (a `<body>` bg paints over the fixed hero image). `html, body` use `overflow-x: clip` (not `hidden`) so the sticky header actually sticks.
- Every overlay `createPortal`s to `document.body` — the layout's `relative z-0` wrapper is a stacking context that seals `fixed` modals below the mini-player.
- Podcast artwork uses `<img>` (not `next/image`) — arbitrary per-feed hosts. The local hero uses `next/image`.
- Boost button glyph is an inline SVG (`BoltIcon`) — the `⚡` emoji is invisible on the yellow `btn-bolt`.
- Native HTML5 `<audio>` plays the enclosure URL directly; the one exception is HLS (`.m3u8`) live streams, which go through `<video>` + `hls.js`.
- Wallet creds + Spark seed live in `localStorage` (and, opt-in, encrypted on Nostr) — nothing wallet-related is sent to our server. `storage.safeSet` evicts regenerable caches and falls back to a memory mirror when the store is full or blocked, so a settings control can't silently freeze.
- Nostr publish is opt-in per boost; **Lightning is sent first**, the note/zap only fires after a payment lands — no false "I boosted" posts.
- PI is treated as flaky by design: a circuit breaker, a not-found-is-not-a-500 rule, and probe-first-then-batch on every fan-out.

## Roadmap-ish

- Relay-list management UI (the `bmb:relays` override has no UI yet).
- Helipad-style boost-log view fed by your own boost notes.
- Streaming sats for Nostr kind:30311 streams (deferred — it would need a new zap-shaped settlement path).
- NIP-51 favorite categories ("podcasts I host", "music I love").
