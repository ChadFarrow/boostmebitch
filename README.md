# Boost Me Bitch — Podcast Boost Station

Search, listen and **boost** Podcasting 2.0 shows — and watch and boost **Nostr live streams** — over Lightning.
**Lightning and Nostr are two independent logins:** connect a wallet and boost with no Nostr account, or sign in with Nostr for the social layer.
All three Podcasting 2.0 payment modes ship — the boost button, boost-all across a music episode's tracks, and streaming sats — and favorites, mutes and follows sync with any Nostr-aware client.

Live at <https://boostmebitch.com> and, family-friendly, <https://boostmebuddy.com>.

```
Stack:    Next.js 15 · React 19 · Tailwind · Zustand
Wallets:  @getalby/sdk (NWC) · @buildonspark/spark-sdk (Spark) · window.webln · LNURL-pay / NIP-57 zaps
Identity: nostr-tools + window.nostr (NIP-07 / Amber NIP-55 / NIP-46 bunker / local key / NIP-65 / NIP-51 / NIP-02)
Video:    hls.js + react-reverse-portal (HLS live streams)
Live V4V: socket.io-client (The Split Kit's <podcast:liveValue> push channel)
Data:     Podcast Index API (server-side proxy) + RSS + Nostr relays
          + an optional read-only Postgres accelerator for playlist tracks
Deploy:   Vercel zero-config, one project per brand (NEXT_PUBLIC_BRAND)
```

---

## Two brands, one repo

One codebase builds two deploys, selected at build time by **`NEXT_PUBLIC_BRAND`**: unset gives
`boostmebitch.com`, `buddy` gives the family-friendly `boostmebuddy.com`. Everything nameable lives in
the table in **`lib/brand.ts`** — display name, domain, the `wireName` that goes out as a boostagram's
`app_name` and a note's `client` tag, the default sender name, the boost sound, the web manifest, the
Podcast Index `User-Agent`, and the Android package id. Nothing is hard-coded; `npm run check:brand`
asserts that no field of the buddy table carries the other brand's word.

**Each deploy signs with its own `SITE_NOSTR_SK`**, so a signed-out boost from the family-friendly site
never carries the other brand's name or NIP-05.

Three things are deliberately **not** branded, and branding any of them would destroy data: the kind:30078
d-tags (`boostmebitch:wallet:spark`, `…:wallet:nwc`, `…:settings`) are addressable at the *user's* pubkey,
so one person using both deploys opens one wallet backup — rebranding points the new deploy at an address
nothing ever wrote. The `bmb:` `localStorage` prefix stays too, since storage is per-origin and the two
deploys never collide.

---

## Features

- **Search** Podcast Index and play any episode (native HTML5 `<audio>`, no proxy).
- **Two independent logins** — connect a Lightning wallet and boost with **no Nostr account**, or sign in with Nostr for the social layer. One combined **"Sign in ▾"** header control (`<AuthControl>`) fronts both.
- **V4V boosts** over three rails — **NWC** (NIP-47), **Spark**, or **WebLN** — to keysend nodes *or* Lightning addresses, with per-recipient value splits and a Podcasting 2.0 boostagram. **Anonymous mode** withholds both sender fields, not just the note's signature.
- **Streaming sats** — sats per minute *or* a fixed amount per track, off by default, per-show override, batched every 10 minutes and settled per payment target.
- **Boost-all tracks** — split a boost across every `valueTimeSplit` remote item on a music episode.
- **Live value switching** — on a live show, payment follows the artist actually broadcasting, over The Split Kit's `<podcast:liveValue>` socket channel with an RSS-polling fallback.
- **Playlists** — `musicL` feeds, which publish no `<item>` at all, paged and resolved track by track; `/playlists` collects the curated ones.
- **Favorites, mutes and follows** that sync across Nostr clients — favorites on a **shared cross-app** kind:10333 event, with a public/private/off choice, an audit-and-repair tool, and export/import.
- **A boost explorer** at `/npub/<npub>` — boosts sent, boosts received, and NIP-57 zap receipts on a permanent shareable page.
- **Signed-out boosts still reach Nostr** — the app has its own Nostr identity that signs the kind:1 note server-side (`SITE_NOSTR_SK`), with a NIP-05 + kind:0 profile + kind:10002 relay list.
- **A `/live` destination** — every `<podcast:liveItem>` on air anywhere, discovered from Podcast Index's global roster and verified against each publisher's own RSS, beside the Nostr streams.
- **Nostr live streams** — kind:30311 streams; watch HLS video in-app; **live chat** (kind:1311) and **boosts/zaps** (kind:9735) rendered together; shareable `/stream/<naddr>` and permanent per-host `/live/<npub>` pages, with a played-so-far track list whose every row carries a favorite heart.
- **Chapters + transcripts** (`<podcast:chapters>` / `<podcast:transcript>`) — seek-bar ticks, chapter-stepping transport, a follow-along transcript with in-panel search, and a share link for a single moment.
- **Podroll** (`<podcast:podroll>`) and **funding** (`<podcast:funding>` → `⊙ SUPPORT`).
- **Discussion threads** (`podcast:socialInteract`) and global / per-podcast / per-episode **Nostr feeds**, with @-mentions in replies and quote reposts.
- **Search lanes** — a content-type selector that picks which lanes to search rather than filtering results after the fact.
- **A kind:0 profile editor** that merges over the raw event and refuses entirely on an untrustworthy read.
- **Music albums** render as albums (play overlay, tracklist, track order); episode lists can run oldest-first.
- **We serve a Lightning address too** — `chadf@boostmebitch.com`, LNURL + keysend.
- **Installable PWA**, **light/dark** themes.

---

## Setup

```bash
npm install
cp .env.example .env.local
# add your Podcast Index key + secret  (the Spark rail needs NO API key)
npm run dev
```

Get Podcast Index keys at <https://api.podcastindex.org/>.

