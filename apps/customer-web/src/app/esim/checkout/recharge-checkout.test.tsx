import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import Checkout, { canEnterTravelerAfterExtraction } from "./checkout-client";
const mocks = vi.hoisted(() => ({ authFetch: vi.fn(), signedIn: false }));
vi.mock("../../authenticated-api-provider", () => ({
  useAuthenticatedFetch: () => mocks.authFetch,
}));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: mocks.signedIn }),
  SignInButton: ({ children }: any) => children,
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}));
const plan = {
  id: "plan",
  name: "Asia 1GB",
  countryCode: "IN",
  countryName: "India",
  sellingPriceNpr: 100,
  dataAllowance: "1 GB",
  validityDays: 1,
  coverage: ["IN"],
};
const ok = (data: unknown) => ({ ok: true, json: async () => ({ data }) });
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/esim/checkout");
  mocks.signedIn = false;
  mocks.authFetch.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ok(plan)),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("shows a paid first-purchase receipt and honest preparation status", async () => {
  mocks.signedIn = true;
  const paid = {
    id: "paid-order",
    orderNumber: "VC-PAID",
    status: "PROVISIONING",
    purchaseType: "INITIAL_PURCHASE",
    plan,
    totalAmountNpr: 652,
    documents: [],
    payment: { provider: "KHALTI", reference: "paid-ref", status: "COMPLETED" },
  };
  mocks.authFetch.mockImplementation(async (url: string) =>
    url.endsWith("/payments/providers")
      ? ok({ providers: ["KHALTI"] })
      : ok(paid),
  );
  render(<Checkout planId="" orderId="paid-order" />);
  expect(
    await screen.findByRole("heading", { name: "Payment confirmed" }),
  ).toBeDefined();
  expect(screen.getAllByText("NPR 652").length).toBeGreaterThan(0);
  expect(
    screen.getByRole("link", { name: /View order/i }).getAttribute("href"),
  ).toBe("/account/orders/paid-order");
  expect(screen.getByText(/We’ll email the installation QR/i)).toBeDefined();
  expect(screen.queryByText("QR sent to your email")).toBeNull();
});
it("shows a confirmed recharge as data added to the existing eSIM", async () => {
  mocks.signedIn = true;
  window.history.replaceState(
    {},
    "",
    "/esim/checkout?order=topup-ready&recharge=1",
  );
  const topup = {
    id: "topup-ready",
    orderNumber: "VC-TOPUP",
    status: "QR_READY",
    purchaseType: "TOPUP",
    plan,
    totalAmountNpr: 450,
    documents: [],
    payment: {
      provider: "KHALTI",
      reference: "topup-ref",
      status: "COMPLETED",
    },
  };
  mocks.authFetch.mockImplementation(async (url: string) =>
    url.endsWith("/payments/providers")
      ? ok({ providers: ["KHALTI"] })
      : ok(topup),
  );
  render(<Checkout planId="" orderId="topup-ready" />);
  expect(
    await screen.findByText("Data has been added to your eSIM"),
  ).toBeDefined();
  expect(screen.queryByText("Ready to install")).toBeNull();
  expect(screen.getByRole("link", { name: /View my eSIM/i })).toBeDefined();
});
describe("recharge checkout", () => {
  it("restores an unpaid Fonepay QR when a pending recharge is reopened", async () => {
    window.history.replaceState(
      {},
      "",
      "/esim/checkout?order=pending-recharge&recharge=1&reference=FONEPAY-REFERENCE",
    );
    const pending = {
      id: "pending-recharge",
      orderNumber: "VC-PENDING",
      status: "PAYMENT_PENDING",
      purchaseType: "TOPUP",
      plan,
      totalAmountNpr: 100,
      documents: [],
      payment: {
        provider: "FONEPAY",
        reference: "FONEPAY-REFERENCE",
        status: "PENDING",
      },
      paymentRetry: {
        canRetry: false,
        canChangeProvider: false,
        blockedReason:
          "We are still confirming your current payment. Please check the status before starting another one.",
      },
    };
    mocks.authFetch.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (url.endsWith("/payments/providers"))
          return ok({ providers: ["FONEPAY"] });
        if (
          url.endsWith("/recharges/pending-recharge/payment/initiate") &&
          init?.method === "POST"
        )
          return ok({
            reference: "FONEPAY-REFERENCE",
            redirectUrl: "",
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            qrDataUrl: "data:image/png;base64,restored",
            qrPayload: "fonepay-qr-payload",
            websocketUrl: "",
            banks: [],
          });
        return ok(pending);
      },
    );

    render(<Checkout planId="plan" orderId="pending-recharge" />);

    expect(
      await screen.findByRole("heading", { name: "Complete your payment" }),
    ).toBeDefined();
    expect(
      screen.getByRole("img", { name: "Fonepay payment QR code" }),
    ).toHaveProperty("src", "data:image/png;base64,restored");
    expect(screen.queryByText("Payment confirmation pending")).toBeNull();
    expect(screen.queryByText("Checking Fonepay payment status")).toBeNull();
    expect(screen.queryByText(/before starting another one/i)).toBeNull();
    expect(screen.getByText("Pay within")).toBeDefined();
    expect(screen.getAllByText("NPR 100").length).toBeGreaterThan(0);
    expect(
      screen
        .getAllByText("View details")
        .every(
          (summary) =>
            summary.closest("details")?.hasAttribute("open") === false,
        ),
    ).toBe(true);
    expect(
      mocks.authFetch.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith(
            "/recharges/pending-recharge/payment/initiate",
          ) && init?.method === "POST",
      ),
    ).toBe(true);
  });

  it("surfaces the server's blocked message when a new payment is declared unsafe", async () => {
    window.history.replaceState(
      {},
      "",
      "/esim/checkout?order=pending-recharge&recharge=1&reference=FONEPAY-REFERENCE",
    );
    const pending = {
      id: "pending-recharge",
      orderNumber: "VC-PENDING",
      status: "PAYMENT_PENDING",
      purchaseType: "TOPUP",
      plan,
      totalAmountNpr: 100,
      documents: [],
      payment: {
        provider: "FONEPAY",
        reference: "FONEPAY-REFERENCE",
        status: "PENDING",
        qrDataUrl: "data:image/png;base64,restored",
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
      paymentRetry: { canRetry: false, canChangeProvider: false },
    };
    mocks.authFetch.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (url.endsWith("/payments/providers"))
          return ok({ providers: ["FONEPAY"] });
        if (
          url.endsWith("/recharges/pending-recharge/payment/initiate") &&
          init?.method === "POST"
        )
          return ok({
            reference: "FONEPAY-REFERENCE",
            redirectUrl: "",
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            qrDataUrl: "data:image/png;base64,restored",
          });
        if (url.endsWith("/payment/verify"))
          return {
            ok: false,
            status: 409,
            json: async () => ({
              error: {
                code: "PAYMENT_RETRY_NOT_SAFE",
                message: "A payment is still being confirmed for this order.",
              },
            }),
          };
        return ok(pending);
      },
    );

    render(<Checkout planId="plan" orderId="pending-recharge" />);
    await screen.findByRole("heading", { name: "Complete your payment" });
    fireEvent.click(
      screen.getByRole("button", { name: "Check payment status" }),
    );
    await screen.findByText(
      /A previous payment must be confirmed before a new attempt is safe/,
    );
    // The silent verification's competing request also ended on the same
    // verdict; the manual check fully stopped instead of showing "pending".
    expect(screen.queryByText("Checking Fonepay payment status")).toBeNull();
  });

  it("restores provider choices after a resumed payment becomes safely retryable", async () => {
    const failed = {
      id: "failed-order",
      orderNumber: "VC-FAILED",
      status: "PAYMENT_FAILED",
      purchaseType: "INITIAL_PURCHASE",
      plan,
      totalAmountNpr: 100,
      documents: [],
      documentReviewStatus: "VERIFIED",
      payment: {
        provider: "FONEPAY",
        reference: "OLDREFERENCE",
        status: "FAILED",
      },
      paymentRetry: { canRetry: true, canChangeProvider: true },
    };
    mocks.authFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/payments/providers"))
        return ok({ providers: ["KHALTI", "FONEPAY"] });
      return ok(failed);
    });

    render(<Checkout planId="plan" orderId="failed-order" />);

    expect(
      await screen.findByRole("button", { name: /Khalti wallet/i }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: /Fonepay Mobile banking/i }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", {
        name: /completed payment.*check status/i,
      }),
    ).toBeNull();
  });

  it.each([false, true])(
    "skips account selection and keeps recovery after payment initiation fails (signed in: %s)",
    async (signedIn) => {
      mocks.signedIn = signedIn;
      const created = {
        id: "recharge",
        orderNumber: "VC-TEST",
        status: "DRAFT",
        purchaseType: "TOPUP",
        plan,
        totalAmountNpr: 100,
        documents: [],
      };
      mocks.authFetch.mockImplementation(async (url: string) => {
        if (url.endsWith("/payments/providers"))
          return ok({ providers: ["KHALTI"] });
        if (url.endsWith("/recharges"))
          return ok({
            order: created,
            token: "session",
            recovery: { token: "recovery", expiresAt: "2027-01-01" },
          });
        if (url.endsWith("/payment/initiate"))
          throw new Error("Payment network unavailable");
        return ok(created);
      });
      render(
        <Checkout
          planId="plan"
          orderId=""
          mobile="123456789"
          lookupToken="lookup"
          targetCountry="IN"
        />,
      );
      fireEvent.click(await screen.findByRole("checkbox"));
      fireEvent.click(
        screen.getByRole("button", { name: "Continue to payment" }),
      );
      await waitFor(() =>
        expect(
          mocks.authFetch.mock.calls.some(([url]) =>
            String(url).endsWith("/payment/initiate"),
          ),
        ).toBe(true),
      );
      expect(screen.queryByText("How would you like to continue?")).toBeNull();
      expect(screen.queryByText("Save to My eSIMs")).toBeNull();
      if (signedIn) {
        expect(
          screen.queryByRole("button", { name: "Copy private link" }),
        ).toBeNull();
      } else {
        expect(
          screen.getByRole("button", { name: "Copy private link" }),
        ).toBeDefined();
        expect(window.location.hash).toBe("#resume=recovery");
      }
      expect(screen.getByRole("status").classList).toContain(
        "recharge-status-card",
      );
      const request = mocks.authFetch.mock.calls.find(([url]) =>
        String(url).endsWith("/recharges"),
      )!;
      const body = JSON.parse(request[1].body);
      expect(body.lookupToken).toBe("lookup");
      expect(body.checkoutAttemptKey).toHaveLength(36);
      expect(body).not.toHaveProperty("customerId");
      expect(window.location.search).toContain("order=recharge");
    },
  );
  it("preserves a checkout attempt after a lost creation response and reload", async () => {
    mocks.authFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/payments/providers"))
        return ok({ providers: ["KHALTI"] });
      throw new Error("Connection lost");
    });
    const props = {
      planId: "plan",
      orderId: "",
      mobile: "123456789",
      lookupToken: "lookup",
      targetCountry: "IN",
    };
    const first = render(<Checkout {...props} />);
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to payment" }),
    );
    await waitFor(() =>
      expect(
        mocks.authFetch.mock.calls.some(([url]) =>
          String(url).endsWith("/recharges"),
        ),
      ).toBe(true),
    );
    const initial = JSON.parse(
      mocks.authFetch.mock.calls.find(([url]) =>
        String(url).endsWith("/recharges"),
      )![1].body,
    ).checkoutAttemptKey;
    first.unmount();
    mocks.authFetch.mockClear();
    render(<Checkout {...props} />);
    const restoredConsent = (await screen.findByRole(
      "checkbox",
    )) as HTMLInputElement;
    expect(restoredConsent.checked).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to payment" }),
    );
    await waitFor(() =>
      expect(
        mocks.authFetch.mock.calls.some(([url]) =>
          String(url).endsWith("/recharges"),
        ),
      ).toBe(true),
    );
    expect(
      JSON.parse(
        mocks.authFetch.mock.calls.find(([url]) =>
          String(url).endsWith("/recharges"),
        )![1].body,
      ).checkoutAttemptKey,
    ).toBe(initial);
  });
});

