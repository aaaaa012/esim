import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import HostedCheckoutClient from "./hosted-checkout-client";

const mocks = vi.hoisted(() => ({ signedIn: false, authFetch: vi.fn() }));
vi.mock("../../authenticated-api-provider", () => ({
  useAuthenticatedFetch: () => mocks.authFetch,
}));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: mocks.signedIn }),
  SignInButton: ({ children }: any) => children,
}));
const ok = (data: unknown) => ({ ok: true, json: async () => ({ data }) });
const session = (verification = "VERIFIED", status = "DRAFT") => ({
  sessionId: "session",
  expiresAt: "2027-01-01",
  partner: { name: "Travel partner" },
  order: {
    id: "order",
    orderNumber: "VC-HOSTED",
    status,
    amountNpr: 2,
    currency: "NPR",
    plan: {
      id: "plan",
      name: "India 500 MB",
      countryCode: "IN",
      dataAllowance: "500 MB",
      validityDays: 1,
    },
    travelerComplete: true,
    documentReviewStatus: verification,
    requiredDocuments: ["PASSPORT", "TICKET"],
    documents: [
      {
        id: "passport",
        type: "PASSPORT",
        status: "UPLOADED",
        fileName: "passport.png",
        uploadVerified: true,
        passportVerificationStatus: verification,
      },
      {
        id: "ticket",
        type: "TICKET",
        status: "UPLOADED",
        fileName: "ticket.png",
        uploadVerified: true,
      },
    ],
  },
});
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  sessionStorage.clear();
  sessionStorage.setItem(
    "hosted-checkout-consent:v1:private-token",
    "accepted",
  );
  window.history.replaceState({}, "", "/partner-checkout/private-token?step=3");
  mocks.signedIn = false;
  mocks.authFetch.mockReset();
  fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/payments/providers"))
      return ok({ providers: ["KHALTI", "FONEPAY"] });
    if (url.endsWith("/complete"))
      return ok({
        orderId: "order",
        orderNumber: "VC-HOSTED",
        status: "PAYMENT_PENDING",
      });
    if (url.endsWith("/payment"))
      return ok({
        reference: "payment",
        redirectUrl: "",
        expiresAt: "2027-01-01",
      });
    return ok(session());
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const acceptConsents = () =>
  screen
    .getAllByRole("checkbox")
    .forEach((checkbox) => fireEvent.click(checkbox));

