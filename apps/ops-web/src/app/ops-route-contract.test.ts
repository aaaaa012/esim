import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = join(appRoot, "..");

const expectedRoutes = [
  "/",
  "/access-error",
  "/account-unavailable",
  "/admin",
  "/admin/homepage-campaigns",
  "/admin/homepage-featured-plans",
  "/admin/integrations",
  "/admin/partners/[id]",
  "/admin/partners-showcase",
  "/attention",
  "/audit",
  "/change-password",
  "/customers",
  "/customers/[ownerId]",
  "/integration-events",
  "/integration-logs",
  "/inventory",
  "/logs",
  "/manual-refunds",
  "/notifications",
  "/orders",
  "/orders/[id]",
  "/provisioning-operations",
  "/security/[[...security]]",
  "/service-unavailable",
  "/rate-limited",
  "/sign-in/[[...sign-in]]",
  "/staff-activate",
  "/staff-onboarding",
  "/super-admin/[[...sign-in]]",
  "/transatel",
  "/unauthorized",
  "/users/[id]",
  "/work-queue",
] as const;

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function routeFor(page: string) {
  const directory = dirname(relative(appRoot, page));
  return directory === "." ? "/" : `/${directory.split(sep).join("/")}`;
}

describe("Ops route contract", () => {
  const pages = filesBelow(appRoot).filter((path) => path.endsWith("page.tsx"));

  it("keeps the reviewed route inventory explicit", () => {
    expect(pages.map(routeFor).sort()).toEqual([...expectedRoutes].sort());
  });

  it.each(expectedRoutes)("exports the %s screen", (route) => {
    const page = pages.find((candidate) => routeFor(candidate) === route);
    expect(page, `Missing page for ${route}`).toBeDefined();
    expect(readFileSync(page!, "utf8")).toMatch(/export\s+default/);
  });

  it("uses application feedback instead of native dialogs or forced reloads", () => {
    const violations = filesBelow(sourceRoot)
      .filter((path) => /\.(ts|tsx)$/.test(path) && !/\.test\./.test(path))
      .flatMap((path) => {
        const source = readFileSync(path, "utf8");
        return [
          /\bwindow\.alert\s*\(/.test(source) ? "window.alert" : null,
          /\bwindow\.confirm\s*\(/.test(source) ? "window.confirm" : null,
          /\blocation\.reload\s*\(/.test(source) ? "location.reload" : null,
        ]
          .filter((value): value is string => Boolean(value))
          .map((value) => `${relative(sourceRoot, path)}: ${value}`);
      });
    expect(violations).toEqual([]);
  });
});
