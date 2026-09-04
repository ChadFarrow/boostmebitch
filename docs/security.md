# Security — SSRF guard and show-notes sanitizer

Read before touching `lib/safe-fetch.ts`, `lib/safe-url-attr.ts`, `sanitizeShowNotes` in `lib/pi.ts`, `app/api/transcript`, `app/api/nostr/site-sign`, or `next.config.mjs`.

Core rules live in [`../CLAUDE.md`](../CLAUDE.md); this file holds the reasoning.

### SSRF guard (`lib/safe-fetch.ts`)

Every server-side fetch of a feed/chapter/transcript URL goes through **`safeFetch(url, init)`**, never a bare `fetch`. **Two layers**, and it takes both:

1. `assertSafeFetchUrl` — sync and pure, pinned by `check:ssrf`. Scheme, private hostnames, private IP *literals*.
2. `assertResolvedHostSafe` — resolves the hostname and re-runs the IP checks on **every address DNS returns** (any, not the first — we do not pick which one the dialer uses).

Then it **follows redirects manually, re-validating every hop** with both layers — a guard that only checks the initial URL lets a public host 302 to `http://169.254.169.254/…`, and one that only checks literals lets it 302 to a *name* that resolves there.

- **Layer 2 exists because layer 1 alone was bypassed by a plain DNS record, needing no attacker infrastructure at all.** `nip.io` and `localtest.me` are public wildcard resolvers, so `http://127.0.0.1.nip.io/` is an ordinary public hostname that passed every literal check and resolved to loopback. `/api/transcript` returns the body verbatim, which made that a **read** primitive, not a blind one. The old module header called DNS "out of scope"; that was true of *rebinding*, not of this.
- **Both layers share one exported `isPrivateIp`.** A denylist maintained in two places is a denylist with a hole in it.
- **IPv6 needs more than loopback/ULA/link-local.** `::7f00:1` (IPv4-compatible), `64:ff9b::a9fe:a9fe` (NAT64 → cloud metadata), `2002:7f00:1::` (6to4), `fec0::1` (site-local) and Teredo all reach somewhere private without matching those. Each **whole prefix** is refused rather than decoding its embedded IPv4 — a second address parser is a second place to get it wrong. All are deprecated or special-purpose, so nothing legitimate is lost.
- **IETF special-use IPv4 is blocked too** — `192.0.0.0/24`, the three TEST-NETs, `198.18.0.0/15`, `192.88.99.0/24`. None is routable, so none can be a real podcast host.
- **STILL OPEN: TOCTOU rebinding.** This is resolve-then-fetch, and undici resolves again when it dials, so a resolver that answers the two differently gets through. Closing it needs a custom dialer/agent pinning the validated address. Do not let the two layers read as "SSRF is solved".

- **The trailing dot is stripped before any comparison.** DNS treats `metadata.google.internal.` as identical to `metadata.google.internal`, but `.endsWith('.internal')` is **false** for it — one extra character walks past every hostname check, including the cloud-metadata one. Same for `localhost.` and `nas.local.`. Don't "simplify" the `.replace(/\.+$/, '')`.
- **Decimal/octal/hex host forms are already safe** — the WHATWG URL parser normalizes `http://2130706433/` to `127.0.0.1` before the regexes see it. Same for `0x7f000001`, `0177.0.0.1`, `127.1`, `0`, fullwidth digits, circled digits, `user:pass@` and a trailing dot. All re-verified against the shipping guard. Test before adding rules for them.
- **100.64.0.0/10 is blocked on purpose** — RFC 6598 CGNAT *and* the Tailscale range. Without it, a self-hoster running this beside a tailnet exposes every node through the feed/chapter proxies.
- Pinned by `npm run check:ssrf`. Its **ALLOWED half is as load-bearing as the BLOCKED half** — it holds boundary addresses just outside each blocked range (`100.63.255.255`, `172.32.0.1`, `223.255.255.255`) so a bypass fix can't start rejecting real podcast hosts.

**Rate-limit key:** `rateLimit` buckets on the platform-trusted `x-real-ip` / **rightmost** `x-forwarded-for` hop, never the spoofable leftmost entry. Both are still request headers, so the value is length-clamped and the bucket map has a hard ceiling with oldest-first eviction — otherwise a caller rotating that header grows a `Map` this process holds for a minute. The clamp bounds key size; it does not make a spoofed value trustworthy and is not meant to.

