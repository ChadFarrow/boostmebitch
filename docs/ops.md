# Ops — Google OAuth verification, DNS, deploys

Read before touching the Google Cloud console, DNS records, or OAuth consent-screen config.

Core rules live in [`../CLAUDE.md`](../CLAUDE.md); this file holds the reasoning.

## Google OAuth verification surfaces

**Verification is complete** (2026-07-29): brand verification approved, branding published, Audience set to *In production*. The consent screen shows `BoostMeBitch` + logo, any Google account can authorize, and there is nothing left to submit. The 7-day deadline in Google's docs applied only to clicking *Publish branding* after approval — done, and it doesn't recur.

**Whether the button renders is a separate switch: `NEXT_PUBLIC_GOOGLE_CLIENT_ID` in the Vercel Production environment.** The entry point is gated on `isGoogleAuthConfigured()`, so with that variable unset nothing about Google sign-in is user-visible. Check the Vercel env var before concluding the feature is reachable in production.

**Two bits of UI exist for verification, not for their own sake — don't tidy either away:**

- **`app/privacy/page.tsx`**, linked from the **layout footer**. Google requires the policy to be on the homepage's domain, linked *from* the homepage, at the identical URL entered on the consent screen — the footer lives in the layout precisely so it's on the homepage. Several claims ("we never receive your name or email", "we cannot decrypt your backup") are only true because of specific implementation choices; change those and the page must change. It carries the required Limited Use statement.
- **The homepage description paragraph** in `components/home-page.tsx`. Google requires the home page to describe the app's functionality and the purpose of the data it requests; a three-word headline carries neither. Gated on the browse view (`!inDetailView && !inEpisodeDetail && !inDiscussion`), deliberately **not** on `showLeftRightLayout` — that flips on stored favorites, and a compliance-critical string must not vanish based on localStorage.

**Console facts worth not re-deriving:**

- **Both scopes are non-sensitive** (`openid` + `drive.appdata`), so brand verification was the only review — no demo video, no scope justification, no annual CASA assessment. The restricted Drive scopes are `drive`, `drive.readonly`, `drive.metadata`, `drive.activity`, `drive.scripts`; the only sensitive one is `drive.apps.readonly`. **Adding a sensitive or restricted scope later moves the app onto the heavy path** — check a scope's classification on the Data Access page *before* building against it, and register every scope you request there (the GIS token client requests them at runtime, so the console can't discover them; `openid` is absent from the picker because it's OIDC, which is normal).
- **The apex 307-redirects to `www`**, so `https://www.boostmebitch.com` is the origin GIS sees and the `www` form is in the console's App-domain fields. Authorized JavaScript origins: `https://www.boostmebitch.com`, `https://boostmebitch.com`, `http://localhost`, `http://localhost:3000`. No redirect URIs — the token client is origin-scoped.
- **`*.vercel.app` can't be an authorized domain** (you can't Search-Console-verify a domain Vercel owns), so **Google sign-in does not work on preview deployments.** Test on localhost or production.
- **DNS is at Namecheap, not Vercel** — nameservers `dns1/dns2.registrar-servers.com`, apex A record and `www` CNAME pointing at Vercel. `boostmebitch.com` is verified as a Search Console **domain property** via a TXT record at host `@`, alongside Namecheap's pre-existing email-forwarding SPF record. **Never delete that record or fold it into the SPF one** — it un-verifies the domain and invalidates the brand approval.
- **Editing branding re-opens the review.** App name, logo (`public/icons/icon-120.png` — 120×120 is what Google wants; deliberately not in `manifest.json`, since no browser asks for that size), home page URL and privacy policy URL are verified as a set.

## Sharing the login with other apps (decision not yet taken)

The goal is a user onboarding on boostmebitch and restoring the same npub and Spark wallet on **onlyboosts** (ours) and **stablekraft.app** (not ours). The crypto side is done — [`google-key-backup-spec.md`](google-key-backup-spec.md) is implementable by anyone. What's left is entirely a console and trust decision, recorded here so it isn't re-derived:

- **`appDataFolder` is scoped to the OAuth client, and the isolation is absolute.** Google creates it per third-party app, only that app can read its contents, and they cannot be shared — no scope, permission, or console setting changes this. **Two Cloud projects can never see each other's blobs however identical their crypto is.** So the *only* mechanism is one OAuth client with every app's origin under its Authorized JavaScript origins.
- **Everyone in that client is in one mutual-trust set.** Each participating app can list, read and **delete** every blob. It can't decrypt one without that PIN, but it can destroy it, and it can harvest ciphertext for an offline search against a 6-digit PIN. That's the real cost of adding a third party, not the branding.
- **The consent screen shows one brand for all of them.** StableKraft's users would see `BoostMeBitch` unless the client moves to a neutrally-branded project — which is a fresh brand verification (privacy policy + homepage description on *that* domain), and re-branding the existing project re-opens review per the rule above. Either way we remain the accountable party under Limited Use for their traffic.
- **`onlyboosts.local` can never be an authorized origin.** Google accepts `https://` origins and `http://localhost` (with or without port) only; a private TLD is rejected outright. Local dev has to run on `http://localhost:<port>` — already registered, see the origins list above — and production needs a real https domain that's Search-Console-verifiable, which also rules out `*.vercel.app` previews for the same reason it already does for us.
- **Nothing in the app blocks this today.** `listBackups` filters to the `bmb_bk_` prefix precisely so a shared folder holding another app's files doesn't read as "this Google account already has an identity" and lock a new user out of account creation.


