import { describe, expect, it, vi } from "vitest";
import { PaymentDisputeStatus, PaymentStatus } from "@prisma/client";
import { PaymentDisputesService } from "./payment-disputes.service.js";

function fixture() {
  const payment = {
    id: "payment-1",
    orderId: "order-1",
    paymentReference: "pidx-1",
    status: PaymentStatus.COMPLETED,
    amount: 2499,
    currency: "NPR",
    order: { id: "order-1", orderNumber: "VC-1" },
  };
  const dispute = {
    id: "dispute-1",
    orderId: "order-1",
    paymentId: "payment-1",
    providerCaseId: "case-1",
    status: PaymentDisputeStatus.OPEN,
    type: "CHARGEBACK",
  };
  const upsert = vi.fn(async ({ create, update }) => ({
    ...dispute,
    status: create?.status ?? update.status,
  }));
  const paymentUpdate = vi.fn(async () => payment);
  const auditCreate = vi.fn(async () => ({}));
  const tx = {
    paymentDispute: { upsert },
    payment: { update: paymentUpdate },
    auditLog: { create: auditCreate },
  };
  const prisma = {
    enabled: true,
    payment: { findUnique: vi.fn(async () => payment) },
    webhookEvent: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) =>
      work(tx),
    ),
  };
  const resilience = {
    attention: vi.fn(async () => undefined),
    resolve: vi.fn(async () => undefined),
  };
  return {
    service: new PaymentDisputesService(prisma as never, resilience as never),
    prisma,
    resilience,
    upsert,
    paymentUpdate,
    auditCreate,
  };
}

describe("PaymentDisputesService", () => {
  it("records an opened chargeback idempotently and creates financial attention", async () => {
    const { service, resilience, upsert, paymentUpdate } = fixture();
    const event = {
      provider: "khalti",
      eventId: "event-1",
      eventType: "CHARGEBACK_OPENED" as const,
      reference: "pidx-1",
      caseId: "case-1",
      amount: 2499,
      currency: "NPR",
    };

    await service.recordProviderEvent(event);
    await service.recordProviderEvent(event);

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(paymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: PaymentStatus.DISPUTED } }),
    );
    expect(resilience.attention).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "PAYMENT_DISPUTE",
        availableActions: ["REVIEW_FINANCIAL_DISPUTE"],
      }),
    );
  });

  it("marks funds charged back when the provider reports a lost case", async () => {
    const { service, paymentUpdate, resilience } = fixture();

    await service.recordProviderEvent({
      provider: "KHALTI",
      eventId: "event-2",
      eventType: "CHARGEBACK_LOST",
      reference: "pidx-1",
      caseId: "case-1",
      reason: "Issuer ruled for cardholder",
    });

    expect(paymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: PaymentStatus.CHARGED_BACK } }),
    );
    expect(resilience.attention).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "CRITICAL" }),
    );
  });

  it("restores the payment evidence and resolves attention when a case is won", async () => {
    const { service, paymentUpdate, resilience } = fixture();

    await service.recordProviderEvent({
      provider: "KHALTI",
      eventId: "event-3",
      eventType: "DISPUTE_WON",
      reference: "pidx-1",
      caseId: "case-1",
    });

    expect(paymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: PaymentStatus.COMPLETED } }),
    );
    expect(resilience.resolve).toHaveBeenCalledWith(
      "payment-dispute:dispute-1",
      null,
      expect.stringContaining("WON"),
    );
  });

  it("rejects currency conflicts without mutating financial state", async () => {
    const { service, paymentUpdate, upsert } = fixture();

    await expect(
      service.recordProviderEvent({
        provider: "KHALTI",
        eventId: "event-4",
        eventType: "DISPUTE_OPENED",
        reference: "pidx-1",
        caseId: "case-1",
        currency: "USD",
      }),
    ).rejects.toThrow("currency does not match");
    expect(upsert).not.toHaveBeenCalled();
    expect(paymentUpdate).not.toHaveBeenCalled();
  });

  it("creates a security case for an unknown payment reference", async () => {
    const { service, prisma, resilience } = fixture();
    prisma.payment.findUnique.mockResolvedValueOnce(null as never);

    await expect(
      service.recordProviderEvent({
        provider: "KHALTI",
        eventId: "event-5",
        eventType: "DISPUTE_OPENED",
        reference: "unknown-reference",
        caseId: "case-unknown",
      }),
    ).rejects.toThrow("reference is unknown");
    expect(resilience.attention).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "PAYMENT_SECURITY",
        failureCategory: "UNKNOWN_PAYMENT_REFERENCE",
      }),
    );
  });
});