### Response size caps (`readCappedText` / `readCappedJson` / `readCappedBytes`)

**`AbortSignal.timeout(...)` caps how LONG a fetch runs, not how many bytes it returns**, and every proxied URL here comes from feed data — eight seconds of a fast upstream is hundreds of megabytes. Every drain site goes through `readCappedText`/`readCappedJson`, which stream and abort past the cap. `Content-Length` is a fast path only; it is absent on chunked responses and trivially lied about, so the running byte count is what enforces the limit. Bytes are joined *before* decoding so a multi-byte character split across chunks survives.

**`readBytesUpTo` is the third shape, and the difference from the other two is the whole point: it stops instead of refusing.** `readCappedText`/`readCappedBytes` throw past the cap, which is right when a partial body is worthless — half a feed is not a feed. A prefix is exactly what `/api/og/boost.png` wants from an animated cover: frame one sits at the front of the file, measured at 606 KB inside a 19 MB episode artwork, so it reads the prefix, **cancels the reader** (without that the rest of the body keeps arriving on a socket nobody reads) and cuts the GIF. It reports `truncated` because "the whole file, which is small" and "as much as you allowed" need different handling and a byte count cannot tell them apart. Use it only where a prefix is genuinely meaningful; everywhere else the throw is the correct behaviour.

**`readCappedBytes` is that same loop without the decode, and it is where a binary body goes.** `/api/og/boost.png` fetches a feed's cover art to draw into the boost banner, and `TextDecoder` over a PNG returns replacement characters — so the text reader is not an option there, and the tempting fallback, `res.arrayBuffer()`, buffers the whole body first and measures after, which is the exact behaviour this section exists to prevent. `readCappedText` now delegates to it: one cap, two shapes. That route pairs it with a 2 MB ceiling (real covers are 50–500 KB), a `Content-Type` allowlist of what the rasterizer can actually decode, and a rule that the fetched bytes are drawn into a PNG and **never proxied back** — so an internal response that somehow got past `safeFetch` still could not be read out of it.

**The caches were the amplifier.** `rssXmlCache` (`lib/pi.ts`) and `feedCache` (`lib/musicl-resolver.ts`) are keyed by feed-supplied URL and hold whole RSS bodies, and neither evicted — entries past TTL stopped being *served* but were never *deleted*, so distinct URLs pinned one body each for the life of the instance. Both now expire first and evict oldest-first at a ceiling, with **delete-then-set** so a refreshed entry moves to the back of the queue; re-setting an existing key keeps its original insertion position, which would put the eviction order exactly backwards.

**Fan-out caps belong on any list that came from a feed** — `lib/musicl-resolver.ts`'s publisher walk and `lib/pi.ts`'s `resolveValueTimeSplits` both lacked one. The splits cap bounds the **work**, never the array: callers read that list positionally and `splitAtPosition` walks it to decide which window covers a second, so slicing the result would move which artist a boost pays. Entries past the cap pass through unresolved instead.

**And a cap on the ITEM COUNT is not a cap on the FAN-OUT. Both of those walks shipped believing it was, and they NEST.** Capping the list decides how many entries are resolved; `Promise.all` still starts every one of them at once. `resolveValueTimeSplits` resolves up to 200 splits and each one can reach `resolveRemoteItemFromRss`, which searched up to 100 album feeds — so a single `/api/value-splits` request could open **200 × 100 concurrent `safeFetch` calls**, each admitting the 8 MB `readCappedText` ceiling. The comment at both sites said "CAP THE FAN-OUT"; both capped the list. `mapLimit` is the missing half, at `PI_FANOUT` (6) where the upstream being protected is Podcast Index, and at `FEED_FANOUT` (8) where the cost is our own memory. **The two constants answer different questions and should not be merged** — one is a courtesy to somebody else's rate limiter, the other is a bound on our own heap, and the second is deliberately looser because that walk is latency-visible: it decides which artist a boost pays, with the modal's send button disabled until it answers.

