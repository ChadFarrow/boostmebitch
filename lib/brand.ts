// The brand this deploy wears.
//
// ONE repo, TWO deploys. `boostmebitch.com` and `boostmebuddy.com` are the same
// application built twice, each Vercel project setting `NEXT_PUBLIC_BRAND`. A
// fork would drift, and this repo carries money and privacy invariants that must
// not diverge between two copies — so the difference is a table, not a branch.
//
// WHY THIS MODULE HAS NO IMPORTS AT ALL:
//
// It holds `DEFAULT_SENDER_NAME` and `resolveSenderName`, which used to live in
// `lib/util.ts`. That file must keep only TYPE-ONLY imports, because
// `check:vts` and `check:musicl` load it under `node --experimental-strip-types`
// and Node's resolver needs a real path with an extension — a relative value
// import there is not a style violation, it is an immediate
// `ERR_MODULE_NOT_FOUND` that un-pins every function those scripts reach through
// it. So the brand table could not be imported INTO `lib/util.ts`; the two names
// moved DOWN here instead, into a leaf with no imports of its own. That is the
// same move `mute-state.ts` and `profile-metadata.ts` already made, and it keeps
// this module loadable by `check:brand`. `scripts/import-free.mjs` enforces it.
//
// WHY `process.env.NEXT_PUBLIC_BRAND` IS WRITTEN OUT LITERALLY, ONCE:
//
// Next.js inlines a `NEXT_PUBLIC_*` read by replacing the exact member
// expression at build time. It cannot follow a variable, so every module that
// wanted the value would have to repeat the literal — which is a second source
// of truth per file. It is read here and nowhere else; everything downstream
// imports `BRAND`.

/** Which brand a build wears. Unset means the original site. */
export type BrandId = 'bmb' | 'buddy';

export interface Brand {
  id: BrandId;
  /** Page header wordmark, `<title>`, and every sentence naming the app. */
  displayName: string;
  /**
   * PWA `short_name` — the label under a home-screen icon.
   *
   * NOTHING READS THIS YET, and that is the trap: the value that actually ships
   * is the `short_name` written into `public/manifest.json` and
   * `public/manifest-buddy.json`, which are static files a browser fetches
   * directly. Editing this field alone changes no home-screen label anywhere.
   * It is kept because those two files are the thing that should collapse into
   * an `app/manifest.ts` route reading this table — at which point this becomes
   * the single source it already looks like. Until then, edit BOTH.
   *
   * `description` below has the same shape: it IS read (by `app/layout.tsx`,
   * for the meta and OG tags) but the manifests carry their own copy too.
   */
  shortName: string;
  /**
   * The name that goes on the WIRE: the boostagram TLV `app_name` and the
   * `client` tag on every published note. CamelCase with no spaces, matching the
   * Helipad-aggregator convention Fountain and StableKraft follow.
   *
   * Recipients read this. It is how an artist's aggregator says which site paid
   * them, so the two deploys identify themselves separately on purpose.
   */
  wireName: string;
  /** Bare domain, as a NIP-05 renders it and as the OG banner falls back to. */
  domain: string;
  /**
   * Canonical origin, and it must be the `www` form: the apex 307-redirects to
   * it, and this is what `app/layout.tsx`'s `metadataBase` and the boost note's
   * deep link and banner URL are built from. See `lib/nostr/boost-notes.ts` for
   * why a note's banner URL can never be changed after the fact.
   */
  origin: string;
  /**
   * The npub of this deploy's OWN Nostr identity — the public half of its
   * `SITE_NOSTR_SK`, the key that signs a boost note when the user is signed
   * out or has chosen Anonymous.
   *
   * IT IS HERE TO BE CHECKED AGAINST, NOT TO BE READ. Nothing in the app
   * imports it, and nothing should: the running app derives its pubkey from
   * the secret (`lib/nostr/site-key.ts`), so at runtime the two cannot
   * disagree. What this pins is the pairing of a KEY with a BRAND — and that
   * pairing lives in an env file, which makes it the one part a person sets by
   * hand and therefore the one part that goes wrong.
   *
   * `scripts/publish-site-profile.mjs` is the only tool that writes the site's
   * kind:0. It reads the brand and the key from the SAME env file and refuses
   * when the key it loaded does not derive this npub. Without the check, a
   * `.env.buddy.local` missing its `NEXT_PUBLIC_BRAND` line publishes the
   * ORIGINAL brand's name, about, avatar and nip05 under the BUDDY identity —
   * every field the second brand exists to keep apart, live on the relays under
   * the family-friendly site's own npub. The reverse pairing is worse: it
   * overwrites the real site's profile with the other one's.
   *
   * Committing it discloses nothing. `/.well-known/nostr.json` already serves
   * this pubkey to anyone who asks — that route is what a NIP-05 badge reads.
   */
  siteNpub: string;
  /**
   * Substituted for the sender's name on an anonymous boost, and used whenever
   * "From" is left empty. See {@link DEFAULT_SENDER_NAME}.
   */
  senderName: string;
  /** The celebration ping. Served from `public/`; a missing file is silent. */
  boostSound: string;
  /** Which static web manifest `metadata.manifest` points at. */
  manifest: string;
  /** `User-Agent` fallback for the server-side Podcast Index calls. */
  userAgent: string;
  /** `<meta name="description">`, the OG description, and the manifest's. */
  description: string;
}

