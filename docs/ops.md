# Ops — Google OAuth verification, DNS, deploys

Read before touching the Google Cloud console, DNS records, or OAuth consent-screen config.

Core rules live in [`../CLAUDE.md`](../CLAUDE.md); this file holds the reasoning.

## Google OAuth verification surfaces

**Verification is complete** (2026-07-29): brand verification approved, branding published, Audience set to *In production*. The consent screen shows `BoostMeBitch` + logo, any Google account can authorize, and there is nothing left to submit. The 7-day deadline in Google's docs applied only to clicking *Publish branding* after approval — done, and it doesn't recur.

**Whether the button renders is a separate switch: `NEXT_PUBLIC_GOOGLE_CLIENT_ID` in the Vercel Production environment.** The entry point is gated on `isGoogleAuthConfigured()`, so with that variable unset nothing about Google sign-in is user-visible. Check the Vercel env var before concluding the feature is reachable in production.

**Two bits of UI exist for verification, not for their own sake — don't tidy either away:**

- **`app/privacy/page.tsx`**, linked from the **layout footer**. Google requires the policy to be on the homepage's domain, linked *from* the homepage, at the identical URL entered on the consent screen — the footer lives in the layout precisely so it's on the homepage. Several claims ("we never receive your name or email", "we cannot decrypt your backup") are only true because of specific implementation choices; change those and the page must change. It carries the required Limited Use statement.
- **The homepage description paragraph** in `components/home-page.tsx`. Google requires the home page to describe the app's functionality and the purpose of the data it requests; a three-word headline carries neither. Gated on the browse view (`!inDetailView && !inEpisodeDetail && !inDiscussion`), deliberately **not** on `showLeftRightLayout` — that flips on stored favorites, and a compliance-critical string must not vanish based on localStorage.
  - **It now carries only the FUNCTIONALITY half.** The sentence naming the optional Google sign-in, the Nostr identity it mints, the encrypted Drive backup and "we never see the key or your PIN" was **removed on request, 2026-08-20**. That sentence was the *purpose for which your app requests user data* half, and the app still requests the Drive scope, so the home page no longer satisfies that requirement on its own. `app/privacy/page.tsx` still carries the full disclosure — that meets the separate privacy-policy-URL requirement above and is **not** a substitute for the home-page one. **Restore it before any re-submission or scope change**, either of which re-opens the review.

**Console facts worth not re-deriving:**