`/api/publisher` carried the same hole twice, and the two halves fail differently. Its PI half fired up to 99 concurrent `getPodcastByFeedUrl` calls with a `.catch(() => null)` on each — PI rate-limits the burst, and a swallowed 429 then reads as "PI does not hold this feed", so real children vanish from the page. That is exactly the failure `probeThenBatch` was written against. Its RSS half is a memory lever instead: every child PI missed gets an 8 MB allowance, so an unbounded pass put **~800 MB of feed text in flight from one request**. The bounded-cache ceiling limits what is *retained* and says nothing about the peak while they are all in hand. It stays hand-rolled rather than calling `probeThenBatch` for one reason worth keeping: that helper swallows a probe throw and returns, and this route needs the throw so its 429/408 branch can set `couldNotAskPi`.

### Request body caps (`readCappedRequestText` in `lib/api-handler.ts`)

**Everything above is about bodies we READ from upstream. Nothing capped the bodies callers send US.** Four routes used `await req.json()` or `await req.text()`, which buffer the whole thing and measure after — the precise behaviour `readCappedText` exists to prevent, pointed the other way. The App Router applies no limit of its own: `bodyParser.sizeLimit` is a Pages-API setting and does nothing here. On Vercel the platform refuses a body over 4.5 MB, so the practical ceiling there is 4.5 MB per request; under a self-hosted `next start`, which this repo supports, there was none at all.

`/api/lightning/boostbox` showed the shape most clearly: it read the body in full and *then* refused it over 10 KB, twelve lines above its own correct note that measuring a string you have already allocated is not a cap. `/api/nostr/site-sign` is the sharpest target — unauthenticated, 30 requests per minute per IP.

`readCappedText` now accepts a `Request` as well as a `Response` (`CappableBody` is the three members the loop actually touches), so there is **one capping loop for both directions** rather than a second copy of it. `readCappedRequestText` wraps it and returns **`null` rather than throwing**, so each route answers with its own literal 400 — the deliberate-message path `withErrorHandling` never sees. A stream that errors mid-read is also `null`: either way the honest answer is that the body was not usable.

### Feed-supplied URLs rendered as `href`

**`safeUrlAttr` guards show-notes HTML. It does not guard a URL a component passes to `href={...}` directly, and three of those had no guard at all.** React does **not** block a `javascript:` href — it only warns in dev — and this origin's `localStorage` holds the NWC spending credential and the nsec. So a feed that writes `<podcast:funding url="javascript:…">` got a live script link under the SUPPORT button, and one press ran the feed author's code against the user's wallet.

Three sources, all third-party, all fixed at the **parse boundary** rather than at the render site, so a fourth surface inherits the guard instead of re-deciding it:

- **`<podcast:funding url>`** — `parseFunding` took the raw attribute, and `fundingFromPi` took PI's mirror of it. Podcast Index carries the feed author's string verbatim; it is not a filter. Two render sites (`episode-detail-view.tsx`, `lists/episode-list.tsx`).
- **A chapters JSON `url`** — attacker-chosen bytes at a URL the feed names, rendered as the ↗ control in `<EpisodeContents>`. Its sibling `img` deliberately stays unfiltered: it is only ever an `<img src>`, where no scheme executes, and narrowing it would drop the `data:` covers some feeds legitimately inline.
- **BoostBox's `url`** — a third-party service response that is also **persisted into `StoredBoost.legs`**, so an unchecked value outlives the request and sits in the user's own boost history until that entry is evicted.

The allowlist is `httpUrl` (`lib/util.ts`), which is what `parseLiveValue` already used for the same reason on the live-value socket URI. It fails closed: an unparseable or non-http(s) value drops the entry, which renders no control rather than a dead one. **Any new surface that renders a feed-supplied or third-party URL as an `href` inherits this**, and note that `extractImages`' `LINK_RE` is already `https?://`-anchored, which is why note bodies were never exposed.

### Error messages (`lib/api-handler.ts`)

**`withErrorHandling` returns the `fallback`, never the exception's message.** That is the *unhandled* path, so by definition nobody decided what an anonymous caller should learn from it, and the messages that reached there said more than they looked like: `PiHttpError` is `PI <status>: <body>` (Podcast Index raw body, reflected out of our 500), and `assertSafeFetchUrl` names the host it rejected while "fetch failed" (refused) reads differently from "aborted due to timeout" (open but hanging) — a pair that turns the SSRF guard into an oracle for mapping internal addresses. Detail goes to the server log. Routes own deliberate messages are unaffected: they are 400/502 `return`s that never reach this catch.

