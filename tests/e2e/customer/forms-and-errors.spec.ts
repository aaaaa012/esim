import { expect, test } from "@playwright/test";
import { mockPublicCustomerApi } from "../support/customer-api";
import { expectNoHorizontalOverflow } from "../support/ui-audit";

test.beforeEach(async ({ page }) => {
  await mockPublicCustomerApi(page);
});

test("recharge recovery enforces required fields before any request", async ({ page }) => {
  let submitted = false;
  await page.route("**/api/v1/recharges/recovery-link", (route) => {
    submitted = true;
    return route.fulfill({ status: 204 });
  });
  await page.goto("/recharge/recover");
  await page.getByRole("button", { name: /send private tracking link/i }).click();
  await expect(page.locator("#recovery-order:invalid")).toBeVisible();
  expect(submitted).toBe(false);
  await expectNoHorizontalOverflow(page);
});

test("recharge recovery API failure is presented in a dialog", async ({ page }) => {
  await page.route("**/api/v1/recharges/recovery-link", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );
  await page.goto("/recharge/recover");
  await page.getByLabel("Recharge order number").fill("VC-2026-E2E00001");
  await page.getByLabel("Original purchase email").fill("traveller@example.com");
  await page.getByRole("button", { name: /send private tracking link/i }).click();
  await expect(page.getByRole("dialog")).toContainText(/could not process|try again/i);
});

test("catalogue API failure is presented in a dialog", async ({ page }) => {
  await page.route("**/api/v1/public/countries", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );
  await page.goto("/destinations");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(/unavailable|try again/i);
});
