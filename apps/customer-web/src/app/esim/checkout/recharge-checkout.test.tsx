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