### The site-signing oracle (`app/api/nostr/site-sign`)

The `⚡ Boost ⚡` content prefix constrains **ten characters**. It was commented as stopping the oracle signing arbitrary free-text as the site NIP-05-verified identity; it does not, and **it cannot** — a boost note legitimately carries the user typed message, so arbitrary text is the feature.

What *is* bounded is the amplifier. Tags are **allowlisted** to the exact vocabulary `buildBoostNoteTemplate` emits (`i`, `k`, `r`, `p`, `amount`, `client`, `t`), which is provably non-regressive because that vocabulary is enumerable, and `p` tags are capped at 8. The allowlist closes the vector actually worth attacking: an `e` tag. A boost note never has one, and with one a signed event from the site key appears to **reply** to any note in the world. **If `buildBoostNoteTemplate` gains a tag, add it here in the same change** or site-signed notes start failing.

**`safeFetch` is not the only way this server makes an outbound request, and the exception was the framework's.** `next.config.mjs` carried `images.remotePatterns: [{ protocol: 'https', hostname: '**' }]`, which makes `/_next/image?url=…` an open image proxy: any caller could have this server fetch an arbitrary https URL, optimize it, and serve it back from our own domain and CDN. That is a server-side fetch to an attacker-chosen host that never touches `assertSafeFetchUrl` or the redirect re-validation above — the guard's whole point — and it also fed attacker-chosen bytes into `sharp`/libvips, which carries unpatched high-severity CVEs (transitive under `next`, so patching means bumping Next, which `CLAUDE.md` warns has previously dragged a `nostr-tools` upgrade that breaks `nostrconnect://` login).

The wildcard had **no consumers**: the app contains exactly one `<Image>`, `src="/hero.jpg"` in `app/layout.tsx`, and local files under `/public` need no `remotePatterns`. Every *remote* image here — podcast artwork, avatars, live-block covers — renders through a bare `<img>` precisely because the host is arbitrary. Removing it returns 400 `"url" parameter is not allowed` for any external host while the hero still optimizes.

**If a remote host ever genuinely needs optimizing, add that one hostname. Never restore the `**` wildcard** — and note the general lesson: when auditing outbound requests, grep the framework config, not just `fetch(`.


### Response headers and CSP (`next.config.mjs`)

