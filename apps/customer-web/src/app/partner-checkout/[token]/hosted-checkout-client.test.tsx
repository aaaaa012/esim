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
    orderType: "INITIAL_PURCHASE",
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
    replacementReasons: {} as Partial<Record<"PASSPORT" | "TICKET", string>>,
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
      expect(
        (
          screen.getByRole("button", {
            name: "Save and continue",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(mocks.authFetch).not.toHaveBeenCalled();
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
      expect(screen.getByText("Documents verified")).toBeTruthy();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url.endsWith("/complete") || url.endsWith("/payment"),
        ),
      ).toBe(false);
      fireEvent.click(
        screen.getByRole("button", { name: /Fonepay Mobile banking/ }),
      );
      expect(
        screen.getByRole("button", { name: /Khalti wallet/ }),
      ).toBeTruthy();
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

  it.each(["FAILED", "OCR_PENDING", "CORRECTION_REQUIRED", "MANUAL_REVIEW"])(
    "blocks payment for %s documents",
    async (status) => {
      fetchMock.mockImplementation(async (url: string) =>
        url.endsWith("/payments/providers")
          ? ok({ providers: ["KHALTI"] })
          : ok(session(status)),
      );
      render(<HostedCheckoutClient token="private-token" />);
      await screen.findByRole("heading", { name: "Traveller information" });
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
    "continues from compatibility to documents (signed in: %s)",
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
      await screen.findByRole("heading", { name: "Travel documents" });
      expect(screen.queryByText("How would you like to continue?")).toBeNull();
      expect(mocks.authFetch).toHaveBeenCalledTimes(signedIn ? 1 : 0);
      if (signedIn)
        expect(mocks.authFetch.mock.calls[0]![0]).toContain(
          "/partner-checkout/private-token/claim",
        );
      expect(window.location.search).toBe("?step=2");
    },
  );

  it("advances from document verification to traveller confirmation", async () => {
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
    expect(
      screen.getByRole("list", { name: "Document summary" }),
    ).toBeDefined();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change documents" }));
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
    expect(screen.getByText(/Replacing your passport/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cancel changes" }));
    expect(container.querySelector('input[type="file"]')).toBeNull();
    fireEvent.click(
      (
        await screen.findAllByRole("button", {
          name: "Review traveller details",
        })
      )[0]!,
    );
    await screen.findByRole("heading", { name: "Traveller information" });
    expect(window.location.search).toBe("?step=3");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("heading", { name: "Travel documents" });
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
    expect(window.location.search).toBe("?step=2");
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

  it("clears a dead Fonepay payment (PAYMENT_EXPIRED) so the QR is not re-scanned", async () => {
    const failedVerify = {
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          code: "PAYMENT_EXPIRED",
          message: "This payment attempt has expired. Please start a new one.",
        },
      }),
    };
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/payments/providers"))
        return ok({ providers: ["KHALTI", "FONEPAY"] });
      if (url.endsWith("/complete"))
        return ok({ orderNumber: "VC-HOSTED", status: "PAYMENT_PENDING" });
      if (url.endsWith("/payment"))
        return ok({
          reference: "payment",
          redirectUrl: "",
          expiresAt: "2027-01-01",
          qrPayload: "payload",
        });
      if (url.endsWith("/verify")) return failedVerify;
      return ok(session());
    });
    render(<HostedCheckoutClient token="private-token" />);
    await screen.findByRole("heading", { name: "Pay NPR 2" });
    fireEvent.click(
      screen.getByRole("button", { name: /Fonepay Mobile banking/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to Fonepay" }),
    );
    await screen.findByRole("button", {
      name: "I've completed payment - check status",
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "I've completed payment - check status",
      }),
    );
    await screen.findByText(
      "That payment attempt has ended. Start a new one to continue.",
    );
    // The dead QR/session is gone: no re-scan UI, and a fresh attempt action is
    // shown instead of the verify button.
    expect(
      screen.queryByRole("button", {
        name: "I've completed payment - check status",
      }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Continue to Fonepay" }),
    ).toBeDefined();
    // The verify call carried the terminal verdict back to the client.
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/verify"))).toBe(
      true,
    );
  });

  it("ends the payment screen for PAYMENT_RETRY_NOT_SAFE while surfacing the server message", async () => {
    const blockedVerify = {
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          code: "PAYMENT_RETRY_NOT_SAFE",
          message: "A payment is still being confirmed for this order.",
        },
      }),
    };
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/payments/providers"))
        return ok({ providers: ["KHALTI", "FONEPAY"] });
      if (url.endsWith("/complete"))
        return ok({ orderNumber: "VC-HOSTED", status: "PAYMENT_PENDING" });
      if (url.endsWith("/payment"))
        return ok({
          reference: "payment",
          redirectUrl: "",
          expiresAt: "2027-01-01",
          qrPayload: "payload",
        });
      if (url.endsWith("/verify")) return blockedVerify;
      return ok(session());
    });
    render(<HostedCheckoutClient token="private-token" />);
    await screen.findByRole("heading", { name: "Pay NPR 2" });
    fireEvent.click(
      screen.getByRole("button", { name: /Fonepay Mobile banking/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to Fonepay" }),
    );
    await screen.findByRole("button", {
      name: "I've completed payment - check status",
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "I've completed payment - check status",
      }),
    );
    await screen.findByText(
      /A payment is still being confirmed for this order/,
    );
    // The scan screen ended; the customer may not re-scan the same QR.
    expect(
      screen.queryByRole("button", {
        name: "I've completed payment - check status",
      }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Continue to Fonepay" }),
    ).toBeDefined();
  });
});

