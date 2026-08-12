# Nostr — identity, lists, live streams, notes, feeds

Read before touching `lib/nostr/*` (non-signer), `components/*note*`, `components/*feed*`, or `live-chat.tsx`.

Core rules live in [`../CLAUDE.md`](../CLAUDE.md); this file holds the reasoning.

## Nostr identity enrichment

`loginWithExtension()` returns only `{ pubkey, npub }`. After login, `components/nostr-auth/index.tsx:loadProfile` merges these in parallel:

- **kind:0 profile** — `name`, `display_name`, `picture`, `nip05`, `about` → header avatar, boost-modal "From" auto-fill.
- **NIP-65 relay list (kind:10002)** — unmarked + `write` entries → publish target.
- **NIP-51 favorites (kind:30003, `d:podcast:favorites`)** — shared cross-app list, see Favorites and [`docs/pc20-favorites.md`](pc20-favorites.md).
- **NIP-51 mutes (kind:10000)** — public + NIP-04 private p-tags. See Mutes.
- **Spark backup (kind:30078, `d:boostmebitch:wallet:spark`)** — NIP-44 v2 encrypted-to-self mnemonic; best-effort silent restore, failures swallowed.
- **Settings (kind:30078, `d:boostmebitch:settings`)** — NIP-44 encrypted-to-self JSON, currently just `railPref` → `storage.railPref`. `lib/nostr/settings-backup.ts`.
- **NWC backup (kind:30078, `d:boostmebitch:wallet:nwc`)** — NIP-44 encrypted-to-self `{ uri }`, **opt-in only**. Restored to `bmb:nwc_uri` when this device has none. `lib/nostr/wallet-backup.ts`.

NIP-07 perms ever requested: `getPublicKey`, `signEvent`, `nip04.{en,de}crypt` (private mutes), `nip44.{en,de}crypt` (wallet backup). No DMs, no reactions. **kind:3 contacts** are read + written, but only for Follows — on demand when a follow button renders, never in `loadProfile`; `signEvent` already covers it.

**Fast-path identity hydration.** On page load, cached `bmb:npub` is decoded synchronously via `nip19.decode` into a bare `{ pubkey, npub }` identity, and `storage.profile` + `storage.favorites` + `storage.muted` land in the store within the same frame. The signer is called lazily, only when something needs to sign.

**Relay query timeouts.** Every `pool.querySync` passes a `maxWait` from `lib/nostr/pool.ts`: `QUERY_MAX_WAIT_MS = 4000` for single-author lookups, `FEED_QUERY_MAX_WAIT_MS = 8000` for broad feed scans. Without these a stalled relay pins the tab in loading.

**Single-latest-event lookups don't `querySync`.** `fetchLatestEvent` (`lib/nostr/event-queries.ts`) uses `subscribeMany` and resolves at the earliest of all-relays-EOSE, **1.5 s after the first matching event** (grace window for a newer replaceable version), or `maxWait`. `querySync` waits for every relay, so one dead relay in a 20-relay union pinned every restore at the full timeout.

**Never record an absence you didn't reliably observe.** A null from `fetchLatestEvent` means either "every relay answered and none had it" or "nothing answered in time" — any caller writing a **negative cache** must tell them apart. `fetchProfile` didn't — it called `storage.profile.setMiss(pubkey)` on any null — so a sign-in coinciding with one relay 503ing cached a miss for a kind:0 live on five relays, pinning a bare npub for the full 15-minute `PROFILE_MISS_TTL_MS`.

- **`fetchLatestEventDetailed`** returns `{ event, trustworthy }`; `fetchLatestEvent` is a thin wrapper, so callers that don't cache misses are unaffected.
- `trustworthy` is a **signal, not a guarantee** — a relay that never connects doesn't hold nostr-tools' aggregate `oneose` open, so EOSE means "every *reachable* relay confirmed none." Same caveat as the kind:3 `ok` flag.
- An event that arrives but won't parse **is** a cacheable miss — we heard back.
- Same discipline as `fetchFollowList`'s `ok` and `resolveProfilesForNotes`' `firstHealthy`. **Apply it to any new negative cache.**

**`resolvePublishRelays(identity)`** (`lib/nostr/relays.ts`) is the single source of truth for publish targets: `bmb:relays` override, else NIP-65 write relays **unioned with `DEFAULT_RELAYS`**, capped at 20. The union (not write-relays-*instead-of*) is deliberate — a user whose write relays are all dead/AUTH-gated was getting "published to 0/N relays" on a boost that paid. A manual override is used as-is.

**`sanitizeRelays(urls)`** drops any entry that isn't a parseable `ws://`/`wss://` URL (gated on `new URL()`), dedupes, strips trailing slashes. Applied at **every point an untrusted relay list enters a pool query**: `fetchRelayList`'s NIP-65 parse, the output of `resolvePublishRelays` (falls back to `DEFAULT_RELAYS` if sanitizing empties it), and in `lib/nostr/discover.ts` — `fetchAuthorWriteRelays`, `fetchQuotedEvents`, `fetchSocialInteractThread`.