`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, and a deliberately partial CSP: `base-uri 'self'; object-src 'none'; frame-ancestors 'none'`.

**The missing `script-src` is a decision, not an omission** — the reasoning is inline in the config and worth not re-litigating: the FOUC blocker in `app/layout.tsx` is an inline `<script>` that must run before first paint (so `script-src` needs nonce plumbing through the App Router, and `'unsafe-inline'` would defeat the point), and `connect-src` cannot be constrained because the app connects to arbitrary user-supplied relays, arbitrary feed/chapter/transcript hosts, and arbitrary LNURL servers by design. With no `connect-src` allowlist, injected script can still exfiltrate — so a `script-src` alone would read as more protection than it delivers. Clipboard is intentionally left at the default `self` allowlist: the Amber signer reads it and Share writes it, both same-origin.

This matters more than it used to: since Google onboarding shipped, this origin can hold a **signing key** (`lib/nostr/local-key-store.ts`) alongside the NWC spending credential.


### Show notes (`sanitizeShowNotes` in `lib/pi.ts`)

→ `Episode.contentEncoded`, rendered via `dangerouslySetInnerHTML`. Three real-world quirks. The first two are safe because the allowlist pass runs after them; the two linkify passes run *after* the allowlist, so **anything they emit has no allowlist pass behind it**. `linkifyNostrRefs` is safe because bech32 is `[0-9a-z]` only, so its href and label need no escaping. `linkifyBareUrls` emits a **feed-derived** URL, so it is the case that warning is about: its href goes through the same `safeUrlAttr` → `escapeHtmlAttr` pair the tag pass uses, and its label is the matched text verbatim (it came out of the sanitized stream, so it is already correctly encoded for a text context, and the match regex excludes `<`).

- **Source:** prefer `<content:encoded>`; **fall back to the item `<description>`** when absent (some feeds, including Podcasting 2.0's own, put the full HTML there). PI's `description` is the same field but truncated ~3000 chars mid-word and tag-stripped, so the RSS version is strictly better.
- **Escaped markup:** some feeds HTML-escape their emphasis (`&lt;b&gt;`) or their whole notes, which would render as literal tag text. `looksEscapedHtml` detects fully-escaped notes and decodes; a smaller pass un-escapes stray inline emphasis (`b/i/em/strong/u/s/br`).
- **npub links:** `linkifyNostrRefs` wraps bare/`nostr:`-prefixed identifiers in `https://njump.me/<bech32>` links. Person refs also get `data-npub` so the client can attach a follow button.
- **Bare URLs:** feeds routinely end their notes with a plain-text "Links:" block, which rendered as text a phone user could only select and paste. `linkifyBareUrls` wraps them. **Order matters: bare URLs run BEFORE nostr refs** — a plain-text `https://njump.me/npub1…` becomes one anchor and the nostr pass then skips it, where the other order wraps the npub in the *middle* of a text URL and mangles both.
- **Both passes go through `mapNotesText`, which skips `<a>…</a>` blocks AND tags.** Skipping anchors stops a feed's own link being double-wrapped. Skipping tags is the half `linkifyNostrRefs` was missing: it split on anchor blocks only, so a match inside an attribute — an npub or a URL sitting in an `<img src>` that no anchor wrapped — would have spliced an `<a>` into the middle of the tag.
- **The client half is `<LinkedText>` (`components/linked-text.tsx`), and the split rule is SHARED (`splitOnBareUrls` in `lib/util.ts`).** Two surfaces render a `stripHtml`'d plain `description` instead of this HTML — the fullscreen player's About pane and the episode page's no-`contentEncoded` fallback — so a second copy of "what counts as a URL" means the same link is clickable on one screen and dead text on the other. `<LinkedText>` renders React elements, never `dangerouslySetInnerHTML`, and still runs each href through `httpUrl` because **React does not block a `javascript:` href** — it only warns in dev.

**`href`/`src` go through `safeUrlAttr` (`lib/safe-url-attr.ts`) — a scheme ALLOWLIST, and it must stay one.** This is the app's highest-consequence sanitizer: notes come from arbitrary feeds, render via `dangerouslySetInnerHTML`, and this origin's `localStorage` holds `bmb:nwc_uri` (a budgeted spending credential) and the bunker `clientSk`. Script execution here is theft, not defacement.

**The direction is the whole point.** It shipped as a **denylist** (`/^\s*(javascript|data|vbscript):/i`) tested against the *raw* attribute, then re-emitted verbatim — and six vectors reached the DOM as live `javascript:`, each needing only a click, because a browser does two things to an `href` that a regex over source text cannot see: **entities decode during parsing** (`java&#115;cript:`) and **URL parsing discards tab/CR/LF anywhere in the string, including inside the scheme** (`java<TAB>script:`). `safeUrlAttr` instead resolves what the browser will actually see and requires the result to *match* http/https (plus protocol-relative, and `mailto:` for links). An allowlist **fails closed** — obfuscation the decoder doesn't understand leaves a string that simply isn't `https://…` — while a denylist fails open. Don't "improve" it by enumerating more bad schemes; that's an arms race against every entity form and browser quirk.

Two supporting details: the **validated string is the emitted one**, so no second decode pass can reintroduce a scheme; and it's written back through `escapeHtmlAttr`, which escapes `&` as well as `"`/`<`/`>` — necessary *because* we emit decoded values, or a legitimate `?a=1&amp;b=2` would double-decode. The tag pass strips every other attribute, so these two are the entire URL surface.

It lives in its own module with no static imports so `npm run check:sanitizer` exercises production code, not a copy; all six original bypasses are frozen there, and the script's BENIGN half guards the opposite failure, an allowlist so strict it eats ordinary links. Deliberately **not DOMPurify** — this runs server-side inside `lib/pi.ts`, so it would mean jsdom, a very large tree for a repo that ships 15 dependencies.



### Known advisories, and why they are deferred

`npm audit` reports **4 high** (6 counting duplicates), all inside `next` and its dependencies. **`next@15.5.23` is already the newest release on the 15.x backport line** — the fixes exist only in Next 16, so "run `npm audit fix`" does not resolve them; a major upgrade does. That is its own branch, not a line in a hardening pass, and `CLAUDE.md` warns that bumping Next has previously dragged in a `nostr-tools` upgrade that breaks `nostrconnect://` login.

