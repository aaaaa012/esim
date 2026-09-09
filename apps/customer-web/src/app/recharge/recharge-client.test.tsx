import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RechargeClient from "./recharge-client";

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  isLoaded: true,
  isSignedIn: true,
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: mocks.isLoaded, isSignedIn: mocks.isSignedIn }),
}));
vi.mock("../authenticated-api-provider", () => ({
  useAuthenticatedFetch: () => mocks.authFetch,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const ok = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("hybrid recharge route", () => {
  beforeEach(() => {
    mocks.isLoaded = true;
    mocks.isSignedIn = true;
    mocks.authFetch.mockReset();
    window.history.replaceState({}, "", "/recharge");
  });

  it("sends a customer with one owned eSIM directly to destination selection", async () => {
    mocks.authFetch.mockResolvedValue(ok({
      targets: [{ id: "owned-1", label: "Travel eSIM · 1234" }],
    }));
    render(<RechargeClient />);
    const target = await screen.findByRole("link", { name: /Travel eSIM · 1234/i });
    expect(target.getAttribute("href")).toBe("/destinations?esim=owned-1");
    expect(screen.getByRole("heading", { name: "Recharge your eSIM" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Help a friend stay connected" })).toBeTruthy();
  });

  it("asks a customer with multiple eSIMs to choose one", async () => {
    mocks.authFetch.mockResolvedValue(ok({
      targets: [
        { id: "owned-1", label: "Travel eSIM · 1234" },
        { id: "owned-2", label: "Travel eSIM · 5678" },
      ],
    }));
    render(<RechargeClient />);
    expect(await screen.findByRole("heading", { name: "Which eSIM needs data?" })).toBeTruthy();
    expect(screen.getAllByText("Choose destination and plan")).toHaveLength(2);
  });

  it("offers friend recharge and a new purchase when no eSIM is owned", async () => {
    mocks.authFetch.mockResolvedValue(ok({ targets: [] }));
    render(<RechargeClient />);
    expect(await screen.findByRole("heading", { name: "No rechargeable eSIM is linked yet" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Buy a new eSIM/i }).getAttribute("href")).toBe("/destinations");
    expect(screen.getByLabelText("eSIM mobile number")).toBeTruthy();
  });

  it("keeps guests on secure email verification without loading owned targets", async () => {
    mocks.isSignedIn = false;
    render(<RechargeClient />);
    await waitFor(() => expect(screen.getByLabelText("eSIM mobile number")).toBeTruthy());
    expect(mocks.authFetch).not.toHaveBeenCalled();
    expect(screen.queryByText("Your account")).toBeNull();
  });
});