describe("hosted checkout payment flow", () => {
  it.each([false, true])(
    "collects first-purchase consent at the beginning once, including after refresh (signed in: %s)",
    async (signedIn) => {
      sessionStorage.clear();
      mocks.signedIn = signedIn;
      mocks.authFetch.mockResolvedValue(ok(session()));
      const view = render(<HostedCheckoutClient token="private-token" />);
      await screen.findByRole("heading", { name: "Device compatibility" });
      expect(
        screen.getByRole("checkbox", { name: /I agree to the purchase terms/ }),
      ).toBeDefined();
      expect(screen.queryByRole("heading", { name: "Pay NPR 2" })).toBeNull();
      fireEvent.click(
        screen.getByRole("checkbox", { name: /I confirm my device/ }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Save and continue" }),
      );
      await screen.findByRole("alertdialog");
      expect(mocks.authFetch).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Dismiss message" }));
      fireEvent.click(
        screen.getByRole("checkbox", { name: /I agree to the purchase terms/ }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Save and continue" }),
      );
      if (!signedIn)
        fireEvent.click(
          await screen.findByRole("button", { name: "Continue as guest" }),
        );
      await screen.findByRole("heading", { name: "Pay NPR 2" });
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(
        (
          screen.getByRole("button", {
            name: "Continue to Khalti",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
      view.unmount();
      render(<HostedCheckoutClient token="private-token" />);
      await screen.findByRole("heading", { name: "Pay NPR 2" });
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(
        (
          screen.getByRole("button", {
            name: "Continue to Khalti",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    },
  );

  it("does not reuse consent from a different hosted checkout link", async () => {
    render(<HostedCheckoutClient token="another-token" />);
    await screen.findByRole("heading", { name: "Device compatibility" });
    expect(
      (
        screen.getByRole("checkbox", {
          name: /I agree to the purchase terms/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(screen.queryByRole("heading", { name: "Pay NPR 2" })).toBeNull();
  });

  it.each([false, true])(
    "keeps recharge consent at payment without repeating compatibility (signed in: %s)",
    async (signedIn) => {
      mocks.signedIn = signedIn;
      const recharge = {
        ...session(),
        order: {
          ...session().order,
          orderType: "TOPUP",
          documents: [],
          requiredDocuments: [],
        },
      };
      fetchMock.mockImplementation(async (url: string) =>
        url.endsWith("/payments/providers")
          ? ok({ providers: ["KHALTI"] })
          : ok(recharge),
      );
      mocks.authFetch.mockResolvedValue(ok(recharge));
      render(<HostedCheckoutClient token="private-token" />);
      await screen.findByRole("heading", { name: "Your eSIM recharge" });
      expect(screen.queryByRole("checkbox")).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "Save and continue" }),
      );
      if (!signedIn)
        fireEvent.click(
          await screen.findByRole("button", { name: "Continue as guest" }),
        );
      await screen.findByRole("heading", { name: "Pay NPR 2" });
      expect(screen.getAllByRole("checkbox")).toHaveLength(1);
      const pay = screen.getByRole("button", {
        name: "Continue to Khalti",
      }) as HTMLButtonElement;
      expect(pay.disabled).toBe(true);
      fireEvent.click(
        screen.getByRole("checkbox", { name: /I approve this eSIM recharge/ }),
      );
      expect(pay.disabled).toBe(false);
    },
  );

  it.each([false, true])(
    "offers payment methods after verification before submitting (signed in: %s)",
    async (signedIn) => {
      mocks.signedIn = signedIn;
      render(<HostedCheckoutClient token="private-token" />);
      await screen.findByRole("heading", { name: "Pay NPR 2" });
      expect(screen.queryByText("Review & confirm")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Complete order" }),
      ).toBeNull();
      expect(screen.getByText("Passport verified")).toBeDefined();
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url.endsWith("/complete") || url.endsWith("/payment"),
        ),
      ).toBe(false);
      fireEvent.click(
        screen.getByRole("button", { name: /Fonepay Mobile banking/ }),
      );
      const pay = screen.getByRole("button", {
        name: "Continue to Fonepay",
      }) as HTMLButtonElement;
      expect(pay.disabled).toBe(false);
      expect(screen.queryByRole("checkbox")).toBeNull();
      fireEvent.click(pay);
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(([url]) => url.endsWith("/payment")),
        ).toBe(true),
      );
      const paymentCall = fetchMock.mock.calls.find(([url]) =>
        url.endsWith("/payment"),
      )!;
      expect(JSON.parse(paymentCall[1].body)).toEqual({ provider: "FONEPAY" });
      const completeCall = fetchMock.mock.calls.find(([url]) =>
        url.endsWith("/complete"),
      )!;
      expect(JSON.parse(completeCall[1].body)).toEqual({
        consentAccepted: true,
        compatibilityAccepted: true,
      });
      expect(fetchMock.mock.calls.indexOf(completeCall)).toBeLessThan(
        fetchMock.mock.calls.indexOf(paymentCall),
      );
      expect(screen.queryByText("Payment confirmed")).toBeNull();
    },
  );

  it.each(["FAILED", "OCR_PENDING", "MANUAL_REVIEW"])(
    "blocks payment for %s documents",
    async (status) => {
      fetchMock.mockImplementation(async (url: string) =>
        url.endsWith("/payments/providers")
          ? ok({ providers: ["KHALTI"] })
          : ok(session(status)),
      );
      render(<HostedCheckoutClient token="private-token" />);
      await screen.findByRole("heading", { name: "Travel documents" });
      expect(
        screen.queryByRole("button", { name: "Continue to Khalti" }),
      ).toBeNull();
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url.endsWith("/complete") || url.endsWith("/payment"),
        ),
      ).toBe(false);
    },
  );

  it.each([false, true])(
    "continues from compatibility to traveller details (signed in: %s)",
    async (signedIn) => {
      sessionStorage.clear();
      mocks.signedIn = signedIn;
      const fresh = session();
      fresh.order.travelerComplete = false;
      fresh.order.documents = [];
      fetchMock.mockImplementation(async (url: string) =>
        url.endsWith("/payments/providers")
          ? ok({ providers: ["KHALTI"] })
          : ok(fresh),
      );
      mocks.authFetch.mockResolvedValue(ok(fresh));
      render(<HostedCheckoutClient token="private-token" />);
      await screen.findByRole("heading", { name: "Device compatibility" });
      acceptConsents();
      fireEvent.click(
        screen.getByRole("button", { name: "Save and continue" }),
      );
      if (!signedIn) {
        await screen.findByText("How would you like to continue?");
        fireEvent.click(
          screen.getByRole("button", { name: "Continue as guest" }),
        );
      }
      await screen.findByRole("heading", { name: /Traveller/ });
      expect(screen.queryByText("How would you like to continue?")).toBeNull();
      expect(mocks.authFetch).toHaveBeenCalledTimes(signedIn ? 1 : 0);
      if (signedIn)
        expect(mocks.authFetch.mock.calls[0]![0]).toContain(
          "/partner-checkout/private-token/claim",
        );
      expect(window.location.search).toBe("?step=2");
    },
  );

  it("advances from document verification to payment and updates the URL", async () => {
    const partial = session();
    partial.order.documents = [partial.order.documents[0]!];
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/payments/providers"))
        return ok({ providers: ["KHALTI"] });
      if (url.endsWith("/verify-passport")) return ok({ status: "VERIFIED" });
      if (url.endsWith("/documents"))
        return ok({ id: "document", upload: { mode: "local-simulator" } });
      if (url.endsWith("/confirm")) return ok({});
      return ok(partial);
    });
    const { container } = render(
      <HostedCheckoutClient token="private-token" />,
    );
    await screen.findByRole("heading", { name: "Travel documents" });
    container
      .querySelectorAll('input[type="file"]:not([capture])')
      .forEach((input) => {
        fireEvent.change(input, {
          target: {
            files: [
              new File(["document"], "document.png", { type: "image/png" }),
            ],
          },
        });
      });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Continue to payment" }),
    );
    await screen.findByRole("heading", { name: "Pay NPR 2" });
    expect(window.location.search).toBe("?step=4");
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url.endsWith("/complete") || url.endsWith("/payment"),
      ),
    ).toBe(false);
  });

  it("retries payment initiation without submitting the order again", async () => {
    let attempts = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/payments/providers"))
        return ok({ providers: ["KHALTI"] });
      if (url.endsWith("/complete"))
        return ok({ orderNumber: "VC-HOSTED", status: "PAYMENT_PENDING" });
      if (url.endsWith("/payment")) {
        if (++attempts === 1) throw new Error("Network unavailable");
        return ok({
          reference: "payment",
          redirectUrl: "",
          expiresAt: "2027-01-01",
        });
      }
      return ok(session());
    });
    render(<HostedCheckoutClient token="private-token" />);
    await screen.findByRole("heading", { name: "Pay NPR 2" });
    fireEvent.click(screen.getByRole("button", { name: "Continue to Khalti" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss message" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to Khalti" }));
    await waitFor(() => expect(attempts).toBe(2));
    expect(
      fetchMock.mock.calls.filter(([url]) => url.endsWith("/complete")),
    ).toHaveLength(1);
  });
});