Reachability, which is what actually matters here:

- **`sharp` / libvips (4 CVEs) — unreachable.** `next.config.mjs` has no `images` block, so `/_next/image` accepts no external host and the only bytes that decoder ever sees are the local `public/hero.jpg`. This is the payoff from removing the `remotePatterns` wildcard, and it is the reason not to restore it.
- **`postcss` — build-time only.** The advisories are `sourceMappingURL`-driven arbitrary `.map` reads while processing CSS. This repo's CSS is its own; no untrusted stylesheet is ever compiled.
- **`GHSA-68g3-v927-f742` (cache confusion of response bodies for requests with bodies) — worth a second look on the Next 16 branch.** These routes set `s-maxage` on 200s, so a caching bug in the framework is the one advisory here with a plausible path to our behaviour. The one route taking a body (`/api/lightning/boostbox`) is `POST` and uncached.
- **`GHSA-p9j2-gv94-2wf4` (SSRF in rewrites via attacker-controlled destination hostname)** — `vercel.json` has exactly one rewrite, to a hardcoded host, with the user-supplied segment only in the path.

Re-check this list when the Next 16 branch lands; do not let it rot into a reason to ignore `npm audit`.

### A secret key must be refused at the input, not by a parser returning `null`

`components/search-bar.tsx` invites a key. Its placeholder used to read "search
podcasts…" and then read "search podcasts, or paste an npub…" — before that
change, nobody had a reason to paste key material into it. That is the setup.

**The content-type selector did not make this smaller, and reading it that way
is the trap.** `ALL`'s placeholder no longer mentions a key, because only the
NPUB mode looks one up now — but NPUB's placeholder asks for one outright
("paste an npub, nprofile or hex pubkey…"), so the box still invites exactly the
paste this guard exists for, and now does so in the most direct words it has
ever used. `looksLikeSecretKey` therefore runs in **all five modes**,
unconditionally, before the fetch. It is not downstream of `parseNpubInput` and
must never become so: the parse is now scoped to one mode, and a refusal that
inherited that scope would send an `nsec` typed under `PODCASTS` straight to
Podcast Index.

The trap is that `parseNpubInput` **does** reject an `nsec`: `nip19.decode`
returns type `nsec`, which isn't `npub` or `nprofile`, so the function returns
`null`. But `null` is the same answer it gives for "bowl after bowl", and the
call site read:

```ts
if (!q.trim() || npubHit) { onResults([], ''); return; }   // ← nsec falls through
const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
```

So a rejected secret key went to `/api/search`, into this origin's server logs,
and on to Podcast Index — a third party — in a URL. Silently. Confirmed by
reading `app/api/search/route.ts`, which passes the query to `searchPodcasts`.

**A key that has been sent to a third party is burnt.** There is no un-sending
it, no rotation for a Nostr identity that already has a follow graph and a
signed history, and no log to check. The failure is also self-repeating: with no
message on screen, the user assumes the box is broken and pastes again.

`looksLikeSecretKey` (`lib/nostr/npub-input.ts`) is the guard, and its shape is
deliberate:

- **A prefix test, not a decode.** `nsec1` / `ncryptsec1`, lowercased, after a
  `nostr:` strip. A truncated or half-typed `nsec1qq…` is still key material and
  must not be sent anywhere either, and a decode-based test would let exactly
  those through. It also means the function never holds the key it protects.
- **Checked before the fetch**, in the same expression that already suppresses
  the search for a valid npub.
- **Rendered as a refusal**, never a silent drop, for the reason above — the same
  "a guard that withholds must say so" rule the favorites notice exists for.

Verified by driving a real browser over CDP and recording every request the page
issued while an `nsec` sat in the box: **zero requests carrying the key, zero
calls to `/api/search`**, warning shown, suggestion row absent.

The general rule, which is in `CLAUDE.md` because it reaches files this doc
doesn't name: **a parser's `null` is a "no" about parsing, not a decision about
safety.** Any input accepting a Nostr identifier — npub, nprofile, hex pubkey —
needs the explicit secret-key refusal before whatever the miss falls through to.
