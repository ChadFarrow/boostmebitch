// Where a listener was on /demu: the search words, how many rows they had
// revealed, and how far down they had scrolled.
//
// MODULE STATE, on purpose. It survives client-side navigation — opening an
// album and coming back by "← back to DeMu" or the browser's back button — and
// a reload starts fresh. That is the whole requirement, so this is NOT a
// `bmb:*` storage key: nothing here is worth keeping across sessions, and a
// key would bring the docs/storage.md rules (eviction class, migration) for
// nothing.
//
// `<HomePage>` writes `query` before it links here ("browse all DeMu →"), so
// the page opens already filtered to the words of the DEMU search.
// Design: docs/superpowers/specs/2026-11-15-demu-page-design.md.
export const demuView: { query: string; shown: number; scrollY: number } = {
  query: '',
  shown: 0,
  scrollY: 0,
};
