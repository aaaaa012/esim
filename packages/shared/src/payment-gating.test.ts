import { describe, expect, it } from "vitest";
import { OrderStatus, PaymentStatus } from "./contracts.js";
import { declarePaymentRetry } from "./payment-gating.js";

describe("declarePaymentRetry", () => {
  it("allows a fresh attempt on a draft order", () => {
    expect(
      declarePaymentRetry({ status: OrderStatus.DRAFT, payment: null }),
    ).toEqual({ canRetry: true, canChangeProvider: true });
  });

  it("allows retry and provider change after a terminal payment failure", () => {
    expect(
      declarePaymentRetry({
        status: OrderStatus.PAYMENT_FAILED,
        payment: { status: PaymentStatus.FAILED },
      }),
    ).toEqual({ canRetry: true, canChangeProvider: true });
  });

  it("blocks a new session while a live pending payment window is open", () => {
    const declaration = declarePaymentRetry({
      status: OrderStatus.PAYMENT_PENDING,
      payment: {
        status: PaymentStatus.PENDING,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(declaration.canRetry).toBe(false);
    expect(declaration.canChangeProvider).toBe(false);
    expect(declaration.blockedReason).toBeTruthy();
  });

  it("blocks a new session when the pending window already elapsed and reconciliation must resolve it", () => {
    const declaration = declarePaymentRetry({
      status: OrderStatus.PAYMENT_PENDING,
      payment: {
        status: PaymentStatus.PENDING,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    expect(declaration.canRetry).toBe(false);
    expect(declaration.canChangeProvider).toBe(false);
  });

  it("lets persisted pending evidence override a stale retryable order status", () => {
    for (const status of [OrderStatus.DRAFT, OrderStatus.PAYMENT_FAILED]) {
      const declaration = declarePaymentRetry({
        status,
        payment: {
          status: PaymentStatus.PENDING,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
      expect(declaration.canRetry).toBe(false);
      expect(declaration.canChangeProvider).toBe(false);
    }
  });

  it("never advertises retry when persisted evidence says completed or refunded", () => {
    for (const paymentStatus of [
      PaymentStatus.COMPLETED,
      PaymentStatus.REFUNDED,
    ]) {
      const declaration = declarePaymentRetry({
        status: OrderStatus.PAYMENT_FAILED,
        payment: { status: paymentStatus },
      });
      expect(declaration.canRetry).toBe(false);
      expect(declaration.canChangeProvider).toBe(false);
    }
  });

  it("blocks any new attempt while an order is under payment review", () => {
    const declaration = declarePaymentRetry({
      status: OrderStatus.PAYMENT_REVIEW_REQUIRED,
      payment: { status: PaymentStatus.REVIEW_REQUIRED },
    });
    expect(declaration.canRetry).toBe(false);
    expect(declaration.canChangeProvider).toBe(false);
  });

  it("blocks new attempts once the order is being fulfilled", () => {
    for (const status of [
      OrderStatus.PAYMENT_CONFIRMED,
      OrderStatus.PROVISIONING,
      OrderStatus.QR_READY,
      OrderStatus.COMPLETED,
    ]) {
      expect(declarePaymentRetry({ status }).canRetry).toBe(false);
    }
  });

  it("closes retry for cancelled or refunded orders", () => {
    expect(declarePaymentRetry({ status: OrderStatus.REFUNDED }).canRetry).toBe(
      false,
    );
    expect(
      declarePaymentRetry({ status: OrderStatus.CANCELLED }).canChangeProvider,
    ).toBe(false);
  });
});
