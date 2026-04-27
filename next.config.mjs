import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the workspace root so Next doesn't pick up an unrelated lockfile elsewhere
  // on disk (the parent dir has a bun.lock that's nothing to do with this app).
  outputFileTracingRoot: __dirname,
  images: {
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },
};
export default nextConfig;