const BMB: Brand = {
  id: 'bmb',
  displayName: 'Boost Me Bitch',
  shortName: 'Boost Me',
  wireName: 'BoostMeBitch',
  domain: 'boostmebitch.com',
  origin: 'https://www.boostmebitch.com',
  siteNpub: 'npub18qs0flu9sa682vx8l6h7glq7tyhrec8a9y5mf7g8usr3f0fx7syq9kpq9l',
  senderName: 'boostmebitch.com user',
  boostSound: '/boost.mp3',
  manifest: '/manifest.json',
  userAgent: 'boostmebitch/0.1',
  description:
    'Search, listen, and boost Podcasting 2.0 shows over Lightning. Sign in with Nostr.',
};

const BUDDY: Brand = {
  id: 'buddy',
  displayName: 'Boost Me Buddy',
  shortName: 'Boost Buddy',
  wireName: 'BoostMeBuddy',
  domain: 'boostmebuddy.com',
  origin: 'https://www.boostmebuddy.com',
  siteNpub: 'npub1payksynch9rkj3dt0ps093cqja8c0r8fhq244kyngcendqgh885qzjs08q',
  senderName: 'boostmebuddy.com user',
  // A SEPARATE asset, not an overwrite of `/boost.mp3`: both deploys are built
  // from this one repo, so `public/` holds both files and the brand picks.
  // `check:brand` asserts the file is actually THERE, because a missing one is
  // a silent no-op — `playBoostSound` swallows the rejected `play()`, so the
  // table shipped naming a file the repo did not have and every buddy boost
  // was quiet under confetti, with no error anywhere.
  boostSound: '/boost-buddy.mp3',
  manifest: '/manifest-buddy.json',
  userAgent: 'boostmebuddy/0.1',
  description:
    'Search, listen, and boost Podcasting 2.0 shows over Lightning. Sign in with Nostr.',
};

export const BRANDS: Record<BrandId, Brand> = { bmb: BMB, buddy: BUDDY };

/** Normalize the environment value. Exported so `check:brand` can pin it. */
export function brandIdFrom(raw: string | undefined): BrandId {
  const v = raw?.trim().toLowerCase();
  return v === 'buddy' ? 'buddy' : 'bmb';
}

/**
 * The active brand.
 *
 * Unknown or unset falls back to `bmb`, which is the original site — so a deploy
 * that forgets the variable keeps behaving exactly as it did rather than serving
 * a half-named page. There is no "unbranded" state to fall into.
 */
export const BRAND: Brand = BRANDS[brandIdFrom(process.env.NEXT_PUBLIC_BRAND)];

/** `<title>` and the OG title — the wordmark plus what the site is. */
export function siteTitle(brand: Brand = BRAND): string {
  return `${brand.displayName} — Podcast Boost Station`;
}

/**
 * The "From" name a boost carries when the user asks not to be named, and when
 * they simply never typed one.
 *
 * **A real default, not the input's ghost text.** Substituting beats omitting
 * because `JSON.stringify` drops an `undefined` key entirely, which leaves the
 * presentation to each recipient's aggregator — the same boost then renders
 * blank in one and "Unknown" in the next.
 *
 * **It lives here rather than in `components/boost-modal/sender-name.tsx`,
 * because `lib/v4v/streaming.ts` needs it.** That module is inside the v4v
 * swap-out boundary, which exists so `lib/v4v/*` can be replaced wholesale
 * without touching `components/` — an import pointing the other way inverts it,
 * and drags a `'use client'` React module into the payment engine.
 * `sender-name.tsx` re-exports this, so the modals' import sites are unchanged.
 * It is a PRODUCT string, so swapping the v4v toolkit must not delete it.
 */
export const DEFAULT_SENDER_NAME = BRAND.senderName;

/**
 * The one place "From" becomes a wire value. Anonymous discards the typed name
 * outright rather than trimming it — see the anonymity note in CLAUDE.md's boost
 * flow: the promise covers the payment, not just the Nostr note.
 */
export function resolveSenderName(typed: string, anonymous: boolean): string {
  return (anonymous ? '' : typed.trim()) || DEFAULT_SENDER_NAME;
}
