import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PartnerWorkspace from "./partner-workspace";

const authFetchMock = vi.fn<typeof window.fetch>();
const replaceMock = vi.fn();

vi.mock("../../../authenticated-api-provider", () => ({
  useAuthenticatedFetch: () => authFetchMock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const response = (data: unknown) =>
  ({ ok: true, json: async () => ({ data }) }) as unknown as Response;

const partner = {
  id: "partner-1",
  code: "agency-one",
  name: "Agency One",
  status: "ACTIVE",
  rateLimitPerMinute: 120,
  createdAt: "2026-08-01T00:00:00.000Z",
  account: { balancePaisa: 500_000, reservedPaisa: 0 },
  credentials: [],
  webhooks: [],
  _count: { orders: 0, customers: 2, refundRequests: 0, credentials: 0 },
};
const summary = {
  currentBalancePaisa: 500_000,
  ordersCreated: 0,
  fulfilledOrders: 0,
  failedOrders: 0,
  totalOrderValuePaisa: 0,
  totalCreditedPaisa: 500_000,
  totalDebitedPaisa: 0,
  totalRefundedPaisa: 0,
  averageOrderValuePaisa: 0,
  ordersByStatus: {},
};

describe("PartnerWorkspace", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    replaceMock.mockReset();
    authFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (/\/admin\/partners\/partner-1$/.test(url)) return response(partner);
      if (url.includes("/summary")) return response(summary);
      if (url.includes("/orders")) return response([]);
      if (url.includes("/ledger")) return response([]);
      if (url.includes("/refunds")) return response([]);
      if (url.includes("/webhooks")) return response([]);
      if (url.includes("/webhook-deliveries")) return response([]);
      throw new Error(`Unexpected request: ${url}`);
    });
  });

  it("renders the operational header and persists tab selection", async () => {
    render(<PartnerWorkspace id="partner-1" />);
    expect(await screen.findByText("Agency One")).toBeTruthy();
    expect(screen.getAllByText("NPR 5,000").length).toBeGreaterThan(0);
    expect(screen.getByText("120 requests/min")).toBeTruthy();

    const ordersTab = screen.getByRole("tab", { name: "orders" });
    fireEvent.mouseDown(ordersTab);
    fireEvent.click(ordersTab);
    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith(
        expect.stringContaining("tab=orders"),
        { scroll: false },
      ),
    );
  });

  it("blocks balance changes until the reason and typed confirmation are provided", async () => {
    render(<PartnerWorkspace id="partner-1" />);
    await screen.findByText("Agency One");

    const ledgerTab = screen.getByRole("tab", { name: "ledger" });
    fireEvent.mouseDown(ledgerTab);
    fireEvent.click(ledgerTab);

    fireEvent.change(screen.getByPlaceholderText("5000"), {
      target: { value: "100" },
    });
    fireEvent.change(screen.getByPlaceholderText("bank-deposit-2026-001"), {
      target: { value: "deposit-001" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("Offline settlement received"),
      { target: { value: "Cash received" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Review" }));

    const apply = screen.getByRole("button", { name: "Apply adjustment" });
    expect(apply).toHaveProperty("disabled", true);
    fireEvent.change(
      screen.getByPlaceholderText("Required for the audit log"),
      { target: { value: "Cash received" } },
    );
    fireEvent.change(screen.getByLabelText(/Type.*ADJUST.*to confirm/), {
      target: { value: "ADJUST" },
    });
    expect(apply).toHaveProperty("disabled", false);
  });
});