describe("first-purchase document verification", () => {
  it("does not open traveller entry when an expired replacement passport is rejected", () => {
    expect(
      canEnterTravelerAfterExtraction({
        documentReviewStatus: "REUPLOAD_REQUIRED",
        passportExtraction: {
          status: "MANUAL_ENTRY_REQUIRED",
          failureCode: "PASSPORT_EXPIRED",
        },
      }),
    ).toBe(false);
    expect(
      canEnterTravelerAfterExtraction({
        documentReviewStatus: "NOT_STARTED",
        passportExtraction: {
          status: "MANUAL_ENTRY_REQUIRED",
          failureCode: "PASSPORT_EXPIRED",
        },
      }),
    ).toBe(false);
    expect(
      canEnterTravelerAfterExtraction({
        documentReviewStatus: "NOT_STARTED",
        passportExtraction: {
          status: "MANUAL_ENTRY_REQUIRED",
          failureCode: "OCR_UNAVAILABLE",
        },
      }),
    ).toBe(true);
  });

  it("explains an expired passport inline and marks it for replacement", async () => {
    mocks.authFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/payments/providers"))
        return ok({ providers: ["KHALTI"] });
      return ok({
        id: "expired-passport",
        orderNumber: "VC-EXPIRED",
        status: "DRAFT",
        purchaseType: "INITIAL_PURCHASE",
        plan,
        totalAmountNpr: 100,
        traveler: null,
        documentReviewStatus: "NOT_STARTED",
        passportVerification: {
          status: "FAILED",
          detail: "The uploaded passport has expired",
        },
        passportExtraction: {
          status: "MANUAL_ENTRY_REQUIRED",
          fields: { passportExpiryDate: "2020-01-01" },
          fieldsRequiringInput: [],
          failureCode: "PASSPORT_EXPIRED",
        },
        documents: [
          {
            type: "PASSPORT",
            status: "PENDING",
            fileName: "expired-passport.png",
            uploadVerified: true,
          },
          {
            type: "TICKET",
            status: "PENDING",
            fileName: "ticket.png",
            uploadVerified: true,
          },
        ],
      });
    });

    render(<Checkout planId="plan" orderId="expired-passport" />);

    expect(
      await screen.findByText("Passport needs a new upload"),
    ).toBeDefined();
    expect(
      screen.getAllByText(
        "This passport has expired. Upload a valid passport before continuing.",
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Replace passport")).toBeDefined();
    expect(
      screen.queryByRole("heading", { name: "Traveller information" }),
    ).toBeNull();

    expect(
      screen.getByRole("heading", { name: "Travel documents" }),
    ).toBeDefined();
  });

  it("restores saved traveller names when a partial extraction omitted them", async () => {
    mocks.authFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/payments/providers"))
        return ok({ providers: ["KHALTI"] });
      return ok({
        id: "partial-extraction",
        orderNumber: "VC-PARTIAL",
        status: "DRAFT",
        purchaseType: "INITIAL_PURCHASE",
        plan,
        totalAmountNpr: 100,
        traveler: {
          firstName: "Anish",
          surname: "Ghimire",
          dateOfBirth: "1983-07-30",
          passportNumber: "PA0319064",
          passportExpiryDate: "2032-05-03",
          nationality: "NP",
        },
        documentReviewStatus: "NOT_STARTED",
        passportExtraction: {
          status: "PARTIAL",
          fields: {
            dateOfBirth: "1983-07-30",
            passportNumber: "PA0319064",
            passportExpiryDate: "2032-05-03",
            nationality: "NP",
          },
          fieldsRequiringInput: ["firstName", "surname"],
        },
        documents: [
          { type: "PASSPORT", uploadVerified: true },
          { type: "TICKET", uploadVerified: true },
        ],
      });
    });

    render(<Checkout planId="plan" orderId="partial-extraction" />);

    await screen.findByRole("heading", { name: "Traveller information" });
    expect(screen.getByRole("textbox", { name: "First name" })).toHaveProperty(
      "value",
      "Anish",
    );
    expect(screen.getByRole("textbox", { name: "Surname" })).toHaveProperty(
      "value",
      "Ghimire",
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("heading", { name: "Travel documents" });
    expect(screen.getByLabelText("Passport", { exact: true })).toBeDefined();
    expect(new URLSearchParams(window.location.search).get("step")).toBe("2");
    expect(
      screen.queryByRole("heading", { name: "Choose payment method" }),
    ).toBeNull();
  });

  it("prefills passport fields but leaves non-passport traveller data for confirmation", async () => {
    mocks.authFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/payments/providers"))
        return ok({ providers: ["KHALTI"] });
      return ok({
        id: "extracted",
        orderNumber: "VC-EXTRACTED",
        status: "DRAFT",
        purchaseType: "NEW",
        plan,
        totalAmountNpr: 100,
        traveler: null,
        documentReviewStatus: "NOT_STARTED",
        passportExtraction: {
          status: "READY",
          fields: {
            firstName: "ANISH",
            surname: "GHIMIRE",
            passportNumber: "PA1234567",
          },
          fieldsRequiringInput: ["nationality"],
        },
        documents: [
          { type: "PASSPORT", uploadVerified: true },
          { type: "TICKET", uploadVerified: true },
        ],
      });
    });

    render(<Checkout planId="plan" orderId="extracted" />);

    await screen.findByRole("heading", { name: "Traveller information" });
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "First name" }),
      ).toHaveProperty("value", "ANISH"),
    );
    expect(screen.getByRole("textbox", { name: "Surname" })).toHaveProperty(
      "value",
      "GHIMIRE",
    );
    expect(
      screen.getByRole("textbox", { name: "Passport number" }),
    ).toHaveProperty("value", "PA1234567");
    expect(
      screen.getByRole("textbox", { name: "City / district" }),
    ).toHaveProperty("value", "");
    expect(
      screen.queryByRole("heading", { name: "Choose payment method" }),
    ).toBeNull();
  });

  it.each([false, true])(
    "focuses recovery on traveller details and passport while keeping other documents changeable (signed in: %s)",
    async (signedIn) => {
      mocks.signedIn = signedIn;
      mocks.authFetch.mockImplementation(async (url: string) => {
        if (url.endsWith("/payments/providers"))
          return ok({ providers: ["KHALTI"] });
        return ok({
          id: "recovery",
          orderNumber: "VC-RECOVERY",
          status: "DRAFT",
          purchaseType: "NEW",
          plan,
          totalAmountNpr: 100,
          traveler: { firstName: "Traveller" },
          documentReviewStatus: "REUPLOAD_REQUIRED",
          timeline: [
            {
              reason:
                "PASSPORT: The photo page is cropped (requested by staff-1)",
            },
          ],
          passportVerification: { status: "FAILED" },
          documents: [
            {
              type: "PASSPORT",
              status: "REUPLOAD_REQUIRED",
              fileName: "old-passport.png",
              uploadVerified: true,
            },
            {
              type: "TICKET",
              status: "UPLOADED",
              fileName: "ticket.png",
              uploadVerified: true,
            },
          ],
        });
      });
      render(<Checkout planId="plan" orderId="recovery" />);
      await screen.findByRole("heading", { name: "Travel documents" });
      expect(
        await screen.findByText("Passport needs a new upload"),
      ).toBeDefined();
      expect(screen.getByText("The photo page is cropped")).toBeDefined();
      expect(
        screen.getByRole("button", { name: "Check traveller details" }),
      ).toBeDefined();
      expect(screen.getByText("ticket.png")).toBeDefined();
      expect(screen.queryByLabelText("Travel ticket")).toBeNull();
      expect(screen.getByText("Kept on file")).toBeDefined();
      expect(screen.getByLabelText("Passport", { exact: true })).toBeDefined();
      fireEvent.click(
        screen.getByRole("button", { name: "Check traveller details" }),
      );
      await screen.findByRole("heading", { name: "Traveller information" });
      expect(window.location.search).toContain("step=3");
    },
  );

  it.each([false, true])(
    "uses the same verification journey and compact success state (signed in: %s)",
    async (signedIn) => {
      mocks.signedIn = signedIn;
      let reads = 0;
      mocks.authFetch.mockImplementation(async (url: string) => {
        if (url.endsWith("/payments/providers"))
          return ok({ providers: ["KHALTI"] });
        reads += 1;
        return ok({
          id: "first",
          orderNumber: "VC-FIRST",
          status: "DRAFT",
          purchaseType: "NEW",
          plan,
          totalAmountNpr: 100,
          traveler: { firstName: "Traveller" },
          documentReviewStatus: reads === 1 ? "OCR_PENDING" : "VERIFIED",
          passportVerification: {
            status: reads === 1 ? "OCR_PENDING" : "VERIFIED",
          },
          documents: [
            {
              type: "PASSPORT",
              status: "UPLOADED",
              fileName: "passport.png",
              uploadVerified: true,
            },
            {
              type: "TICKET",
              status: "UPLOADED",
              fileName: "ticket.png",
              uploadVerified: true,
            },
          ],
        });
      });
      const { container } = render(<Checkout planId="plan" orderId="first" />);
      await screen.findByRole(
        "heading",
        { name: "Choose payment method" },
        { timeout: 12_000 },
      );
      expect(container.querySelector('input[type="file"]')).toBeNull();
      expect(
        mocks.authFetch.mock.calls.some(([url]) =>
          url.endsWith("/verify-passport"),
        ),
      ).toBe(false);
    },
    15_000,
  );

  it("describes an order refresh neutrally before its saved stage is known", async () => {
    mocks.signedIn = true;
    mocks.authFetch.mockImplementation(
      () => new Promise<Response>(() => undefined),
    );

    render(<Checkout planId="plan" orderId="first" />);

    expect(
      await screen.findByRole("status", { name: "Restoring your order" }),
    ).toBeDefined();
    expect(screen.queryByText(/verifying your khalti payment/i)).toBeNull();
  });

  it("shows a retry screen instead of a zero-price payment step when an order cannot be restored", async () => {
    mocks.signedIn = true;
    let orderRequests = 0;
    mocks.authFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/payments/providers"))
        return ok({ providers: ["KHALTI"] });
      if (url.endsWith("/customer/orders/first")) {
        orderRequests += 1;
        if (orderRequests === 1)
          return {
            ok: false,
            status: 503,
            json: async () => ({
              error: {
                code: "SERVICE_UNAVAILABLE",
                message: "Temporarily unavailable",
              },
            }),
          };
        return ok({
          id: "first",
          orderNumber: "VC-FIRST",
          status: "DRAFT",
          purchaseType: "INITIAL_PURCHASE",
          plan,
          totalAmountNpr: 100,
          documents: [],
          documentReviewStatus: "NOT_STARTED",
        });
      }
      return ok({});
    });

    render(<Checkout planId="" orderId="first" />);

    expect(
      await screen.findByRole("heading", {
        name: "We couldn’t restore your order",
      }),
    ).toBeDefined();
    expect(screen.queryByText("NPR 0")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { name: "Travel documents" }),
    ).toBeDefined();
    expect(orderRequests).toBe(2);
  });

  it("allows first-time traveller entry while uploaded documents await manual review", async () => {
    mocks.signedIn = true;
    mocks.authFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/payments/providers"))
        return ok({ providers: ["KHALTI"] });
      return ok({
        id: "first",
        orderNumber: "VC-FIRST",
        status: "DRAFT",
        purchaseType: "INITIAL_PURCHASE",
        plan,
        totalAmountNpr: 100,
        documentReviewStatus: "MANUAL_REVIEW",
        passportExtraction: { status: "MANUAL_ENTRY_REQUIRED", fields: {} },
        documents: [
          {
            type: "PASSPORT",
            status: "PENDING",
            fileName: "passport.jpg",
            uploadVerified: true,
          },
          {
            type: "TICKET",
            status: "PENDING",
            fileName: "ticket.jpg",
            uploadVerified: true,
          },
        ],
      });
    });

    render(<Checkout planId="" orderId="first" />);

    expect(
      await screen.findByRole("heading", { name: "Traveller information" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Save and continue" }),
    ).toBeDefined();
    expect(
      screen.queryByText(
        "These identity details are read-only while the review is open.",
      ),
    ).toBeNull();
  });

  it("restores a submitted manual review as its own screen instead of the traveller form", async () => {
    mocks.signedIn = true;
    mocks.authFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/payments/providers"))
        return ok({ providers: ["KHALTI"] });
      return ok({
        id: "review-order",
        orderNumber: "VC-REVIEW",
        status: "DRAFT",
        purchaseType: "INITIAL_PURCHASE",
        plan,
        totalAmountNpr: 100,
        documentReviewStatus: "MANUAL_REVIEW",
        passportExtraction: {
          status: "MANUAL_ENTRY_REQUIRED",
          fields: {},
          failureCode: "MRZ_REVIEW_REQUIRED",
        },
        traveler: {
          firstName: "Jane",
          middleName: "",
          surname: "Doe",
          dateOfBirth: "1990-01-01",
          passportNumber: "P1234567",
          passportExpiryDate: "2030-01-01",
          nationality: "NP",
        },
        documents: [
          { type: "PASSPORT", status: "PENDING", uploadVerified: true },
          { type: "TICKET", status: "PENDING", uploadVerified: true },
        ],
      });
    });

    render(<Checkout planId="" orderId="review-order" />);

    expect(
      await screen.findByRole("heading", {
        name: "Your documents are awaiting approval",
      }),
    ).toBeDefined();
    expect(screen.getByText("Payment after approval")).toBeDefined();
    expect(
      screen.queryByRole("heading", { name: "Traveller information" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Awaiting approval" }),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: /report an error/i }),
    ).toBeDefined();
  });

  it("lets a guest confirm a passport mismatch and enter manual review", async () => {
    sessionStorage.setItem("vc_guest_token_mismatch-order", "guest-session");
    const traveler = {
      title: "MR",
      firstName: "Samir",
      surname: "Majhi",
      dateOfBirth: "1983-07-30",
      passportNumber: "PA031964",
      passportExpiryDate: "2032-05-03",
      nationality: "NP",
    };
    const mismatchOrder = {
      id: "mismatch-order",
      orderNumber: "VC-MISMATCH",
      status: "DRAFT",
      purchaseType: "INITIAL_PURCHASE",
      plan,
      totalAmountNpr: 100,
      documentReviewStatus: "CORRECTION_REQUIRED",
      passportVerification: {
        status: "FAILED",
        mismatchedFields: ["firstName", "surname"],
      },
      passportExtraction: {
        status: "READY",
        fields: { firstName: "Resham", surname: "Bishwokarma" },
      },
      traveler,
      documents: [
        { type: "PASSPORT", status: "PENDING", uploadVerified: true },
        { type: "TICKET", status: "PENDING", uploadVerified: true },
      ],
    };
    mocks.authFetch.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (url.endsWith("/payments/providers"))
          return ok({ providers: ["KHALTI"] });
        if (
          url.endsWith(
            "/guest/orders/mismatch-order/confirm-passport-details",
          ) &&
          init?.method === "POST"
        )
          return ok({
            ...mismatchOrder,
            documentReviewStatus: "MANUAL_REVIEW",
          });
        return ok(mismatchOrder);
      },
    );

    render(<Checkout planId="" orderId="mismatch-order" />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "I checked—my details are correct",
      }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Your documents are awaiting approval",
      }),
    ).toBeDefined();
    expect(
      mocks.authFetch.mock.calls.some(([url]) =>
        String(url).endsWith(
          "/guest/orders/mismatch-order/confirm-passport-details",
        ),
      ),
    ).toBe(true);
  });

  it("restores a guest review from its private URL after tab storage is lost", async () => {
    window.history.replaceState(
      {},
      "",
      "/esim/checkout?order=guest-review#resume=private-token",
    );
    const reviewed = {
      id: "guest-review",
      orderNumber: "VC-GUEST",
      status: "DRAFT",
      purchaseType: "INITIAL_PURCHASE",
      plan,
      totalAmountNpr: 100,
      documentReviewStatus: "MANUAL_REVIEW",
      traveler: { firstName: "Samir", surname: "Majhi" },
      documents: [],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/guest/orders/guest-review/recover")
          ? ok({
              order: reviewed,
              token: "new-session",
              recoveryExpiresAt: "2027-01-01",
            })
          : ok(plan),
      ),
    );
    mocks.authFetch.mockImplementation(async (url: string) =>
      url.endsWith("/payments/providers")
        ? ok({ providers: ["KHALTI"] })
        : ok(reviewed),
    );

    render(<Checkout planId="" orderId="guest-review" />);

    expect(
      await screen.findByRole("heading", {
        name: "Your documents are awaiting approval",
      }),
    ).toBeDefined();
    expect(sessionStorage.getItem("vc_guest_token_guest-review")).toBe(
      "new-session",
    );
    expect(window.location.hash).toBe("#resume=private-token");
    expect(
      mocks.authFetch.mock.calls.some(([url]) =>
        String(url).endsWith("/guest/orders/guest-review"),
      ),
    ).toBe(true);
  });

  it("shows mismatch confirmation failures beside the comparison, not in a bottom-sheet dialog", async () => {
    sessionStorage.setItem("vc_guest_token_mismatch-order", "guest-session");
    const mismatchOrder = {
      id: "mismatch-order",
      orderNumber: "VC-MISMATCH",
      status: "DRAFT",
      purchaseType: "INITIAL_PURCHASE",
      plan,
      totalAmountNpr: 100,
      documentReviewStatus: "CORRECTION_REQUIRED",
      passportVerification: {
        status: "FAILED",
        mismatchedFields: ["firstName"],
      },
      passportExtraction: { status: "READY", fields: { firstName: "Resham" } },
      traveler: { firstName: "Samir" },
      documents: [],
    };
    mocks.authFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/payments/providers"))
        return ok({ providers: ["KHALTI"] });
      if (url.endsWith("/confirm-passport-details"))
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: { code: "CONFLICT" } }),
        };
      return ok(mismatchOrder);
    });

    render(<Checkout planId="" orderId="mismatch-order" />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "I checked—my details are correct",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveProperty(
      "className",
      "passport-mismatch-error",
    );
    expect(screen.getByText(/Save them and compare again/i)).toBeDefined();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("moves from the dedicated review screen to payment after approval arrives", async () => {
    mocks.signedIn = true;
    const manualOrder = {
      id: "review-order",
      orderNumber: "VC-REVIEW",
      status: "DRAFT",
      purchaseType: "INITIAL_PURCHASE",
      plan,
      totalAmountNpr: 100,
      documentReviewStatus: "MANUAL_REVIEW",
      passportVerification: { status: "NOT_READY" },
      traveler: {
        firstName: "Jane",
        middleName: "",
        surname: "Doe",
        dateOfBirth: "1990-01-01",
        passportNumber: "P1234567",
        passportExpiryDate: "2030-01-01",
        nationality: "NP",
      },
      documents: [
        { type: "PASSPORT", status: "PENDING", uploadVerified: true },
        { type: "TICKET", status: "PENDING", uploadVerified: true },
      ],
    };
    let resolveReview: ((value: ReturnType<typeof ok>) => void) | undefined;
    let orderRequests = 0;
    mocks.authFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/payments/providers"))
        return ok({ providers: ["KHALTI"] });
      orderRequests += 1;
      if (orderRequests === 1) return ok(manualOrder);
      return new Promise<ReturnType<typeof ok>>((resolve) => {
        resolveReview = resolve;
      });
    });

    render(<Checkout planId="" orderId="review-order" />);
    expect(
      await screen.findByRole("heading", {
        name: "Your documents are awaiting approval",
      }),
    ).toBeDefined();
    await waitFor(() => expect(resolveReview).toBeDefined());
    await act(async () => {
      resolveReview!(
        ok({
          ...manualOrder,
          documentReviewStatus: "MANUALLY_APPROVED",
          passportVerification: { status: "VERIFIED" },
        }),
      );
    });
    expect(
      await screen.findByRole("heading", { name: "Choose payment method" }),
    ).toBeDefined();
  });

  it("restores accepted checkout consent within the active tab", async () => {
    sessionStorage.setItem("vc_checkout_consent:v1:plan", "accepted");
    mocks.authFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/payments/providers"))
        return ok({ providers: ["KHALTI"] });
      return ok(plan);
    });

    render(<Checkout planId="plan" orderId="" />);

    const confirmations = await screen.findAllByRole("checkbox");
    expect(confirmations).toHaveLength(2);
    expect(
      confirmations.every((checkbox) => (checkbox as HTMLInputElement).checked),
    ).toBe(true);
  });

  it("moves backward one valid step and keeps prior consent selected", async () => {
    mocks.signedIn = true;
    const savedDraft = {
      id: "first",
      orderNumber: "VC-FIRST",
      status: "DRAFT",
      purchaseType: "INITIAL_PURCHASE",
      plan,
      totalAmountNpr: 100,
      traveler: { firstName: "Samira" },
      documentReviewStatus: "NOT_STARTED",
      documents: [],
    };
    mocks.authFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/payments/providers"))
        return ok({ providers: ["KHALTI", "FONEPAY"] });
      return ok(savedDraft);
    });

    render(<Checkout planId="plan" orderId="first" />);

    await screen.findByRole("heading", { name: "Travel documents" });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("heading", { name: "Confirm your device" });
    expect(
      screen
        .getAllByRole("checkbox")
        .every((checkbox) => (checkbox as HTMLInputElement).checked),
    ).toBe(true);
    expect(new URLSearchParams(window.location.search).get("step")).toBe("1");
  });

  it.each([false, true])("returns an unchanged verified traveller to payment without another request (signed in: %s)", async (signedIn) => {
    mocks.signedIn = signedIn;
    const saved = {
      id: "verified-order", orderNumber: "VC-VERIFIED", status: "DRAFT",
      purchaseType: "INITIAL_PURCHASE", plan, totalAmountNpr: 100,
      documentReviewStatus: "VERIFIED",
      passportVerification: { status: "VERIFIED", matchedFields: [] },
      traveler: {
        title: "MR", firstName: "Resham", middleName: "", surname: "Kumar",
        dateOfBirth: "1983-07-30", nationality: "NP", city: "Kathmandu",
        countryOfResidence: "NP", employerOrBusinessName: "", email: "r@example.com",
        mobile: "+9779800000000", passportNumber: "PA031964",
        passportExpiryDate: "2032-05-03", pointOfSaleCode: "",
      },
      documents: ["PASSPORT", "TICKET"].map((type) => ({ type, status: "APPROVED", uploadVerified: true, fileName: `${type}.png` })),
    };
    const request = vi.fn(async (url: string) =>
      url.endsWith("/payments/providers") ? ok({ providers: ["KHALTI"] }) : ok(saved));
    mocks.authFetch.mockImplementation(request);
    render(<Checkout planId="" orderId="verified-order" />);
    await screen.findByRole("button", { name: "Back to documents" });
    fireEvent.click(screen.getByRole("button", { name: "Back to documents" }));
    fireEvent.click(await screen.findByRole("button", { name: "Review traveller details" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save and continue" }));
    expect(await screen.findByRole("button", { name: "Back to documents" })).toBeDefined();
    expect(request.mock.calls.some(([url]) => url.endsWith("/traveler") || url.endsWith("/verify-passport"))).toBe(false);
  });
});
