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
- **A precaching service worker.** See the phase 6 section when it lands: a
  network-first worker is not precaching, and the distinction is the whole argument.