- **Both scopes are non-sensitive** (`openid` + `drive.appdata`), so brand verification was the only review — no demo video, no scope justification, no annual CASA assessment. The restricted Drive scopes are `drive`, `drive.readonly`, `drive.metadata`, `drive.activity`, `drive.scripts`; the only sensitive one is `drive.apps.readonly`. **Adding a sensitive or restricted scope later moves the app onto the heavy path** — check a scope's classification on the Data Access page *before* building against it, and register every scope you request there (the GIS token client requests them at runtime, so the console can't discover them; `openid` is absent from the picker because it's OIDC, which is normal).
- **The apex 307-redirects to `www`**, so `https://www.boostmebitch.com` is the origin GIS sees and the `www` form is in the console's App-domain fields. Authorized JavaScript origins: `https://www.boostmebitch.com`, `https://boostmebitch.com`, `http://localhost`, `http://localhost:3000`. No redirect URIs — the token client is origin-scoped.
- **A refused origin and a cancelled popup are the SAME GIS code, so separate them by SHAPE before you touch the console.** Google refuses an origin the OAuth client does not list, and it does so *after* the account chooser: a popup opens, the user taps their account, an error page appears, the window closes. GIS reports `popup_closed` — the identical code it sends when the user simply closes the window, and when the popup dies on a network fault. Nothing on screen tells them apart. **The discriminator is repeatability: a refused origin fails 100% of the time, on every device, for everyone.** Measured on 2026-08-31: a "cancelled" on `boostmebuddy.com` on desktop, with the same account working on mobile minutes later and on the same desktop after that. That is the transport, not the console — and the first read of it in this repo was wrong in exactly that way. Read the `[google]` console line (`lib/nostr/google-auth.ts`), which names the fault type, the origin and the client id the build actually used.
- **Each brand needs its own Google Cloud PROJECT, not another origin on this one.** Google verifies the consent-screen name, logo, home page and privacy policy **per project**, so one client serving both deploys shows **`BoostMeBitch`** to everyone signing in on the family-friendly site. That is the leak `npm run check:brand` exists to stop, one layer below where that script can see. The brand-correct arrangement is one project per brand: its own consent-screen name and logo, its own brand verification against its own domain, its own OAuth client with its own origins, and its own `NEXT_PUBLIC_GOOGLE_CLIENT_ID` in that brand's Vercel project. Until verification lands, that brand's consent screen carries the unverified-app notice and a 100-user cap — a working sign-in, not a broken one. **Leave `NEXT_PUBLIC_GOOGLE_CLIENT_ID` unset on a deploy with no client of its own**: `isGoogleAuthConfigured()` then hides the entry point, which is honest, where a shared client is off-brand.
- **`*.vercel.app` can't be an authorized domain** (you can't Search-Console-verify a domain Vercel owns), so **Google sign-in does not work on preview deployments.** Test on localhost or production.
- **DNS is at Namecheap, not Vercel** — nameservers `dns1/dns2.registrar-servers.com`, apex A record and `www` CNAME pointing at Vercel. `boostmebitch.com` is verified as a Search Console **domain property** via a TXT record at host `@`, alongside Namecheap's pre-existing email-forwarding SPF record. **Never delete that record or fold it into the SPF one** — it un-verifies the domain and invalidates the brand approval.
- **Editing branding re-opens the review.** App name, logo (`public/icons/icon-120.png` — 120×120 is what Google wants; deliberately not in `manifest.json`, since no browser asks for that size), home page URL and privacy policy URL are verified as a set.

## The Nostr read index (Railway)

`services/nostr-index` is a second deployable. It is **not** on Vercel, and
cannot be: its job is to hold WebSocket subscriptions to several relays open
continuously, and a serverless function has no persistent process to do that in.
A cron-driven poller was considered and rejected — staler, noisier against the
relays, and unable to catch up on a burst.

**Everything it stores is a rebuildable cache and relays stay authoritative.**
Dropping the database loses speed and nothing else. Its own README carries the
list of kinds it refuses to index and why; the short version is that kind:10333
favorites, kind:10000 mutes, kind:3 follows and kind:30078 backups are never
stored, because each drives a destructive replaceable-event write on the client
or carries ciphertext.

### Railway setup

One project, two components on the **private** network so the database is never
exposed to the internet:

1. **Postgres** — Railway's managed plugin. Take the *private* connection
   string for `DATABASE_URL`, not the public proxy one.
2. **Service** — root directory `services/nostr-index`, start command
   `npm start`. Migrations run automatically on boot.

Set `INDEX_API_KEY` to a long random secret, and `PODCAST_INDEX_KEY` /
`PODCAST_INDEX_SECRET` to the same values Vercel holds so the warm-fill worker
can populate the shared metadata cache. Everything else has a working default;
see the service README for the full table.

`INDEX_ROLE` splits the API and the indexer into two Railway services later
without a code change. One process (`all`, the default) is the cheapest thing
that works and is the right starting point.

### Vercel side

Two variables, and they are required **together** — one alone leaves the feature
off:

| Variable | Value |
|---|---|
| `NOSTR_INDEX_URL` | the Railway service's public URL |
| `NOSTR_INDEX_KEY` | the same secret as `INDEX_API_KEY` |

Absent either one, `/api/nostr/index` answers 503 and every client path falls
back to relays and to the single-guid Podcast Index routes — which is exactly
how the app behaved before the index existed. **This is the rollback**: unset
`NOSTR_INDEX_URL` and redeploy. There is no migration to undo and no client
state to clean up.

Neither variable may ever be `NEXT_PUBLIC`. The key is server-only, and the
whole reason the app proxies the index through its own route rather than letting
the page call Railway directly is so the browser never holds it. The proxy also
puts Vercel's CDN in front, which matters more than it looks: the global feed is
byte-identical for every visitor, so `s-maxage` means the edge serves it rather
than the Railway box.


