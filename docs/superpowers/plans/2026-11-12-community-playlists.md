# Community Playlists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Signed-in listeners make public musicL playlists of songs on BMB; BMB stores them, serves each as an RSS feed on boostmebuddy.com, lists them in Community playlists, gives Chad an admin page to delete and ban, and boost notes from a playlist song name the playlist.

**Architecture:** One Postgres store (via the existing `pg` dependency) shared by both Vercel projects holds playlists and bans. Server routes under `/api/community-playlists` take writes authorized by NIP-98 (kind 27235) events; `/feeds/playlists/<id>.xml` renders the stored record as RSS and `/feeds/playlists/<id>.jpg` serves its cover. Pure rules (validation, art verdict, word filter, feed XML, note context) live in loadable leaves pinned by a new `check:community`; the UI is a new `/playlists/make` route, a sheet for adding songs, a Community section fed by the store, and `/admin`.

**Tech Stack:** Next.js App Router (this repo), TypeScript, `pg`, `sharp`, `nostr-tools` 2.19.4 (`nostr-tools/nip98`, pinned — do not bump), `obscenity` (new), Tailwind tokens from `tailwind.config.ts`, CDP harness `scripts/cdp.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-12-community-playlists-design.md` (approved 2026-11-12). Read it and `CLAUDE.md` first; then `docs/feeds.md`, `docs/ui.md`, `docs/nostr.md`, `docs/signers.md`, `docs/storage.md`, `docs/testing.md` before the tasks that touch their areas.

## Global Constraints

- Feed address: `https://www.boostmebuddy.com/feeds/playlists/<id>.xml` in production on BOTH deploys; the origin comes from `NEXT_PUBLIC_COMMUNITY_FEED_ORIGIN` (default `BRANDS.buddy.origin`), never from `BRAND.origin`. The path shape is a permanent public contract.
- `<podcast:medium>musicL</podcast:medium>`; `<podcast:txt purpose="npub">npub1…</podcast:txt>`; one `<podcast:remoteItem feedGuid itemGuid [feedUrl] medium="music"/>` per song; **no `<podcast:value>`, no `<item>`, no `<itunes:author>`**.
- Publish rules: title required; **at least 10 songs**; songs only (music medium); no duplicates; art link optional, `https://`, square, **1400 × 1400 to 3000 × 3000**, **PNG or JPEG**, **no alpha**.
- The word filter (`obscenity`, whole words) masks offensive words in title and description; it never refuses a publish.
- No approval, no per-key publish limit; every API route still starts with `rateLimit`.
- Ownership: a Nostr key. Every write carries a NIP-98 event; only the owner edits; owner or admin deletes; a banned key cannot publish or edit.
- Admins: server-only env `ADMIN_NPUBS` (comma-separated npubs).
- Store: server-only env `COMMUNITY_DB_URL` (optional `COMMUNITY_DB_CA`). Unset ⇒ every write route answers 503 `playlists are not configured` and the listing answers an empty list.
- Beta and previews: test DB, no Podcast Index calls, feed origin `https://beta.boostmebitch.com`. Podcast Index is told only when `VERCEL_ENV === 'production'` and the feed origin is `BRANDS.buddy.origin`.
- Boost notes: the boostagram (TLV `7629169`, `app_name`) never changes. Notes from a song in a **BMB-hosted** playlist use `BRANDS.buddy` for links, picture origin, sender name, `client` tag and site signer.
- Repo rules that bite here: `rateLimit` first, `requireJsonBody`, `readCappedRequestJson`, `withErrorHandling` fallback strings, `Cache-Control` on 200s only; `safeFetch` + `readCappedBytes` for any remote image; `httpUrl` at parse boundaries; `lib/util.ts` keeps type-only imports; all `bmb:*` access through `lib/storage.ts`; controls ≥ 24 × 24; overlays through `<ModalShell>`.
- Each PR in this plan is added to beta (`npm run beta -- add <PR>`) and tested there by Chad before it merges. Every push asks Chad (the push hook). Leave the checkout on a clean branch, never commit to `main`.

## Review Focus

1. **A signer that never answers during PUBLISH** (Amber dismissed, bunker offline): the button must not spin forever and the draft must survive. Test in Task 12 (fake signer that never resolves → after the timeout the button is enabled again, the error says why, and every song is still listed).
2. **A reload or app switch in the middle of building** (Amber on Android can return in a new tab): the draft must come back. Test in Task 8 (`storage.playlistDraft` round trip) and Task 12 (reload restores title and 12 songs).
3. **XML-special and long text** (`&`, `<`, `"`, `'`, `]]>`, emoji, RTL) in title/description/guids: the feed must stay valid and parse back exactly. Test in Task 2.
4. **A phone clock that is off by more than 60 s:** NIP-98 fails; the listener must be told to check the device clock, not "unauthorized". Test in Task 5.
5. **Two edits from two tabs:** a stale edit must not silently overwrite a newer one. Test in Task 5 (PUT with an old `expectedUpdatedAt` → 409 `changed elsewhere`).

---

## PR 1 — Server core (branch `community-playlists-server`, from `origin/main`)

### Task 1: Shared constants, publish rules, art verdict, word filter

**Files:**
- Modify: `lib/curated-playlists.ts` (import-free leaf; add constants and URL helpers)
- Create: `lib/community/rules.ts` (types + pure validation; imports nothing relative)
- Create: `lib/community/clean-text.ts` (imports only `obscenity`)
- Create: `scripts/check-community.mjs`; Modify: `package.json` (`"check:community": "node --experimental-strip-types scripts/check-community.mjs"`, dependency `obscenity`)

**Interfaces:**
- Produces (`lib/curated-playlists.ts`):
  - `COMMUNITY_FEED_ORIGIN: string` = `process.env.NEXT_PUBLIC_COMMUNITY_FEED_ORIGIN || 'https://www.boostmebuddy.com'` (literal, the leaf may not import `brand.ts`; `check:community` asserts it equals `BRANDS.buddy.origin` when the env is unset)
  - `COMMUNITY_FEED_PATH = '/feeds/playlists/'`
  - `communityFeedUrl(id: string): string` → `${COMMUNITY_FEED_ORIGIN}/feeds/playlists/${id}.xml`
  - `communityCoverUrl(id: string, version: number): string` → `${COMMUNITY_FEED_ORIGIN}/feeds/playlists/${id}.jpg?v=${version}`
  - `communityIdFromFeedUrl(url: string | undefined): string | null` → the id when `url` is exactly `<COMMUNITY_FEED_ORIGIN>/feeds/playlists/<uuid>.xml`, else null
