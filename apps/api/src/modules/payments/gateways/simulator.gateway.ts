import { Injectable } from "@nestjs/common";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { PaymentStatus } from "@visa-compass/shared";
import type { PaymentContext, PaymentGateway } from "../payment-gateway.js";
import { paymentSimulatorSecret } from "../../../common/payment-simulator-secret.js";

@Injectable()
export class PaymentSimulatorGateway implements PaymentGateway {
  readonly provider = "SIMULATOR";
  private records = new Map<
    string,
    { orderId: string; amountNpr: number; status: PaymentStatus }
  >();
  async initiate(input: {
    orderId: string;
    orderNumber: string;
    amountNpr: number;
    returnUrl: string;
  }) {
    const reference = randomUUID();
    this.records.set(reference, {
      orderId: input.orderId,
      amountNpr: input.amountNpr,
      status: PaymentStatus.PENDING,
    });
    return {
      reference,
      redirectUrl: `${input.returnUrl}?simulated=1&reference=${reference}`,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
  }
  complete(reference: string) {
    const record = this.records.get(reference);
    if (record) record.status = PaymentStatus.COMPLETED;
  }
  apply(
    reference: string,
    scenario: "SUCCESS" | "CANCELLED" | "PENDING" | "WRONG_AMOUNT" | "REFUNDED",
    context?: PaymentContext,
  ) {
    const record =
      this.records.get(reference) ??
      (context
        ? {
            orderId: context.orderId,
            amountNpr: context.amountNpr,
            status: PaymentStatus.PENDING,
          }
        : undefined);
    if (!record) return;
    this.records.set(reference, record);
    if (scenario === "SUCCESS") record.status = PaymentStatus.COMPLETED;
    if (scenario === "CANCELLED") record.status = PaymentStatus.CANCELLED;
    if (scenario === "PENDING") record.status = PaymentStatus.PENDING;
    if (scenario === "REFUNDED") record.status = PaymentStatus.REFUNDED;
    if (scenario === "WRONG_AMOUNT") {
      record.status = PaymentStatus.COMPLETED;
      record.amountNpr += 1;
    }
  }
  sign(payload: string) {
    return createHmac("sha256", paymentSimulatorSecret())
      .update(payload)
      .digest("hex");
  }
  verifySignature(payload: string, signature: string) {
    const expected = Buffer.from(this.sign(payload));
    const actual = Buffer.from(signature);
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }
  async verify(reference: string, context: PaymentContext) {
    const record = this.records.get(reference) ?? {
      orderId: context.orderId,
      amountNpr: context.amountNpr,
      status: PaymentStatus.PENDING,
    };
    return { reference, ...record, providerTransactionId: `sim-${reference}` };
  }
}
