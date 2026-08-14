// Shared guard for the modules that must stay loadable by a `check:*` script.
//
// Three modules are deliberately import-free — `lib/nostr/favorites-list.ts`,
// `lib/nostr/read-trust.ts`, `lib/v4v/lease.ts` — and one is allowed bare npm
// specifiers only (`lib/v4v/nwc-errors.ts`). The rule exists because the check
// scripts import the REAL shipping module under
// `node --experimental-strip-types`; a reimplemented copy in the script would
// stay green while the shipping code drifted, which is the exact failure being
// guarded, and it has happened here before.
//
// WHY A STATIC SCAN AND NOT "IT LOADS, SO IT'S FINE":
//
// Node's ESM resolver needs real paths with extensions. This repo writes
// `./publish` and `@/lib/store`, so a relative import breaks the load outright —
// loudly, which is survivable. The dangerous edit is the one that DOESN'T break:
//
//     import type { Foo } from './types';    // erased by type-stripping — loads
//     import { type Foo } from './types';    // NOT erased — ERR_MODULE_NOT_FOUND
//
// One character apart, opposite outcomes. The first passes every check today and
// leaves the module one `type` deletion away from breaking, at which point the
// tempting repair is to stop importing the real module and copy its functions
// into the script — green forever, guarding nothing.
//
// So the scan rejects ALL relative imports, including type-only ones. It cannot
// run at all in the already-broken case (the check script's own top-level import
// throws first, with a clear enough ERR_MODULE_NOT_FOUND naming the specifier);
// its job is to catch the harmless-looking step before it gets there.

import { readFileSync } from 'node:fs';

/** Every `from '...'` specifier in the source, import or re-export. */
function specifiersIn(source) {
  const out = [];
  const re = /(?:^|\n)\s*(?:import|export)\b[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source))) out.push(m[1]);
  // Bare side-effect imports (`import './x'`) carry no `from`.
  const side = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  while ((m = side.exec(source))) out.push(m[1]);
  return out;
}

const isRelative = (s) => s.startsWith('.') || s.startsWith('@/');

/**
 * Assert a module's imports stay within what plain Node can resolve.
 *
 * `allowBare` permits npm specifiers (`@getalby/sdk`), which resolve fine —
 * only relative ones don't. Returns a list of human-readable problems; empty
 * means it conforms.
 */
export function importFreeProblems(path, { allowBare = false } = {}) {
  const specs = specifiersIn(readFileSync(path, 'utf8'));
  const problems = [];
  for (const s of specs) {
    if (isRelative(s)) {
      problems.push(`relative import ${JSON.stringify(s)} — Node's resolver needs a real path with an extension, and even a type-only one is a deletion away from breaking the load`);
    } else if (!allowBare) {
      problems.push(`import ${JSON.stringify(s)} — this module is meant to have none at all`);
    }
  }
  return problems;
}

/**
 * Print the standard explanation for a violation. Kept here so all three check
 * scripts say the same thing, and specifically so nobody "fixes" a failure by
 * reimplementing the module inside the script.
 */
export function explainImportFree(path, problems) {
  console.error(`\n  FAIL  ${path} must stay loadable under plain Node`);
  for (const p of problems) console.error(`          ${p}`);
  console.error(
    '\n        This module is imported by a check:* script under'
    + '\n        `node --experimental-strip-types`, so it exercises the REAL'
    + '\n        shipping code. Do NOT fix this by copying its functions into'
    + '\n        the script — a copy stays green while the shipping code drifts,'
    + '\n        which is the failure the arrangement exists to prevent.'
    + '\n        Move whatever needs the import to a caller instead.\n',
  );
}
