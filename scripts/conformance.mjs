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
// SIX VECTORS ARE RED ON PURPOSE, AND A GREEN RUN WOULD BE THE SURPRISE.
//
// The spec moved an item's feed guid onto the item's own `i` tag, and the
// migration to it is staged across both apps that write this event
// (`pc20-favorites-feed-guid-migration.md`). This app is at STAGE 1: it reads
// the three-element form and carries it whole, and still writes its own items
// in the legacy two-element form under a feed group. Writing the new form may
// not land until the other writer READS it — a reader on stage 0 takes
// `podcast:guid:F` at position 1 and silently converts a saved episode into a
// followed show.
//
//   6, 25, 27  stage 2 — write the new form, and claim the (feed, item) pair
//   26         stage 3 — stop writing placement feed entries
//   18, 28     stage 4 — emit each `medium` run in band order
//
// So 22 pass / 6 fail is this branch's expected result. A NEW red is a
// regression; these six are a schedule. Vector 27's carry half already passes —
// it fails on the migration half and on one assertion that a writer may not
// claim an entry it carries, which this app's adopting model reads differently
// (see rule 2, "you may claim an entry you have adopted and will keep
// asserting"). That one is a question for the spec repo, not a defect here.

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
