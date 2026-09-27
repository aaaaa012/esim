import { expect, test } from "@playwright/test";
import { mockPublicCustomerApi } from "../support/customer-api";
import {
  expectElementsInsideViewport,
  expectNoHorizontalOverflow,
} from "../support/ui-audit";

test.beforeEach(async ({ page }) => {
  await mockPublicCustomerApi(page);
});

test("recharge recovery enforces required fields before any request", async ({
  page,
}) => {
  let submitted = false;
  await page.route("**/api/v1/recharges/recovery-link", (route) => {
    submitted = true;
    return route.fulfill({ status: 204 });
  });
  await page.goto("/recharge/recover");
  await page
    .getByRole("button", { name: /send private tracking link/i })
    .click();
  await expect(page.locator("#recovery-order:invalid")).toBeVisible();
  expect(submitted).toBe(false);
  await expectNoHorizontalOverflow(page);
});

test("recharge recovery rejects a malformed order number before any request", async ({
  page,
}) => {
  let submitted = false;
  await page.route("**/api/v1/recharges/recovery-link", (route) => {
    submitted = true;
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.goto("/recharge/recover");
  await page.getByLabel("Recharge order number").fill("520DD926");
  await page.getByLabel("Original purchase email").fill("traveller@example.com");
  await page.getByRole("button", { name: /send private tracking link/i }).click();
  await expect(page.locator("#recovery-order:invalid")).toBeVisible();
  expect(submitted).toBe(false);
});

test("recharge recovery uses a privacy-safe confirmation dialog", async ({
  page,
}) => {
  await page.route("**/api/v1/recharges/recovery-link", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.goto("/recharge/recover");
  await page.getByLabel("Recharge order number").fill("vc-2026-520dd926");
  await page.getByLabel("Original purchase email").fill("traveller@example.com");
  await page.getByRole("button", { name: /send private tracking link/i }).click();
  const dialog = page.getByRole("dialog", { name: "Request received" });
  await expect(dialog).toContainText(/cannot confirm whether a match exists/i);
});

test("recharge recovery API failure is presented in a dialog", async ({
  page,
}) => {
  await page.route("**/api/v1/recharges/recovery-link", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );
  await page.goto("/recharge/recover");
  await page.getByLabel("Recharge order number").fill("VC-2026-E2E00001");
  await page
    .getByLabel("Original purchase email")
    .fill("traveller@example.com");
  await page
    .getByRole("button", { name: /send private tracking link/i })
    .click();
  await expect(page.getByRole("alertdialog")).toContainText(
    /could not process|try again/i,
  );
});

test("catalogue API failure shows an actionable inline alert", async ({ page }) => {
  await page.route("**/api/v1/public/countries", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );
  await page.goto("/destinations");
  const alert = page.getByRole("alert").filter({ hasText: /couldn’t load the catalog/i });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(/unavailable|try again/i);
  await expect(alert.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("document checkout keeps the active form ahead of a fitted summary", async ({
  page,
}) => {
  const plan = {
    id: "plan-in-1",
    countryCode: "IN",
    countryName: "India",
    name: "India Essential 1 GB",
    dataAllowance: "1 GB",
    allowanceMb: 1024,
    validityDays: 7,
    sellingPriceNpr: 999,
    coverage: ["IN"],
    popular: true,
  };
  await page.route("**/api/v1/public/plans/plan-in-1", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: plan }),
    }),
  );
  await page.route("**/api/v1/payments/providers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { providers: ["KHALTI"] } }),
    }),
  );
  await page.route("**/api/v1/guest/orders", (route) =>
    route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          order: {
            id: "order-mobile-layout",
            orderNumber: "VC-2026-MOBILE",
            status: "DRAFT",
            totalAmountNpr: 999,
            purchaseType: "INITIAL_PURCHASE",
            plan,
          },
          token: "guest-test-token",
          recovery: {
            token: "recovery-test-token",
            expiresAt: "2026-10-08T00:00:00.000Z",
          },
        },
      }),
    }),
  );

  await page.goto("/esim/checkout?plan=plan-in-1");
  await page.getByText("I confirm my device is eSIM compatible", { exact: true }).click();
  await page.getByText("I agree to the purchase terms", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /I agree to the purchase terms/i })).toBeChecked();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: /Continue as guest/i }).click();
  await expect(page.getByRole("heading", { name: "Travel documents" })).toBeVisible();

  await expectNoHorizontalOverflow(page);
  await expectElementsInsideViewport(
    page,
    ".checkout-shell, .checkout-layout, .checkout-card, .form-section, .form-grid, .form-grid label, .form-grid input, .form-grid select, .order-summary",
  );

  const form = await page.locator(".checkout-card").boundingBox();
  const summary = await page.locator(".order-summary").boundingBox();
  expect(form).not.toBeNull();
  if (summary && (page.viewportSize()?.width ?? 0) <= 880) {
    expect(summary.y).toBeGreaterThanOrEqual(form!.y + form!.height - 1);
  } else if (summary) {
    expect(summary!.x).toBeGreaterThan(form!.x);
  }
});
