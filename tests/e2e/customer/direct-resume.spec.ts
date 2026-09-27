import { expect, test } from "@playwright/test";

test("direct guest restores a verified order and navigates without another passport check", async ({ page }) => {
  test.setTimeout(90_000);
  const order = {
    id: "direct-e2e-order",
    orderNumber: "VC-2026-DIRECT",
    status: "DRAFT",
    purchaseType: "INITIAL_PURCHASE",
    totalAmountNpr: 652,
    plan: {
      id: "fr-3gb", countryCode: "FR", countryName: "France", name: "France 3 GB",
      dataAllowance: "3 GB", allowanceMb: 3072, validityDays: 30,
      sellingPriceNpr: 652, coverage: ["FR"], popular: false,
    },
    traveler: {
      title: "MR", firstName: "Resham", middleName: "", surname: "Kumar",
      dateOfBirth: "1983-07-30", nationality: "NP", city: "Kathmandu",
      countryOfResidence: "NP", employerOrBusinessName: "", email: "traveller@example.com",
      mobile: "+9779800000000", passportNumber: "PA031964", passportExpiryDate: "2032-05-03",
      pointOfSaleCode: "WEB-NP",
    },
    documentReviewStatus: "VERIFIED",
    passportVerification: { status: "VERIFIED", matchedFields: [], checkedAt: "2026-09-26T00:00:00.000Z", method: "tesseract-ocr" },
    documents: [
      { type: "PASSPORT", status: "APPROVED", fileName: "passport.png", uploadVerified: true },
      { type: "TICKET", status: "APPROVED", fileName: "ticket.png", uploadVerified: true },
    ],
  };
  let travelerWrites = 0;
  let passportChecks = 0;
  await page.route("**/api/v1/guest/orders/direct-e2e-order/recover", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { order, token: "guest-access-token", recoveryExpiresAt: "2027-01-01T00:00:00.000Z" } }) }),
  );
  await page.route("**/api/v1/guest/orders/direct-e2e-order", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: order }) }),
  );
  await page.route("**/api/v1/guest/orders/direct-e2e-order/traveler", (route) => {
    travelerWrites += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: order }) });
  });
  await page.route("**/api/v1/guest/orders/direct-e2e-order/verify-passport", (route) => {
    passportChecks += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: order }) });
  });
  await page.route("**/api/v1/payments/providers", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { providers: ["KHALTI"] } }) }),
  );
  await page.goto("/esim/checkout?order=direct-e2e-order#resume=recovery-token", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Back to documents" }).click();
  await page.getByRole("button", { name: "Review traveller details" }).click();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("button", { name: "Back to documents" })).toBeVisible();
  expect(travelerWrites).toBe(0);
  expect(passportChecks).toBe(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Back to documents" })).toBeVisible();
});
