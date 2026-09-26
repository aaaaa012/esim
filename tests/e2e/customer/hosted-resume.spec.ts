import { expect, test } from "@playwright/test";

const token = "private-token";
test.beforeEach(() => test.setTimeout(90_000));
const traveler = {
  title: "MR",
  firstName: "Resham",
  middleName: "",
  surname: "Kumar",
  dateOfBirth: "1983-07-30",
  nationality: "NP",
  city: "Kathmandu",
  countryOfResidence: "NP",
  employerOrBusinessName: "",
  email: "traveller@example.com",
  mobile: "+9779800000000",
  passportNumber: "PA031964",
  passportExpiryDate: "2032-05-03",
};

const hostedSession = {
  sessionId: "session-1",
  expiresAt: "2027-01-01T00:00:00.000Z",
  partner: { name: "Travel partner" },
  order: {
    id: "hosted-order-1",
    orderNumber: "VC-HOSTED-E2E",
    orderType: "INITIAL_PURCHASE",
    status: "DRAFT",
    amountNpr: 652,
    currency: "NPR",
    plan: {
      id: "plan-fr-1",
      name: "France 3 GB",
      countryCode: "FR",
      dataAllowance: "3 GB",
      validityDays: 30,
    },
    traveler,
    travelerComplete: true,
    documentReviewStatus: "VERIFIED",
    replacementReasons: {},
    requiredDocuments: ["PASSPORT", "TICKET"],
    documents: [
      { id: "passport-1", type: "PASSPORT", status: "UPLOADED", fileName: "passport.png", uploadVerified: true, passportVerificationStatus: "VERIFIED" },
      { id: "ticket-1", type: "TICKET", status: "UPLOADED", fileName: "ticket.png", uploadVerified: true },
    ],
  },
};

test("hosted guest can go back and forward on a verified order without re-verification", async ({ page }) => {
  let travelerWrites = 0;
  let passportChecks = 0;
  await page.addInitScript(() => {
    sessionStorage.setItem("hosted-checkout-consent:v1:private-token", "accepted");
    sessionStorage.setItem("hosted-checkout-access-mode:v1:private-token", "guest");
  });
  await page.route(`**/api/v1/partner-checkout/${token}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: hostedSession }) }),
  );
  await page.route(`**/api/v1/partner-checkout/${token}/traveler`, (route) => {
    travelerWrites += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: hostedSession }) });
  });
  await page.route(`**/api/v1/partner-checkout/${token}/verify-passport`, (route) => {
    passportChecks += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { status: "VERIFIED" } }) });
  });
  await page.route("**/api/v1/payments/providers", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { providers: ["KHALTI"] } }) }),
  );

  await page.goto(`/partner-checkout/${token}?step=4`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Back to documents" }).click();
  await page.getByRole("button", { name: "Review traveller details" }).click();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("button", { name: "Back to documents" })).toBeVisible();
  expect(travelerWrites).toBe(0);
  expect(passportChecks).toBe(0);

  await page.reload();
  await expect(page.getByRole("button", { name: "Back to documents" })).toBeVisible();
  expect(travelerWrites).toBe(0);
  expect(passportChecks).toBe(0);
});

test("hosted checkout keeps payment locked while OCR is pending", async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("hosted-checkout-consent:v1:private-token", "accepted");
    sessionStorage.setItem("hosted-checkout-access-mode:v1:private-token", "guest");
  });
  const pending = {
    ...hostedSession,
    order: { ...hostedSession.order, documentReviewStatus: "OCR_PENDING" },
  };
  await page.route(`**/api/v1/partner-checkout/${token}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: pending }) }),
  );
  await page.goto(`/partner-checkout/${token}?step=3`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Traveller information" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to Khalti" })).toHaveCount(0);
});

test("hosted replacement names the rejected document and ops reason without offering payment", async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("hosted-checkout-consent:v1:private-token", "accepted");
    sessionStorage.setItem("hosted-checkout-access-mode:v1:private-token", "guest");
  });
  const replacement = {
    ...hostedSession,
    order: {
      ...hostedSession.order,
      status: "AWAITING_CUSTOMER",
      documentReviewStatus: "REUPLOAD_REQUIRED",
      replacementReasons: { TICKET: "The itinerary date is unreadable." },
      documents: hostedSession.order.documents.map((document) =>
        document.type === "TICKET" ? { ...document, status: "REUPLOAD_REQUIRED" } : document,
      ),
    },
  };
  await page.route(`**/api/v1/partner-checkout/${token}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: replacement }) }),
  );
  await page.goto(`/partner-checkout/${token}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("The itinerary date is unreadable.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit replacement for review" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to Khalti" })).toHaveCount(0);
});

test("hosted payment return distinguishes eSIM preparation from recharge completion", async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("hosted-checkout-consent:v1:private-token", "accepted");
    sessionStorage.setItem("hosted-checkout-access-mode:v1:private-token", "guest");
  });
  let current = {
    ...hostedSession,
    order: { ...hostedSession.order, status: "PROVISIONING" },
  };
  await page.route(`**/api/v1/partner-checkout/${token}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: current }) }),
  );
  await page.goto(`/partner-checkout/${token}?step=4`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Payment confirmed" })).toBeVisible();
  await expect(page.getByText(/email the installation QR/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "Track this order" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to Khalti" })).toHaveCount(0);

  current = {
    ...hostedSession,
    order: { ...hostedSession.order, orderType: "TOPUP", status: "QR_READY" },
  };
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Payment confirmed" })).toBeVisible();
  await expect(page.getByText(/Data has been added to your eSIM/i)).toBeVisible();
  await expect(page.getByText(/email the installation QR/i)).toHaveCount(0);
});
