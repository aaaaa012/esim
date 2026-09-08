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
        screen.getByText("Passport and traveller details need checking"),
      ).toBeDefined();
      expect(
        screen.getByRole("button", { name: "Check traveller details" }),
      ).toBeDefined();
      expect(screen.getByText("ticket.png")).toBeDefined();
      expect(screen.queryByLabelText("Travel ticket")).toBeNull();
      fireEvent.click(screen.getAllByRole("button", { name: "Change" })[0]!);
      expect(screen.getByLabelText("Travel ticket")).toBeDefined();
      expect(screen.getByLabelText("Passport", { exact: true })).toBeDefined();
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
      await screen.findByRole("heading", { name: "Travel documents" });
      expect(
        screen.getByRole("list", { name: "Saved documents" }).textContent,
      ).toContain("ticket.png");
      expect(
        screen.queryByRole("heading", { name: "Choose payment method" }),
      ).toBeNull();
      const next = await screen.findByRole(
        "button",
        { name: "Continue to payment" },
        { timeout: 5000 },
      );
      expect(
        screen.getByRole("list", { name: "Document summary" }),
      ).toBeDefined();
      expect(
        screen.getByRole("button", { name: "Change documents" }),
      ).toBeDefined();
      expect(container.querySelector('input[type="file"]')).toBeNull();
      fireEvent.click(next);
      await screen.findByRole("heading", { name: "Choose payment method" });
      expect(
        mocks.authFetch.mock.calls.some(([url]) =>
          url.endsWith("/verify-passport"),
        ),
      ).toBe(false);
    },
  );
});
