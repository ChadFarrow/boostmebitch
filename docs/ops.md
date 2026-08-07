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


