// Whether this build is the beta site, `beta.boostmebitch.com`.
//
// A build flag and not a brand. `lib/brand.ts` names what a deploy IS on the
// wire and on other people's screens: `BRAND.domain` reaches a NIP-05, the
// keysend route and every boost note, and beta must say exactly what the main
// site says there. So this flag changes three things a tester sees, and nothing
// a recipient reads: the tag in `app/layout.tsx`, `noindex`, and the bug report.
// A fourth, temporary: the early download of the next track in
// `components/player/use-next-prefetch.ts`, an experiment for bug #546.
//
// `process.env.NEXT_PUBLIC_BETA` IS WRITTEN OUT LITERALLY, ONCE, for the reason
// `lib/brand.ts` gives: Next.js inlines the exact member expression at build
// time and cannot follow a variable. Only the exact value `1` turns it on, so a
// stray value in a dashboard leaves the main behaviour in place.
//
// See docs/ops.md, "The beta site".

export const IS_BETA: boolean = process.env.NEXT_PUBLIC_BETA === '1';

/**
 * The bug report's `site` value. `BRAND.domain` alone makes a report from beta
 * read as a report from the main site, and the issue is all the owner gets.
 */
export function reportSite(domain: string, beta: boolean = IS_BETA): string {
  return beta ? `beta.${domain}` : domain;
}
