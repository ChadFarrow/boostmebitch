# Downloads

Read this before editing anything under `lib/downloads/`, the download button, or
the `/downloads` page.

Downloads are **supplementary, for low bandwidth**. The listener presses a button
while they have signal, keeps listening to something else, and plays that episode
later from local bytes. This is not an offline-first app and the feature is not
trying to become one.

---

## The measurement that shaped the whole design: hosts send CORS

`<audio src="https://host/ep.mp3">` needs no CORS header. `fetch()` of the same URL
does. The obvious fear is therefore that most podcast hosts would refuse a download,
and that the app would need a server-side audio proxy the way StableKraft does
(`/api/proxy-audio`, plus a hand-maintained domain allowlist deciding proxy-first
versus direct-first per host).

Five real enclosures were tested on **2026-09-09**, with
`Origin: https://boostmebitch.com`:

| Host | `Access-Control-Allow-Origin` | `Accept-Ranges` |
| --- | --- | --- |
| Homegrown Hits (self-hosted) | `*` | bytes |
| Megaphone behind `www.podtrac.com` | `*` | bytes |
| Simplecast behind `dts.podtrac.com` + two more redirects | echoed our origin | bytes |
| archive.org | `*` | bytes |
| Fountain (a `musicL` album track, 53 MB `.wav`) | `*` | bytes |

Five of five. **So this app has no audio proxy and must not grow one casually.** What
that buys is not tidiness:

- No SSRF surface. An audio proxy takes a feed-supplied URL and fetches it
  server-side, which is the exact shape `lib/safe-fetch.ts` exists to contain.
- No audio bytes billed through Vercel. A proxy doubles them — host to us, us to
  the listener — for a feature whose entire purpose is that bandwidth is scarce.
- No domain allowlist to drift. StableKraft's two lists were hand-mirrored and went
  out of sync at 16 entries versus 14, and the symptom was "streams fine, won't
  download."

A host that does **not** send the header fails the download. That is a minority, and
the button says which host and why — see "Failure is a sentence" below. If that
minority ever turns out to matter, adding a proxy is a real option; adding one
*before* it matters is paying all three costs for nothing.

**Re-measure before you conclude a host is broken.** `curl -sIL -H 'Origin: …'` on
the enclosure answers this in one command.

---

## The three modules, and which one may hold a rule

```
download-rules.ts    pure decisions, IMPORT-FREE, pinned by check:downloads
downloads-cache.ts   bytes      → Cache API
downloads-db.ts      metadata   → IndexedDB
download-manager.ts  orchestration only
```

`download-rules.ts` is import-free because `scripts/check-downloads.mjs` loads the
**shipping** module under `node --experimental-strip-types`. Nothing else here can
be loaded that way — `download-manager.ts` imports `../util`, which plain Node
cannot resolve without an extension — so **anything in the manager that starts to
look like a rule belongs down in the leaf**, or it becomes unpinnable at the moment
it starts to matter.

That import-free constraint costs exactly one thing, deliberately: `isDownloadable`
carries its own copy of the HLS test rather than calling `isHlsUrl` (`lib/util.ts`),
which is the app's one answer everywhere else. A second copy drifts, so
`check:downloads` has a section asserting the two agree about a list of URLs
including the near-misses (`notes-about-m3u8-files.mp3`,
`ep.mp3?next=stream.m3u8`). **If that section fails, `isHlsUrl` moved and this file
follows it — never the other way round.**

### Three names that may never be renamed

`BmbDownloadsDB` (+ its `downloads` store), `bmb-downloads-v1`,
`bmb-downloads-art-v1`. These are on-disk identifiers. Renaming one migrates
nothing: it points the app at storage nothing ever wrote, so every existing
download reads back as never having existed while its bytes stay on disk,
unreachable and uncountable. Guard comments sit at all three declaration sites.

`DB_VERSION` may only be raised with an **additive** `onupgradeneeded`; never
`deleteObjectStore`. Adding a field to `DownloadRecord` needs no bump at all,
because IndexedDB stores whole objects.

---

## `downloadKey` must be idempotent, and that is the whole feature

`downloadKey(downloadKey(u)) === downloadKey(u)` for every input. The play-side call
is sometimes handed a URL that has already been through here, so a key that changes
on re-derivation produces a download that **exists on disk and can never be found** —
with no error anywhere, because both halves believe they are correct. The listener
paid for the file, and pays again on the connection they downloaded it to avoid.

Every normalization changes **no bytes on the wire**: the URL it returns fetches
exactly what the input would have. That is the admission test for adding another one.

