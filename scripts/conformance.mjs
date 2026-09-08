// Run the PC20-Nostr favorites conformance suite against this app's merge.
//
//   npm run check:conformance
//
// The suite lives in the spec's repo, not here, on purpose: a copy would drift
// from the document the same way a reimplemented check drifts from shipping
// code. It is found at `../PC20-Nostr` beside this checkout, or wherever
// `PC20_NOSTR_DIR` points. The adapter it drives is
// `scripts/conformance-adapter.mjs`.
//
// THREE VECTORS ARE RED ON PURPOSE, AND EACH FOR A DIFFERENT REASON.
//
// The spec moved an item's feed guid onto the item's own `i` tag (PC20-Nostr#34)
// and prescribed a band order for each `medium` run. This app ships stages 2 and
// 4 of `pc20-favorites-feed-guid-migration.md`: it reads and writes the
// three-element form, rewrites a legacy item once, claims the (feed, item) pair,
// and bands each run.
//
// It also ships what PC20-Nostr#38 and #40 added on 2026-09-08 — a move between
// halves is a merge and not a copy (29), an emptied half encodes to nothing
// (30), and a carried claim retires with the entry it names (31). Those three
// are GREEN and are not on the list below; a red one is a regression, not a
// known divergence.
//
// 28 of 31 pass. The three that do not:
//
//   25  Its LAST assertion only. The pair claim itself works — the merge removes
//       exactly the claimed copy and keeps the one under the other feed, pinned
//       in `check:favsync`. The refusal comes from this app's wholesale-delete
//       guard: the fixture holds NOTHING locally while its baseline claims an
//       entry, which is byte-for-byte what an unhydrated store looks like, and
//       publishing on that shape cost a live account 213 groups and 232 items on
//       2026-08-21. The guard is deliberately stricter than the suite.
//
//   26  STAGE 3, which is not shipped. A placement feed entry already on the
//       wire is carried rather than retracted. This app stops writing NEW ones —
//       an item names its own feed — but taking down one it wrote earlier is the
//       change that breaks a reader still on stage 0 hardest, and the spec says
//       to hold it back longest.
//
//   27  Its carry half and its migration half both pass. It fails on TWO
//       assertions — that a writer may not claim an entry it carries — which
//       this app's model reads differently: it paints the shared list into ONE
//       library and lets the user unfavorite any of it, so it has to claim what
//       it renders. Rule 2 allows exactly that ("you may claim an entry you have
//       adopted and will keep asserting; you may never claim one you are merely
//       carrying"), and its test is whether we will still be HOLDING them next
//       cycle rather than where the ids came from — which this app passes, since
//       the adapter's `holds` names every entry the baseline claims.
//       `conformance/adapter.d.ts` documents this app by name as that model and
//       says an adopted entry is "claimed in the baseline", so the contract file
//       and the vector disagree with each other. Filed as PC20-Nostr#44. A
//       question for the spec repo, not a defect here.
//
//       An earlier revision of this note also said vector 14 asserted the
//       opposite direction. It does not: in that fixture the entry is already
//       held AND already claimed going in, so nothing there is a carried entry
//       being claimed for the first time. Checked before opening the issue, and
//       left out of it.
//
// So 28 pass / 3 fail is this branch's expected result. A NEW red is a
// regression; these three are not.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = process.env.PC20_NOSTR_DIR ?? path.resolve('..', 'PC20-Nostr');
const suite = path.join(dir, 'conformance', 'vectors.test.mjs');

if (!existsSync(suite)) {
  console.error(
    `conformance: ${suite} not found.\n`
    + 'Clone github.com/ChadFarrow/PC20-Nostr beside this repo, or set PC20_NOSTR_DIR to a checkout.',
  );
  process.exit(2);
}

const r = spawnSync(process.execPath, ['--experimental-strip-types', '--test', suite], {
  stdio: 'inherit',
  env: { ...process.env, PC20_FAVORITES_ADAPTER: path.resolve('scripts/conformance-adapter.mjs') },
});
process.exit(r.status ?? 1);