**Checks — there is no test runner.** `npm run typecheck` (`tsc --noEmit`, strict) · `npm run lint` (ESLint 9 flat config) · `npm run build`, plus **37 `check:*` scripts** that stand in for the tests this repo doesn't have (seven of them below; `package.json` has the rest), `npm run check:conformance`, which runs the cross-app favorites spec's own vectors, and `npm run check:claudemd`, which guards the size of `CLAUDE.md` itself. Each imports the **real** module (`node --experimental-strip-types`) and pins a function whose silent breakage costs a user something irreversible — treat a failure as a stop, and fix the code rather than the vector:

| Command | Guards |
| --- | --- |
| `npm run check:spark` | `sparkMnemonicFromKey` / `deriveBackupKey` — change either and every derived wallet moves and every Drive backup becomes undecryptable |
| `npm run check:sanitizer` | `safeUrlAttr` — the show-notes URL scheme allowlist (this origin holds the NWC spending credential) |
| `npm run check:ssrf` | `assertSafeFetchUrl` — server-side fetch guard, including the ALLOWED half so it can't start rejecting real podcast hosts |
| `npm run check:liveblock` | `parseLiveBlock` — the Split Kit live-value payload → value block |
| `npm run check:livemerge` | `mergeLiveOverPi` — when a publisher's RSS may DELETE a live row, and when an unreadable one may not |
| `npm run check:stream` | the streaming ledger's arithmetic, settle batching, and every money constant |
| `npm run check:assetlinks` | `buildAssetLinks` — the Digital Asset Links statement that lets the Android app represent this origin, and so reach the Chrome profile holding the wallet credential |

`npm run probe:live -- <feedUrl>` is a discovery tool, not a check: it polls a feed and reports which live-value signal that publisher actually moves.

