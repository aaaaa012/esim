import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import OrderList from "./esim-list";
import Details from "./[id]/esim-details";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../authenticated-api-provider", () => ({
  useAuthenticatedFetch: () => mocks.fetch,
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}));
const ok = (data: unknown) => ({ ok: true, json: async () => ({ data }) });
const order = {
  id: "order",
  orderNumber: "VC-TEST",
  status: "DRAFT",
  totalAmountNpr: 2,
  createdAt: "2026-09-01",
  plan: {
    name: "India 500 MB",
    countryCode: "IN",
    dataAllowance: "500 MB",
    validityDays: 1,
  },
  documents: [],
  timeline: [],
  documentReviewStatus: "OCR_PENDING",
};
const displayedPlanName = order.plan.name;
beforeEach(() => {
  mocks.fetch.mockReset();
});
afterEach(() => cleanup());
it("does not show an empty purchase history while orders are loading", () => {
  mocks.fetch.mockReturnValue(new Promise(() => {}));
  render(<OrderList />);
  expect(screen.getByRole("status").textContent).toContain("Loading orders");
  expect(screen.queryByText("No orders yet")).toBeNull();
});
it("recovers an order-list failure without showing a false empty state", async () => {
  mocks.fetch
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(ok([order]));
  render(<OrderList />);
  await screen.findByRole("alert");
  expect(screen.queryByText("No orders yet")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("heading", { name: displayedPlanName });
  expect(screen.queryByRole("alert")).toBeNull();
});
it("includes provisioning failures in Needs action and offers an exit from empty filters", async () => {
  mocks.fetch.mockResolvedValue(
    ok([{ ...order, status: "PROVISIONING_FAILED" }]),
  );
  render(<OrderList />);
  await screen.findByRole("heading", { name: displayedPlanName });
  fireEvent.click(screen.getByRole("button", { name: "Needs action" }));
  expect(screen.getByRole("heading", { name: displayedPlanName })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Completed" }));
  fireEvent.click(screen.getByRole("button", { name: "Show all orders" }));
  expect(screen.getByRole("heading", { name: displayedPlanName })).toBeDefined();
});
it("keeps a failed order-detail load recoverable through repeated retries", async () => {
  mocks.fetch
    .mockRejectedValueOnce(new Error("offline"))
    .mockRejectedValueOnce(new Error("offline again"))
    .mockResolvedValueOnce(ok(order));
  render(<Details id="order" />);
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  await screen.findByRole("heading", { name: displayedPlanName });
  expect(
    screen.getByText(/Payment becomes available after verification succeeds/),
  ).toBeDefined();
  expect(screen.queryByText(/activation continue normally/)).toBeNull();
});
it("refreshes a pending order without requiring a reload", async () => {
  mocks.fetch
    .mockResolvedValueOnce(ok(order))
    .mockResolvedValue(
      ok({ ...order, documentReviewStatus: "VERIFIED", status: "QR_READY" }),
    );
  render(<Details id="order" />);
  await screen.findByText("Checking your documents");
  await screen.findByText("Ready to install", {}, { timeout: 5000 });
  expect(screen.queryByText("Checking your documents")).toBeNull();
});

it("confirms a replacement upload without clearing another selected document", async () => {
  const documents = ["PASSPORT", "TICKET"].map((type) => ({
    id: type,
    type,
    status: "REUPLOAD_REQUIRED",
    fileName: `old-${type}.pdf`,
  }));
  const existing = {
    ...order,
    status: "AWAITING_CUSTOMER",
    documentReviewStatus: "REUPLOAD_REQUIRED",
    documents,
  };
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith("/documents"))
      return ok({ id: "replacement", upload: { mode: "local-simulator" } });
    if (url.endsWith("/confirm")) return ok({});
    return ok(existing);
  });
  const { container } = render(<Details id="order" />);
  await screen.findByRole("heading", { name: displayedPlanName });
  const inputs = container.querySelectorAll('input[type="file"]');
  for (const input of inputs)
    fireEvent.change(input, {
      target: {
        files: [
          new File(["replacement"], "replacement.pdf", {
            type: "application/pdf",
          }),
        ],
      },
    });
  fireEvent.click(
    screen.getAllByRole("button", { name: "Upload replacement" })[0]!,
  );
  await screen.findByText(
    "Replacement securely saved. Verification updates will appear here.",
  );
  expect(
    (
      screen.getAllByRole("button", {
        name: "Upload replacement",
      })[1] as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(
    mocks.fetch.mock.calls.some(([url]) =>
      url.endsWith("/replacement/confirm"),
    ),
  ).toBe(true);
});