### Deploy checklist

The order matters, and each step has a check that proves it worked before the
next one depends on it. The variable tables above and in
[`services/nostr-index/README.md`](../services/nostr-index/README.md) say what
each value *is*; this says when to set it.

**0. Measure first, before anything is provisioned.**

```bash
npm run probe:index
```

Keep the output. It times the relay path stage by stage and counts the corpus.
Without it the whole change is a performance claim with no before number, and
this repo has no test runner to fall back on. It also sizes the database: the
corpus is the network-wide podcast boost stream, which is small — a published
measurement of the same stream puts it near 22,000 notes across ~1,300 shows.

**1. Railway Postgres.** Add the managed plugin. Copy the **private** connection
string, not the public proxy one — the database has no reason to be reachable
from the internet.

**2. Railway service.** Root directory `services/nostr-index`, start command
`npm start`. Nothing else; there is no build step.

> **The root directory is not optional, and getting it wrong is silent.**
> `railway up` archives from the **git repository root**, not the working
> directory — so running it from inside `services/nostr-index` still uploads the
> whole repo. Railpack then finds the repo's own `package.json` first and runs
> `next start`: the Next.js app boots, binds the port, passes the health check,
> and the deployment reports **SUCCESS** while serving the wrong application on
> the index's URL. Nothing anywhere says so. It happened on the first deploy of
> this service and was caught only by reading the runtime log and noticing the
> package name.
>
> Set `rootDirectory` on the service instance before the first deploy, and
> confirm the deploy log names `boostmebitch-nostr-index`, never
> `boostmebitch`. **A green deployment is not evidence the right thing is
> running** — the package name in the log is.

**3. Set the service variables.** `DATABASE_URL` (the private string),
`INDEX_API_KEY` (a long random secret), and `PODCAST_INDEX_KEY` /
`PODCAST_INDEX_SECRET` — the same pair Vercel already holds, so the warm-fill
worker can populate the shared metadata cache.

*Check:* the boot log prints `[migrate] applied 001_init.sql`, then
`[index] api listening`. `GET /health` answers without a key, and every other
route answers **401** without one.

**Read what `/health` returns, not just that it answered.** It used to be a
static `{"ok":true}` that never touched the database, which is how this service
came to sit stalled for hours in August 2026 while reporting itself healthy. It
now carries `indexedThrough`, `secondsBehind`, `relaysConnected` /
`relaysConfigured`, `relaysDown` and `relaysWithoutSubscriptions`. `ok` is false
when no relay is connected, or when a connected relay carries no subscriptions —
the shape of that stall. It is **not** false merely because `secondsBehind` is
large: this corpus is quiet enough that hours can pass between notes.

It answers HTTP 200 either way on purpose, so Railway's health check cannot
restart-loop the container during a relay-side outage while the in-process
watchdog is already recovering. If `ok` is false and stays false, restart it —
but read the log first, because `reportStats` now prints an `idle:` line every
minute naming the connected relay count.

**Checking freshness through the app needs a cache-buster.** `/api/nostr/index`
sets `s-maxage` and Vercel's CDN serves it, so reading `indexedThrough` from
`https://www.boostmebitch.com/api/nostr/index?path=/feed/global` can hand back a
response cached before whatever you just did. On 2026-08-25 that produced three
consecutive readings of "186 minutes behind" from an index that was in fact
0.1 minutes behind — the number even drifted upward between reads, which looks
exactly like a stalled indexer rather than a frozen cache. Add a changing query
parameter, or check `x-vercel-cache` in the response headers, before believing
a freshness number.

**Deploying the service is a separate act from merging.** It is CLI-uploaded,
not repo-connected, so a merged PR touching `services/nostr-index/` changes
nothing until `railway up` runs from that directory. See the note in CLAUDE.md
under the server/client boundary.

