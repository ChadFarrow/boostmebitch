// Which search rows the DEMU search type keeps — the self-hosted half of the
// rule. The lane in `app/api/search/route.ts` applies the music half.
//
// IMPORT-FREE, not even `import type`: `npm run check:demu` loads this file
// under plain Node (`scripts/import-free.mjs`). That is why the closed-host
// test arrives as a PARAMETER rather than an import: `lib/moved-feeds.ts` stays
// the one list of closed hosts, and every caller passes its `closedService`.
//
// **What DeMu means here (Chad, 2026-11-15):** "anything that's self-hosted …
// on a user's own website or fountain.fm also counts … RSS Blue did until they
// went away, and PodHome would also count. Basically anything that's not
// Wavlake." And: "anything with a generator tag of Wavlake isn't on this list.
// So if it's a Wavlake generator tag, but it's hosted somewhere else, then that
// still gets removed."
//
// **Why the generator and never the host.** Measured against Podcast Index's
// 8,671 music feeds: every feed on wavlake.com carries the Wavlake generator,
// and 5 Wavlake QA feeds carry it on a `run.app` host. A host test keeps those
// five. LNBeats, the site this copies, tested `!generator.includes('Wavlake')`
// (`thebells1111/lnbeats`, `src/components/Discover/Discover.svelte`); this
// test is the same, made case-insensitive.
//
// **Why a closed host is not DeMu.** RSS Blue closed in 2026 and answers 410
// for every feed, while Podcast Index still serves those records as healthy. A
// listener who finds one cannot play it or request it, and an artist who moved
// shows under the new feed. `closedService` already knows this (see
// `lib/moved-feeds.ts`).
//
// Design: docs/superpowers/specs/2026-11-15-demu-search-design.md.

/** The two fields of a Podcast Index feed record the rule reads. */
export interface DemuRow {
  /**
   * The feed's `<generator>`. BLANK passes: Podcast Index sends `""` for a feed
   * without one, and 190 DeMu feeds have none. ABSENT fails: PI always sends
   * the key and `buildPodcast` keeps it, so a row without it was built by
   * something that dropped the field, and passing it would call every Wavlake
   * album DeMu.
   */
  generator?: string;
  /** The feed URL. */
  url?: string;
}

/**
 * Whether one feed record is self-hosted by Chad's rule: no "wavlake" in its
 * generator, case-insensitively, and not on a closed host. A row with no
 * `generator` field at all FAILS CLOSED (see `DemuRow.generator`).
 *
 * This does NOT test the medium. The DEMU lane runs the music lanes, and
 * `matchesSearchType(p, 'demu')` applies the music test to byterm's rows.
 */
export function isDemuFeed(
  row: DemuRow,
  closedService: (url: string) => string | null,
): boolean {
  if (typeof row.generator !== 'string') return false;
  if (/wavlake/i.test(row.generator)) return false;
  return closedService(row.url ?? '') === null;
}
