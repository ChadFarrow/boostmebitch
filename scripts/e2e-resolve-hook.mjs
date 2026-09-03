// Resolve hook so a Node test can import the SHIPPING browser modules.
//
// The app is bundled by webpack, which resolves extensionless specifiers and
// the `@/` alias. Node's ESM resolver does neither, which is exactly why
// scripts/import-free.mjs exists and why every check:* script is limited to
// import-free leaves. This hook is the narrow exception a wiring test needs: it
// ONLY appends an extension and expands `@/`, so the module graph it builds is
// the same one webpack builds. It resolves nothing webpack would not.
// It is for e2e ONLY. A check:* script must keep importing an import-free leaf
// under plain `node --experimental-strip-types`: that constraint is what stops
// a pinned module quietly acquiring dependencies, and a resolver that hides the
// problem would take the guarantee away from all twenty-nine of them.
//
// Registered by the script that uses it:
//   import { register } from 'node:module';
//   register('./e2e-resolve-hook.mjs', import.meta.url);
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import path, { dirname } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXTS = ['.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx'];

export async function resolve(specifier, context, next) {
  let spec = specifier;
  if (spec.startsWith('@/')) spec = pathToFileURL(path.join(ROOT, spec.slice(2))).href;
  const isRel = spec.startsWith('./') || spec.startsWith('../');
  if (isRel || spec.startsWith('file:')) {
    const base = isRel
      ? path.resolve(path.dirname(fileURLToPath(context.parentURL)), spec)
      : fileURLToPath(spec);
    if (!existsSync(base) || base.endsWith(path.sep)) {
      for (const ext of EXTS) {
        if (existsSync(base + ext)) return next(pathToFileURL(base + ext).href, context);
      }
    }
    return next(pathToFileURL(base).href, context);
  }
  return next(specifier, context);
}
