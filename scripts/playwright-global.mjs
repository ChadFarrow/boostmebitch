// Resolves Playwright without putting it in package.json.
//
// The two scripts that need a browser — make-maskable-icon.mjs and
// shoot-screenshots.mjs — are one-shot asset generators, run by hand when the
// logo or the listing changes. Adding Playwright as a devDependency would put
// a browser download in every `npm install` this repo ever runs, for a job
// nobody does in a normal week. So it is used from wherever it already is.
//
// A bare `import 'playwright'` does not find a globally installed copy: NODE_PATH
// is honoured by CommonJS `require`, not by the ESM resolver, so the obvious
// `NODE_PATH=$(npm root -g) node script.mjs` fails with ERR_MODULE_NOT_FOUND.
// This resolves the global root itself and imports by absolute file URL.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Playwright's entry point is CommonJS. Node's ESM interop sometimes detects
// its named exports and sometimes hands back only `default`, depending on how
// the module is reached — so normalize rather than trusting either shape.
const unwrap = (mod) => (mod?.chromium ? mod : mod?.default ?? mod);

/** `import('playwright')`, falling back to the globally installed copy. */
export async function loadPlaywright() {
  try {
    return unwrap(await import('playwright'));
  } catch {
    // Not a local dependency, which is the expected case.
  }
  let root;
  try {
    root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  } catch {
    root = '';
  }
  const entry = root && join(root, 'playwright', 'index.js');
  if (!entry || !existsSync(entry)) {
    throw new Error(
      'Playwright not found. It is deliberately NOT a dependency of this repo — '
      + 'install it globally (`npm i -g playwright`) or locally just to run this '
      + 'script, then run it again.',
    );
  }
  return unwrap(await import(pathToFileURL(entry).href));
}
