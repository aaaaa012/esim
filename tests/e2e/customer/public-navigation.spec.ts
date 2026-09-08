import { expect, test } from "@playwright/test";
import { mockPublicCustomerApi } from "../support/customer-api";
import {
  attachAudit,
  auditInteractiveNames,
  expectElementsInsideViewport,
  expectNoHorizontalOverflow,
  observeBrowserProblems,
} from "../support/ui-audit";

const publicRoutes = [
  "/",
  "/destinations",
  "/compatibility",
  "/terms",
  "/privacy",
  "/refund-policy",
  "/recharge/recover",
  "/service-unavailable",
  "/unauthorized",
  "/account-unavailable",
] as const;

test.beforeEach(async ({ page }) => {
  await mockPublicCustomerApi(page);
});

for (const route of publicRoutes) {
  test(`${route} renders without overflow or unnamed controls`, async ({
    page,
  }, testInfo) => {
    const problems = observeBrowserProblems(page);
    const response = await page.goto(route, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBeLessThan(400);
    await expect(page.locator("body")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await auditInteractiveNames(page);
    await attachAudit(testInfo, "browser-problems.json", problems);
    expect(problems.filter((problem) => problem.kind === "pageerror")).toEqual(
      [],
    );
  });
}

test("destination selection stays on the catalogue route", async ({ page }) => {
  await page.goto("/destinations");
  await page.getByRole("button", { name: /India/i }).first().click();
  await page.getByPlaceholder(/Search countries/i).fill("Australia");
  await page.getByRole("option", { name: /Australia/i }).click();
  await expect(page).toHaveURL(/\/destinations\?country=AU$/);
  await expect(page.getByText("Australia Essential 3 GB")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectElementsInsideViewport(
    page,
    ".supported-destinations, .destination-picker, .cards, .card, .price",
  );
});

test("header destinations navigation never falls back to the homepage", async ({
  page,
}) => {
  await page.goto("/compatibility");
  const mobileMenu = page.getByRole("button", { name: /navigation menu/i });
  if (await mobileMenu.isVisible()) await mobileMenu.click();
  await page
    .locator("header")
    .getByRole("link", { name: "Destinations", exact: true })
    .click();
  await expect(page).toHaveURL(/\/destinations$/);
  await expect(
    page.getByRole("heading", { name: /Choose where you need data/i }),
  ).toBeVisible();
});

test("unknown routes render the application 404", async ({ page }) => {
  const response = await page.goto("/this-route-must-not-exist");
  expect(response?.status()).toBe(404);
  await expect(page.getByText(/not found|could not be found/i)).toBeVisible();
});