**3b. Trim the relay set to what actually answers.** `INDEX_RELAYS` and
`INDEX_PROFILE_RELAYS` default to eight relays, and on 2026-08-25 three of them
served nothing when asked with the indexer's own two filters — not with a
generic `kinds:[1]` query, which is misleading for a specialist relay and will
tell you `purplepag.es` is broken when it is doing its job.

| Relay | podcast-notes | boostagrams | Verdict |
|---|---|---|---|
| `relay.damus.io` | 50 | 50 | keep |
| `relay.fountain.fm` | 50 | 50 | keep — it carries this corpus |
| `nos.lol` | 50 | 50 | keep |
| `relay.primal.net` | 50 | 9 | keep |
| `relay.nostr.band` | 0 | 0 | connects, serves nothing |
| `purplepag.es` | — | kind:0 = 20 | keep (profiles) |
| `nostr.bitcoiner.social` | — | kind:0 = 0 | serves nothing |
| `eden.nostr.land` | — | kind:0 = 0 | times out; the source of every `NOTICE ... closed: timeout` |

The deployed set is therefore four core relays and one profile relay. This is
two environment variables and a redeploy, never a code change — re-measure
before trusting the table, because a relay that is dead today may not be
tomorrow, and the cost of keeping a dead one is a socket and some log noise,
not correctness.

**4. Watch the backfill.** It walks history backwards and logs a cursor per page.
It records progress in `indexer_state`, so a restart resumes rather than
re-walking from the top.

*Check:* `select kind, count(*) from events group by kind` climbs, and
`backfill_done` eventually goes true for both core filters.

**5. Vercel PREVIEW only.** Set `NOSTR_INDEX_URL` and `NOSTR_INDEX_KEY` on a
preview deployment, never production first. Compare the preview against
production side by side — same show, same `/npub` page, same favorites list.

*Check:* the feeds paint in well under a second, and the favorites list is
**identical** to production. A list that differs is a stop, not a rounding
error.

**6. Promote to production**, then re-run the probe with the index:

```bash
npm run probe:index -- --index https://<railway-host> --key <INDEX_API_KEY>
```

That prints the before and after side by side. Put both numbers in the PR.

**7. Prove the rollback, once.** Unset `NOSTR_INDEX_URL` and redeploy. Every
surface must still work — slower, and otherwise unchanged.

This is the most important step and the easiest to skip. It is the difference
between an accelerator and a dependency, and the only moment you find out which
one you built is the moment you need it to be the first.

## The second Vercel project — its environment is its own, and BoostBox proved it

One repo builds two Vercel projects: `boostmebitch` (`prj_70009zf…`) and
`boostmebuddy` (`prj_ds2CBCB…`), both linked to `ChadFarrow/boostmebitch` on
`main`. A push deploys **both** with the same code. **Nothing else is shared:
each project holds its own environment variables**, and a variable set on one
project is simply absent on the other, with no error at build time and none at
request time either — the code falls back, exactly as it is written to.

**The reported instance: "boostmebuddy isn't sending TLV info."** Same commit
on both projects. Runtime logs, same week:

| Project | `POST /api/lightning/boostbox` |
|---|---|
| `boostmebitch` | 200, every call |
| `boostmebuddy` | `401 {"error":"unauthorized"}` from the upstream, every call, five of five in the retained log window (one day on this Vercel plan) |

That route is the whole metadata channel for an **LNURL** leg (a keysend leg
carries the boostagram inline in TLV `7629169` and never touches it; see
[`money-boosts.md`](money-boosts.md)). A 401 there is non-fatal by design —
`storeBoostMetadata` returns `null`, the leg pays, the modal shows ✓ — so every
LNURL leg from the buddy deploy paid fine and carried **no `rss::payment`
descriptor**: no `sender_id`, no `remote_feed_guid`, no episode. On the
receiving side that is indistinguishable from an app that sends no metadata at
all, which is how it was reported.

The cause is not in the diff. The route reads `BOOSTBOX_URL` and
`BOOSTBOX_API_KEY` and falls back to `https://tardbox.com` and `v4v4me`, and
`tardbox.com` is the fork that **runs its own key** (`.env.example` says so).
The `boostmebitch` project carries the real key; the `boostmebuddy` project was
created later and either never had it set or holds a different value. Either
way, the fix is in the Vercel dashboard, not here:

1. Copy `BOOSTBOX_URL` and `BOOSTBOX_API_KEY` from the `boostmebitch` project's
   Production environment onto the `boostmebuddy` project, both environments.
2. Redeploy `boostmebuddy` — a variable change does not redeploy on its own.
3. Boost one LNURL recipient from boostmebuddy.com and read the runtime log:
   the line must be `POST /api/lightning/boostbox 200`, and the browser console
   must print `[lnurl] <addr> → comment (desc "rss::payment::boost …")` rather
   than `NO DESCRIPTOR`.

**Why it stayed invisible.** The client-side warning exists
(`[boostbox] <addr> — metadata NOT stored … proxy returned 401`), but it is a
console line on the sender's device, and the sender's own `<BoostCard>` still
renders a BoostBox link from a URL that was never stored. The server log is the
only place the word `unauthorized` appears. **When the two deploys behave
differently on identical code, read the buddy project's runtime log for
`[boostbox] upstream` before opening a file** — the code cannot see its own
environment, and neither can a diff.

**The same trap applies to every server-only variable in `.env.example`**, and
the list is not short: `PODCAST_INDEX_KEY`/`SECRET`, `SITE_NOSTR_SK` (a
*different* key per deploy, see `lib/brand.ts`), `NOSTR_INDEX_URL`/`KEY`,
`PLAYLIST_DB_URL`/`CA`, and `NEXT_PUBLIC_BRAND=buddy` itself. A variable added
for a feature is set on the project the person is looking at; the other project
gets it when someone notices the feature is missing there. Treat "set the
variable" as a two-project step, and `.env.example`'s warning about the
**copied** `ANDROID_*` pair as the one exception where copying is the bug.

## Dependency advisories — which ones are actually reachable

`npm audit` is noisy here because Next bundles its own copies of things, so the
useful question is never the count. It is *which decoder or parser does an
attacker's bytes actually reach.* Two answers this repo has already had to work
out, both easy to get backwards:

**`sharp` IS reachable and must be kept current.** `app/api/art/route.ts` fetches
a feed-supplied URL and hands the body to sharp on every cover it resizes — the
busiest route in the app. The comment in `next.config.mjs` explaining why
`images.remotePatterns` is empty says the `/_next/image` pipeline only ever
decodes `public/hero.jpg`; that is true **of that pipeline** and is not a
statement about sharp overall. Read as one, it is a licence to sit on a libvips
advisory while the art route feeds the same library arbitrary bytes all day.
sharp was pinned at `^0.34.5` against four high-severity libvips CVEs for
exactly that reason. The route's own guards (`safeFetch`, the 12 MB cap,
`limitInputPixels`, `artTypeVerdict`) bound *what* reaches the decoder; they do
not patch the decoder.

**Verify a sharp major before believing it.** 0.34 → 0.35 is a major bump, and
what matters is not the changelog but whether the exact pipeline still runs:
`sharp(bytes, { animated: false, limitInputPixels })` → `.resize(w, w, { fit:
'cover', position: 'centre', withoutEnlargement: true })` → `.webp({ quality:
78, effort: 4 })` → `.toBuffer()`, across every allowed width, plus the two
failure directions that are *supposed* to throw (an over-`limitInputPixels`
input, and bytes that are not an image). A blank cover on twelve surfaces is
what a silent regression here looks like, and `npm run check:art` will not see
it — that script pins `artWidth`/`artCandidates`/`artTypeVerdict`, which are
pure functions that never touch sharp.

**The residual advisory is `postcss` inside `node_modules/next/node_modules`.**
It is Next's own bundled copy and only `next@16` — a breaking major — moves it.
The top-level `postcss` this repo controls is current. The advisories are
build-time source-map and stringifier issues against the CSS being compiled,
which here is our own `app/globals.css` and Tailwind's output, not anything a
feed or a visitor supplies. Left in place deliberately; revisit with the Next 16
upgrade rather than forcing it.