describe("hosted document progress", () => {
  it("keeps visible feedback while saving traveller details", async () => {
    const fresh = session("NOT_STARTED");
    fresh.order.travelerComplete = false;
    let releaseTraveler!: () => void;
    const travelerSaved = new Promise<void>((resolve) => {
      releaseTraveler = resolve;
    });
    Object.assign(fresh.order, {
      traveler: {
        firstName: "Anish",
        surname: "Ghimire",
        dateOfBirth: "1990-01-01",
        passportNumber: "PA1234567",
        passportExpiryDate: "2030-01-01",
        city: "Kathmandu",
        nationality: "NP",
        countryOfResidence: "NP",
        email: "anish@example.com",
        mobile: "+9779800000000",
      },
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/payments/providers"))
        return ok({ providers: ["KHALTI"] });
      if (url.endsWith("/traveler")) {
        await travelerSaved;
        return ok(fresh);
      }
      if (url.endsWith("/verify-passport"))
        return ok({ status: "OCR_PENDING" });
      return ok(fresh);
    });

    render(<HostedCheckoutClient token="private-token" />);
    await screen.findByRole("heading", { name: "Traveller information" });
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "First name" }),
      ).toHaveProperty("value", "Anish"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    const saving = await screen.findByRole("button", {
      name: "Save and continue",
    });
    expect((saving as HTMLButtonElement).disabled).toBe(true);
    releaseTraveler();
    expect(
      await screen.findByRole("heading", { name: "Traveller information" }),
    ).toBeDefined();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => url.endsWith("/verify-passport")),
      ).toBe(true),
    );
  });

  it("prefills extracted passport fields before traveller confirmation", async () => {
    const extracted = session("NOT_STARTED");
    extracted.order.travelerComplete = false;
    Object.assign(extracted.order, {
      passportExtraction: {
        status: "READY",
        fields: {
          firstName: "ANISH",
          surname: "GHIMIRE",
          passportNumber: "PA1234567",
        },
        fieldsRequiringInput: ["nationality"],
      },
    });
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/payments/providers")
        ? ok({ providers: ["KHALTI"] })
        : ok(extracted),
    );

    render(<HostedCheckoutClient token="private-token" />);

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
    expect(screen.queryByRole("heading", { name: "Pay NPR 2" })).toBeNull();
  });

  it.each([false, true])(
    "uses the same verification journey and explicit payment action (signed in: %s)",
    async (signedIn) => {
      mocks.signedIn = signedIn;
      let reads = 0;
      fetchMock.mockImplementation(async (url: string) => {
        if (url.endsWith("/payments/providers"))
          return ok({ providers: ["KHALTI"] });
        reads += 1;
        return ok(session(reads === 1 ? "OCR_PENDING" : "VERIFIED"));
      });
      render(<HostedCheckoutClient token="private-token" />);
      await screen.findByRole(
        "heading",
        { name: "Pay NPR 2" },
        { timeout: 5000 },
      );
      expect(
        screen.getByRole("dialog", { name: "Verification complete" }),
      ).toBeDefined();
      expect(
        screen.getByText(
          "Your passport was matched with your traveller details. You can continue to payment.",
        ),
      ).toBeDefined();
      expect(
        fetchMock.mock.calls.some(([url]) => url.endsWith("/verify-passport")),
      ).toBe(false);
    },
  );

  it("keeps saved files and shows a connection error when checking fails", async () => {
    const pending = session("NOT_STARTED");
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/payments/providers"))
        return ok({ providers: ["KHALTI"] });
      if (url.endsWith("/verify-passport")) throw new Error("Disconnected");
      return ok(pending);
    });
    render(<HostedCheckoutClient token="private-token" />);
    await screen.findByRole("heading", { name: "Traveller information" });
    fireEvent.click(screen.getByRole("button", { name: "Documents" }));
    await screen.findByRole("heading", { name: "Travel documents" });
    fireEvent.click(screen.getByRole("button", { name: "Save documents" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Save documents" }));
  await screen.findByText(/Check your connection and try again/);
  expect(
    screen.getByRole("list", { name: "Saved documents" }).textContent,
  ).toContain("Passport.png");
  fireEvent.click(screen.getByRole("button", { name: "Save documents" }));
  await screen.findAllByRole("button", { name: "Review traveller details" });
  expect(authorized).toEqual(["PASSPORT", "TICKET", "TICKET"]);
});

it("uses the current order review status instead of an old passport verdict on resume", async () => {
  const replaced = session("NOT_STARTED");
  replaced.order.documents[0]!.passportVerificationStatus = "VERIFIED";
  replaced.order.documents[1]!.uploadVerified = false;
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

it.each([false, true])(
  "submits only the replacement passport and resumes verification (signed in: %s)",
  async (signedIn) => {
    mocks.signedIn = signedIn;
    const current = session("REUPLOAD_REQUIRED");
    current.order.documents[0]!.status = "REUPLOAD_REQUIRED";
    current.order.replacementReasons.PASSPORT = "The photo page is cropped.";
    const submitted: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/payments/providers"))
        return ok({ providers: ["KHALTI"] });
      if (url.endsWith("/documents")) {
        submitted.push(JSON.parse(String(init?.body)).type);
        return ok({ id: "passport", upload: { mode: "local-simulator" } });
      }
      if (url.endsWith("/confirm")) {
        current.order.documentReviewStatus = "OCR_PENDING";
        current.order.documents[0]!.status = "PENDING";
        current.order.documents[0]!.passportVerificationStatus = "OCR_PENDING";
        return ok({});
      }
      if (url.endsWith("/verify-passport")) {
        return ok({ status: "OCR_PENDING" });
      }
      return ok(current);
    });
    render(<HostedCheckoutClient token="private-token" />);
    await screen.findByRole("heading", { name: "Travel documents" });
    expect(
      await screen.findByText("Passport needs a new upload"),
    ).toBeDefined();
    expect(screen.getByText("The photo page is cropped.")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Check traveller details" }),
    ).toBeDefined();
    expect(screen.getByText("ticket.png")).toBeDefined();
    expect(screen.getByText("Kept on file")).toBeDefined();
    expect(screen.queryByLabelText("Travel ticket")).toBeNull();
    fireEvent.change(screen.getByLabelText("Passport", { exact: true }), {
      target: {
        files: [
          new File(["passport"], "new-passport.png", { type: "image/png" }),
        ],
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Submit replacement for review" }),
    );
    await screen.findByText("We’re checking your passport");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(submitted).toEqual(["PASSPORT"]);
    expect(screen.queryByRole("heading", { name: "Pay NPR 2" })).toBeNull();
  },
);

it("reopens a paid guest order for the requested replacement without another payment", async () => {
  const current = session("REUPLOAD_REQUIRED", "AWAITING_CUSTOMER");
  current.order.documents[1]!.status = "REUPLOAD_REQUIRED";
  current.order.replacementReasons.TICKET = "The itinerary date is unreadable.";
  const submitted: string[] = [];
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/payments/providers"))
      return ok({ providers: ["KHALTI"] });
    if (url.endsWith("/documents")) {
      submitted.push(JSON.parse(String(init?.body)).type);
      return ok({ id: "ticket", upload: { mode: "local-simulator" } });
    }
    if (url.endsWith("/confirm")) {
      current.order.status = "REVIEW_PENDING";
      current.order.documentReviewStatus = "OCR_PENDING";
      current.order.documents[1]!.status = "PENDING";
      return ok({});
    }
    return ok(current);
  });
  render(<HostedCheckoutClient token="private-token" />);
  await screen.findByRole("heading", { name: "Travel documents" });
  expect(screen.getByText("The itinerary date is unreadable.")).toBeDefined();
  expect(screen.queryByLabelText("Passport", { exact: true })).toBeNull();
  fireEvent.change(screen.getByLabelText("Travel ticket"), {
    target: {
      files: [new File(["ticket"], "new-ticket.png", { type: "image/png" })],
    },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Submit replacement for review" }),
  );
  await screen.findByText("Reviewing documents");
  expect(screen.getByRole("heading", { name: "Payment confirmed" })).toBeDefined();
  expect(submitted).toEqual(["TICKET"]);
  expect(screen.queryByRole("heading", { name: "Pay NPR 2" })).toBeNull();
});

it.each([
  { signedIn: false, status: "PROVISIONING", action: "Track this order" },
  { signedIn: true, status: "QR_READY", action: "Track this order" },
])("shows the paid order journey for signed-in and guest customers ($status)", async ({ signedIn, status, action }) => {
  mocks.signedIn = signedIn;
  const current = session("VERIFIED", status);
  fetchMock.mockImplementation(async (url: string) =>
    url.endsWith("/payments/providers") ? ok({ providers: ["KHALTI"] }) : ok(current),
  );
  render(<HostedCheckoutClient token="private-token" />);
  await screen.findByRole("heading", { name: "Payment confirmed" });
  expect(screen.getAllByText("NPR 2").length).toBeGreaterThan(0);
  expect(screen.getByRole("link", { name: action })).toBeDefined();
  if (status === "PROVISIONING")
    expect(screen.getByText(/We’ll email the installation QR/i)).toBeDefined();
  else expect(screen.getByText("Your eSIM is ready")).toBeDefined();
});

it("shows a hosted recharge as added data without promising an installation QR", async () => {
  const current = session("VERIFIED", "QR_READY");
  current.order.orderType = "TOPUP";
  fetchMock.mockImplementation(async (url: string) =>
    url.endsWith("/payments/providers") ? ok({ providers: ["KHALTI"] }) : ok(current),
  );
  render(<HostedCheckoutClient token="private-token" />);
  expect(await screen.findByText("Data has been added to your eSIM")).toBeDefined();
  expect(screen.queryByText("Ready to install")).toBeNull();
  expect(screen.getByRole("link", { name: "Track this recharge" })).toBeDefined();
});

it.each([false, true])(
  "opens traveller details directly from document recovery (signed in: %s)",
  async (signedIn) => {
    mocks.signedIn = signedIn;
    const current = session("REUPLOAD_REQUIRED");
    current.order.documents[0]!.status = "REUPLOAD_REQUIRED";
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/payments/providers")
        ? ok({ providers: ["KHALTI"] })
        : ok(current),
    );
    render(<HostedCheckoutClient token="private-token" />);
    await screen.findByRole("heading", { name: "Travel documents" });
    fireEvent.click(
      screen.getByRole("button", { name: "Check traveller details" }),
    );
    await screen.findByRole("heading", { name: "Traveller information" });
    expect(window.location.search).toContain("step=3");
  },
);
