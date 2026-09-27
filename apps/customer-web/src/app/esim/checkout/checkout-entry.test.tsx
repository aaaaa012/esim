import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import CheckoutEntry from "./checkout-entry";

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  signedIn: true,
  isLoaded: true,
  userId: "owner",
}));
vi.mock("../../authenticated-api-provider", () => ({
  useAuthenticatedFetch: () => mocks.authFetch,
}));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({
    isLoaded: mocks.isLoaded,
    isSignedIn: mocks.signedIn,
    userId: mocks.userId,
  }),
  SignInButton: ({ children }: any) => children,
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}));
const plan = {
  id: "plan",
  name: "Asia 1 GB",
  countryCode: "IN",
  countryName: "India",
  sellingPriceNpr: 100,
  dataAllowance: "1 GB",
  validityDays: 1,
};
const ok = (data: unknown) => ({ ok: true, json: async () => ({ data }) });
const targets = [
  { id: "11111111-1111-4111-8111-111111111111", label: "Travel eSIM · 1234" },
  { id: "22222222-2222-4222-8222-222222222222", label: "Travel eSIM · 5678" },
];
const created = {
  id: "recharge",
  orderNumber: "VC-RECHARGE",
  status: "DRAFT",
  purchaseType: "TOPUP",
  plan,
  totalAmountNpr: 100,
  documents: [],
};
beforeEach(() => {
  mocks.signedIn = true;
  mocks.isLoaded = true;
  mocks.userId = "owner";
  mocks.authFetch.mockReset();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/esim/checkout?plan=plan");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ok(plan)),
  );
  mocks.authFetch.mockImplementation(async (url: string) => {
    if (url.endsWith("/recharges/targets"))
      return ok({ targets: [targets[0]] });
    if (url.endsWith("/payments/providers"))
      return ok({ providers: ["KHALTI"] });
    if (url.endsWith("/recharges"))
      return ok({
        order: created,
        token: "session",
        recovery: { token: "recovery", expiresAt: "2027-01-01" },
      });
    if (url.endsWith("/payment/initiate"))
      return ok({
        reference: "payment",
        redirectUrl: "",
        expiresAt: "2027-01-01",
      });
    return ok(created);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("checkout entry routing", () => {
  it.each(["/", "/destinations?country=IN"])(
    "uses the existing eSIM for a signed-in plan purchase from %s",
    async (entry) => {
      window.history.replaceState({}, "", entry);
      render(<CheckoutEntry planId="plan" orderId="" />);
      const consent = await screen.findByRole("checkbox");
      expect(screen.queryByText("Traveller information")).toBeNull();
      expect(screen.queryByText("Device compatibility")).toBeNull();
      expect(
        screen.getByText(/Adding data to Travel eSIM · 1234/),
      ).toBeDefined();
      fireEvent.click(consent);
      fireEvent.click(
        screen.getByRole("button", { name: "Continue to payment" }),
      );
      await waitFor(() =>
        expect(
          mocks.authFetch.mock.calls.some(([url]) =>
            url.endsWith("/payment/initiate"),
          ),
        ).toBe(true),
      );
      const request = mocks.authFetch.mock.calls.find(
        ([url, init]) => url.endsWith("/recharges") && init?.method === "POST",
      )!;
      expect(JSON.parse(request[1].body)).toMatchObject({
        targetEsimId: targets[0]!.id,
        planId: "plan",
        termsAccepted: true,
        privacyAccepted: true,
      });
      expect(
        mocks.authFetch.mock.calls.some(
          ([url]) =>
            url.includes("/customer/orders") ||
            url.includes("/traveler") ||
            url.includes("/documents"),
        ),
      ).toBe(false);
    },
  );

  it("asks which eSIM to recharge when there are multiple, without creating an order", async () => {
    const impl = mocks.authFetch.getMockImplementation()!;
    mocks.authFetch.mockImplementation((url: string, init?: RequestInit) =>
      url.endsWith("/recharges/targets")
        ? Promise.resolve(ok({ targets }))
        : impl(url, init),
    );
    render(<CheckoutEntry planId="plan" orderId="" />);
    await screen.findByRole("heading", {
      name: "Choose the eSIM to add data to",
    });
    expect(
      mocks.authFetch.mock.calls.some(([, init]) => init?.method === "POST"),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Travel eSIM · 5678/ }));
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to payment" }),
    );
    await waitFor(() =>
      expect(
        mocks.authFetch.mock.calls.some(([url]) => url.endsWith("/recharges")),
      ).toBe(true),
    );
    const request = mocks.authFetch.mock.calls.find(([url]) =>
      url.endsWith("/recharges"),
    )!;
    expect(JSON.parse(request[1].body).targetEsimId).toBe(targets[1]!.id);
  });

  it("retains first-purchase checkout when the customer has no eligible eSIM", async () => {
    const impl = mocks.authFetch.getMockImplementation()!;
    mocks.authFetch.mockImplementation((url: string, init?: RequestInit) =>
      url.endsWith("/recharges/targets")
        ? Promise.resolve(ok({ targets: [] }))
        : impl(url, init),
    );
    render(<CheckoutEntry planId="plan" orderId="" />);
    await screen.findByRole("button", { name: "Continue" });
    expect(
      screen.getByRole("checkbox", {
        name: /I confirm my device is eSIM compatible/,
      }),
    ).toBeDefined();
  });

  it("keeps guests on first-purchase checkout without fetching customer targets", async () => {
    mocks.signedIn = false;
    render(<CheckoutEntry planId="plan" orderId="" />);
    await screen.findByRole("button", { name: "Continue" });
    expect(
      mocks.authFetch.mock.calls.some(([url]) =>
        url.endsWith("/recharges/targets"),
      ),
    ).toBe(false);
  });

  it("waits for sign-in to load before showing the first-purchase form", async () => {
    mocks.isLoaded = false;
    const view = render(<CheckoutEntry planId="plan" orderId="" />);
    expect(screen.getByRole("status")).toBeDefined();
    expect(screen.queryByRole("checkbox")).toBeNull();
    mocks.isLoaded = true;
    view.rerender(<CheckoutEntry planId="plan" orderId="" />);
    await screen.findByText(/Adding data to Travel eSIM · 1234/);
  });

  it("offers a retry instead of silently creating a new eSIM after a failed target lookup", async () => {
    const impl = mocks.authFetch.getMockImplementation()!;
    let tries = 0;
    mocks.authFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/recharges/targets") && ++tries === 1)
        return Promise.reject(new Error("Offline"));
      return impl(url, init);
    });
    render(<CheckoutEntry planId="plan" orderId="" />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText(/Adding data to Travel eSIM · 1234/);
  });

  it("preserves explicit Add data targets and payment-return orders", async () => {
    const view = render(
      <CheckoutEntry planId="plan" orderId="" targetEsimId={targets[1]!.id} />,
    );
    await screen.findByRole("checkbox");
    expect(
      mocks.authFetch.mock.calls.some(([url]) =>
        url.endsWith("/recharges/targets"),
      ),
    ).toBe(false);
    view.unmount();
    render(<CheckoutEntry planId="" orderId="recharge" />);
    await waitFor(() =>
      expect(
        mocks.authFetch.mock.calls.some(([url]) => url.includes("/recharge")),
      ).toBe(true),
    );
    expect(
      mocks.authFetch.mock.calls.some(([url]) =>
        url.endsWith("/recharges/targets"),
      ),
    ).toBe(false);
  });
});
