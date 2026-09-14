import { describe, expect, it } from "vitest";
import { OrderStatus } from "@visa-compass/shared";
import { canTransition } from "./order-machine.js";

describe("order lifecycle", () => {
  it("never provisions before approval", () =>
    expect(
      canTransition(OrderStatus.PAYMENT_CONFIRMED, OrderStatus.PROVISIONING),
    ).toBe(false));
  it("auto-approves a confirmed payment", () =>
    expect(
      canTransition(OrderStatus.PAYMENT_CONFIRMED, OrderStatus.APPROVED),
    ).toBe(true));
  it("allows an approved order to provision", () =>
    expect(canTransition(OrderStatus.APPROVED, OrderStatus.PROVISIONING)).toBe(
      true,
    ));
  it("never returns completed orders to an active state", () =>
    expect(canTransition(OrderStatus.COMPLETED, OrderStatus.PROVISIONING)).toBe(
      false,
    ));
  it("allows a completed order to enter the explicit refund workflow", () =>
    expect(
      canTransition(OrderStatus.COMPLETED, OrderStatus.REFUND_PENDING),
    ).toBe(true));
  it("moves a provisioned order to QR_READY before completion", () =>
    expect(canTransition(OrderStatus.PROVISIONING, OrderStatus.QR_READY)).toBe(
      true,
    ));
  it("routes every charged order through the pending refund workflow", () => {
    [OrderStatus.PAYMENT_CONFIRMED, OrderStatus.REVIEW_PENDING,
      OrderStatus.AWAITING_CUSTOMER, OrderStatus.APPROVED,
      OrderStatus.PROVISIONING, OrderStatus.PROVISIONING_FAILED,
      OrderStatus.QR_READY, OrderStatus.ACTIVATION_ATTENTION,
      OrderStatus.COMPLETED].forEach((status) =>
      expect(canTransition(status, OrderStatus.REFUND_PENDING)).toBe(true),
    );
  });
  it("never marks a charged order refunded without passing the pending state", () => {
    expect(
      canTransition(OrderStatus.PROVISIONING, OrderStatus.REFUNDED),
    ).toBe(false);
    expect(canTransition(OrderStatus.QR_READY, OrderStatus.REFUNDED)).toBe(
      false,
    );
    expect(
      canTransition(OrderStatus.PROVISIONING_FAILED, OrderStatus.REFUNDED),
    ).toBe(false);
  });
  it("blocks refund entries for uncharged or already-terminated orders", () => {
    [OrderStatus.DRAFT, OrderStatus.PAYMENT_PENDING,
      OrderStatus.PAYMENT_FAILED, OrderStatus.CANCELLED,
      OrderStatus.REFUNDED].forEach((status) =>
      expect(canTransition(status, OrderStatus.REFUND_PENDING)).toBe(false),
    );
  });
  it("only completes an order once activated", () =>
    expect(canTransition(OrderStatus.QR_READY, OrderStatus.COMPLETED)).toBe(
      true,
    ));
  it("routes a stale ready order to activation attention without invalidating its QR", () =>
    expect(
      canTransition(OrderStatus.QR_READY, OrderStatus.ACTIVATION_ATTENTION),
    ).toBe(true));
  it("never completes before qr delivered", () =>
    expect(canTransition(OrderStatus.APPROVED, OrderStatus.COMPLETED)).toBe(
      false,
    ));
  it("never moves a QR order straight to provisioning", () =>
    expect(canTransition(OrderStatus.QR_READY, OrderStatus.PROVISIONING)).toBe(
      false,
    ));
});