A corrupt entry (a NIP-65 `r`-tag of `"avatar wss://purplerelay.com"`, or spam stuffed into one) otherwise reaches nostr-tools' `normalizeURL`, which **throws `Invalid URL` synchronously inside `pool.querySync`/`subscribeMany`**; that rejection escapes per-call try/catch and aborts the whole flow. **A `startsWith('wss://')` check does not catch this** — only `new URL()` does, because a comma in the host is what throws. Defense in depth: `collectEventsByAuthors` wraps its `subscribeMany` so a survivor resolves empty rather than aborting.


## Favorites (NIP-51 kind:30003) — SHARED with other apps

♡ toggles a favorite on a podcast row (`<FavHeart>`) or an episode row (`<FavEpisodeHeart>`), both in `components/fav-heart.tsx`. Both go into **one** kind:30003 event at `d:podcast:favorites` — an app-neutral address shared with StableKraft and any other app that implements [`docs/pc20-favorites.md`](pc20-favorites.md). **That document, not this code, is the spec**; keep them in step.

Items are NIP-73 identifiers: `i: podcast:guid:<feedGuid>` for a show, `i: podcast:item:guid:<itemGuid>` for an episode. Position 2 is the feed's RSS URL (NIP-73's URL hint); position 3 on an item is `podcast:guid:<feedGuid>` of its parent — an additive extension, because `getEpisodeByGuid` needs `podcastguid` and an item guid alone won't resolve. Caches `bmb:favorites:<npub>` and `bmb:favepisodes:<npub>` (or `:guest`) render instantly; toggles are optimistic and publish is **debounced 1.5 s**.

**The module split is load-bearing.** `lib/nostr/favorites-merge.ts` is the wire format and the merge, and has **zero imports** so `npm run check:favsync` can load the real thing under plain Node — a reimplemented copy in the check script would stay green while the shipping merge drifted, the exact failure being guarded. `lib/nostr/favorites.ts` holds the I/O and re-exports it. Don't add an import to the merge module.

**There is deliberately no "publish my favorites" function.** A shared replaceable event has no partial update, so a blind publish deletes whatever the other app added, silently, with no undo. `syncFavorites` reads → merges → publishes as one step, and the exported surface gives a caller no way to skip the read. Three rules follow:

- **The delta is against a BASELINE, not against the local set.** `storage.favSynced.<npub>` holds the id list this device last agreed with the relay on. `next = (latest ∪ (local − baseline)) − (baseline − local)`. Publishing the local set alone erases every entry another app added; publishing the union alone makes unfavoriting impossible, permanently. An empty local set with an empty baseline must delete nothing — a device that hasn't hydrated is not making a claim — while an empty local set with a full baseline is a real clear-all.
- **A degraded read publishes nothing.** `fetchSharedFavorites` reports `trustworthy` (from `fetchLatestEventDetailed`), and both `syncFavorites` and `hydrateFavorites` bail on false. A null from a relay means "nobody had it" *or* "nothing answered", and acting on the second wipes favorites across every app the user owns. Same rule as kind:3 and kind:0.
- **Identifiers we can't read still ride along.** The merge never looks inside an `i` tag; `interpretShows`/`interpretItems` run at render time only. A third app's `podcast:publisher:guid:`, or StableKraft's track favorites viewed from here, survive our republish untouched — as do unrecognized top-level tags and `k` tags naming kinds we don't generate (stripping those would remove another app's `#k` filter from the event).

**`k` tags come from a known-kind table, never from string-scanning.** `podcast:guid`, `podcast:item:guid`, `podcast:publisher:guid`. Item guids are routinely permalink URLs, so "everything before the last colon" yields `podcast:item:guid:https` — a tag no relay filter matches, breaking discovery with nothing visibly wrong. `check:favsync` pins this.

**Malformed guids are separated at read, not dropped at write.** `interpretShows` splits non-UUID `podcast:guid:` values out as `malformed` — older versions of this app wrote feed IDs and live-episode strings there. They stay on the wire regardless; `window.bmbCleanFavorites()` is an explicit, user-invoked purge. "This app can't read it" is not the same claim as "this is junk".

**Migration off `boostmebitch:favorites`.** `migrateLegacyList` unions the old list into the shared one, and runs on **every** hydrate — a no-op once absorbed, but a user signing in on a new device months later still finds their pre-sync history there. It requires **both** reads to be trustworthy, and merges with an **empty baseline**: passing the legacy ids as a baseline would read anything already on the shared list as a removal. The old event is left intact as the rollback path.

Sign-out clears in-memory favorites; the per-npub caches are left so re-signing in is fast. `bmb:favsynced:<npub>` is deliberately **not** cleared on an identity switch — it's per-npub, so switching back to A must find A's baseline where A left it.

**Switching identities must wipe in-memory state — for favorites that's correctness, not tidiness.** `hydrateFavorites` reads the store rather than the per-npub cache (deliberately — that's how a signed-**out** user's favorites get adopted on first sign-in), and adoption publishes whatever it finds there under the incoming key. So carrying account A's favorites across a switch writes A's list to relays under B's key. `completeSignIn`'s `identity && identity.pubkey !== id.pubkey` branch therefore clears `favorites`, `favoriteEpisodes`, `mutedPubkeys` and `resetFollows()` alongside the wallet teardown — signed-out → signed-in leaves `identity` null, skips the block, and still adopts as intended. (`hydrateMutes` reads the per-npub cache and was already correct; cleared for consistency. `resetFollows()` is explicit because `useFollows` only resets the singleton once a `<FollowButton>` effect runs, and a stale `ok: true` gates the kind:3 publish path.)

## Mutes (NIP-51 kind:10000)

🚫 on a `<NoteCard>` mutes that author. Interoperates with Damus/Amethyst/Coracle. `MuteListState` (`lib/nostr/mutes.ts`) carries parallel **public** p-tags (event tags) and **private** p-tags (NIP-04-encrypted JSON tag-array in `event.content`). New mutes go private (Damus default); when the signer exposes no `nip04`, the read path parks the raw ciphertext in `unreadablePrivateContent` and the publish path passes it through verbatim — **we never destroy private mutes set in another client** — while new mutes degrade to public p-tags. Non-`p` tags (`e`, `t`, `word`) are preserved verbatim too.

Filtering is at render time (`<NoteCard>` early-returns null; feeds filter top-level + replies before mapping). `bmb:muted:<npub>` is `MuteListState` JSON; `lib/storage.ts` auto-promotes the legacy `{ pubkeys, otherTags }` shape on read. Account menu surfaces a collapsible "Muted accounts (N)" with kind:0 lookups firing only while expanded.

## Follows (NIP-02 kind:3)

`+ Follow` / `✓ Following` on **note cards** (`<FollowButton>` in `nostr-note-card.tsx`'s author header) and on **npubs in show notes** (`notes-follows.ts`). Hidden signed-out and on the viewer's own pubkey. This is the **only** place the app touches kind:3.

`lib/nostr/follows.ts` is the single surface:

- **`fetchFollowList(identity)`** reads the latest kind:3 from a broad union (write ∪ default ∪ profile relays) and returns `{ event, following: Set<hex>, ok }`. **`ok` is the safety flag** — true only when an event arrived or every relay EOSE'd, via `collectEventsByAuthors`'s `allEosed`/`gotAnyEvent`.
- **`publishFollow(identity, current, targetHex, follow)`** republishes a kind:3 **preserving `current.content` and every existing tag**, changing exactly one `p` tag, and returns the new signed event so the next toggle builds on the latest tags.
- **The invariant: never publish a list you didn't reliably fetch.** Buttons stay disabled until `ok`; a failed fetch shows retry, never wipes. This is the classic kind:3 footgun — a blind republish overwrites the whole follow list.

**Nuke-guard (two layers, both gating only the empty-base publish).** The one wiping path is publishing onto an empty base (`state.event === null`) that was a *transient false-empty* — the load EOSE'd against relays that don't hold the list (classic case: right after login, before NIP-65 hydrated). `allEosed` only means "every **reachable** relay confirmed none", so empty + `ok` is not proof. `toggleFollow` therefore, **only** on that path (normal toggles pay nothing):

1. **Re-confirms** with a fresh `fetchFollowList` right before the write — a list found now **rebases**; an untrustworthy confirm **refuses** (button retries); a reliably-empty confirm **creates** the first list.
2. **Last-known-good cache** (`storage.follows`, `bmb:follows:<npub>`, hex[]), written **only from a real kind:3**. A reliably-empty confirm contradicted by a **non-empty** cached set is treated as false-empty and **refused**. Genuine new users have no cache; a user who really emptied their list has a non-null (empty) kind:3, so `state.event !== null` and this branch isn't reached. Not used for rendering — only as this signal.

**Shared singleton** (also `follows.ts`): `ensureFollowsLoaded` / `subscribeFollows` / `followsSnapshot` / `toggleFollow` / `resetFollows`. **One kind:3 fetch app-wide** (a 20-card feed does 1 fetch), with **serialized toggles** (a promise `chain`) so two quick follows can't republish from stale state and drop each other. `ensureFollowsLoaded` pins `loadedFor` only when `fetched.ok`, so a degraded fetch retries instead of freezing the buttons; `<FollowButton>` surfaces retry when `!ok && !loading`. `components/follow-button.tsx` holds the hook + button; show-notes buttons use the same singleton so both stay in sync. The singleton is store-free (no zustand import) to avoid a cycle with `lib/store`.


## Editing the user's own profile (kind:0)

`<ProfileEditor>` (`components/profile-editor.tsx`), opened from the account menu. Fields: `display_name`, `name`, `picture`. Every signer type can use it — nothing here needs the raw key. **A field absent from that list is preserved, not deleted** — `about` and `lud16` were both dropped, and a user who set either elsewhere still has it, because the editor merges rather than rebuilds.

**One name box, not two.** `display_name` is what renders (every client here and in the wild resolves `display_name || name`); `name` is the older handle some clients show as `@name`, and onboarding sets both to the same string, so for most users the second box is noise. There is one Name box and **no opt-in** — the `name` field appears only for a profile that already carries a genuinely different handle (both non-empty and unequal), set in some other client. **Hidden means synced, not ignored:** with the box off screen, save writes `name = display_name`. That auto-reveal is not a nicety; without it the only two alternatives both lose data. Overwriting a distinct handle with the display name destroys a field the user deliberately set, invisibly. Leaving `name` at its old value is the tempting version and it strands the profile — the merge preserves keys it doesn't manage, so a `name` the editor stopped showing would be unreachable and permanently disagree with the display name wherever a handle is rendered.

**kind:0 is replaceable, so this is the same footgun as kind:3 one kind over: what we publish REPLACES the profile everywhere, and anything we didn't carry forward is deleted from every client with no error.** Two rules, both enforced in the editor:

- **Merge over the RAW fetched content, never over `ProfileMetadata`.** `fetchProfile` returns what `coerceProfileMetadata` allows through — seven known string fields (`auth.ts`'s `PROFILE_STRING_FIELDS`) — because render paths need defending against `name` arriving as a number. Correct for display, catastrophic for editing: `banner`, `website`, `bot` and every custom field another client set simply aren't in the object, so a form built over it deletes them on the first save. **`fetchRawProfile` (`lib/nostr/profile.ts`) exists for this and only this** — it returns the author's parsed content object untouched, and the editor spreads its five keys over it. A blank input **deletes** its key rather than writing `''`, so cleared fields read as absent instead of as an empty string other clients render.
- **Refuse to publish on an untrustworthy read.** `fetchRawProfile` returns `trustworthy` from `fetchLatestEventDetailed` — the same flag `fetchProfile` uses to decide whether an absence is cacheable. An edit assembled after "no relay answered" wipes exactly as thoroughly as one assembled from a truncated parse; the trigger is a timeout instead of a whitelist, and "nobody had it" and "nothing answered" are the same `null` without the flag. The editor shows a retry instead of a form. Don't relax this into "publish anyway if we got *something*" — a newer kind:0 on an unreached relay loses to ours on `created_at`.

**`publishProfile` (`lib/nostr/profile.ts`) is the single kind:0 write path**, shared with onboarding's `provision-profile.ts`, so the relay set (`resolvePublishRelays ∪ PROFILE_RELAYS`, capped 20 — purplepag.es is the outbox Damus and Amethyst read) and the post-publish `storage.profile` reseed can't drift. It publishes `content` verbatim and deliberately does **not** merge for the caller: that would need its own fetch, and a second fetch is a second chance to get an untrustworthy null and wipe the profile. **The reseed is gated on `acceptedRelays.length > 0`** — the cache is a claim about what the network holds, so reseeding after a publish every relay refused caches a profile that exists nowhere, and the user sees a saved name that survives reloads until the miss TTL expires. That gate is what lets the editor's `acceptedRelays.length === 0` error mean something. Onboarding skips the merge safely by construction — a key generated seconds ago has no kind:0 to preserve.

**`picture` must accept `data:image/`, not just `https://`.** The app writes its own generated identicon as an inline `data:image/svg+xml;base64,…` (`lib/nostr/generated-profile.ts`), so an http(s)-only validator rejects the value the editor just loaded — Publish disabled and `save()` refusing on open, for every account that hasn't replaced its avatar. That shipped and was caught in review, not testing, because the test account had already set an https picture. The check is an allowlist of those two shapes (`data:text/html` and `javascript:` stay rejected), matching `safeUrlAttr`'s posture rather than denylisting bad schemes.

**`displayName` (camelCase) is the one field the editor updates without showing.** It's the pre-NIP-24 spelling of `display_name`, deprecated but still written by clients in the wild (Jumble writes it) and still *read* in preference by some. Left untouched it doesn't stay harmless — it keeps the old name, so the profile disagrees with itself and a stale name renders wherever that key wins. It's not a separate field, it's the same field spelled differently, which is why it's the sole exception to "preserve what we don't manage". Updated **only when already present**: creating it would spread a deprecated convention to every profile we touch, deleting it would break the clients still reading it.

**`lud16` is deliberately out of scope: the user sets it from another client.** `@buildonspark/spark-sdk` ships no lightning-address registration API, so the Spark wallet provisioned at signup can't advertise itself, and the editor doesn't offer the field. Other clients read `lud16` to decide whether to show a zap button, so a user who never sets one is unzappable outside this app — which is the accepted trade, not an oversight. **What makes it work is the merge:** an address set in Jumble, Primal or anywhere else survives every edit made here, exactly as `about` / `website` / `banner` do. Verified against live relays — a rename here changed only the name fields and left all four foreign fields byte-identical. So don't "helpfully" add a `lud16` input later without revisiting this; the reason it's absent is that the field belongs to whichever client can actually issue an address.

## Nostr live streams (NIP-53 kind:30311)

A **"Live on Nostr"** horizontal card row renders above the global feed on the browse view only (`components/nostr-live-streams.tsx`, mounted when `!inDetailView`). Pure Nostr, independent of Podcast Index. **One row, tab-selected** (saves the vertical space of stacked sections): a **Live / 24-7 / Upcoming** pill selector filters the single scroll row, defaulting to **Live** so current streams aren't buried behind a long upcoming list, and auto-falling back to the first non-empty group. Only non-empty groups get a tab. **24/7** = perpetual radio-style stations, detected by the `24/7` title convention (`/\b24\s*[/\-]\s*7\b/i`) since NIP-53 has no "perpetual" field. Polling is gated on document visibility + a 45 s floor, not a blind 60 s + every-focus refetch of the 7-relay query.

**Stream id is `<64hex pubkey>:<dTag>`** (the NIP-33 address tail), carried as `episode.guid`. Use the helpers in `lib/nostr/live-streams.ts` — `streamIdOf`, `parseStreamId` (validates the 64-hex pubkey), `isLiveStreamId` — and `streamChatAddr(streamId)` in live-chat.ts for the `30311:`-prefixed chat/zap `a`-tag. Don't inline `indexOf(':')`/`slice`/`/^[0-9a-f]{64}:/`.

**Fetch + filter.** `fetchNostrLiveStreams()` queries kind:30311 over `LIVE_STREAM_RELAYS` (`DEFAULT_RELAYS` ∪ `wss://relay.zap.stream` + `wss://nostr.wine`, sanitized) within a 7-day `since`, dedupes replaceable events by address (newest `created_at` wins), then:

- **Drops stale `live` events** older than `LIVE_FRESH_SECS` (2 h). An active 30311 is re-published while broadcasting, but most clients never publish the `ended` status — they just stop updating — so a stale `live` event is a dead broadcast. **Planned streams are exempt** (set once, ahead of time).
- **Sorts upcoming-first**, then live; within each group newest `startsAt` first.

**`fetchLiveStreamByAddr(pubkey, dTag, relayHints)`** fetches ONE stream for the `/stream/<naddr>` deep link. It queries by **author only** and filters the d-tag **client-side** — NOT a `#d` filter: a stream's event often lives only on the host's relay (e.g. `fountain.fm`), which doesn't honor `#d` reliably in-browser, so the filtered query came back empty and said "not found" even when the broad main-page query found it. The stream page also **retries** — cold Firefox-private tabs have no warm DNS/TLS/WS to the host relay, so the first query can time out.

**`streamNaddr(pubkey, dTag)`** encodes the shareable `naddr` with stream-relay hints (zap.stream/fountain/nos.lol); generic defaults aren't enough for other clients to resolve a fountain-only stream.

**Stream → player/boost bridge.** `streamToEpisode(stream, value)` / `streamToPodcast(stream, profile)` map a stream onto the existing `Episode`/`Podcast` so the player, boost modal and `liveStatus` UI work unmodified: `episode.guid = stream.id`, `enclosureUrl` = the HLS `streaming` URL, `liveStatus` from status, `id`/`feedId` synthetic (`fnvHash`/0).

**V4V (`resolveStreamV4V`).** A `ValueBlock` of `lnaddress` recipients from each participant's kind:0 `lud16`/`lud06` — from NIP-53 `zap` split tags when present, else the host alone. Explicit weight `0` means the host opted that participant out: **preserved, not coerced to 1**, and dropped; falls back to the host if every split is zeroed. Profiles are fetched against the **broad `LIVE_STREAM_RELAYS` set** and **re-fetched on a cached miss** — a streamer's lud16 often lives on the stream's relays, and a transient miss otherwise hid BOOST for the 15-min profile-miss TTL.

**HLS video (`player.tsx`).** A single `<video>` in a **reverse portal** (`react-reverse-portal`) moves between the mini-bar thumbnail and the fullscreen art pane **without remounting** — a remount kills playback and the `hls.js` attachment. `isHlsUrl(url)` gates the video path; everything else stays on native `<audio>` (the inactive element is left srcless). `hls.js` is **dynamic-imported** on first stream play; native HLS (Safari `canPlayType`) skips it. The portal node is **created client-only** — `createHtmlPortalNode()` touches `document` and crashes Next SSR.

**Dedicated route `app/stream/[naddr]/page.tsx`.** A shared stream link is a real route, so refresh restores it. The page renders ONLY a loading / "not found" state and opens the layout's player on top — no browse header or feeds mount. Collapsing the player navigates home (`router.push('/')`); the stream keeps playing in the mini-bar. A **fast-path** skips the fetch when `current` already matches the naddr. Tapping a card calls `play(...)` instantly + `router.push('/stream/<naddr>')`; the card's PLAY button stays in the mini-bar (no nav). It also mounts a hidden `<NostrAuth>` so sign-in works there without leaving. Old `/?stream=<naddr>` links redirect here.

**Permanent per-host route `app/live/[npub]/page.tsx`.** `/stream/<naddr>` pins ONE broadcast by its dTag, and every new broadcast gets a fresh dTag — so the link a show puts in its bio dies after one episode. `/live/<npub>` resolves the host's *current* stream at click time instead. Same shell as `/stream` (placeholder-only render, opens the layout player, collapse → `router.push('/')`, hidden `<NostrAuth>`), with three differences that each exist for a reason:

- **`fetchLatestStreamByPubkey` runs TWO queries — `authors: [pubkey]` AND `#p: [pubkey]`.** Platform-published streams (Shosho, zap.stream) are authored by the **platform's** key with the host in a `p` tag, so an authors-only query finds nothing for exactly the hosts most likely to hand out a share link. Host-role is checked client-side; no `#d` filter, same reasoning as `fetchLiveStreamByAddr`.
- **`episode.liveHostPubkey` is what the share link is built from, never the stream id's author half** (`streamHostPubkey` — the NIP-53 `p` tag with role `host`, falling back to the event author). Building it from the address's pubkey points a platform-published stream's permanent link at the *platform*, so it would resolve to whatever that platform is streaming next.
- **Offline is a first-class state, not a 404** — name, avatar, and a "Next: <title> — starts <time>" line when the latest event is `planned`. A bio link that 404s between broadcasts reads as broken.

Retries up to 3× at 800 ms, breaking early on `live`, for the cold-relay timeout `/stream` hits too. V4V enrichment lands as a second `play()` with the **same `episode.id`**, so the hls attachment isn't torn down.

**Live chat (`lib/nostr/live-chat.ts` + `components/live-chat.tsx`).** Shown in the fullscreen right pane for live streams. `subscribeLiveChat(streamId, onEvent)` owns a long-lived `SimplePool` and runs three phases: (1) `querySync` history backfill — relays trickle stored events slowly over a bare `subscribeMany`, so a reload would show only a handful; (2) `subscribeMany` for live messages; (3) a **re-sync backstop** every 12 s and on `visibilitychange`/focus, a `since`-bounded re-query, because the persistent subscription goes stale when a device backgrounds or a socket drops and the chat diverges across devices / from Fountain.

It subscribes to **kind:[1311, 9735]** — chat messages and zap receipts tagged to the stream. `<LiveChat>` renders both through one `<ChatRow>` (zap rows add a `⚡ N sats` badge + tint), shows a total-sats-zapped line (sum of 9735 amounts via `zapInfo`), resolves author/zapper/`@mention` profiles against `LIVE_STREAM_RELAYS`, renders `nostr:npub` mentions as `@names` and http links as anchors, applies the mute filter, and gates the composer on sign-in. `publishLiveChat(streamId, content)` posts a kind:1311.

**Boosting a live stream goes out as a real NIP-57 zap** so the receipt shows up in Fountain / tunestr / zap.stream and in BMB's chat — see Boost flow invariant 0 in [`../CLAUDE.md`](../CLAUDE.md) for the qualifying conditions and the fallback. Interop is the shared NIP-53 standard, not per-platform code; the only variable is relay coverage.


## Episode discussion (`podcast:socialInteract`, Nostr)

Episodes (and RSS live items) can carry `<podcast:socialInteract protocol="nostr" uri="nostr:nevent1…|note1…">` pointing at a publisher-designated root note. `lib/pi.ts` parses them into `Episode.socialInteract: SocialInteract[]` (sorted by `priority`), normalizing spec `nostr:<bech32>` and non-standard `https://njump.me/<bech32>` URIs via `extractNostrUri`. PI's `/episodes/byfeedid` doesn't expose the tag, so `/api/feed` picks it up from the shared RSS pass. Only `protocol="nostr"` is kept.

**Fetch + render.** `fetchSocialInteractThread(uri, opts)` (`lib/nostr/discover.ts`) decodes the note1/nevent1, unions `DEFAULT_RELAYS` with up to 4 nevent hints, fetches the root, and BFS-assembles the reply tree via the same `assembleNotes` as the feed. **Contract:** returns `[]` for an undecodable URI or a root no relay carries; **throws** when the relay query itself fails — so the UI can tell a transient outage (offer retry) from genuine emptiness. `components/episode-social-thread.tsx` is the self-contained surface, shared by the discussion view and the fullscreen player: status union `loading | ready | error`, skeleton, retry, a reply count excluding the root anchor, and a sign-in-gated composer.

**Comment composer.** A signed-in user replies to the root via `publishReply({ parent: notes[0].rawEvent })` (`lib/nostr/interactions.ts`) — a real reply, so it interoperates with other PC2.0 clients. Insert is **optimistic**: `signAndPublish` returns the signed `event` on `PublishedNote`, and `noteFromEvent` builds a `DiscoveredNote` appended under the root's `replies`. Optimistic rather than refetch because the publish relays may not overlap the query relays; a `pendingOptimistic` ref re-merges the comment if a wholesale revalidation lands during the reply-stream window.

**Faster first paint.** `fetchSocialInteractThread` fires an `onRoot(root)` callback the moment the root resolves (built from the cached profile, no extra network), so the anchor + composer appear in ~1 s while replies stream in — the component used to await root + up to 6 sequential 8 s BFS levels + profile/quote resolution before painting anything. Repeat visits paint instantly from `storage.socialThread` (per-URI, no TTL, stale-while-revalidate, mirroring `storage.feedNotes`); an error after a cache/root paint keeps what's shown and flips a quiet "couldn't refresh" hint instead of wiping it.

**Full-page discussion view (not inline, not a modal).** The `· 💬 discussion` button in the `EpisodeList` info row calls `openDiscussion(e)`; `components/home-page.tsx` renders `<DiscussionView>` *ahead of* the detail/browse branches — one of four state-driven page-level views (browse, `<EpisodeDetailView>`, detail, discussion) with a `← back to episodes` button. `discussionEpisode` lives in the store and `selectPodcast` clears it, so a thread can't outlive its show. Earlier iterations (inline in the expanded panel, then a scroll-to-thread shortcut) were dropped because a long thread ballooned the episode row and broke list scanning. The fullscreen player keeps its own inline `<EpisodeSocialThread>` — its scroll container absorbs the height.

**Inline images in notes.** `NoteCard` pulls image URLs (`jpg/jpeg/png/gif/webp/avif/bmp`, optional query string) out of the body via `extractImages` and renders `<img>` thumbnails (clickable, lazy, `max-h-80`) instead of raw links — every note surface, not just the thread. Detection is extension-based, so URLs without one (some `i.nostr.build/<hash>`) aren't caught; that would need NIP-92 `imeta` parsing. Uses `<img>`, not `next/image` (arbitrary hosts), like `PodcastCover`.


## Nostr publish shape

`publishBoostNote()` in `lib/nostr/boost-notes.ts` builds a kind:1 with:

- NIP-73 `i`/`k` pairs for `podcast:guid:<feed-guid>` and (per-episode) `podcast:item:guid:<item-guid>`.
- **Two `r` tags** when the URLs differ: a listen-link via `podcastLandingUrl` and a BMB deep-link via `bmbLandingUrl`. Both are appended to the body so readers see "listen elsewhere" and "boost back on BMB" as separate affordances. **Both take the `episode` and point at it when there is one** — a boost note about one episode that lands the reader on the show's front door makes them go hunt for it:
  - `podcastLandingUrl` prefers the **episode's own page** (`Episode.link`, the RSS `<link>`), then **the item guid when it's an http(s) URL** — RSS defines `<guid>` as a permalink unless `isPermaLink="false"`, and plenty of feeds (Bowl After Bowl) use the episode page URL verbatim; we don't parse that attribute, so it's a heuristic that only runs when the feed published no `<link>` at all, where the alternative is dropping the reader on the show. Then `https://pod.link/<itunesId>`, `https://podcastindex.org/podcast/<feedId>`, the raw RSS URL. Those last three are show-level on purpose: neither pod.link nor PI has an episode URL constructible from a guid (pod.link's episode paths key on an id of their own).
  - `bmbLandingUrl` appends `&episode=<guid>` (encodeURIComponent'd — unlike the podcast UUID, an item guid is arbitrary feed-chosen text and is routinely a URL). `?podcast=&episode=` is a restorable view per the URL contract and `app/page.tsx` emits episode-level OG tags for it, so the unfurl carries the episode's own title and art. Still null without a `podcastGuid`, which is what keeps live-stream boosts (synthetic podcast, no guid) from emitting one.
- **`Episode.link` is raw feed text** — `lib/pi.ts` only checks it's a non-empty string. Anything derived from it goes through **`httpUrl` (`lib/util.ts`)**, an http(s) allowlist over the WHATWG parser (same fail-closed direction as `safeUrlAttr`, returning the parser's normalized form so a value that only parsed because tab/CR/LF were stripped can't be re-emitted with them). Used both here and for the detail view's "Episode page ↗" anchor — **React does not block a `javascript:` href, it only warns in dev.**
- **`p` tags for the npubs the feed declares** via `<podcast:txt purpose="nostr|npub">` and `<podcast:person npub="…">` — episode-level first (a music track's own artist), then channel-level (the show), deduped by pubkey and capped at 4 (`noteNpubs`). Parsing + validation happen server-side in `lib/feed-xml.ts`; see [`feeds.md`](feeds.md). This is the difference between a boost being a post *about* an artist and one that reaches them — without it the note never enters their mentions.
  - **Deliberately NOT gated on the share picker's "Anonymous".** Every other identity-adjacent branch in the boost modals is, so this looks like an oversight and isn't: `anonymous` exists to stop the **sender** leaking (it drops `sender_id` and replaces `sender_name`), while a `p` tag names the **recipient**. An anonymous boost should still reach the artist. Don't "fix" it.
  - Each npub is also appended to the body as `nostr:<npub>`, by `withMentions` in `buildBoostNoteTemplate` — **not** inside `formatContent`, because `BoostAllModal` hand-builds a `contentOverride` that replaces the whole body and would silently lose the mention. Appending post-override is the one place both content paths converge (same drift that bit the sender-name line). Append-only, so the `⚡ Boost ⚡` prefix the site-sign route validates on survives.
  - **The mention is invisible in BMB's own feed** — `<NoteCard>` runs `stripNostrUris`, so other clients render `@name` and ours renders nothing. The `p` tag fires the notification either way; `noteHasSubstance` also strips `nostr:` refs but boosts short-circuit on `isBoost`, so the note is never filtered out.
- `amount` in millisats from `value_msat_total` (intent).
- `client` tag from `app_name`, default `BoostMeBitch`.
- `t`: `boostagram` + `value4value`.

Publish target is `resolvePublishRelays(identity)`. Body lives in `formatContent()` (override per call with `contentOverride`):

```
⚡ Boost ⚡

[message, if present]

[sender name] boosted N sats → [podcast title]
📻 [episode title, omitted on show-level boosts]

[pod.link or PI URL]

[nostr:npub… mentions, when the feed declared any]
```

`signAndPublish` handles both kind:1 boost notes and kind:30003 favorites — a third event kind is ~10 lines.

## Site Nostr identity (boost notes for signed-out users)

Since Lightning and Nostr are independent logins, a signed-out boost would otherwise never reach Nostr. The **site owns one persistent Nostr identity** that signs the note on the user's behalf, so "Share on Nostr" is usable when signed out.

- **`SITE_NOSTR_SK` is a server-only secret** (nsec or 32-byte hex), read only by `lib/nostr/site-key.ts` (`siteSecretKey()` / `sitePubkey()`) — **never** `NEXT_PUBLIC`, never shipped to the browser (a signing key in the bundle is extractable by anyone). Absent/malformed → the feature is off. Set in Vercel (Production) + `.env.local`.
- **Signing is server-side.** `app/api/nostr/site-sign/route.ts` accepts an unsigned kind:1 template and **validates it's a boost note** — kind 1, required `⚡ Boost ⚡` content prefix, `t:boostagram` + `t:value4value`, `created_at` within ±5 min — bounding the signing oracle so it can't sign arbitrary events as the site. 503 when unconfigured. **The tag caps bound size, not just count**: `MAX_TAGS` limits how many, `MAX_TAG_ITEMS`/`MAX_TAG_ITEM_LEN`/`MAX_TAGS_TOTAL_LEN` how big. That gap mattered because the content-prefix check constrains only `content`, so tags were the way to get attacker-chosen text signed under the site's NIP-05-verified identity. Real boost notes are ~9 two-element tags totalling ~540 chars, so the limits sit far above anything genuine.
- **Client path:** `publishBoostNoteViaSite()` builds the same template as `publishBoostNote` (shared `buildBoostNoteTemplate`), POSTs to the route, then publishes the returned signed event via `publishSignedEvent` to `DEFAULT_RELAYS`. Branch in both modals: the user's own key only when signed in **and** `storage.shareNostrAs` is `'self'` (default); the site key when signed out or the user picked "Post via boostmebitch.com". Publish failures are swallowed — the boost still pays.
- **Share UI:** `<ShareNostrPicker>` (`components/boost-modal/share-nostr-picker.tsx`), shared by both modals. Signed in → one compact pill row (My feed / Anonymous / Don't post, same pattern as the rail picker) with a single description line, persisted as `bmb:share_nostr` + `bmb:share_nostr_as`; signed out → a two-state checkbox.
- **NIP-05:** `app/.well-known/nostr.json/route.ts` maps `_@boostmebitch.com` to the site pubkey **derived from `SITE_NOSTR_SK`** so it can't drift. CORS-open per spec, served by the Next app (nothing to configure at the registrar).
- **Profile:** `scripts/publish-site-profile.mjs` publishes/updates the kind:0. One-off: `node --env-file=.env.local scripts/publish-site-profile.mjs`. Edit `PROFILE` and re-run (kind:0 is replaceable).


## Feed loading (`useNostrFeed`)

`lib/nostr/use-feed.ts` is the stale-while-revalidate hook behind global + per-podcast feeds:

1. **Cache always paints first.** `storage.feedNotes.get(cacheKey)` returns whatever's there regardless of age (no TTL gate), set into state synchronously in the mount effect.
2. **Full fetch on every load.** Mount and user-triggered `refresh()` both do a full relay fetch (no `since`). Stale cached state is replaced, not merged — simpler, and stale notes can't block new relay activity.
3. **No auto-refresh.** Mount + user click only, never a timer. Local mutations (e.g. `boostsTick` after a sent boost) intermix client-side, not via re-fetch.

**Album-page track union.** `fetchPodcastNotes(podcastGuid, opts, episodeGuids?)` widens its `#i` filter to `podcast:guid:<guid>` **plus** `podcast:item:guid:<g>` per entry (OR semantics in one filter). `PodcastNostrFeed` passes every track guid **only for music feeds** (keyed into the fetch deps via a joined `guidsKey`) — music tracks have no per-track pages, so this is what surfaces boosts that tagged only a track's item guid. Regular podcasts have per-episode pages, so they don't pass the union (avoids duplication).

**Substance filter (`noteHasSubstance`, `lib/nostr/discover.ts`).** The feeds are a firehose of *every* kind:1 tagged with NIP-73 `podcast:guid`/`podcast:item:guid`. Some clients (notably **Amplify**) publish an empty kind:1 per listen — `content: ""` plus the podcast tags — which renders as a bare podcast chip; at ~1/3 of all podcast-tagged traffic these drowned out real posts. `noteHasSubstance` keeps boosts always (`isBoost`), otherwise strips `nostr:` refs + image URLs the way `<NoteCard>` does and requires non-empty body text or an image. **Filter on content, not the `client` tag** — real human comments made *via* those same clients survive, and Fountain notes (no `client` tag at all) are unaffected. Applied at render time beside the `mutedPubkeys` filter, so it doesn't touch the `bmb:feed:*` cache and a stale paint can briefly flash filtered cards.