- `http:` → `https:` — the app is https-only, so the http form would fail anyway,
  and a feed that switched mid-life does not orphan what it already wrote.
- The fragment is dropped — never sent to the server, so two URLs differing only by
  one name the same resource and must not download twice.
- A literal space is encoded, because `fetch()` encodes it too. Disagree here and
  the save key and the play key differ.
- **An analytics redirect is NOT unwrapped.** `podtrac.com/pts/redirect.mp3/…` and
  `op3.dev/e/…` are part of the URL the host will serve, and a signed CDN URL
  underneath one is not ours to rewrite. StableKraft unwraps `op3`; this does not,
  and the difference is that StableKraft keys music tracks that appear under both
  forms while this app keys episodes that do not.

Anything that is not an absolute http(s) URL returns `null`. The scheme test is an
**allowlist**, never a denylist of bad schemes — the same rule `safeUrlAttr` is
under, for the same reason.

---

## A live item is never downloadable, whatever its status

`isDownloadable` refuses **every** `<podcast:liveItem>`, not just `status="live"`,
and this rule was written against a real feed rather than a hypothesis.

Measured 2026-09-09: Homegrown Hits episode 150 sat at `status="pending"` with
the enclosure `https://stream.bowlafterbowl.com/listen/bowlafterbowl/stream.mp3`
— an **endless icecast stream**. It ends in `.mp3` and answers 200, so nothing
about the URL says "not a file". Refusing only `'live'` let the download button
offer it, and the browser test happily started pulling it.

The consequence is worse than a wasted download. An endless source sends no
`Content-Length`, so neither the feed hint nor the response header can size it,
and `downloadBytes` accumulates chunks in an **in-memory array** until it can
write them — so it takes the tab down rather than merely filling the disk.
`MAX_DOWNLOAD_BYTES` (600 MB, enforced on bytes **received**, never on bytes
declared) is the backstop; refusing the item is the fix. Same rule as
`lib/capped-body.ts`, pointed at audio.

`'ended'` is refused too, and that is the deliberate direction to be wrong in. A
publisher who keeps the recording republishes it as an ordinary `<item>`, which
carries no `liveStatus` and is accepted; an ended `liveItem` usually still names
the dead stream. Refusing one costs a single episode. Allowing one costs a
download that never finishes, on the connection this feature exists to spare.

## Say the size before the press, and never say "0 MB"

Episodes are big — 160–190 MB each on Homegrown Hits, and one Fountain music
track measured 53 MB as a `.wav`. Somebody deciding whether to spend that needs
the number *before* they press, so `Episode.enclosureLength` is parsed from RSS's
`<enclosure length>` and from Podcast Index's mirror of it, and the button puts it
in its accessible name at every size.

Both sources lie in the same two ways: the attribute is routinely absent or
`"0"`, and PI mirrors the zero. `numOrUndef` (`lib/pi.ts`) and `fmtBytes`
(`lib/format.tsx`) both answer *nothing* rather than a number in that case —
"0 MB" beside a 160 MB file is worse than silence. It is a **hint**, never a
fact: the response `Content-Length` is what the second room check uses.

The visible size shares ONE FIXED-WIDTH SLOT with the download percentage, and
that is a layout rule rather than a space saving. `<FavHeart>` documents why: this
control is the last item in a right-aligned cluster, so anything that changes
width shoves BOOST and the heart sideways. "162 MB" and "47%" are both about six
characters, so reserving the width once means no state change can move anything.
`.tile` is excluded — 52 px cannot hold a third line — and keeps the size in its
accessible name only.

## `roomVerdict` has a blast radius outside this feature

The obvious version — `usage + bytes <= quota` — is wrong twice, and both are
measured behaviours rather than hypotheticals.

**It fills the origin to the brim.** Downloads share one quota with this origin's
`localStorage`, which holds the NWC spending credential, the Spark mnemonic and the
favorites baseline. A full store on iOS Safari makes every subsequent write fail —
down to a one-byte `bmb:stream_on` — while reads keep working, so nothing else looks
wrong and a fresh profile never reproduces it. See `docs/storage.md`. So
`roomVerdict` reserves `max(64 MB, 5% of quota)`, and it needs **both** bounds: the
flat floor alone refuses every download on a small quota, and the fraction alone
leaves a few hundred kilobytes on one.

**It answers `'no'` when the browser simply cannot estimate.** `navigator.storage
.estimate()` is absent on older iOS — the platform this app is mostly listened on —
so that is a dead button with no explanation, indistinguishable from a broken one.
`'unknown'` **allows** the download and lets a real `QuotaExceededError` be the
answer instead.

