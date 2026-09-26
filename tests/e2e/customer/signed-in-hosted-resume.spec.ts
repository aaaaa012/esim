import { expect, test } from "@playwright/test";

test("signed-in hosted checkout resumes the same verified order after back and refresh", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("customer-signed-in-"), "Requires the signed-in customer fixture");
  test.setTimeout(120_000);
  const token = "account-hosted-token";
  const order = {
    id: "account-hosted-order",
    orderNumber: "VC-ACCOUNT-HOSTED",
    orderType: "INITIAL_PURCHASE",
    status: "DRAFT",
    amountNpr: 652,
    currency: "NPR",
    plan: { id: "fr-3gb", name: "France 3 GB", countryCode: "FR", dataAllowance: "3 GB", validityDays: 30 },
    traveler: {
      title: "MR", firstName: "Resham", middleName: "", surname: "Kumar",
      dateOfBirth: "1983-07-30", nationality: "NP", city: "Kathmandu",
      countryOfResidence: "NP", employerOrBusinessName: "", email: "traveller@example.com",
      mobile: "+9779800000000", passportNumber: "PA031964", passportExpiryDate: "2032-05-03",
    },
    travelerComplete: true,
    documentReviewStatus: "VERIFIED",
    replacementReasons: {},
    requiredDocuments: ["PASSPORT", "TICKET"],
    documents: [
      { id: "passport", type: "PASSPORT", status: "UPLOADED", fileName: "passport.png", uploadVerified: true, passportVerificationStatus: "VERIFIED" },
      { id: "ticket", type: "TICKET", status: "UPLOADED", fileName: "ticket.png", uploadVerified: true },
    ],
  };
  const session = { sessionId: "account-session", expiresAt: "2027-01-01", partner: { name: "Travel partner" }, order };
  let travelerWrites = 0;
  let verificationRequests = 0;
  await page.addInitScript(() => {
    sessionStorage.setItem("hosted-checkout-consent:v1:account-hosted-token", "accepted");
    sessionStorage.setItem("hosted-checkout-access-mode:v1:account-hosted-token", "account");
  });
  await page.route(`**/api/v1/partner-checkout/${token}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: session }) }),
  );
  await page.route(`**/api/v1/partner-checkout/${token}/traveler`, (route) => {
    travelerWrites += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: session }) });
  });
  await page.route(`**/api/v1/partner-checkout/${token}/verify-passport`, (route) => {
    verificationRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { status: "VERIFIED" } }) });
  });
  await page.route("**/api/v1/payments/providers", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { providers: ["KHALTI"] } }) }),
  );

  await page.goto(`/partner-checkout/${token}?step=4`);
  await page.getByRole("button", { name: "Back to documents" }).click();
  await page.getByRole("button", { name: "Review traveller details" }).click();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("button", { name: "Back to documents" })).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Back to documents" })).toBeVisible();
  expect(travelerWrites).toBe(0);
  expect(verificationRequests).toBe(0);
});

test("signed-in direct checkout preserves verification on unchanged back and forward navigation", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("customer-signed-in-"), "Requires the signed-in customer fixture");
  test.setTimeout(120_000);
  const id = "account-direct-order";
  const order = {
    id,
    orderNumber: "VC-2026-ACCOUNT",
    status: "DRAFT",
    purchaseType: "INITIAL_PURCHASE",
    totalAmountNpr: 652,
    plan: { id: "fr-3gb", countryCode: "FR", countryName: "France", name: "France 3 GB", dataAllowance: "3 GB", allowanceMb: 3072, validityDays: 30, sellingPriceNpr: 652, coverage: ["FR"], popular: false },
    traveler: {
      title: "MR", firstName: "Resham", middleName: "", surname: "Kumar", dateOfBirth: "1983-07-30",
      nationality: "NP", city: "Kathmandu", countryOfResidence: "NP", employerOrBusinessName: "",
      email: "traveller@example.com", mobile: "+9779800000000", passportNumber: "PA031964",
      passportExpiryDate: "2032-05-03", pointOfSaleCode: "WEB-NP",
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
  await page.route(`**/api/v1/customer/orders/${id}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: order }) }),
  );
  await page.route(`**/api/v1/customer/orders/${id}/traveler`, (route) => {
    travelerWrites += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: order }) });
  });
  await page.route(`**/api/v1/customer/orders/${id}/verify-passport`, (route) => {
    passportChecks += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: order }) });
  });
  await page.route("**/api/v1/payments/providers", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { providers: ["KHALTI"] } }) }),
  );

  await page.goto(`/esim/checkout?order=${id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Back to documents" }).click();
  await page.getByRole("button", { name: "Review traveller details" }).click();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("button", { name: "Back to documents" })).toBeVisible();
  expect(travelerWrites).toBe(0);
  expect(passportChecks).toBe(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Back to documents" })).toBeVisible();
});