describe("hosted document progress", () => {
  it("refreshes verification automatically and keeps payment behind an explicit continue action", async () => {
    let reads = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/payments/providers"))
        return ok({ providers: ["KHALTI"] });
      reads += 1;
      return ok(session(reads === 1 ? "OCR_PENDING" : "VERIFIED"));
    });
    render(<HostedCheckoutClient token="private-token" />);
    await screen.findByText("Checking your passport");
    expect(screen.queryByRole("heading", { name: "Pay NPR 2" })).toBeNull();
    const next = await screen.findByRole(
      "button",
      { name: "Continue to payment" },
      { timeout: 5000 },
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(next);
    await screen.findByRole("heading", { name: "Pay NPR 2" });
    expect(
      fetchMock.mock.calls.some(([url]) => url.endsWith("/verify-passport")),
    ).toBe(false);
  });

  it("keeps saved files and shows a connection error when checking fails", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/payments/providers"))
        return ok({ providers: ["KHALTI"] });
      if (url.endsWith("/verify-passport")) throw new Error("Disconnected");
      return ok(session("NOT_STARTED"));
    });
    render(<HostedCheckoutClient token="private-token" />);
    await screen.findByRole("heading", { name: "Travel documents" });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await screen.findByText(/Check your connection and try again/);
    expect(
      screen.getByRole("list", { name: "Saved documents" }).textContent,
    ).toContain("passport.png");
    expect(screen.queryByText(/doesn.t match/)).toBeNull();
    expect(
      fetchMock.mock.calls.some(([url]) => url.endsWith("/documents")),
    ).toBe(false);
    expect(screen.queryByRole("heading", { name: "Pay NPR 2" })).toBeNull();
  });
});

