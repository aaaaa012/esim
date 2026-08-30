import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
const workspaceRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const publicAssetBase = process.env.NEXT_PUBLIC_ASSET_BASE_URL;
const remoteAssetPattern = (() => {
  if (!publicAssetBase) return [];
  try {
    const url = new URL(publicAssetBase);
    return [
      {
        protocol: url.protocol.replace(":", "") as "http" | "https",
        hostname: url.hostname,
        port: url.port,
        pathname: `${url.pathname.replace(/\/$/, "")}/**`,
      },
    ];
  } catch {
    return [];
  }
})();
const config: NextConfig = {
  transpilePackages: ["@visa-compass/shared"],
  // Keep an active dev server isolated from `next build`. Sharing `.next`
  // lets a production build replace the React client manifest underneath dev.
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  // Prevent Next from tracing the parent directory when another unrelated
  // lockfile exists on the developer machine or build host.
  outputFileTracingRoot: workspaceRoot,
  images: { remotePatterns: remoteAssetPattern },
};
export default config;
