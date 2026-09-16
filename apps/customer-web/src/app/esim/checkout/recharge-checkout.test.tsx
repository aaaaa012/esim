import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import Checkout from "./checkout-client";
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
    expect(screen.getByText("Pay within")).toBeDefined();
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
    mocks.authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
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
    });

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
      expect(
        screen.getByRole("button", { name: "Copy private link" }),
      ).toBeDefined();
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
        await screen.findByRole("alertdialog", {
          name: "Document check needs attention",
        }),
      ).toBeDefined();
      expect(
        screen.queryByText("One or more documents need replacement"),
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: "Check traveller details" }),
      ).toBeDefined();
      expect(screen.getByText("ticket.png")).toBeDefined();
      expect(screen.queryByLabelText("Travel ticket")).toBeNull();
      fireEvent.click(screen.getAllByRole("button", { name: "Change" })[0]!);
      expect(screen.getByLabelText("Travel ticket")).toBeDefined();
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
        { timeout: 5000 },
      );
      expect(container.querySelector('input[type="file"]')).toBeNull();
      expect(
        mocks.authFetch.mock.calls.some(([url]) =>
          url.endsWith("/verify-passport"),
        ),
      ).toBe(false);
    },
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
});