it("retries a failed ticket without uploading the confirmed passport again", async () => {
  const current = session("NOT_STARTED");
  current.order.documents = [];
  let failTicket = true;
  const authorized: string[] = [];
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/payments/providers"))
      return ok({ providers: ["KHALTI"] });
    if (url.endsWith("/documents")) {
      const type = JSON.parse(String(init?.body)).type;
      authorized.push(type);
      if (type === "TICKET" && failTicket) {
        failTicket = false;
        throw new Error("Disconnected");
      }
      return ok({ id: type, upload: { mode: "local-simulator" } });
    }
    if (url.endsWith("/confirm")) return ok({});
    if (url.endsWith("/verify-passport")) return ok({ status: "VERIFIED" });
    return ok(current);
  });
  render(<HostedCheckoutClient token="private-token" />);
  await screen.findByRole("heading", { name: "Travel documents" });
  for (const label of ["Passport", "Travel ticket"])
    fireEvent.change(screen.getByLabelText(label, { exact: true }), {
      target: {
        files: [new File(["document"], `${label}.png`, { type: "image/png" })],
      },
    });
  fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
  await screen.findByText(/Check your connection and try again/);
  expect(
    screen.getByRole("list", { name: "Saved documents" }).textContent,
  ).toContain("Passport.png");
  fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
  await screen.findByRole("button", { name: "Continue to payment" });
  expect(authorized).toEqual(["PASSPORT", "TICKET", "TICKET"]);
});

it("uses the current order review status instead of an old passport verdict on resume", async () => {
  const replaced = session("NOT_STARTED");
  replaced.order.documents[0]!.passportVerificationStatus = "VERIFIED";
  fetchMock.mockImplementation(async (url: string) =>
    url.endsWith("/payments/providers")
      ? ok({ providers: ["KHALTI"] })
      : ok(replaced),
  );
  render(<HostedCheckoutClient token="private-token" />);
  await screen.findByRole("heading", { name: "Travel documents" });
  expect(
    screen.queryByRole("button", { name: "Continue to payment" }),
  ).toBeNull();
  expect(screen.queryByRole("heading", { name: "Pay NPR 2" })).toBeNull();
});
