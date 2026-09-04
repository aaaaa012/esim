import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TopupLookup from "./topup-lookup";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("customer recharge journey", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    push.mockReset();
    window.history.replaceState({}, "", "/");
  });

  it("uses a uniform public response and sends no subscriber data before email verification", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ verificationRequested: true }),
    );
    render(<TopupLookup />);
    fireEvent.change(screen.getByLabelText("eSIM MSISDN"), {
      target: { value: "+9779800000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find recharge plans" }));
    expect(await screen.findByText(/check your original purchase email/i)).toBeTruthy();
    expect(screen.queryByText(/eligible for recharge/i)).toBeNull();
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("/guest/orders/topup-lookup"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("verifies the signed email link before revealing and selecting a recharge plan", async () => {
    window.history.replaceState({}, "", "/#topup=signed-token");
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        found: true,
        mobile: "+9779800000000",
        lookupToken: "signed-token",
        topUpAvailable: true,
        subscriber: {
          hasActiveEsim: true,
          countryCode: "FR",
          currentPlan: { id: "plan-1", name: "France 5 GB", countryCode: "FR", countryName: "France", dataAllowance: "5 GB", validityDays: 30, sellingPriceNpr: 2500 },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ allowed: true }));
    render(<TopupLookup />);
    expect(await screen.findByText("France 5 GB")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /continue with this plan/i }));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(
        "/esim/checkout?plan=plan-1&mobile=%2B9779800000000&lookup=signed-token&country=FR",
      ),
    );
    expect(request.mock.calls[0]?.[0]).toContain("/topup-lookup/verify");
    expect(request.mock.calls[1]?.[0]).toContain("/topup-eligibility");
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        mobile: "+9779800000000",
        lookupToken: "signed-token",
        planId: "plan-1",
      }),
    });
  });
});
