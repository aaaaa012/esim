import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
const workspaceRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const imageBaseUrls = [
  process.env.NEXT_PUBLIC_ASSET_BASE_URL,
  process.env.NEXT_PUBLIC_API_URL,
].filter((url): url is string => Boolean(url));

const remoteAssetPatterns = imageBaseUrls.flatMap((baseUrl) => {
  try {
    const url = new URL(baseUrl);
    return [{
      protocol: url.protocol.replace(":", "") as "http" | "https",
      hostname: url.hostname,
      port: url.port,
      pathname: `${url.pathname.replace(/\/$/, "")}/**`,
    }];
  } catch {
    return [];
  }
});
const config: NextConfig = {
  transpilePackages: ["@visa-compass/shared"],
  // Keep an active dev server isolated from `next build`. Sharing `.next`
  // lets a production build replace the React client manifest underneath dev.
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  // Prevent Next from tracing the parent directory when another unrelated
  // lockfile exists on the developer machine or build host.
  outputFileTracingRoot: workspaceRoot,
  images: { remotePatterns: remoteAssetPatterns },
  webpack(current) {
    if (process.env.NEXT_PUBLIC_E2E_TEST_MODE === "true") {
      if (process.env.NODE_ENV === "production")
        throw new Error("E2E Clerk adapter is forbidden in production");
      current.resolve.alias["@clerk/nextjs$"] = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "src/test/clerk-client.tsx",
      );
    }
    return current;
  },
};
export default config;
