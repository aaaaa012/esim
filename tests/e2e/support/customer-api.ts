import type { Page } from "@playwright/test";

const countries = [
  { code: "IN", name: "India", popular: true },
  { code: "AU", name: "Australia", popular: false },
];

const plans = [
  {
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
  },
  {
    id: "plan-au-1",
    countryCode: "AU",
    countryName: "Australia",
    name: "Australia Essential 3 GB",
    dataAllowance: "3 GB",
    allowanceMb: 3072,
    validityDays: 15,
    sellingPriceNpr: 2499,
    coverage: ["AU"],
    popular: false,
  },
];

export async function mockPublicCustomerApi(page: Page) {
  await page.route("**/api/v1/public/countries", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: countries, meta: { correlationId: "e2e", timestamp: new Date(0).toISOString() } }),
    }),
  );
  await page.route("**/api/v1/public/plans**", (route) => {
    const url = new URL(route.request().url());
    const country = url.searchParams.get("country");
    const data = country
      ? plans.filter((plan) => plan.countryCode === country)
      : plans.filter((plan) => plan.popular);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data, meta: { correlationId: "e2e", timestamp: new Date(0).toISOString() } }),
    });
  });
  await page.route("**/api/v1/public/homepage-campaigns", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [], meta: { correlationId: "e2e", timestamp: new Date(0).toISOString() } }),
    }),
  );
}
