import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
const workspaceRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config: NextConfig = {
  transpilePackages: ['@visa-compass/shared'],
  // Keep an active dev server isolated from `next build`. Sharing `.next`
  // lets a production build replace the React client manifest underneath dev.
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
  // Prevent Next from tracing the parent directory when another unrelated
  // lockfile exists on the developer machine or build host.
  outputFileTracingRoot: workspaceRoot,
};
export default config;
