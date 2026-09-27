import { expect, test } from "@playwright/test";
import {
  auditInteractiveNames,
  expectNoHorizontalOverflow,
} from "../support/ui-audit";

const publicRoutes = [
  "/sign-in",
  "/unauthorized",
  "/account-unavailable",
  "/access-error",
  "/service-unavailable",
] as const;

for (const route of publicRoutes) {
  test(`${route} renders as a responsive, labelled boundary`, async ({ page }) => {
    const response = await page.goto(route, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBeLessThan(400);
    await expect(page.locator("body")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await auditInteractiveNames(page);
  });
}

test("unknown Ops routes return 404", async ({ page }) => {
  const response = await page.goto("/this-ops-route-must-not-exist");
  expect(response?.status()).toBe(404);
});