**`'no'` is never an instruction to evict.** A download is something the listener
chose to keep. Deleting one to make room for another is a decision they did not ask
for, and they may be about to get on a plane.

---

## The container feed is not the item's parent

`DownloadRecord.feedGuid` is the **item's own** parent feed, never the guid of
whatever feed listed it. A `musicL` playlist lists tracks living in hundreds of other
feeds, so the container's guid is a fact about the playlist, not about the track —
and this field is what a boost from `/downloads` resolves its payee against.

Same rule and same reasoning as `<FavEpisodeHeart>`; read its comment in
`components/fav-heart.tsx` before touching `parentFeedGuid`. It refuses **narrowly**:
the item's own `podcastGuid` wins when present, and the container's is used only when
the item states none.

**StableKraft stores no value block at all**, so a track played from its Downloads
page has no recipients and cannot be boosted correctly. This app stores `value` and
`valueTimeSplits` with the record specifically to avoid that. The stored block is a
**cache** and never outranks a live read.

---

## The `/downloads` page, and the two handoffs it must get right

**Playing a row does not navigate.** `<Player>` is mounted in the root layout, so
`play()` from here starts the audio in place and the mini-player appears over the
list. Verified: `location.pathname` stays `/downloads` while `audio.src` is a
`blob:` URL the decoder has read.

**Opening the SHOW is the one thing that needs a handoff**, and it is the one
`<FavoritesPage>` documents: set the store, then `router.push('/')` — never
`router.push('/?podcast=…')`. `<HomePage>`'s restore effect early-returns whenever
a selection is already set, and the store is module-level, so a visitor who opened
any show earlier in the session would have their param silently ignored and land
back on that show. `setShowOrigin` goes **after** `selectPodcast`, which clears it.
And the page's own `<Link href="/">` calls `clearShowSelection()`, because the
handoff works precisely *because* the store outlives the route change.

**Delete is by key.** A download whose feed moved its enclosure URL and which
carries no item guid is genuinely orphaned — nothing can match it to an episode
any more — so a row's DELETE is the only way those bytes ever come back.

**The empty state is a claim.** "Nothing downloaded yet" may only be shown once
`downloadManager.ready()` is true. `<FavoritesPage>` shipped saying "Nothing saved
yet." over a full library because it had no in-flight state, and it self-corrected
a moment later, which is what made it worse.

**DELETE ALL is a two-press confirm, not `window.confirm`.** In the installed PWA a
native dialog is a system sheet over the app.

The dock is now five tabs. Measured at 390 px under CDP device emulation: 78 × 56
each, so height is still the binding dimension at 56 > 44. `<TabBar>`'s own comment
gives the number to check against — the floor is not threatened until **seven**.

## Chapters and the transcript are cached by THIS APP'S request URL

Not by the third-party document URL, and not as parsed content inside the
record. `useChapters` and `useTranscript` take a **URL and no episode**, so
keying the cache by the exact request they were about to make lets them try it
first without being handed an episode they have no other use for. It also means
the stored bytes are same-origin and therefore readable — a cross-origin fetch of
the raw document would be opaque.

`chaptersRequestUrl` and `transcriptRequestUrl` live in the import-free leaf and
are pinned, because **the key IS the string**: the loader builds this URL to
fetch and the download builds it to cache, so the two agreeing character for
character is the whole feature. A copy on each side is the shape that broke
StableKraft's downloads — its proxy-first and direct-first domain lists were
hand-mirrored and drifted to 16 entries against 14. Here the symptom would be
quieter still: every download silently re-fetching its chapters. The transcript's
`type` is part of the key because it is part of the request.

A **non-ok response is never cached.** A 404 or a 502 outlives the outage that
produced it, and the loader would then render an empty transcript as though the
feed had none.

The documents are fetched **after** the audio is stored and the record written,
so a failure there cannot turn a successful download into a failed one. The
record names what it cached in `docKeys`, which is what lets `remove()` delete
them; that is deliberately **not** ref-counted, because two episodes sharing a
chapters URL is not a thing feeds do and the cost of being wrong is one re-fetch
of a few kilobytes.

## Cover art is a ladder, and it is allowed to fail

`downloadImage` tries **every** proxied `/api/art` candidate in order, for the
same reason `<PodcastCover>` has a four-deep `onError` chain: Podcast Index's
`image` and `artwork` routinely disagree and either can be broken. Measured
2026-09-09 on Homegrown Hits, the episode's own cover is a **19 MB GIF** that
`/api/art` answers 502 for — so taking only the first candidate meant no art at
all, with the feed-level PNG sitting right behind it.

