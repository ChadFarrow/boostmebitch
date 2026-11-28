// postinstall: copy the Libre wallet's LDK WASM out of the package into public/,
// so it is served at /liblightningjs.wasm (the `wasmUrl` in lib/v4v/libre.ts).
//
// It runs on every install, Vercel's included, so the served file always matches
// the pinned package; it is git-ignored and never committed. It never fails the
// install: a missing package (an install that left it out) is a warning, and the
// widget then reports "Couldn't load Libre Wallet" instead of the build failing.
// It reads and writes local files only — no network.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(REPO, 'node_modules/@libre/wallet-embed/dist/liblightningjs.wasm');
const dst = join(REPO, 'public/liblightningjs.wasm');

try {
  if (!existsSync(src)) {
    console.warn(`[postinstall] Libre wallet WASM not found at ${src}; Libre will not load.`);
  } else {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
} catch (e) {
  console.warn(`[postinstall] could not copy the Libre wallet WASM: ${e?.message ?? e}`);
}
