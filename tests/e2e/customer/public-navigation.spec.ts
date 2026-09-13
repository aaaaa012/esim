import { expect, test } from "@playwright/test";
import { mockPublicCustomerApi } from "../support/customer-api";
import {
  attachAudit,
  auditInteractiveNames,
  expectElementsInsideViewport,
  expectNoCollapsedText,
  expectNoHorizontalOverflow,
  observeBrowserProblems,
} from "../support/ui-audit";

const publicRoutes = [
  "/",
  "/destinations",
  "/compatibility",
  "/help",
  "/terms",
  "/privacy",
  "/refund-policy",
  "/recharge",
  "/recharge/recover",
  "/service-unavailable",
  "/unauthorized",
  "/account-unavailable",
] as const;

test.beforeEach(async ({ page }) => {
  await mockPublicCustomerApi(page);
});

test("public Help offers safe recovery and direct support paths", async ({
  page,
}) => {
  await page.goto("/help");
  await expect(
    page.getByRole("heading", { name: "How can we help?" }),
  ).toBeVisible();
  await expect(page.getByText(/do not pay again/i)).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Find my recharge/i }),
  ).toHaveAttribute("href", "/recharge/recover");
  await expect(
    page.getByRole("link", { name: /Check my phone/i }),
  ).toHaveAttribute("href", "/compatibility");
  await expect(
    page.locator('a[href^="mailto:support@visacompassnepal.com"]'),
  ).not.toHaveCount(0);
  await expect(page.getByText(/Never send passport files/i)).toBeVisible();
});

test("compatibility remains a Help topic", async ({ page }) => {
  await page.goto("/compatibility");
  await expect(
    page.getByRole("link", { name: "Back to Help" }),
  ).toHaveAttribute("href", "/help");
  const mobileHelp = page
    .getByRole("navigation", {
      name: "Primary mobile navigation",
    })
    .getByRole("link", { name: "Help" });
  if (await mobileHelp.isVisible()) {
    await expect(mobileHelp).toHaveAttribute("aria-current", "page");
  }
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
    await expectNoCollapsedText(page);
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

test("mobile Explore opens home while desktop Destinations opens the catalogue", async ({
  page,
}) => {
  await page.goto("/compatibility");
  const mobileNavigation = page.getByRole("navigation", {
    name: "Primary mobile navigation",
  });
  const mobileExplore = mobileNavigation.getByRole("link", { name: "Explore" });
  if (await mobileExplore.isVisible()) {
    await mobileExplore.click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("#explore")).toBeVisible();
  } else {
    await page
      .locator("header")
      .getByRole("link", { name: "Destinations", exact: true })
      .click();
    await expect(page).toHaveURL(/\/destinations$/);
    await expect(
      page.getByRole("heading", { name: /Choose where you need data/i }),
    ).toBeVisible();
  }
});

test("homepage prioritizes destination discovery on mobile", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Your data lands before you do/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Search destination/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Explore eSIM plans/i }),
  ).toHaveAttribute("href", "/destinations");

  const isMobileNavigation = await page
    .getByRole("navigation", {
      name: "Primary mobile navigation",
    })
    .isVisible();
  if (isMobileNavigation) {
    const mobileNavigation = page.getByRole("navigation", {
      name: "Primary mobile navigation",
    });
    await expect(
      mobileNavigation.getByRole("link", { name: "Explore" }),
    ).toHaveAttribute("href", "/");
    await expect(
      mobileNavigation.getByRole("link", { name: "Explore" }),
    ).toHaveAttribute("aria-current", "page");
    const navigationBox = await page
      .getByRole("navigation", {
        name: "Primary mobile navigation",
      })
      .boundingBox();
    expect(navigationBox).not.toBeNull();
    expect(
      (navigationBox?.y ?? 0) + (navigationBox?.height ?? 0),
    ).toBeGreaterThan((page.viewportSize()?.height ?? 0) - 2);
    await expect(page.locator(".phone-stage")).toBeHidden();
    await expect(
      page.getByRole("button", { name: /navigation menu/i }),
    ).toBeHidden();
    await expect(
      page.getByRole("link", { name: "Recharge", exact: true }).last(),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "My eSIM", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Orders", exact: true }),
    ).toHaveAttribute("href", "/recharge/recover");
    await expect(
      page.getByRole("link", { name: "Home", exact: true }),
    ).toBeHidden();
  } else {
    await expect(page.locator(".phone-stage")).toBeVisible();
  }
});

test("unknown routes render the application 404", async ({ page }) => {
  const response = await page.goto("/this-route-must-not-exist");
  expect(response?.status()).toBe(404);
  await expect(page.getByText(/not found|could not be found/i)).toBeVisible();
});
