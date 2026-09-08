import { expect, test } from "@playwright/test";
import {
  attachAudit,
  auditInteractiveNames,
  expectNoHorizontalOverflow,
  observeBrowserProblems,
} from "../support/ui-audit";

const operationalRoutes = [
  "/",
  "/work-queue",
  "/attention",
  "/orders",
  "/customers",
  "/inventory",
  "/transatel",
  "/provisioning-operations",
  "/manual-refunds",
  "/notifications",
  "/logs",
  "/integration-events",
  "/integration-logs",
  "/audit",
  "/admin",
  "/admin/integrations",
  "/admin/homepage-campaigns",
  "/admin/partners-showcase",
] as const;

for (const route of operationalRoutes) {
  test(`${route} remains usable at the configured Ops viewport`, async ({
    page,
  }, testInfo) => {
    const problems = observeBrowserProblems(page);
    const response = await page.goto(route, { waitUntil: "domcontentloaded" });

    expect(
      response?.status(),
      `${route} returned an error document`,
    ).toBeLessThan(400);
    await expect(page.locator("main")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await auditInteractiveNames(page);
    await attachAudit(testInfo, "browser-problems.json", problems);

    expect(
      problems.filter(
        (problem) =>
          problem.kind === "pageerror" ||
          problem.kind === "requestfailed" ||
          problem.kind === "http",
      ),
      problems
        .map((problem) => `${problem.kind}: ${problem.detail}`)
        .join("\n"),
    ).toEqual([]);
  });
}

test("mobile operations navigation opens, identifies the active page, and closes", async ({
  page,
}, testInfo) => {
  test.skip(
    (testInfo.project.use.viewport?.width ?? 1280) >= 1024,
    "Desktop navigation is permanently visible",
  );

  await page.goto("/logs", { waitUntil: "networkidle" });
  const sidebar = page.getByRole("complementary", {
    name: "Operations navigation",
  });
  await expect(sidebar.locator(".ops-sidebar-user .meta b")).not.toHaveText(
    "Loading...",
  );
  const open = page.getByRole("button", { name: "Open operations navigation" });
  await open.click();

  await expect(sidebar).toHaveClass(/open/);
  await expect(sidebar.getByRole("link", { name: "Logs" })).toHaveClass(
    /active/,
  );

  await page.getByRole("button", { name: "Close navigation" }).click();
  await expect(page.locator(".ops-sidebar")).not.toHaveClass(/open/);
});