It is still allowed to fail, and `check`ing that it succeeded would be wrong. The
invariant the e2e pins is the honest one: **a cover that could not be fetched
leaves the download, its record and its documents intact.** That is the rule the
artwork proxy is under everywhere in this app — a failing route costs appearance
and nothing else.

`/downloads` is the one surface that renders those stored bytes, because it is
the one that has to paint with no connection. It passes the blob **alone**, with
no `artwork` beside it: `artCandidates` puts every proxied URL ahead of every raw
one and a `blob:` is not proxyable, so passing both would order the network copy
first and leave the local bytes as its fallback.

## The service worker is network-first, which is not precaching

`public/sw.js` used to be a deliberate passthrough, and its comment gave the
reason: Next emits hashed bundle URLs that change every build, so a stale cache
would silently break the app for installed users. **That argument is against
precaching.** Three rules make the failure it describes impossible:

1. **A document is network-first.** Fetch it; on success serve it and keep a
   copy; use the cache **only when the fetch rejects**. A reader with a
   connection is never served a stale document, so a stale document can never
   reference dead chunk hashes while online.
2. **`/_next/static/*` is cache-first, and that is safe by construction.** Those
   URLs are content-hashed — a given URL's bytes never change — so a cached copy
   cannot go stale. This is what makes rule 1 work offline: the last document's
   chunks are still there.
3. **The cache names carry the build id** (`bmb-sw-static-<id>`,
   `bmb-sw-pages-<id>`), and `activate` deletes every `bmb-sw-*` cache that is
   not the current build's.

**TWO documents are precached, and the exception is what makes rule 1 usable.**
`install` does `cache.add('/')` and `cache.add('/downloads')`. Without it the worker had no offline shell at
all after a fresh install: the FIRST document of a visit is fetched before the
worker controls the page, so it never passes through the fetch handler and never
enters `PAGES`. Somebody who installed the app and lost signal without loading a
second time got nothing — measured on an iPhone, in airplane mode, and it did
not degrade. It produced *"FetchEvent.respondWith received an error: TypeError:
Load failed"*.

`/downloads` is the second for its own reason, not for symmetry: it is the one
route whose entire purpose is to work without a network. A dock tab is a Next
`<Link>`, so tapping it is a client-side route change that fetches an RSC
payload rather than a document; when that fetch fails the router falls back to a
real navigation, and that navigation has to land on the route's OWN document.
Without this it landed on the shell, which is the home page's HTML under a
`/downloads` URL. Reported from an iPhone — the tab did not open in airplane
mode and was fine on wifi. **It does not reproduce in headless Chrome**, which
prefetches every dock `<Link>` on the first load and so always has what the tap
needs; that is recorded in the e2e beside the check rather than left for the
next person to rediscover.

It does not weaken network-first. Both are still fetched fresh on every load
that has a connection, and the precached copy is only ever reached when the
fetch rejects. It cannot go stale across a deploy either, because `PAGES` carries the
build id: a new worker precaches its own `/` and `activate` deletes the old one.

**A NAVIGATION MAY NEVER REJECT INSIDE `respondWith`.** This is the rule that
error screen taught, and it is worth stating separately from the fix. Rejecting
does not hand the navigation back to the browser's own offline page — it
REPLACES that page with a service-worker error, which is a worse screen than
having no worker installed at all. So a navigation that misses its exact URL
falls back to the shell, and then to a minimal inline document; it never throws.
The app reads its own deep-link parameters off `window.location` on mount, so
`/?podcast=…` served from the shell still lands where the reader meant.

A **subresource** is the opposite and still rejects, deliberately: that is
exactly what happens with no worker installed, and it is what the app's own
`catch` blocks are written against. Synthesising a `Response` there would turn a
network failure into a non-ok *answer*, and `fetchDoc` reads the difference — it
falls back to a downloaded copy only on a rejection.

That prefix is narrow **on purpose**: the download buckets are `bmb-downloads-*`
and are the user's own files. A sweep that took them would delete a library
somebody saved deliberately, on a deploy they never asked for.

Four things never enter a cache, and each would be a real bug: anything under
`/api/*` (a cached `/api/feed` serves a stale episode list; `/api/live-status`
would report a finished show as live), any non-GET, any cross-origin request
(enclosure audio and relay traffic are not ours to hold), and any response that
is not `ok` (a cached 404 outlives the outage that produced it).

