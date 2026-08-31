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
});
const config: NextConfig = {
  transpilePackages: ["@visa-compass/shared"],
  outputFileTracingRoot: workspaceRoot,
  images: { remotePatterns: remoteAssetPatterns },
};
export default config;
