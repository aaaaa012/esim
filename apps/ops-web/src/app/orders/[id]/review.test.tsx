import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import OrderReview from "./review";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  confirm: vi.fn(async () => true),
}));
vi.mock("../../authenticated-api-provider", () => ({
  useAuthenticatedFetch: () => mocks.fetch,
}));
vi.mock("@/components/confirmation-provider", () => ({
  useConfirmation: () => mocks.confirm,
}));
vi.mock("./manual-refund-card", () => ({ ManualRefundCard: () => null }));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}));
afterEach(cleanup);

it("shows hosted attribution and pre-payment verification, retaining context after manual review", async () => {
  const order = {
    id: "hosted-order",
    orderNumber: "VC-HOSTED",
    status: "DRAFT",
    channel: "PARTNER_HOSTED",
    purchaseType: "INITIAL_PURCHASE",
    createdAt: "2026-09-06T16:00:00Z",
    totalAmountNpr: 2,
    plan: { name: "Asia 500 MB", countryCode: "IN" },
    customer: {
      id: "customer",
      customerCode: "VC-CUSTOMER",
      email: "customer@example.com",
      source: "WEBSITE",
    },
    loginAccount: {
      id: "user",
      email: "customer@example.com",
      status: "ACTIVE",
    },
    partner: { id: "partner", code: "test2", name: "test2" },
    partnerCustomer: {
      id: "partner-customer",
      externalCustomerId: "partner-ref",
    },
    documentReviewPolicy: "AUTO_OCR",
    documentReviewStatus: "MANUAL_REVIEW",
    passportVerification: { status: "VERIFIED" },
    documents: [
      {
        id: "passport",
        type: "PASSPORT",
        status: "PENDING",
        fileName: "passport.png",
        uploadVerified: true,
      },
      {
        id: "ticket",
        type: "TICKET",
        status: "PENDING",
        fileName: "ticket.png",
        uploadVerified: true,
      },
    ],
    timeline: [
      {
        from: "DRAFT",
        to: "DRAFT",
        reason: "Passport verified automatically",
        at: "2026-09-06T16:00:00Z",
      },
      {
        from: "PAYMENT_CONFIRMED",
        to: "APPROVED",
        reason: "Auto-approved after payment",
        at: "2026-09-06T16:05:00Z",
      },
    ],
    assignment: { inventoryId: "inventory", iccid: "test-iccid" },
    packageUsage: { balanceStatus: "WAITING_FOR_FIRST_USE" },
    esimUsage: {
      freshness: "STALE",
      summary: { confirmedPackageCount: 0, packageCount: 1, remainingMb: 0 },
    },
  };
  let detailReads = 0;
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/auth/me"))
      return {
        ok: true,
        json: async () => ({ data: { accountType: "OPERATIONS" } }),
      };
    if (init?.method === "POST")
      return {
        ok: true,
        json: async () => ({
          data: { id: order.id, documents: order.documents },
        }),
      };
    detailReads++;
    return { ok: true, json: async () => ({ data: order }) };
  });
  render(<OrderReview id="hosted-order" />);
  await screen.findByText("Partner hosted checkout");
  expect(screen.getByText("partner-ref")).toBeDefined();
  expect(screen.getByText("Customer signup source")).toBeDefined();
  expect(screen.queryByText("Direct")).toBeNull();
  expect(screen.getByText("Verified automatically")).toBeDefined();
  expect(screen.getByText("Uploaded · awaiting manual review")).toBeDefined();
  expect(screen.getByText("Passport verified")).toBeDefined();
  expect(screen.getByText("Approved for activation")).toBeDefined();
  expect(screen.getByText("Balance not confirmed")).toBeDefined();
  expect(screen.queryByText(/Package added to the existing eSIM/)).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[1]!);
  await waitFor(() => expect(detailReads).toBe(2));
  expect(screen.getByText("Partner hosted checkout")).toBeDefined();
  expect(screen.getByText("partner-ref")).toBeDefined();
});