### It is served from a route, and `public/sw.js` had to go

A file in `public/` is static bytes and cannot know which build it belongs to, so
it could never clean up after an older deploy. `app/sw.js/route.ts` interpolates
`BUILD_ID`; the path stays `/sw.js` because that is what every installed device
already has registered, and a worker's scope is its own directory, so `/sw.js`
scopes to `/` with no `Service-Worker-Allowed` header. **`public/sw.js` was
deleted rather than left alongside** — a file in `public/` wins over a route at
the same path, so leaving it would have made the route dead code that looked
live.

`BUILD_ID` must never be a runtime value. A per-request id would make every
request a different cache name, so the caches would grow without bound and
`activate` would delete the set it had just written.

### The check that matters is the deploy, not the airplane

Measured 2026-09-09 across a real rebuild, one Chrome profile kept between the
two halves so the worker and its caches persisted as an installed app's would:
the build id changed, **every cache from the old build was gone, the new one was
present, React still mounted and nothing threw.** That is the regression the old
comment warned about, and it is the check to repeat — an offline launch that
works proves nothing about whether a deploy is taken.

**One honest limitation.** Immediately after a deploy the static cache is empty:
the old worker was still controlling while the page's chunks were fetched, and
`activate` then deleted its caches. So a listener who goes offline between the
deploy and their next load gets the document but not its chunks. It fills on the
following load and needs no intervention — but it is why the offline launch is
"reliable once you have opened the app since the last deploy" rather than
unconditional.

## Running the e2e: kill the last browser first

`npm run e2e:downloads` refuses to start if anything already holds its debug
port, and that guard exists because its absence cost a long session. A Chrome
left over from an earlier run keeps both the port and the profile, so the new one
exits on the locked profile and the harness quietly attaches to the **old**
browser. Every assertion then runs against storage it was never told about, and
the failure reads as *"the app wrote a record but no bytes"* — a shipping bug
that is not there.

## Failure is a sentence, not a ✗

Every refusal is rendered in words. A guard that silently withholds is
indistinguishable from a broken one — the rule `<FavoritesSyncNotice>` exists for.

| Cause | What the listener reads |
| --- | --- |
| The host sent no CORS header, or the device is offline | "Could not reach `<host>` to download this episode." |
| `roomVerdict` said `'no'` | "Not enough space — remove a download to make room." |
| HLS, a live item, or no URL | The button does not render at all. |
| Anything else | The thrown message, or "Download failed — tap to retry." |

`DownloadRefused` is a distinct class from a failure on purpose: nothing was
attempted and nothing was spent.

---

## Eviction is expected, and `null` is not an error

iOS drops an origin's storage under pressure without telling anyone.
`requestPersistence()` asks not to be, once, lazily, after the first successful
download — and Safari does not grant it. So `getObjectUrl` returning `null` for a
record that exists is an **ordinary state**: the manager forgets the record and the
player streams instead, which is what the listener had before they pressed download.

A `null` target must never be read as "the download never happened."

---

## Two lookups, because a URL can move

`resolveSource` tries the URL-derived key first and the `itemGuid` index second.
`<Player>`'s src effect documents the case in its own comment: an episode object can
be **enriched in place** and arrive with a new `enclosureUrl` on the same id — a feed
moving CDN, or gaining an analytics wrapper. A URL-derived key alone reads that as a
different episode and re-downloads it.

A download whose URL moved and which has no item guid is genuinely orphaned. The
`/downloads` page must therefore always allow deleting a row **by key**, so those
bytes are recoverable.

---

## One at a time

The queue runs a single download. StableKraft runs three, and three is right for a
music app on wifi. Here it is wrong: the feature exists for a connection too thin to
stream on, and on that connection three parallel downloads starve the episode the
listener is playing right now — turning the fix into the symptom.

`AbortController` is created **before** the queue slot is acquired, so cancelling
something still waiting is honoured and never issues a fetch.

---

## What is deliberately not here

- **Offline boosting and an offline payment queue.** The value block is stored so a
  boost works once the network is back; nothing is queued while it is not.
- **Bulk download and auto-download.** Both spend the listener's data without a
  screen in front of them.
- **Range requests and resume.** Resuming needs partial bytes kept somewhere, and a
  half-written entry is the class of bug the Cache API's atomic `put` avoids
  entirely.
- **A precaching service worker.** The section above is the argument: a
  network-first worker is not precaching. The one exception is the shell at `/`,
  which is precached because a first visit otherwise leaves nothing to open
  offline with — and which is still only ever served when a fetch rejects.