- Produces (`lib/community/rules.ts`):
  - `MIN_SONGS = 10`, `MAX_SONGS = 500`, `MAX_TITLE_LEN = 120`, `MAX_DESCRIPTION_LEN = 1000` (characters, counted with `[...s].length`), `ART_MIN_PX = 1400`, `ART_MAX_PX = 3000`
  - `interface PlaylistSong { feedGuid: string; itemGuid: string; feedUrl?: string }`
  - `interface PlaylistDraft { title: string; description: string; artUrl: string | null; songs: PlaylistSong[] }`
  - `type DraftProblem = { kind: 'title-missing' } | { kind: 'title-too-long' } | { kind: 'description-too-long' } | { kind: 'too-few-songs'; have: number } | { kind: 'too-many-songs'; have: number } | { kind: 'duplicate-song'; itemGuid: string } | { kind: 'bad-song'; index: number } | { kind: 'art-not-https' }`
  - `validatePlaylistDraft(raw: unknown): { ok: true; draft: PlaylistDraft } | { ok: false; problems: DraftProblem[] }` — trims title/description, `artUrl` `''` → null, rejects a song whose `feedGuid` is empty or > 120 chars or `itemGuid` empty or > 2048 chars (the limits `parsePlaylistRemoteItems` enforces), drops a `feedUrl` that is not `http(s):`, reports every problem (not just the first)
  - `type ArtRefusal = 'not-image' | 'format' | 'not-square' | 'too-small' | 'too-large' | 'alpha'`
  - `artVerdict(meta: { format?: string; width?: number; height?: number; hasAlpha?: boolean }): { ok: true } | { ok: false; reason: ArtRefusal }` — format must be `jpeg` or `png` (sharp's names)
  - `interface StoredPlaylist extends PlaylistDraft { id: string; ownerPubkey: string; createdAt: string; updatedAt: string }`
  - `interface CommunityPlaylistSummary { id: string; title: string; description: string; feedUrl: string; podcastGuid: string; ownerPubkey: string; ownerNpub: string; coverUrl: string; songCount: number; createdAt: string; updatedAt: string }`
- Produces (`lib/community/clean-text.ts`): `cleanText(s: string): string` — `obscenity` `RegExpMatcher` with `englishDataset.build()` + `englishRecommendedTransformers`, censored with `TextCensor` using an asterisk strategy; whitespace untouched.

- [ ] **Step 1: Write the failing checks** in `scripts/check-community.mjs` (pattern: `scripts/check-capped-body.mjs`; import the real modules with `.ts` paths; `importFreeProblems('lib/curated-playlists.ts')` must stay empty; `importFreeProblems('lib/community/clean-text.ts', { allowBare: true })` empty):
  - `validatePlaylistDraft({ title: '  ', description: '', artUrl: '', songs: [] })` → problems include `title-missing` and `{ kind: 'too-few-songs', have: 0 }`
  - 9 distinct songs → `{ kind: 'too-few-songs', have: 9 }`; 10 → ok; 501 → `too-many-songs`
  - two songs with the same `itemGuid` and `feedGuid` → `duplicate-song` with that guid
  - `artUrl: 'http://x/a.png'` → `art-not-https`; `artUrl: ''` → ok with `artUrl === null`
  - a 121-char title → `title-too-long`; a 120-emoji title → ok (characters, not UTF-16 units)
  - `artVerdict({ format: 'png', width: 1400, height: 1400, hasAlpha: false })` ok; 3000×3000 jpeg ok; 1399 → `too-small`; 3001 → `too-large`; 1400×1500 → `not-square`; `webp` → `format`; png with `hasAlpha: true` → `alpha`; `{}` → `not-image`
  - `cleanText('fuck this')` → `'**** this'`; `cleanText('Scunthorpe classics')`, `cleanText('assassin')`, `cleanText('Cocktail hour')` unchanged
  - `communityFeedUrl('0b5e…')` and `communityIdFromFeedUrl` round-trip; `communityIdFromFeedUrl('https://www.boostmebuddy.com/feeds/playlists/x.xml')` (not a uuid) → null; another origin → null
- [ ] **Step 2: Run** `npm run check:community` — Expected: FAIL (modules missing)
- [ ] **Step 3: Implement** the three modules with the signatures above; `npm i obscenity` (exact version saved in `package.json`).
- [ ] **Step 4: Run** `npm run check:community && npm run typecheck` — Expected: all `ok`, exit 0
- [ ] **Step 5: Commit** — `git add lib/curated-playlists.ts lib/community scripts/check-community.mjs package.json package-lock.json && git commit -m "Community playlists: rules, art verdict, word filter, feed URL helpers"`

### Task 2: The feed document

**Files:**
- Create: `lib/community/feed-doc.ts` (imports `node:crypto` and `import type` from `./rules` only)
- Modify: `scripts/check-community.mjs`

**Interfaces:**
- Consumes: `StoredPlaylist`, `PlaylistSong` (Task 1)
- Produces:
  - `escapeXml(s: string): string` — `&` `<` `>` `"` `'` → entities
  - `communityFeedGuid(feedUrl: string): string` — UUIDv5 of the URL with the scheme and trailing slashes removed, namespace `ead4c236-bf58-58c6-a2c6-a6b28d128cb6` (SHA-1 via `node:crypto`)
  - `buildPlaylistFeedXml(p: StoredPlaylist, o: { feedUrl: string; coverUrl: string; ownerNpub: string; fallbackDescription: string }): string` — RSS 2.0 with `xmlns:podcast="https://podcastindex.org/namespace/1.0"` and `xmlns:itunes`; channel: `title`, `description` (or `fallbackDescription`), `link` (the feed URL), `language` `en`, `lastBuildDate` (RFC-822 from `updatedAt`), `podcast:guid`, `podcast:medium` `musicL`, `podcast:txt purpose="npub"`, `itunes:image href` = `coverUrl`, `image` block with `coverUrl`, then the remote items in order; every interpolation escaped.

- [ ] **Step 1: Write the failing checks:**
  - `communityFeedGuid('https://mp3s.nashownotes.com/pc20rss.xml')` → `917393e3-1b1e-5cef-ace4-edaa54e1f810` (Podcasting 2.0's guid; **confirm against `getPodcastByFeedUrl` once before keeping the vector**), and the same with a trailing `/` and with `http://`
  - build a 12-song playlist whose title is `` Tom & Jerry's <"mix"> ]]> 🎵 שלום `` → `parsePlaylistRemoteItems(channelSlice(xml))` (real `lib/feed-xml.ts`) returns the 12 refs in order with exact guids; `parseFeedNpubs(xml)` returns the owner npub; `decodeXmlText` of the `<title>` equals the input
  - the document contains no `<podcast:value`, no `<item`, no `<itunes:author`
  - a song without `feedUrl` emits no `feedUrl` attribute
- [ ] **Step 2: Run** `npm run check:community` — Expected: FAIL
- [ ] **Step 3: Implement** `lib/community/feed-doc.ts`.
- [ ] **Step 4: Run** `npm run check:community` — Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "Community playlists: feed document builder"`

### Task 3: NIP-98 verification and the admin list

**Files:**
- Create: `lib/community/auth.ts` (imports `nostr-tools` subpaths only — bare)
- Modify: `scripts/check-community.mjs`

**Interfaces:**
- Produces:
  - `type AuthFailure = 'missing' | 'malformed' | 'clock' | 'url' | 'method' | 'payload' | 'signature'`
  - `verifyNip98(header: string | null, url: string, method: string, bodyText: string | null): Promise<{ ok: true; pubkey: string } | { ok: false; reason: AuthFailure }>` — `unpackEventFromToken`, then `verifyEvent`, kind 27235, `validateEventTimestamp` (`clock`), `u` tag equals `url` ignoring a trailing `?` (`url`), `method` tag (`method`), and for a body the `payload` tag equals `hashPayload(JSON.parse(bodyText))` (`payload`)
  - `adminPubkeys(env?: string): Set<string>` — parses `ADMIN_NPUBS` (default `process.env.ADMIN_NPUBS`), decodes each npub with `nip19.decode`, drops invalid ones
  - `authMessage(reason: AuthFailure): string` — `clock` → `"Your device clock is off. Set it to automatic time and try again."`; others → `"Sign-in check failed. Sign in again and retry."`

- [ ] **Step 1: Write the failing checks** (in the check script, make a throwaway key with `generateSecretKey`, sign with `finalizeEvent`, build the header with `getToken(url, method, sign, true, payload)`):
  - valid POST with body → `{ ok: true, pubkey }`; same token against another URL → `url`; against `PUT` → `method`; body changed after signing → `payload`; `created_at` 120 s old → `clock`; kind 1 → `malformed` or `signature` (assert not ok); tampered `sig` → `signature`; `null` header → `missing`
  - `adminPubkeys('npub1…valid, junk')` → one hex key
- [ ] **Step 2: Run** `npm run check:community` — Expected: FAIL
- [ ] **Step 3: Implement** `lib/community/auth.ts`.
- [ ] **Step 4: Run** `npm run check:community` — Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "Community playlists: NIP-98 verification and admin list"`

### Task 4: The store

**Files:**
- Create: `lib/community/store.ts` (server-only; `pg`, env)
- Create: `scripts/community-schema.sql`
- Create: `scripts/e2e-community-api.mjs`; Modify: `package.json` (`"e2e:communityapi": "node scripts/e2e-community-api.mjs"`)

**Interfaces:**
- Consumes: `PlaylistDraft`, `StoredPlaylist`, `PlaylistSong` (Task 1)
- Produces:
  - schema: `community_playlists(id uuid primary key, owner_pubkey text not null, title text not null, description text not null default '', art_url text, songs jsonb not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, deleted_by text)`, index on `(created_at desc) where deleted_at is null`, index on `(owner_pubkey)`; `community_bans(pubkey text primary key, banned_at timestamptz not null default now(), banned_by text not null)`
  - `communityStoreConfigured(): boolean`
  - `createPlaylist(owner: string, d: PlaylistDraft): Promise<StoredPlaylist>` (id `crypto.randomUUID()`)
  - `updatePlaylist(id: string, d: PlaylistDraft, expectedUpdatedAt: string): Promise<StoredPlaylist | 'gone' | 'stale'>` — single `UPDATE … WHERE id = $1 AND deleted_at IS NULL AND updated_at = $n`
  - `getPlaylist(id: string): Promise<StoredPlaylist | 'gone' | null>` (`'gone'` when `deleted_at` is set)
  - `listPlaylists(o: { limit: number; owner?: string }): Promise<StoredPlaylist[]>` newest `created_at` first, not deleted
  - `findPlaylistByGuid(podcastGuid: string): Promise<StoredPlaylist | null>` — compares against `communityFeedGuid(communityFeedUrl(id))`; implement with a `podcast_guid text` column filled on insert (add it to the schema, unique)
  - `deletePlaylist(id: string, by: 'owner' | string): Promise<boolean>`; `deletePlaylistsByOwner(owner: string, by: string): Promise<number>`
  - `isBanned(pubkey: string): Promise<boolean>`; `banPubkey(pubkey: string, by: string): Promise<void>`; `unbanPubkey(pubkey: string): Promise<void>`; `listBans(): Promise<{ pubkey: string; bannedAt: string; bannedBy: string }[]>`
  - One module-level `Pool` (`max: 3`, `ssl` from `COMMUNITY_DB_CA` the way `lib/playlist-db.ts` does it); `npm run community:schema` (`psql "$COMMUNITY_DB_URL" -f scripts/community-schema.sql`) documented in `docs/ops.md`.

- [ ] **Step 1: Start a local Postgres** for tests: `colima start && docker run -d --rm --name bmb-community-pg -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:16` (check `/Volumes/NAS/reference/downloads/` for a saved `postgres:16` image first, per `global.md`), then `psql postgres://postgres:test@localhost:54329/postgres -f scripts/community-schema.sql` — Expected: `CREATE TABLE` ×2
- [ ] **Step 2: Write the store part of `e2e:communityapi`** — a Node script that imports nothing from the app, talks to the dev server only over HTTP (Task 5 adds the routes); for now leave a failing first assertion: `GET /api/community-playlists` answers 200 `{ playlists: [] }`.
- [ ] **Step 3: Implement** `lib/community/store.ts` and the schema.
- [ ] **Step 4: Run** `npm run typecheck` — Expected: exit 0
- [ ] **Step 5: Commit** — `git commit -m "Community playlists: Postgres store and schema"`

### Task 5: The API routes

**Files:**
- Create: `app/api/community-playlists/route.ts` (GET list, POST create)
- Create: `app/api/community-playlists/[id]/route.ts` (GET one, PUT edit, DELETE)
- Create: `app/api/community-playlists/admin/route.ts` (GET rows + bans, POST ban/unban)
- Create: `lib/community/checks.ts` (server-only: art fetch + song verification)
- Modify: `scripts/e2e-community-api.mjs`

**Interfaces:**
- Consumes: Tasks 1–4; `rateLimit`, `requireJsonBody`, `readCappedRequestJson(req, 64 * 1024)`, `withErrorHandling`, `NO_STORE` (`lib/api-handler.ts`); `safeFetch`; `readCappedBytes(res, 12 * 1024 * 1024)`; `sharp(...).metadata()`; `batchEpisodes`, `batchPodcasts` (`lib/pi-batch.ts`); `nip19.npubEncode`
- Produces (all `export const runtime = 'nodejs'`):
  - `GET /api/community-playlists[?owner=<hex>]` → 200 `{ playlists: CommunityPlaylistSummary[] }` (max 200; `Cache-Control: public, s-maxage=30, stale-while-revalidate=300` without `owner`, `NO_STORE` with it); store unset → `{ playlists: [] }`
  - `POST /api/community-playlists` body `{ draft: PlaylistDraft }` → 201 `{ id, feedUrl }`; 400 `{ error: 'not publishable', problems: (DraftProblem | { kind: 'art'; reason: ArtRefusal } | { kind: 'song-not-found'; itemGuid } | { kind: 'not-music'; itemGuid })[] }`; 401 `{ error: authMessage(reason) }`; 403 `{ error: 'This account cannot publish playlists.' }` when banned; 503 when the store is unset. The stored title/description are `cleanText(...)` of the validated ones.
  - `GET /api/community-playlists/[id]` → 200 `{ playlist: StoredPlaylist }` | 404 | 410
  - `PUT /api/community-playlists/[id]` body `{ draft, expectedUpdatedAt }` → 200 `{ playlist }` | 403 not owner/banned | 409 `{ error: 'changed elsewhere' }` | 410
  - `DELETE /api/community-playlists/[id]` → 200 `{ deleted: true }` (owner or admin) | 403
  - `GET /api/community-playlists/admin` (NIP-98, admin only) → `{ playlists: CommunityPlaylistSummary[], bans }`; `POST` body `{ action: 'ban' | 'unban' | 'delete', pubkey?: string, id?: string, deleteAll?: boolean }` → 200 `{ ok: true, deleted?: number }`; non-admin → 403
  - `lib/community/checks.ts`: `checkArt(url: string): Promise<{ ok: true } | { ok: false; reason: ArtRefusal }>` (safeFetch with `accept: image/*`, 10 s timeout, `readCappedBytes`, `sharp(buf, { limitInputPixels: 24_000_000 }).metadata()` → `artVerdict` with `hasAlpha`); `verifySongs(songs: PlaylistSong[]): Promise<{ notFound: string[]; notMusic: string[] }>` — `batchEpisodes` in chunks of `MAX_BATCH`; a `null` answer is not-found, an absent key ("could not ask") passes; `batchPodcasts` of the distinct feed guids, a known `medium` other than `music` is not-music
  - The NIP-98 URL the server checks is `new URL(req.url)` with the search string removed, rebuilt on `x-forwarded-host` when present (verify on a Vercel preview which host `req.url` carries and write it down in `docs/feeds.md`).

- [ ] **Step 1: Write the failing e2e assertions** in `scripts/e2e-community-api.mjs` (Node `fetch` against `APP_URL` default `http://localhost:3000`; a throwaway owner key, a second key, and an admin key whose npub is in the dev server's `ADMIN_NPUBS`; songs: 12 real `{ feedGuid, itemGuid }` pairs read at start from one of ChadF's playlists via `GET /api/playlist?url=<a COMMUNITY_PLAYLIST_URLS entry>&limit=12`):
  - unsigned POST → 401; POST signed 120 s ago → 401 with `"device clock"` in `error`
  - POST with 9 songs → 400 with `too-few-songs`; with a made-up `itemGuid` → 400 `song-not-found`
  - POST 12 songs, title `"fuck yeah"` → 201; GET the playlist → title `"**** yeah"`
  - list → the new id first; `GET <feedUrl path>` (Task 6) skipped until Task 6
  - PUT by the second key → 403; PUT by owner with `expectedUpdatedAt` from before another PUT → 409; PUT with a fresh one → 200
  - admin POST `ban` of the owner → 200; owner PUT → 403; admin `unban` → 200; non-admin admin GET → 403
  - owner DELETE → 200; GET → 410; list no longer has it
- [ ] **Step 2: Run** `npm run dev` (with `COMMUNITY_DB_URL=postgres://postgres:test@localhost:54329/postgres ADMIN_NPUBS=<admin npub>` in `.env.local`), then `npm run e2e:communityapi` — Expected: FAIL (routes missing)
- [ ] **Step 3: Implement** the routes and `lib/community/checks.ts`.
- [ ] **Step 4: Run** `npm run e2e:communityapi` — Expected: every line `ok`
- [ ] **Step 5: Commit** — `git commit -m "Community playlists: API routes with NIP-98 writes, art and song checks"`

### Task 6: Feed and cover route, guid lookup, Podcast Index

**Files:**
- Create: `app/feeds/playlists/[file]/route.ts`
- Create: `lib/community/cover.ts` (server-only)
- Create: `lib/community/pi-notify.ts` (server-only)
- Modify: the route `<HomePage>`'s `?podcast=<guid>` restore uses to resolve a guid (find it from `components/home-page.tsx` → `lib/podcast-meta.ts`; expected `app/api/by-guid/route.ts`) to fall back to `findPlaylistByGuid` on a Podcast Index miss
- Modify: `lib/util.ts` (add `communityPlaylistToPodcast`, type-only import of `CommunityPlaylistSummary`)
- Modify: `lib/curated-roster.ts` so `searchCuratedPlaylists` also matches stored playlists (title via `filterPlaylistsByQuery`), each built with `communityPlaylistToPodcast`
- Modify: `scripts/e2e-community-api.mjs`; `docs/feeds.md`, `docs/ops.md`, `CLAUDE.md` (Server-only list gains `lib/community/store.ts`, `checks.ts`, `cover.ts`, `pi-notify.ts`; doc table row; `check:community` row: "pins `validatePlaylistDraft`, `artVerdict`, `cleanText`, `buildPlaylistFeedXml`, `verifyNip98`… | a feed no app can parse, or a write by someone who does not own it")

**Interfaces:**
- Produces:
  - `GET /feeds/playlists/<uuid>.xml` → 200 `application/rss+xml; charset=utf-8`, `Cache-Control: public, max-age=60, s-maxage=60, stale-while-revalidate=600`; 410 for deleted; 404 otherwise (any other `file` shape → 404)
  - `GET /feeds/playlists/<uuid>.jpg` → 200 `image/jpeg` 1400 × 1400, `Cache-Control: public, max-age=3600, s-maxage=86400`; it serves the stored art link (fetched with `checkArt`'s path, re-encoded to JPEG) and, when there is none or it fails, `buildGridCover(songs.slice(0, 4))`
  - `buildGridCover(songs: PlaylistSong[]): Promise<Buffer>` — `batchEpisodes` → `episode.image ?? episode.feedImage`, each fetched with `safeFetch` + `readCappedBytes`, `sharp` cover-resized to 700 × 700, composited 2 × 2 on a 1400 × 1400 `#0A0A08` canvas; a missing tile repeats the previous one; no art at all → the plain canvas with a centred ♫ drawn in `#FAE500` (SVG composite)
  - `notifyPodcastIndex(feedUrl: string, kind: 'new' | 'update'): Promise<void>` — no-op unless `process.env.VERCEL_ENV === 'production' && COMMUNITY_FEED_ORIGIN === 'https://www.boostmebuddy.com'`; `new` → PI `add/byfeedurl` with the existing PI auth helper in `lib/pi.ts` (confirm the key may add feeds; log and continue if refused), both → `GET https://api.podcastindex.org/api/1.0/hub/pubnotify?url=<enc>`; never throws, never awaited by the response (use `after()` from `next/server` if available in this Next version, else fire-and-forget with a `.catch`)
  - `cover version` in `communityCoverUrl` = `Date.parse(updatedAt) / 1000 | 0`
  - `communityPlaylistToPodcast(s: CommunityPlaylistSummary): Podcast` in `lib/util.ts` → `{ id: -fnvHash(s.feedUrl), podcastGuid: s.podcastGuid, title: s.title, description: s.description, image: s.coverUrl, artwork: s.coverUrl, url: s.feedUrl, medium: 'musicL', isPreview: true, nostrNpubs: [{ npub: s.ownerNpub, pubkey: s.ownerPubkey }] }` — the one shape both the server (search lane) and the browser (Task 11) use; pin it in `check:community`
  - The POST route calls `notifyPodcastIndex(feedUrl, 'new')`; PUT, DELETE and admin delete call it with `'update'`

- [ ] **Step 1: Add the failing e2e assertions:** after the 201, `GET /feeds/playlists/<id>.xml` → 200, the body parses with the same checks as Task 2 (re-implement the minimal parse in the e2e: count `<podcast:remoteItem` = 12, contains the owner npub, `<podcast:medium>musicL`); `GET …/<id>.jpg` → 200 `image/jpeg`; `GET /feeds/playlists/nope.xml` → 404; after DELETE the `.xml` → 410; the guid restore route answers the playlist for its `podcastGuid`; `GET /api/search?q=<title>&type=playlist` includes it
- [ ] **Step 2: Run** `npm run e2e:communityapi` — Expected: FAIL on the new lines
- [ ] **Step 3: Implement** the route, `cover.ts`, `pi-notify.ts` (and its calls from the Task 5 write routes), `communityPlaylistToPodcast`, the guid fallback and the search-lane merge; update the docs named above.
- [ ] **Step 4: Run** `npm run e2e:communityapi && npm run check && npm run typecheck && npm run lint` — Expected: all pass; then stop the dev server and `npm run build` — Expected: exit 0; `rm -rf .next`
- [ ] **Step 5: Commit** — `git commit -m "Community playlists: feed and cover route, guid lookup, search lane, PI notify"`

### Task 7: Ship PR 1 to beta

- [ ] **Step 1: Chad's setup (blocks the beta test, not the PR).** Add a line to `~/Vibe/project-notes/notes/TODO.md` and tell Chad, in one message, exactly: create two Postgres databases (production, test); run `npm run community:schema` against each; on the **boostmebitch** Vercel project set `COMMUNITY_DB_URL` (Production = production DB, Preview = test DB), `NEXT_PUBLIC_COMMUNITY_FEED_ORIGIN` (Preview = `https://beta.boostmebitch.com`), `ADMIN_NPUBS` (all environments); on **boostmebuddy** set `COMMUNITY_DB_URL` (Production = production DB) and `ADMIN_NPUBS`. Secrets are his to type (memory: settings and secrets need Chad).
- [ ] **Step 2: Push and open the PR** (`gh pr create`, body per `.github/pull_request_template.md`, listing what `e2e:communityapi` verified and what it did not), then `npm run beta -- add <PR>` and give Chad the printed push command.
- [ ] **Step 3: Stop the local Postgres** (`docker stop bmb-community-pg && colima stop`).

---

## PR 2 — Make, list and edit (branch `community-playlists-ui`, from `community-playlists-server` with `home-playlists-section` merged in)

### Task 8: Client API and the saved draft

**Files:**
- Create: `lib/community/client.ts` (browser-only)
- Modify: `lib/storage.ts` (accessor), `docs/storage.md`

**Interfaces:**
- Consumes: `activeNostr()` from `@/lib/nostr/signer` (`.signEvent(template): Promise<Event>`), `getToken` from `nostr-tools/nip98`; Task 5 routes
- Produces:
  - `signedFetch(path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: unknown, o?: { timeoutMs?: number }): Promise<Response>` — absolute URL `location.origin + path`, `Authorization` from `getToken(url, method, (e) => nostr.signEvent(e), true, body)`; the SIGN step races `o.timeoutMs` (default 90 000) and rejects with `SignTimeoutError`
  - `publishPlaylist(d: PlaylistDraft)`, `savePlaylist(id: string, d: PlaylistDraft, expectedUpdatedAt: string)`, `deleteOwnPlaylist(id: string)`, `fetchPlaylist(id: string)`, `fetchCommunityPlaylists(owner?: string): Promise<CommunityPlaylistSummary[] | null>` (null = could not load)
  - `storage.playlistDraft` with `get(npub: string): PlaylistDraftCache | null`, `set(npub, v): boolean`, `clear(npub)`; key `bmb:playlist_draft:<npub>`; `PlaylistDraftCache = { draft: PlaylistDraft; editingId: string | null; expectedUpdatedAt: string | null; labels: Record<string, { title: string; artist?: string; image?: string }> }` (labels keyed by `itemGuid`, so a reload repaints titles without a fetch)

- [ ] **Step 1: Write the failing check** — none is loadable (browser module); instead write the e2e assertion for Task 12 now: after adding 12 songs and reloading, `localStorage['bmb:playlist_draft:<npub>']` parses and the page shows the same title and 12 rows.
- [ ] **Step 2: Implement** `client.ts` and the storage accessor (add the key to `docs/storage.md`'s table with its eviction class: a setting, never evicted).
- [ ] **Step 3: Run** `npm run typecheck && npm run lint` — Expected: exit 0
- [ ] **Step 4: Commit** — `git commit -m "Community playlists: signed client calls and saved draft"`

### Task 9: The maker page and the MAKE PLAYLIST button

**Files:**
- Create: `app/playlists/make/page.tsx` (server: `<AppHeader />` + `<PlaylistMaker />`, `metadata` with `BRAND.displayName`)
- Create: `components/community/playlist-maker.tsx`
- Modify: `components/home-page.tsx` (the Playlists section from PR #533: wrap the link row in `flex flex-wrap gap-2`, add `<Link href="/playlists/make" className="btn-bolt-soft btn-compact">+ MAKE PLAYLIST</Link>`; signed out it still links — the page asks for sign-in)

**Interfaces:**
- Consumes: Task 8; `useApp` (`identity`, `setSignInOpen`); `cleanText` (Task 1, runs in the browser); `validatePlaylistDraft`, `MIN_SONGS`; `<AddSongsSheet>` (Task 10)
- Produces: `PlaylistMaker()` reading `?id=<uuid>` for edit mode. States: signed out → a sentence and `SIGN IN` (`setSignInOpen(true)`); editing → load with `fetchPlaylist`, prefill; normal → the screen in the spec ("The screens", 2). Labels and copy, exactly: `TITLE`, `DESCRIPTION`, `PLAYLIST ART LINK`, hint `Square, 1400–3000 px. Empty: BMB makes the cover from the first four songs.`, `+ ADD SONGS`, `PUBLISH` (edit mode: `SAVE`), `DELETE` (edit mode, confirm first), footer `Signed in as <name>. Only you can change this playlist.`; when `cleanText(title) !== title` show `Will publish as: <cleaned>`; PUBLISH is disabled with the reason while `validatePlaylistDraft` fails (`Add N more songs`, `Add a title`). After a 201: the Published view (spec screen 5) with `PLAY`, `EDIT`, `SHARE` (`<CopyLinkButton>` of the BMB landing link), the feed address and `COPY`.
- Server refusals are rendered per problem (`song-not-found` names the song from `labels`; `art` names the reason in words: `not-square` → "The picture must be square.", `too-small` → "The picture must be at least 1400 × 1400 px.", `too-large` → "The picture must be at most 3000 × 3000 px.", `format` → "Use a PNG or JPEG picture.", `alpha` → "The picture must not be transparent.", `not-image` → "That link is not a picture we can read.").
- Song rows: ↑ ↓ × buttons, each ≥ 32 × 32, `aria-label` `Move up` / `Move down` / `Remove`.

- [ ] **Step 1: Write the failing e2e lines** (Task 12 script): at 390 × 844 mobile emulation, home shows `+ MAKE PLAYLIST` next to `♫ BROWSE PLAYLISTS` with no horizontal overflow; signed out, `/playlists/make` shows `SIGN IN`.
- [ ] **Step 2: Implement** the page, the component and the home button.
- [ ] **Step 3: Run** `npm run typecheck && npm run lint` — Expected: exit 0
- [ ] **Step 4: Commit** — `git commit -m "Community playlists: maker page and MAKE PLAYLIST button"`

### Task 10: Add songs — SEARCH and FAVORITES

**Files:**
- Create: `components/community/add-songs-sheet.tsx`
- Modify: `components/modal-shell.tsx` only if `className="w-full max-w-2xl h-full"` with `clearsPlayer={false}` cannot reach the layout in the spec; then add one prop `fill?: boolean` and document it in its header comment

**Interfaces:**
- Consumes: `<ModalShell>`, `<UnderlineTabs>` + `tabPanelProps`; `GET /api/search?q=&type=music` (`{ feeds: Podcast[] }`, 280 ms debounce and a generation guard like `search-bar.tsx`); `loadFeed({ feedId } | { feedUrl })`; `useApp` `favoriteEpisodes`; `isMusicMedium`
- Produces: `AddSongsSheet({ songs, onAdd, onClose, playlistTitle }: { songs: PlaylistSong[]; onAdd: (s: PlaylistSong, label: { title: string; artist?: string; image?: string }) => void; onClose: () => void; playlistTitle: string })`
  - SEARCH: input + `♫ MUSIC` stamp; album rows → open → `loadFeed` → track rows with `+ ADD` / `✓ ADDED`; the line `Pick songs one at a time. A whole album cannot go in.`; `← RESULTS`
  - FAVORITES: `Object.values(favoriteEpisodes)` filtered to `medium === 'music'` or `medium` undefined with a `feedGuid` (track favorites carry `remoteItem.medium`), newest first, rows `+ ADD` / `✓ ADDED`; a favorite with no `feedGuid` is not listed; empty → `No saved songs yet. Tap ♡ on a song to save it.`
  - `DONE` closes; header shows `<n> in <playlistTitle>`

- [ ] **Step 1: Write the failing e2e lines** (Task 12 script): the SEARCH tab finds an album, opens it, adds 6 tracks (rows flip to `✓ ADDED`); the FAVORITES tab lists only songs (seed `favoriteEpisodes` through `storage` the way `e2e-favorites.mjs` seeds a signed-in user) and adds 6; the count reads `12 in <title>`.
- [ ] **Step 2: Implement** the sheet.
- [ ] **Step 3: Run** `npm run typecheck && npm run lint` — Expected: exit 0
- [ ] **Step 4: Commit** — `git commit -m "Community playlists: add songs from search and favorites"`

### Task 11: Community playlists on /playlists

**Files:**
- Modify: `lib/playlist-collection.ts` (the `COMMUNITY_COLLECTION_URL` branch), `components/playlists-page.tsx` (blurb, EDIT), `components/lists/podcast-results.tsx` (`action` slot)
- Modify: `docs/ui.md` (playlists page section)

**Interfaces:**
- Consumes: `fetchCommunityPlaylists()` (Task 8); `communityPlaylistToPodcast` (Task 6, `lib/util.ts`)
- Produces:
  - `loadCollection(COMMUNITY_COLLECTION_URL)` → stored playlists first (newest first), then the existing seven; `listed` counts both; a store that cannot be reached leaves the seven and sets the partial line
  - Community blurb: `Made by listeners on BMB, and by other people in the V4V community.`
  - `PodcastRow`/`PodcastResults` gain `action?: (p: Podcast) => ReactNode`, rendered as a sibling of the row button (never inside it); `/playlists` passes an `EDIT` `btn-mini` link to `/playlists/make?id=<id>` for rows whose `nostrNpubs[0].pubkey === identity.pubkey` and whose `url` passes `communityIdFromFeedUrl`

- [ ] **Step 1: Write the failing e2e lines** (Task 12 script): after publishing, `/playlists` shows the new playlist first under Community playlists, with `EDIT`; signed in as another key, no `EDIT`; opening the row plays the playlist's track list (12 rows).
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** `npm run typecheck && npm run lint && npm run check:community` — Expected: exit 0
- [ ] **Step 4: Commit** — `git commit -m "Community playlists: list stored playlists first, EDIT on your own"`

### Task 12: The UI e2e, then ship PR 2 to beta

**Files:**
- Create: `scripts/e2e-community-ui.mjs`; Modify: `package.json` (`"e2e:communityui"`), `docs/testing.md`

**Interfaces:**
- Consumes: `launchChrome`, `checker`, `exit` (`scripts/cdp.mjs`); the fake NIP-07 signer from `scripts/e2e-favorites.mjs` (lines 141–173) with a switch that makes `signEvent` never resolve; the local Postgres from Task 4; `Emulation.setDeviceMetricsOverride` 390 × 844 `mobile: true`

- [ ] **Step 1: Assemble the lines from Tasks 8–11** plus the Review Focus tests: (1) never-answering signer → after a 5 s `timeoutMs` override (`window.__bmbSignTimeoutMs`, read by `signedFetch` only when set) the PUBLISH button is enabled again, the message names the signer, and 12 rows remain; (2) reload restores the draft; publish → Published view → `/playlists` first row → EDIT → change the title → SAVE → DELETE → gone from the list; measure `scrollWidth <= clientWidth` and every new control ≥ 24 × 24 on each screen.
- [ ] **Step 2: Run** `npm run e2e:communityui` against `npm run dev` — Expected: every line `ok`
- [ ] **Step 3: Run** `npm run check && npm run typecheck && npm run lint`, stop the dev server, `npm run build`, `rm -rf .next` — Expected: all pass
- [ ] **Step 4: Commit, push, open the PR** (base: `community-playlists-server`), `npm run beta -- add <PR>`; stop the local Postgres and Colima.

---

## PR 3 — Admin page (branch `community-playlists-admin`, from `community-playlists-ui`)

### Task 13: /admin

**Files:**
- Create: `app/admin/page.tsx` (`<AppHeader />` + `<AdminPlaylists />`, `robots: { index: false }`)
- Create: `components/community/admin-playlists.tsx`
- Modify: `scripts/e2e-community-ui.mjs`, `docs/ui.md`, `CLAUDE.md` (doc table: `app/admin/` → ui.md)

**Interfaces:**
- Consumes: `signedFetch('/api/community-playlists/admin', 'GET' | 'POST', …)`; `useApp` `identity`
- Produces: signed out → `SIGN IN`; signed in but the GET answers 403 → `This account is not an admin.`; admin → rows newest first (cover via `/api/art`, title, description, `<npub short>` + kind:0 name, `<n> songs`, published time) each with `DELETE` and `BAN MAKER`; BAN asks `Also delete this person's other playlists?` with `BAN AND DELETE ALL` / `BAN ONLY` / `CANCEL`; a `Banned` list with `UNBAN`.

- [ ] **Step 1: Write the failing e2e lines:** the admin key sees the rows; DELETE removes one from `/playlists`; BAN AND DELETE ALL removes the maker's playlists and the maker's next PUBLISH shows `This account cannot publish playlists.`; UNBAN lets it publish; a non-admin sees `This account is not an admin.`
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** `npm run e2e:communityui`, `npm run typecheck && npm run lint` — Expected: pass
- [ ] **Step 4: Commit, push, open the PR** (base `community-playlists-ui`), `npm run beta -- add <PR>`.

---

## PR 4 — Let the Bitch site ask the Buddy site to sign (branch `buddy-sign-cors`, from `origin/main`)

Beta has no Buddy deploy, so this small PR must reach **Buddy production** before PR 5 can be tested on beta. Tell Chad that when you open it.

### Task 14: CORS on the two Buddy signing routes

**Files:**
- Create: `lib/cross-brand-cors.ts` (import-free leaf)
- Modify: `app/api/nostr/site-sign/route.ts`, `app/api/nostr/zap-receipt-sign/route.ts` (add `OPTIONS`, add headers to every answer); `scripts/check-brand.mjs`; `docs/security.md`

**Interfaces:**
- Produces: `crossBrandOrigins(brandId: 'bmb' | 'buddy'): readonly string[]` → for `buddy`: `['https://www.boostmebitch.com', 'https://beta.boostmebitch.com']`; for `bmb`: `[]`. `corsHeaders(origin: string | null, brandId): Record<string, string>` → `{ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Max-Age': '600', Vary: 'Origin' }` for an allowed origin, else `{ Vary: 'Origin' }`. Rate limits and validation are unchanged (the routes are already public; CORS only lets a browser on the Bitch origin read the answer).

- [ ] **Step 1: Write the failing checks** in `check:brand`: `crossBrandOrigins('buddy')` exact list; `corsHeaders('https://evil.example', 'buddy')` has no `Access-Control-Allow-Origin`; `corsHeaders('https://www.boostmebitch.com', 'bmb')` has none (the Bitch deploy opens nothing).
- [ ] **Step 2: Run** `npm run check:brand` — Expected: FAIL
- [ ] **Step 3: Implement**; then verify with `NEXT_PUBLIC_BRAND=buddy npm run dev` and `curl -i -X OPTIONS -H 'Origin: https://www.boostmebitch.com' -H 'Access-Control-Request-Method: POST' localhost:3000/api/nostr/site-sign` — Expected: 204 with the allow-origin header.
- [ ] **Step 4: Run** `npm run check && npm run typecheck && npm run lint` — Expected: pass
- [ ] **Step 5: Commit, push, open the PR**; ask Chad to merge it to `main` once reviewed (it changes nothing a Bitch visitor sees).

---

## PR 5 — Boost notes from a playlist song (branch `community-playlists-notes`, from `community-playlists-admin`, after PR 4 is live on Buddy)

### Task 15: Pure note context

**Files:**
- Modify: `lib/util.ts` (type-only imports stay), `lib/brand.ts`
- Modify: `scripts/check-community.mjs`, `scripts/check-brand.mjs`, `scripts/check-note-episode-link.mjs`

**Interfaces:**
- Produces (`lib/util.ts`):
  - `playlistBoostContext(podcast: Podcast, episode: Episode | undefined, hostedFeedPrefix: string): { container: Podcast | null; show: Podcast; hosted: boolean }` — `container` is `podcast` when `isPlaylistMedium(podcast)` and `episode?.podcastGuid` is set and differs from `podcast.podcastGuid`; then `show = queueShowFor(episode, podcast)` (the track's own feed), else `show = podcast`; `hosted = !!container?.url?.startsWith(hostedFeedPrefix)`
  - `heardOnLines(container: Podcast, makerNpub: string | null, linkOrigin: string): string[]` → `['🎧 Heard on <title>' + (makerNpub ? ' by nostr:<npub>' : ''), '<linkOrigin>/?podcast=<guid>']`, the link only when `container.podcastGuid` is set
- Produces (`lib/brand.ts`): `resolveSenderName(typed: string, anonymous: boolean, brand: Brand = BRAND): string` (default unchanged)

- [ ] **Step 1: Write the failing checks:**
  - `playlistBoostContext` with a `musicL` container and an episode of another feed → `container` set, `show.podcastGuid === episode.podcastGuid`, `show.nostrNpubs` undefined; same guid → `container: null`, `show === podcast`; a `music` album (not a list medium) with a foreign episode guid → `container: null`; `hosted` true only for `https://www.boostmebuddy.com/feeds/playlists/…`
  - `heardOnLines` exact strings for with/without maker and without a guid
  - `resolveSenderName('', true, BRANDS.buddy) === 'boostmebuddy.com user'`; `resolveSenderName('Chad', false, BRANDS.buddy) === 'Chad'`
  - `check:notelink`: a note body with the track's landing link AND a following `🎧 Heard on …` + playlist link → `episodeLinkInNote` still returns the episode's link (record with `check(...)`, and prove it fails against `naive`)
- [ ] **Step 2: Run** `npm run check:community && npm run check:brand && npm run check:notelink` — Expected: FAIL
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the three checks — Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "Boost notes: playlist context, Heard-on line, brand-aware sender name"`

### Task 16: Wire the note, ship PR 5 to beta

**Files:**
- Modify: `lib/nostr/boost-notes.ts`, `lib/nostr/zap-summary-receipt.ts`, `components/boost-modal/index.tsx`, `components/boost-all-modal.tsx`
- Modify: `docs/nostr.md` (boost note section), `CLAUDE.md` (Names section: one sentence — a note from a BMB-hosted playlist carries Buddy's `wireName` in its `client` tag; the boostagram never does)
- Create: `scripts/e2e-community-note.mjs`; Modify: `package.json`, `docs/testing.md`

**Interfaces:**
- Consumes: Task 15; `BRANDS`; `COMMUNITY_FEED_ORIGIN`, `COMMUNITY_FEED_PATH`
- Produces:
  - `PublishArgs` gains `brand?: Brand` and `senderName?: string`; `siteLandingUrl(feedGuid, itemGuid?, origin = SITE_ORIGIN)`; `boostBannerUrl(..., origin)`; `buildBoostNoteTemplate` uses `ctx.show` for the header line, the landing links, the banner and the FIRST `i` tags (song's own feed, then its item); when `ctx.container` is set, the container's `podcast:guid` `i` tag is kept as an extra tag after them, so the playlist's own discussion still finds the note (read what `components/episode-nostr-feed.tsx` and `lib/nostr/interactions.ts` query before you move a tag); appends `heardOnLines(ctx.container, makerNpub, ctx.hosted ? COMMUNITY_FEED_ORIGIN : brand.origin)` after the track lines when `ctx.container` is set, uses `clientTag(brand.wireName)` when `brand !== BRAND` (else `boostagram.app_name` as today) and `args.senderName ?? boostagram.sender_name` for the sender; `noteNpubs` is unchanged (it already tags the container's npub)
  - `publishBoostNoteViaSite` posts to `${brand.origin}/api/nostr/site-sign` when `brand !== BRAND`; `mintSummaryReceipt(..., brand = BRAND)` posts to `${brand.origin}/api/nostr/zap-receipt-sign` and quotes `brand.siteNpub`
  - Both modals compute `ctx = playlistBoostContext(podcast, episode, COMMUNITY_FEED_ORIGIN + COMMUNITY_FEED_PATH)`, `noteBrand = ctx.hosted ? BRANDS.buddy : BRAND`, pass `brand: noteBrand` and `senderName: resolveSenderName(name, anonymous, noteBrand)`; the boostagram object is not touched
- [ ] **Step 1: Write the failing e2e** `scripts/e2e-community-note.mjs`: a local relay (`createRelay` from `scripts/local-relay.mjs`, `bmb:relays` pointed at it), the stub NIP-47 wallet from `scripts/e2e-nwc-relay.mjs`, a throwaway signer; open a stored playlist, boost its first song for 100 sats with "Share to Nostr" as self, then read the kind:1 from the local relay and assert: header names the song's own album, `📻 <song>` present, `🎧 Heard on <playlist> by nostr:<maker npub>`, the link on `COMMUNITY_FEED_ORIGIN`, a `p` tag with the maker pubkey, `client` = `BoostMeBuddy`, `imeta` URL on `https://www.boostmebuddy.com/api/og/boost.png?`; repeat as Anonymous and assert the event's `pubkey` is Buddy's site key (decode `BRANDS.buddy.siteNpub`) — this half needs PR 4 on Buddy production and a reachable network; skip it with a printed reason when `--offline`; a boost from one of the seven existing community feeds → `client` = `BoostMeBitch`, Heard-on line present, no Buddy words.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** `npm run e2e:communitynote`, `npm run check && npm run typecheck && npm run lint`, then build — Expected: pass
- [ ] **Step 4: Commit, push, open the PR** (base `community-playlists-admin`), `npm run beta -- add <PR>`; in the PR body list the real-wallet boost on beta as Chad's test.
- [ ] **Step 5: Cleanup:** stop every dev server, Chrome (via the harness), Colima and the Postgres container; run `node ~/Vibe/vibe-kit/vibe.mjs`; leave `boostmebitch` on a clean branch.
