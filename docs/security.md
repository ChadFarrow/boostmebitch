# Security — SSRF guard and show-notes sanitizer

Read before touching `lib/safe-fetch.ts`, `lib/safe-url-attr.ts`, `sanitizeShowNotes` in `lib/pi.ts`, `app/api/transcript`, or `app/api/nostr/site-sign`.

Core rules live in [`../CLAUDE.md`](../CLAUDE.md); this file holds the reasoning.

### SSRF guard (`lib/safe-fetch.ts`)

Every server-side fetch of a feed/chapter/transcript URL goes through **`safeFetch(url, init)`**, never a bare `fetch`. It runs `assertSafeFetchUrl` (hostname-level block of localhost/`.local`/`.internal` plus RFC-1918/loopback/link-local/CGNAT/multicast/reserved IPv4 and IPv6 literals; **no DNS-rebinding protection**) and then **follows redirects manually, re-validating every hop** — a guard that only checks the initial URL lets a public host 302 to `http://169.254.169.254/…`.

- **The trailing dot is stripped before any comparison.** DNS treats `metadata.google.internal.` as identical to `metadata.google.internal`, but `.endsWith('.internal')` is **false** for it — one extra character walks past every hostname check, including the cloud-metadata one. Same for `localhost.` and `nas.local.`. Don't "simplify" the `.replace(/\.+$/, '')`.
- **Decimal/octal/hex host forms are already safe** — the WHATWG URL parser normalizes `http://2130706433/` to `127.0.0.1` before the regexes see it. Test before adding rules for them.
- **100.64.0.0/10 is blocked on purpose** — RFC 6598 CGNAT *and* the Tailscale range. Without it, a self-hoster running this beside a tailnet exposes every node through the feed/chapter proxies.
- Pinned by `npm run check:ssrf`. Its **ALLOWED half is as load-bearing as the BLOCKED half** — it holds boundary addresses just outside each blocked range (`100.63.255.255`, `172.32.0.1`, `223.255.255.255`) so a bypass fix can't start rejecting real podcast hosts.

**Rate-limit key:** `rateLimit` buckets on the platform-trusted `x-real-ip` / **rightmost** `x-forwarded-for` hop, never the spoofable leftmost entry.


### Show notes (`sanitizeShowNotes` in `lib/pi.ts`)

→ `Episode.contentEncoded`, rendered via `dangerouslySetInnerHTML`. Three real-world quirks. The first two are safe because the allowlist pass runs after them; `linkifyNostrRefs` runs *after* the allowlist and is safe for a different reason — bech32 is `[0-9a-z]` only, so the href and label it emits need no escaping. **Anything added there that emits a feed-derived URL has no allowlist pass behind it.**

- **Source:** prefer `<content:encoded>`; **fall back to the item `<description>`** when absent (some feeds, including Podcasting 2.0's own, put the full HTML there). PI's `description` is the same field but truncated ~3000 chars mid-word and tag-stripped, so the RSS version is strictly better.
- **Escaped markup:** some feeds HTML-escape their emphasis (`&lt;b&gt;`) or their whole notes, which would render as literal tag text. `looksEscapedHtml` detects fully-escaped notes and decodes; a smaller pass un-escapes stray inline emphasis (`b/i/em/strong/u/s/br`).
- **npub links:** `linkifyNostrRefs` wraps bare/`nostr:`-prefixed identifiers in `https://njump.me/<bech32>` links, splitting on existing `<a>` blocks first so it never double-wraps. Person refs also get `data-npub` so the client can attach a follow button.

**`href`/`src` go through `safeUrlAttr` (`lib/safe-url-attr.ts`) — a scheme ALLOWLIST, and it must stay one.** This is the app's highest-consequence sanitizer: notes come from arbitrary feeds, render via `dangerouslySetInnerHTML`, and this origin's `localStorage` holds `bmb:nwc_uri` (a budgeted spending credential) and the bunker `clientSk`. Script execution here is theft, not defacement.

**The direction is the whole point.** It shipped as a **denylist** (`/^\s*(javascript|data|vbscript):/i`) tested against the *raw* attribute, then re-emitted verbatim — and six vectors reached the DOM as live `javascript:`, each needing only a click, because a browser does two things to an `href` that a regex over source text cannot see: **entities decode during parsing** (`java&#115;cript:`) and **URL parsing discards tab/CR/LF anywhere in the string, including inside the scheme** (`java<TAB>script:`). `safeUrlAttr` instead resolves what the browser will actually see and requires the result to *match* http/https (plus protocol-relative, and `mailto:` for links). An allowlist **fails closed** — obfuscation the decoder doesn't understand leaves a string that simply isn't `https://…` — while a denylist fails open. Don't "improve" it by enumerating more bad schemes; that's an arms race against every entity form and browser quirk.

Two supporting details: the **validated string is the emitted one**, so no second decode pass can reintroduce a scheme; and it's written back through `escapeHtmlAttr`, which escapes `&` as well as `"`/`<`/`>` — necessary *because* we emit decoded values, or a legitimate `?a=1&amp;b=2` would double-decode. The tag pass strips every other attribute, so these two are the entire URL surface.

It lives in its own module with no static imports so `npm run check:sanitizer` exercises production code, not a copy; all six original bypasses are frozen there, and the script's BENIGN half guards the opposite failure, an allowlist so strict it eats ordinary links. Deliberately **not DOMPurify** — this runs server-side inside `lib/pi.ts`, so it would mean jsdom, a very large tree for a repo that ships 15 dependencies.


