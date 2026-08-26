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