**Testing against local data.** A dev server on localhost still publishes to the public relays under whatever npub is signed in — including the kind:10333 favorites event other apps read, which is replaceable and keeps no history. Three scripts close that gap: `npm run relay` (an in-memory NIP-01 relay with real replaceable-event semantics), `npm run seed:relay -- <npub>` (copies an account's real list into it, read-only against the public relays), and the `e2e:*` suite — `e2e:favorites`, `e2e:mutes`, `e2e:mentions` and more — which drives the real app against a throwaway key. See [`docs/nostr.md`](docs/nostr.md).

> Stop the dev server before `npm run build` — the build rewrites `.next` and the running server then serves a mismatched chunk manifest. The collision runs both ways, so `rm -rf .next` before starting `dev` again.

## Deploy to Vercel

```bash
vercel
# env vars in the dashboard:
#   PODCAST_INDEX_KEY
#   PODCAST_INDEX_SECRET
#   NEXT_PUBLIC_BRAND                 (optional — unset = boostmebitch, 'buddy' = boostmebuddy)
#   APP_NAME                          (optional — LEAVE UNSET. It overrides the brand table's
#                                      User-Agent, so setting it makes a buddy deploy introduce
#                                      itself to Podcast Index as boostmebitch)
#   BOOSTBOX_URL / BOOSTBOX_API_KEY   (optional — BoostBox LNURL metadata proxy)
#   SITE_NOSTR_SK                     (optional — server-only nsec/hex, DIFFERENT PER BRAND; lets
#                                      signed-out boosts post a note from the app's Nostr identity)
#   NEXT_PUBLIC_GOOGLE_CLIENT_ID      (optional — unset, the Google onboarding
#                                      entry point doesn't render at all)
#   NOSTR_INDEX_URL / NOSTR_INDEX_KEY (optional — the Railway read cache; both or neither.
#                                      Unset, every path falls back to relays and PI)
#   PLAYLIST_DB_URL / PLAYLIST_DB_CA  (optional — read-only playlist-track accelerator. The CA is
#                                      required whenever the URL is set; the server presents a
#                                      self-signed cert and we will not disable verification)
#   ANDROID_PACKAGE_ID                (optional — com.boostmebitch or com.boostmebuddy)
#   ANDROID_CERT_SHA256               (optional — the APK signing certificate's
#                                      SHA-256; unset, the statement list is
#                                      empty and no Android app verifies)
```

Podcast Index credentials live only in API routes (`app/api/*`) so they never reach the browser. The Spark SDK talks straight to Spark's signing operators, so it needs no key. `vercel.json` also carries the LNURL rewrite for our own Lightning address (see below) — **`next dev` does not apply `vercel.json`**, so that path only exists on a deploy.

## Android apps

Each brand ships an Android build that is a **Trusted Web Activity** — a signed shell around the brand's own origin, built by Bubblewrap from that brand's web manifest. There is no second copy of the app: a Vercel deploy updates the Android app at the same moment it updates the site. It fits this audience — those users sign with **Amber** (already supported over NIP-55, and Android-only) and pay over **NWC**.

**Two of everything, one per brand.** `android/twa-manifest.json` and `android/twa-manifest-buddy.json` are the source files; `zapstore.yaml` and `zapstore-buddy.yaml` are the listings; `.github/workflows/android-release.yml` builds, signs and publishes on a `v*` tag. The package ids are `com.boostmebitch` and `com.boostmebuddy` — a TWA wraps an origin, so a package id can never be rebranded after its first publish. **Only the buddy app is listed on [Zapstore](https://zapstore.dev)**, the Nostr-native app store; the other APK ships from GitHub releases.

Chrome only drops the browser URL bar if `/.well-known/assetlinks.json` names the exact package and signing certificate, which is what `ANDROID_PACKAGE_ID` and `ANDROID_CERT_SHA256` are for — unset, that document is an empty list and no app verifies. The release workflow refuses to publish a build the live origin does not vouch for.

**The keystore and the Zapstore publishing key are not in this repo and cannot be.** [`docs/android.md`](docs/android.md) has the first-release runbook, why the origin must be `www` and not the apex, and what still needs testing on a real device.

---

## Architecture

Nine pages, twenty-five route handlers, and the module boundaries that keep wallet and signer code out of `components/`.

### Pages

| Route | What it is |
| --- | --- |
| `/` | search, the global Nostr feed, URL-restored show and episode views |
| `/live` | everything on air — podcast `liveItem`s verified against RSS, beside kind:30311 streams |
| `/favorites` | your kind:10333 list — grouping, filter, visibility, audit + repair, export/import |
| `/playlists` | the curated `musicL` collections |
| `/stream/[naddr]` | one broadcast, shareable |
| `/live/[npub]` | a host's *current* broadcast — a permanent link that survives each new dTag |
| `/npub/[npub]` | boost explorer: boosts sent, boosts received, NIP-57 zap receipts |
| `/amber-callback` | the NIP-55 return hop from Amber |
| `/privacy` | privacy policy, linked from the layout footer (Google requires both) |

The **dock** (`components/tab-bar.tsx`) fronts three of them — **Home / Live / Favorites** — on every route, at `z-30`, height `--tabbar-h` (56px), beside a fourth **Wallet** slot that is not a route at all: it flips `walletOpen` in the store, the same flag the header's balance chip flips, and `<WalletModalHost>` in the root layout renders the modal. Playlists is deliberately not a tab — it is content, reached from the search box's Playlists lane and from its own linkable page.

### Route handlers

| Route | Upstream | Why it can't be a browser fetch |
| --- | --- | --- |
| `api/search` | PI `/search/byterm` | credentials are server-only; merges the music and playlist lanes, repairs blank PI records from RSS |
| `api/feed` | PI byfeedid ×2 + RSS | credentials; RSS enrichment, show-notes sanitizer, live-item merge |
| `api/by-guid` · `api/by-guid/batch` | PI byguid / byfeedurl | credentials; the batch resolves a whole favorites list in one request |
| `api/episode-by-guid` · `…/batch` | PI `/episodes/byguid` | credentials; the batch is POST because item guids are often permalink URLs |
| `api/value-splits` | PI + RSS | resolves an episode's `valueTimeSplit` remote items |
| `api/remote-item` | PI + RSS | "can this remote item's parent feed be resolved?" — gates a favorite heart |
| `api/playlist` | PI batch | one page of a `musicL` playlist; a cacheable GET, identical for every viewer |
| `api/publisher` | PI then RSS | publisher feed → child albums, with a capped fan-out |
| `api/live-shows` | PI roster + every publisher's RSS | credentials, and the fan-out belongs on a server |
| `api/live-status` | RSS | "is this feed's live item still on air", polled by the show page |
| `api/live-value` | RSS | a live item's current payment target |
| `api/art` | any feed's artwork host | 27.68 MB of source squares → allowlisted-width WebP |
| `api/og/boost.png` | feed art | the 1200×300 banner baked into an immutable kind:1 (satori, hence `route.tsx`) |
| `api/chapters` | `<podcast:chapters>` JSON | hosts send no CORS |
| `api/transcript` | `<podcast:transcript>` | hosts send no CORS; served inert as `text/plain` + `nosniff` |
| `api/keysend` | `.well-known/keysend` | a server-to-server convention with no CORS headers |
| `api/lnurl` | an LNURL-pay endpoint | **fallback only**, used when the direct browser fetch throws |
| `api/lightning/boostbox` | BoostBox | holds `BOOSTBOX_API_KEY` |
| `api/nostr/index` | `services/nostr-index` | keeps the shared key server-side; `path` matched against a fixed allowlist |
| `api/nostr/site-sign` | — | signs a boost note with `SITE_NOSTR_SK`, which may never reach the browser |
| `.well-known/nostr.json` | — | NIP-05 for the site identity, derived from `SITE_NOSTR_SK` |
| `.well-known/keysend/[name]` | — | our own Lightning address's keysend doc, multi-domain aware |
| `.well-known/assetlinks.json` | — | Digital Asset Links, built from the `ANDROID_*` env |

Every route starts with `rateLimit(req, '<route>', N)`, sets `Cache-Control` on 200 responses only, and returns `{ error }` through `getErrorMessage(e, fallback)` — never a raw exception message, which would turn the SSRF guard into an oracle.

### Modules

| Path | Owns |
| --- | --- |
| `lib/v4v/` (19 files) | every wallet call: rails, splits, TLV, the streaming ledger, zaps, live value |
| `lib/nostr/` (52 files) | every signer call: the sign-in paths, feed assembly, lists, encrypted backups, the read-index client |
| `lib/brand.ts` | the two-brand table — an **import-free leaf**, enforced by `scripts/import-free.mjs` |
| `lib/util.ts` | the pure money arithmetic (splits, ordering, allocation) and the shared gates; **type-only imports**, which is what lets the check scripts load it under plain Node |
| `lib/pi.ts` · `podcast-meta.ts` | the server-side Podcast Index client, and the one client-side metadata resolver (cache + circuit breaker) |
| `lib/safe-fetch.ts` · `safe-url-attr.ts` · `capped-body.ts` | the SSRF guard, the show-notes scheme allowlist, and the byte caps every third-party read goes through |
| `lib/store.ts` · `lib/storage.ts` | Zustand in-memory state; every `bmb:*` key, with quota eviction and a memory mirror |
| `lib/playlist-db.ts` · `playlist-db-map.ts` | the read-only Postgres accelerator over another app's track table |
| `lib/gif-first-frame.ts` · `track-art.ts` | cutting an animated cover to frame one, and choosing which artwork a surface shows |
| `components/` (72 files + 4 dirs) | the surfaces — `boost-modal/`, `lists/`, `nostr-auth/`, `player/` |
| `components/lists/` | the row panels; **`lists.tsx` is now only a barrel** |
| `scripts/` | 38 `check-*.mjs` pins, the local relay, and the `e2e:*` / `probe:*` tools |
| `services/nostr-index/` | a separate Railway deployable — see below |

`lib/v4v/*` and `lib/nostr/` are the **only** files that talk to wallets / signers; components import them through the `lib/nostr/` barrel and the `lib/v4v/*` entry points, so the toolkit can be swapped without touching `components/`.

**`services/nostr-index/` is a separate deployable, not part of this app.** It holds relay WebSockets open continuously — which a serverless function cannot — and caches public events so a feed costs one request instead of four serial relay stages. It has its own `package.json`, dependencies and checks, is excluded from this repo's `tsconfig.json` and `eslint.config.mjs`, and never imports from `lib/` (nor `lib/` from it). It caches kinds **0, 1, 6, 9735 and 30311**, and it caches Podcast Index's raw records too — which is the half that fixes favorites hydration, measured at ~445 PI calls per device. **A list of forbidden kinds is enforced at ingest, not merely in the subscription filters** (a filter is a request; a relay may send anything): kinds 3, 4, 1059, 10000, 10002, 10333 and 30078 are refused, because an accelerator that answered about them would drive a destructive write — a stale favorites read satisfies the merge's removal test and deletes another app's entries with no undo. Every lookup fails **soft**: a `null` sends the caller down the relay or PI path it would have taken anyway. It runs on **Railway and is CLI-uploaded, so it does not deploy when you merge** — ship it with `railway up` from that directory.

---

## Where the reasoning lives (`docs/`)

The code says what happens; these say why the obvious version is wrong. Read the relevant one before editing in its area — the rules in it are not reconstructible from the source. (`CLAUDE.md` indexes the same files *by the globs that should trigger a read*; this table is a reading order, so the two are deliberately not identical.)

| Doc | Answers |
| --- | --- |
| [`docs/feeds.md`](docs/feeds.md) | how Podcast Index, RSS, batching and the playlist DB are reconciled — and when each may be trusted |
| [`docs/money-boosts.md`](docs/money-boosts.md) | the split arithmetic, and the keysend-vs-LNURL rail decision, per leg |
| [`docs/streaming.md`](docs/streaming.md) | the ledger, the settle edges, and the live-value watcher |
| [`docs/value-playback.md`](docs/value-playback.md) | kind:3369 / 33369 — an app-neutral wire format shared with other Podcasting 2.0 apps |
| [`docs/wallets.md`](docs/wallets.md) | the three rails, and what each one provably cannot do |
| [`docs/signers.md`](docs/signers.md) | all four sign-in paths, and the Google key backup |
| [`docs/nostr.md`](docs/nostr.md) | notes, feeds, lists, mentions, the boost explorer, and the note's picture |
| [`docs/nostr-index.md`](docs/nostr-index.md) | the read cache: what it may hold, and what it must refuse |
| [`docs/ui.md`](docs/ui.md) | the players, the dock, the panels, and the layout invariants |
| [`docs/storage.md`](docs/storage.md) | every `bmb:*` key, and which of them are evictable |
| [`docs/security.md`](docs/security.md) | hostile feed input, the SSRF guard, and the `nsec` refusal |
| [`docs/ops.md`](docs/ops.md) | Google Cloud, DNS, Vercel env — the settled console state |
| [`docs/android.md`](docs/android.md) | the two TWAs, the release runbook, and why the origin must be `www` |
| [`docs/spark-sdk-swap.md`](docs/spark-sdk-swap.md) | what a Spark SDK upgrade may not move |

---

## Boost flow

Entry points: **⚡ BOOST in the player** (current episode, `ts` = playback position), **⚡ BOOST on the show header** (channel-level value block, `ts: 0`), **⚡ per-track** on any row whose track carries a value block, and **⚡ BOOST N TRACKS** (boost-all). All open a modal that computes splits from the value block and pays.

**Rail.** `pickRail()` honors the user's last-used rail (`storage.railPref`), else priority **NWC > Spark > WebLN**. Both modals show the same **rail picker** (`components/rail-picker.tsx`) whenever 2+ rails are connected — a silent pick is how a funded Spark wallet sat untouched while boosts went out of an old extension. Per recipient:

- **`type=node`** → keysend with TLV record `7629169` carrying the boostagram JSON. Per-recipient `customKey`/`customValue` (e.g. shared-node sub-account routing for getalby.com) is a separate TLV record. (Spark can't keysend — node legs are rejected on the Spark rail.)
- **`type=lnaddress`** → probes `.well-known/keysend/<name>` first, via the `/api/keysend` proxy (that endpoint carries no CORS headers, so a direct browser fetch would always fail). When the address publishes one and the rail isn't known to be keysend-incapable, the leg is paid as a real **keysend** so the boostagram rides in TLV `7629169` intact (instead of degrading to a LUD-21 comment) and the endpoint's `customKey`/`customValue` routes to the right sub-account. Wallets that are *provably* keysend-incapable (Spark, or an NWC connection whose advertised methods exclude `pay_keysend`) skip the probe and go straight to LNURL; a wallet that never advertised its methods is attempted anyway, and a NIP-47 `NOT_IMPLEMENTED` refusal — returned instead of a payment, so nothing moved — falls back to LNURL. Otherwise: LNURL-pay invoice fetch (amount-verified against the BOLT11 before paying), then pay via the chosen rail.

Per-recipient progress + errors render live; confetti fires when a leg lands. **When "Share on Nostr" is on and at least one payment landed**, a kind:1 boost note is published — signed by your own key when signed in, or by the site's Nostr identity server-side (`app/api/nostr/site-sign`, `SITE_NOSTR_SK`) when you're not.

**Anonymity is about the payment, not just the note.** The share picker's three states are **My feed / Anonymous / Don't post**. Anonymous drops `sender_id` (your pubkey — recipient aggregators resolve it to your avatar and name), drops the `reply_*` fields (a lightning address names its owner just as surely) *and* replaces `sender_name` with the brand's default sender name, on every leg of every mode including boost-all's per-track, host-share and summary legs. That default is also what a boost with an empty "From" field sends, so a recipient never renders a blank sender.

**Live-stream boosts → real zaps.** When you boost a Nostr live stream signed-in, with an active signer and a host whose Lightning address supports NIP-57 (checked *before* paying, so no double-pay), the boost is sent as a real **zap** (`sendZap`, `lib/v4v/zap.ts`) tagged to the stream — the recipient's LN service then publishes a kind:9735 receipt that renders as a boost in Fountain / tunestr / zap.stream **and** in this app's chat. Otherwise it falls back to a normal boostagram payment plus a kind:1311 "⚡ Boosted N sats" chat line.

**WebLN and NWC look symmetric and are different wire formats.** WebLN's `customRecords` values are plain UTF-8 strings — the extension hex-encodes internally, so pre-hexing double-encodes. NWC's `pay_keysend` `tlv_records` are hex, per NIP-47. `recordsForKeysend` and `tlvHexFor` (`lib/v4v/boost.ts`) apply the right one per rail; the argument is in [`docs/money-boosts.md`](docs/money-boosts.md).

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

### Value-playback receipts (kind:3369 / 33369)

Streaming publishes no kind:1 — a note per ten-minute settle would bury the user's own feed. The one exemption is a **value-playback receipt**, and it is narrow: no client renders these kinds, so they cannot reach anybody's feed. Both are **opt-in and off by default** (`bmb:stream_receipts`, `bmb:stream_summaries`; the summary requires the receipt, being derived from it), and both are further gated on being signed in, on a signer that can sign unattended, and on not being in anonymous or site-signing mode — each withheld state is named on screen, so the switch can never read ON while nothing publishes.

- **kind:3369** — one receipt per settle, carrying the same `action` word the boostagram carried, so the payment and the Nostr record cannot disagree.
- **kind:33369** — running totals. It is **addressable**, so one person signed into two apps on one key is two writers at one address: the totals are **derived from the receipts, never accumulated**, monotonic on both fields, and compared by value rather than by bytes, or each writer rewrites the other's event forever.

Emitted on **streaming settles only** — a boost you pressed keeps its kind:1 note or its NIP-57 zap receipt and gets no 3369. The wire format is an external spec shared with other Podcasting 2.0 apps, so a format change is a PR upstream before it is a commit here; kind:23369 (an ephemeral live ticker) is specified there and **not implemented**. → [`docs/value-playback.md`](docs/value-playback.md)

---

## Live value — following the artist during a live show

`<podcast:valueTimeSplit>` can't do this: it anchors to offsets into a finished enclosure, and a live stream has no absolute time base. There is no live-VTS tag. What live V4V music shows actually use is a **push channel** — `<podcast:liveValue uri="…" protocol="socket.io"/>` inside the `<podcast:liveItem>`, served by [The Split Kit](https://thesplitkit.com). The host clicks a track; every app's payment target moves within a second.

```
socket 'remoteValue' → { title, image, feedGuid, itemGuid, blockGuid, eventGuid, eventAPI,
                         settings.split, value.destinations[] }   → the block now broadcasting
```

Both paths are implemented and the socket wins whenever it is delivering; the RSS fallback (polled every 20 s, `/api/live-value`) is for shows that don't run Split Kit. Its three signals resolve in precedence order: a `<podcast:remoteItem>` inside the live item → a *lone* `<podcast:valueTimeSplit>` inside it → the live item's own `<podcast:value>`, that last one only once it has been observed to **change** (a static block is indistinguishable from a show that never touches it).

The resolved target becomes an ordinary bucket in the streaming ledger, so the per-bucket settle, the track-boundary settle edge and the boostagram's `remote_feed_guid`/`remote_item_guid` shape all apply unchanged. It also swaps `episode.value`, which is what makes the **boost** button follow the artist with no extra plumbing — `<LiveNowPlaying>` names the target in the boost modal, and the block's own cover art follows onto the fullscreen pane, the mini-bar, the meter and the modal. A failed poll keeps paying the last known artist for ~1 minute, then falls back to the show's own block; `socket.io-client` is dynamic-imported so it costs nothing to anyone who never plays such a show.

**Debugging a live show:** every way this fails is silent and looks identical from outside — the target just doesn't move. `bmbLive()` in devtools reports which one it is, and `npm run probe:live -- <feedUrl>` answers the same question for a feed you haven't played yet. → [`docs/streaming.md`](docs/streaming.md)

---

## Nostr live streams (NIP-53)

`/live` surfaces kind:30311 streams (`fetchNostrLiveStreams`) beside the podcast live items, dropping stale `live` events (no `ended` update within 2h) and sorting upcoming-first then newest. Everything is the shared NIP-53 standard, so it interoperates with **Fountain, tunestr, and zap.stream** — only relay coverage varies.

- **HLS video** plays in-app via `hls.js` (dynamic-imported; native HLS on Safari). A single `<video>` lives in a **reverse portal** so it moves between the mini-bar and the fullscreen pane without remounting (audio keeps playing when collapsed). Non-HLS media stays on the native `<audio>`.
- **Two share routes.** `/stream/<naddr>` pins one broadcast; `/live/<npub>` resolves a host's *current* stream at click time, so the URL a show puts in its bio stays valid across broadcasts (each new stream gets a fresh dTag, the npub never changes) and renders a "not live / next up" placeholder when they're offline. `<Player>` is mounted in the root layout, so playback survives browse ↔ stream navigation.
- **Live chat** subscribes to **kind:1311** (chat) **and kind:9735** (zap receipts / boosts) for the stream. Both render in one row list; zaps get a `⚡ N sats` badge, and a **total-sats-zapped** line shows at the top. New messages re-sync periodically and on focus (relay subscriptions go stale when a device backgrounds). Signed-in users can post (kind:1311).
- **What played so far.** A live show publishes no timeline, so the app remembers each payment target the watcher resolved and renders them as a played-track log — **every row carries a working favorite heart**, which is why the log is scoped to the item's guid: a list shown for the wrong show is a favorite for a song the listener never heard.

---

## Playlists

A Podcasting 2.0 **playlist** is any `*L` medium, and a `musicL` feed is the awkward case: it publishes **no `<item>` elements at all**. Its contents are channel-level `<podcast:remoteItem>` refs — one Podcast Index lookup each, and the live Homegrown Hits list carries 1,217 of them.

`/api/playlist?url=&offset=&limit=` returns one **page** of resolved tracks. It is deliberately a GET: the answer is public and byte-identical for every viewer, so a shared CDN cache can serve it, unlike the per-user POST batch routes. `/playlists` collects two curated sets — one publisher feed of our own, so a new playlist appears with no deploy, and a separate list of playlists by other authors on other hosts, kept separate so attribution is never implied falsely. `lib/musicl-resolver.ts` is the RSS rescue for remote items Podcast Index hasn't indexed, walking host feed → publisher feed → album feed.

**A container feed is not the parent of the items it lists.** A playlist names tracks in hundreds of *other* feeds, so the container's URL, medium, title and art must never be copied onto a track — that would publish a fact about someone else's song into a shared, undoable event, and pay the curator instead of the artist. The discriminator is the item's own `podcastGuid`.

**`PLAYLIST_DB_URL` is an accelerator, never an authority.** It is a read-only connection to another application's Postgres holding ~13,800 already-resolved tracks; on one measured page it answered 319 of 342 refs in a single 117 ms query. Two rules make it safe: **a miss is not an answer** (it falls through to Podcast Index, and every failure returns `null` rather than an empty result — unset the variable and the feature is simply off), and **its cached value blocks are not trusted**, because on one 8-row sample all 8 disagreed with the live feed and two named a different destination node. The playlist *feed* still decides membership and order. `PLAYLIST_DB_CA` is required alongside it: the server presents a self-signed certificate, and the accelerator disables itself rather than skip verification.

---

## Chapters + transcripts

`<podcast:chapters>` JSON and the best **timed** `<podcast:transcript>` (ranked JSON > SRT > VTT) are parsed from the RSS enrichment pass, fetched through `/api/chapters` and `/api/transcript` — many hosts serve them with no `Access-Control-Allow-Origin`, so a direct browser fetch is silently CORS-blocked. The transcript proxy always returns inert `text/plain` + `nosniff`, never the upstream Content-Type: transcript URLs come from arbitrary feeds, and a host serving `text/html` with a `<script>` would otherwise execute in *our* origin.

Both surface in three places — the episode detail page, the fullscreen player's **About / Chapters / Transcript** tab strip, and the mini-player — with seek-bar tick marks, a current-chapter label, chapter-stepping ⏮/⏭, tap-to-seek rows, and an in-panel transcript search that filters while keeping the playing line's highlight correct. `<Player>` owns the single fetch for both; the gates (`chapterUrlFor`, `transcriptSourceFor`) return empty for live streams and music feeds, so this is podcasts-only everywhere at once.

Chapters and `valueTimeSplit` windows render in **one merged list**, merged on timestamp — but a chapter is never mapped to a window. They are distinct row types, so a chapter row has no track identifiers to hand a favorite heart even by accident: on some shows the windows overlap, and "the window covering this chapter" would name the wrong song.

---

## Boostagram TLV (record 7629169)

Podcasting 2.0 fields, plus Nostr-aware additions — drops into Helipad / Fountain / Castamatic ingestion without mapping:

| Field | Source | Notes |
| --- | --- | --- |
| `app_name` | `BRAND.wireName` | `"BoostMeBitch"` or `"BoostMeBuddy"` — the two deploys identify themselves separately on purpose |
| `app_version` | hard-coded | `"0.1.0"` |
| `podcast`, `episode` | feed / stream | `episode` omitted on show-level boosts |
| `feedID`, `itemID` | Podcast Index | omitted on show-level boosts |
| `url` | feed metadata | RSS feed URL (Helipad reads this) |
| `ts` | playback position | `0` on show-level / live boosts |
| `value_msat`, `value_msat_total` | per-leg / total | both in millisats |
| `message` | user input | optional |
| `sender_name` | Nostr `display_name` / `name`, editable | falls back to the brand's default sender name — and is *replaced* by it on an anonymous boost |
| `sender_id` | Nostr pubkey hex | omitted when signed out **or** anonymous |
| `reply_address` | the sender's own `lud16` | a node pubkey when the address publishes `.well-known/keysend`, else the address itself — a receiver tells them apart by the `@`. Omitted when signed out, when there is no `lud16`, **or** when anonymous. Sent from the boost modal only |
| `reply_custom_key`, `reply_custom_value` | that endpoint's routing pair | sub-account routing for a shared custodial node. Both or neither, and the key is a **number** — a receiver reading it as an integer rejects a quoted one |
| `action` | `'boost'` \| `'auto'` \| `'stream'` | `'boost'` = the button. A streaming settlement is `'auto'` when the leg pays a song and `'stream'` when it pays the show |
| `uuid` | one per boost | Helipad groups legs by it |
| `remote_feed_guid`, `remote_item_guid` | `<podcast:guid>` / item guid | NIP-73 refs; carry the **track** on boost-all and streaming legs, the **stream** on live-stream legs |
| `eventGuid`, `blockGuid`, `eventAPI` | Split Kit | only when the target came off a `<podcast:liveValue>` channel; additive, so a normal boostagram is byte-identical to before |

We emit the boostagram in TLV `7629169` only — never a separate `696969` sender record (it collides with shared-node sub-account routing). LNURL legs put the boostagram message in the LUD-21 `comment`; BoostBox legs prepend their `rss::payment::<action>` desc.

---

## Nostr boost note (kind:1)

| Tag | Value |
| --- | --- |
| `i`, `k` | `podcast:guid:<feed-guid>` + `k=podcast:guid` (NIP-73) |
| `i`, `k` | `podcast:item:guid:<item-guid>` + `k=podcast:item:guid` (omitted on show-level boosts) |
| `r` | a listen link **and** a deep link back into this app — both episode-specific when boosting an episode |
| `amount` | total millisats *intended* (not sum of successful legs) |
| `client` | `BRAND.wireName` |
| `t` | `boostagram` + `value4value` |

**Both `r` tags point at the episode when there is one** — a note about one episode that lands the reader on the show's front door makes them go hunting. The listen link prefers the episode's own web page (RSS `<link>`), then a URL-shaped item guid, then `pod.link/<itunesId>` → PI page → raw RSS (those last three are show-level: neither pod.link nor PI has an episode URL constructible from a guid). The app link is `?podcast=<guid>&episode=<guid>` — a restorable view that emits episode-level OG tags, so the unfurl carries the episode's own title and art. Everything derived from feed text goes through `httpUrl`, an http(s) allowlist, before landing in a public note.

**Who signs it.** Signed in → your own key via `window.nostr` (`signAndPublish`). Signed out → the site's own Nostr identity, signed **server-side** at `app/api/nostr/site-sign` (which validates the note is boost-shaped, and bounds tag size as well as tag count, before signing with `SITE_NOSTR_SK`) and published from the browser via `publishBoostNoteViaSite`.

**Where it publishes.** Signed in → `resolvePublishRelays(identity)`: a manual `localStorage.bmb:relays` override, else the user's NIP-65 (kind:10002) write relays **unioned with the defaults** (so a note still lands when the write relays are dead/AUTH-gated), capped at 20. Signed out (site identity) → the defaults. Defaults:

```
wss://relay.damus.io · wss://relay.primal.net · wss://nos.lol · wss://relay.fountain.fm
```

### The note's picture (`/api/og/boost.png`)

Every boost note carries a **1200×300 (4:1) banner** — the show's artwork beside the sats, the show and episode titles, and the brand wordmark, rendered with satori. A 4:1 strip rather than the square cover, because a square pushes the sats, the show and the message apart in a note column. It also closes two gaps a raw artwork URL cannot: artwork whose URL has no image extension, and feeds with no artwork at all.

**Its path, its parameter names and the `.png` suffix are a permanent public contract.** The URL is written into signed, immutable kind:1 events, so renaming any part of it blanks the picture on every boost note ever published, all at once. Add parameters; never change what one means. The extension is in the *path* because a Nostr client decides whether a bare URL is an image before it fetches it.

Only PNG, JPEG and GIF are rasterizable — WebP and AVIF are refused deliberately, since satori throws on them and a modern CDN's cover would become a 502. Animated GIFs are cut to their first frame by `lib/gif-first-frame.ts`, which walks GIF89a block structure and appends a trailer **with no pixel decoding**: one show ships a 19 MB animated GIF as episode art against the route's 2 MB cap, and the first frame is a few hundred KB sitting at the front of the file, so a bounded prefix is enough. A truncated input is therefore the ordinary case, not an error.

---

## Wallets

Connected from the header's **`<AuthControl>`** (the combined "Sign in ▾" login — wallet and Nostr are separate) via the **wallet modal** (`components/wallet-modal.tsx`), which is reachable on every route; a balance chip reads the active rail. Signed out, **NWC + WebLN work fully**; the Spark row needs Nostr sign-in (its seed is encrypted to your key). The modal's connected view also carries the **global streaming rate control** and the **streamed-payment log**.

- **NWC** (NIP-47, `@getalby/sdk`) — paste a connection URI. Optionally **back it up encrypted to Nostr** (kind:30078, NIP-44 to-self) so it restores on other devices; opt-in and deletable.
- **Spark** (`@buildonspark/spark-sdk`) — paste/create/restore a seed; **no API key**. The mnemonic is stored **encrypted to Nostr** (kind:30078) for silent restore, so this rail requires a Nostr identity. Account number matches Primal/BlitzWallet so the same seed shows the same balance.
- **WebLN** — the injected extension (Alby), enabled on demand (we never call `wl.enable()` speculatively).

---

## Signers

`window.nostr` is the single interface; four paths feed it (swapped by `lib/nostr/signer.ts`):

- **NIP-07** browser extension (Alby, nos2x, nostash on iOS).
- **Amber** (NIP-55) on Android — the `nostrsigner:` URL scheme, returning through `app/amber-callback` (a real route, because some browsers open the callback in a new tab).
- **NIP-46 bunker / `nostrconnect://`** remote signer (nsec.app, Clave, Amber-as-bunker, Primal). One-tap hand-off on both mobiles — `nostrconnect://` into Amber on Android, and Clave's Universal Link into Clave on iOS. The iOS control is a real `<a href>`, because a Universal Link only reaches the app from a genuine tap on a real anchor; dispatched from script it loads clave.casa and takes the pending pairing with it. So the pairing is prepared when the sign-in panel opens rather than inside the click, which is what lets the control be an anchor at all. A signer that queues a request for its user (Clave answers `permission denied` first and the real result after the tap) is asked again rather than reported as having refused.
- **Local key** — the only path where *we* hold the key, for users who arrive with no Nostr identity at all. At rest it is AES-GCM ciphertext in IndexedDB under a non-extractable `CryptoKey`, never `localStorage`.

The header's combined **"Sign in ▾"** control opens a modal with **Continue with Google** above a two-tab picker (Extension / Remote signer). `nostr-tools` is pinned to **exactly `2.19.4`** — `2.20.0+`'s NIP-46 rewrite breaks the `nostrconnect://` handshake on our relays.

**Google onboarding — a key for users who have none.** Ported from [Wisp](https://github.com/barrydeen/wisp). **Google is not an identity provider here — it's a zero-knowledge blob store.** The key is generated locally at random and nothing is derived from the Google account; the encrypted blob lives in Drive's app-private `appDataFolder` under an opaque filename, and the npub exists only inside the ciphertext, so Google holds something it cannot link to a Nostr identity. **The PIN is the only secret**, and losing it loses the account — the setup screen says so. New accounts also get a Spark wallet derived from the same key and a generated kind:0 (a two-word name and an identicon derived from the pubkey), so a signup arrives with a working boost rail and a recognizable profile. The whole path is gated on `NEXT_PUBLIC_GOOGLE_CLIENT_ID`: unset, the entry point doesn't render and nothing else changes. Setup, scopes and the settled console state are in [`docs/signers.md`](docs/signers.md) and [`docs/ops.md`](docs/ops.md).

---

## Favorites, mutes, follows

- **Favorites** (kind:10333, one plain replaceable event per pubkey) — ♡ on a podcast row or an episode row. A list **shared with other podcast apps** (see [the PC 2.0 favorites spec](https://github.com/ChadFarrow/PC20-Nostr/blob/main/pc20-favorites.md)), one `i` tag per favorite, under a running `medium` tag. An `i` tag is `['i', feedId, itemId]` and position 2 is optional: two elements is a feed favorite, three is one item of that feed, and the element COUNT is the only difference — their position 1 is the same string. A two-element `podcast:item:guid:` tag is the legacy form, still most of what is on the relays, and takes its feed from the entry above it, so tag ORDER is still the data. Public entries are tags; a private list is the same tag array NIP-44-encrypted to self in `content`, and a `visibility` tag says which half the whole list lives in. Every publish reads first and merges, because any app may write the event and a blind publish deletes the others' entries. Deliberately **not** a NIP-51 bookmark set: podcast favorites aren't bookmarks, and a generic bookmark client editing that set would rewrite this list. `npm run check:favsync` pins the format; `npm run check:conformance` runs the spec's own 28 vectors against it. The app is at **stage 1** of the feed-guid migration — it reads the three-element form and carries it whole, and does not write it until the other implementation reads it — so six of those vectors are red on a published schedule rather than as a regression.
- **`/favorites` is a real route**, not a panel — it replaced a collapsed aside on the home page that showed twelve rows per medium, which was untenable at ~200 favorites. It groups by medium under collapsible headings, sorts and filters, reveals twelve rows at a time (a bytes cap on third-party covers), and carries the **public / private / off** visibility control, a **private-half audit and repair** tool, and **export/import of the kind:10333 event itself**. A per-npub localStorage cache paints it instantly — and that cache is an *input* to the next sync, not just a render cache, so a surface may only claim the library is empty once the read has actually answered.
- **Mutes** (kind:10000) — 🚫 on a note card. Interoperates with Damus/Amethyst. The private half is **whatever cipher the writer used** — NIP-51 specified NIP-04 and later moved to NIP-44, so the list is republished in the form it was read in; rewriting a NIP-44 list as NIP-04 makes it unreadable to the client that wrote it, from a publish that looks entirely successful here. An unreadable blob from another client is carried verbatim, and said so on screen. Filtered at render time across all feeds.
- **Follows** (NIP-02 kind:3) — `+ Follow` on note cards and on npubs in show notes, through one shared singleton (a 20-card feed does **one** kind:3 fetch, and toggles are serialized). Publishing preserves the existing content and every existing tag, changing exactly one `p`. **The invariant: never publish a list you didn't reliably fetch** — buttons stay disabled until the load is trustworthy, and an empty-base publish is re-confirmed against relays and a last-known-good cache first. A blind republish is the classic way clients nuke someone's follow list.

---

## Serving our own Lightning address

The mirror image of the boost path: `chadf@boostmebitch.com` is an address other apps pay.

- **LNURL** is a `vercel.json` **rewrite** — `/.well-known/lnurlp/:user` → an LNbits instance fronting the node. An edge rewrite, so the hottest path in a payment costs no lambda invocation. Not applied by `next dev`.
- **Keysend** is a route handler (`app/.well-known/keysend/[name]/route.ts`), deliberately not a static file. It validates the pubkey on the way *out* against the same `/^0[23][0-9a-f]{64}$/` the reader enforces, and serves 404 rather than publishing a malformed one — a payer that trusts a bad pubkey sends a keysend that can never arrive. Each name carries its own `domain`, so one brand's deploy never answers for the other's address.

The two aren't independent: discovery *starts* at lnurlp, and every BOLT11-only wallet (Spark among them) can only pay that way.

---

## PWA + themes

Installable (`public/manifest.json` — or `manifest-buddy.json` — plus `public/sw.js` and `<SwRegister>`); the service worker has **no precaching** (hashed bundle URLs would go stale) — its empty `fetch` handler just enables the install prompt. Light/dark via role-based CSS tokens (`--ink`, `--bone`, `--bolt`, …) flipped on `:root[data-theme='light']`; a FOUC blocker sets the theme before first paint.

---

## Notes / gotchas

- **Feed content is hostile input.** Show notes render via `dangerouslySetInnerHTML`, and this origin's `localStorage` holds a budgeted NWC spending credential — so `href`/`src` go through `safeUrlAttr`, a scheme **allowlist** (it shipped as a denylist once and six vectors reached the DOM as live `javascript:`). Every server-side fetch of a feed/chapter/transcript URL goes through `safeFetch`, which re-validates **every redirect hop**, and every third-party body is read through the capped readers — a timeout bounds how *long* a fetch runs, not how many bytes it returns. All pinned, must-still-work halves included.
- **Artwork goes through `/api/art`, and it is an accelerator, never a dependency.** Across 53 live feeds, the cover squares this app paints at 64–160px measured **27.68 MB** in total — 535 KB average, largest 8 MB — while a 320px WebP of the same cover is 10–15 KB. Two rules keep it honest: the width is an **allowlist, never a free integer**, because each `(url, width)` pair is a CDN cache key; and `artCandidates` keeps the **raw third-party URL behind the proxied one**, so a failing route costs speed and not pictures. Covers use `<img>` (arbitrary per-feed hosts), not `next/image`; the local hero uses `next/image`.
- **The dock is the only element that pays `env(safe-area-inset-bottom)`**, and anything else anchored to the viewport bottom clears it with `--dock-b` rather than a literal. Anything so anchored also carries `translateY(var(--kb-inset))` — iOS scrolls the visual viewport for the keyboard and does not always scroll it back.
- Every overlay goes through `<ModalShell>`, which owns the portal, the dialog semantics, the focus trap and one app-wide scroll lock — overlays genuinely stack, so the refcount cannot be per surface.
- Native HTML5 `<audio>` plays the enclosure URL directly; the one exception is HLS (`.m3u8`) live streams, which go through `<video>` + `hls.js`.
- **Feed artwork must never outrank the enclosure.** Chapter and cover art is arbitrary third-party media, routinely on the same origin as the audio and routinely enormous, and a starved audio element keeps `paused === false` — so the transport draws ❚❚ over silence. Measured: images blocked bought +13.1 s of playback, allowed bought +0.0 s.
- Wallet creds + Spark seed live in `localStorage` (and, opt-in, encrypted on Nostr) — nothing wallet-related is sent to our server. `storage.safeSet` evicts regenerable caches and falls back to a memory mirror when the store is full or blocked, so a settings control can't silently freeze.
- Nostr publish is opt-in per boost; **Lightning is sent first**, the note/zap only fires after a payment lands — no false "I boosted" posts. And a publish resolving is not proof anything landed: anything recording durable state on the strength of one asserts it first.
- PI is treated as flaky by design: a circuit breaker, a not-found-is-not-a-500 rule, and probe-first-then-batch on every fan-out. A 429 is never an answer *about the data*.

## Roadmap-ish

- Relay-list management UI (the `bmb:relays` override has no UI yet).
- A cross-show listen queue, and an Inbox of new episodes from the shows you follow.
- Streaming sats for Nostr kind:30311 streams (deferred — it would need a new zap-shaped settlement path).
- kind:23369, the ephemeral live value-playback ticker — specified upstream, not implemented here.
- NIP-51 favorite categories ("podcasts I host", "music I love").
