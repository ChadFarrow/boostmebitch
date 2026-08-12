// Resolve hook: lets a check script import the REAL .ts modules, including ones
// that import other modules of their own.
//
// `--experimental-strip-types` can compile a .ts file, but Node's ESM resolver
// is strict about extensions, so an ordinary TypeScript import like
// `from './pool'` fails with ERR_MODULE_NOT_FOUND. That is why the existing
// check scripts can only import dependency-free modules (favorites-merge.ts has
// no imports at all, deliberately).
//
// This retries a failed relative resolution as `.ts`, and as `/index.ts` for a
// directory. It changes nothing about how the app builds — it exists only so a
// check can exercise shipping code rather than a copy of it, which is the whole
// point of these scripts.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) throw err;
    for (const suffix of ['.ts', '/index.ts', '.tsx']) {
      try {
        return await next(specifier + suffix, context);
      } catch {
        /* try the next shape */
      }
    }
    throw err;
  }
}
