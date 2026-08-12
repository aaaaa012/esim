import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
const workspaceRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config: NextConfig = {
  transpilePackages: ['@visa-compass/shared'],
  outputFileTracingRoot: workspaceRoot,
};
export default config;
