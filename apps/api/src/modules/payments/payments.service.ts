import { BadRequestException, Injectable, Logger, Optional } from "@nestjs/common";
import {
  ApiErrorCode,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
} from "@visa-compass/shared";
import { ApiException } from "../../common/api-error.js";
import { OrdersService, type DemoOrder } from "../orders/orders.service.js";
import { KhaltiGateway } from "./gateways/khalti.gateway.js";
import { PaymentSimulatorGateway } from "./gateways/simulator.gateway.js";
import { FonepayGateway } from "./gateways/fonepay.gateway.js";
import { MetricsService } from "../../observability/metrics.service.js";
import { ProductionResilienceService } from "../../jobs/production-resilience.service.js";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { PaymentInitiationStatus, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

type InitiationResult = {
  reference: string;
  correlationId?: string;
  expiresAt?: string;
  redirectUrl?: string;
};

type VerifySource =
  "verify" | "callback" | "recent-reconcile" | "expiry-reconcile";

type LookupVerdict =
  | { outcome: "CONFIRMED"; transactionId?: string }
  | { outcome: "PENDING" }
  | {
      outcome: "TERMINAL";
      resolve: boolean;
      paymentStatus: PaymentStatus;
      code: string;
      message: string;
      reason: string;
    };

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly verifyAttempts = new Map<string, number>();
  private readonly maxVerifyAttempts = (() => {
    const parsed = Number(process.env.PAYMENT_VERIFY_ATTEMPTS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
  })();
  constructor(
    private orders: OrdersService,
    private khalti: KhaltiGateway,
    private simulator: PaymentSimulatorGateway,
    private readonly metrics?: MetricsService,
    private readonly resilience?: ProductionResilienceService,
    private readonly prisma?: PrismaService,
    @Optional() private readonly fonepay?: FonepayGateway,
  ) {}

  async initiate(
    orderId: string,
    ownerId: string | null,
    provider: PaymentProvider,
    returnUrlOverride?: string,
  ) {
    await this.orders.refreshOne?.(orderId, true);
    const order = this.orders.get(orderId, ownerId ?? undefined);
    if (order.purchaseType !== "TOPUP")
      await this.orders.assertInventoryAvailableForNewOrder();
    const existing = order.payment;
    if (
      existing &&
      existing.status === PaymentStatus.PENDING &&
      existing.expiresAt &&
      new Date(existing.expiresAt).getTime() > Date.now() &&
      existing.redirectUrl
    ) {
      return {
        reference: existing.reference,
        redirectUrl: existing.redirectUrl,
        expiresAt: existing.expiresAt,
        ...(existing.correlationId
          ? { correlationId: existing.correlationId }
          : {}),
      };
    }
    const returnUrl =
      returnUrlOverride ??
      `${process.env.CUSTOMER_WEB_URL ?? "http://localhost:3000"}/esim/checkout?order=${orderId}`;
    const result = this.prisma?.enabled
      ? await this.initiatePersisted(order, provider, returnUrl)
      : await this.gateway(provider).initiate({
          orderId,
          orderNumber: order.orderNumber,
          amountNpr: order.totalAmountNpr,
          returnUrl,
        });
    await this.orders.beginPayment(orderId, ownerId, provider, {
      ...result,
      returnUrl,
    });
    return result;
  }

  private async initiatePersisted(
    order: DemoOrder,
    provider: PaymentProvider,
    returnUrl: string,
  ): Promise<InitiationResult> {
    const prisma = this.prisma!;
    const claimToken = randomUUID();
    const leaseExpiresAt = new Date(Date.now() + 2 * 60_000);
    let owned = false;
    try {
      await prisma.paymentInitiation.create({
        data: {
          orderId: order.id,
          provider,
          amountNpr: order.totalAmountNpr,
          claimToken,
          leaseExpiresAt,
        },
      });
      owned = true;
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
    }

    const deadline = Date.now() + 15_000;
    while (!owned && Date.now() < deadline) {
      const record = await prisma.paymentInitiation.findUnique({ where: { orderId: order.id } });
      if (!record) continue;
      if (record.provider !== provider || record.amountNpr !== order.totalAmountNpr)
        throw new BadRequestException("Payment initiation conflicts with the current order amount or provider");
      if (record.status === PaymentInitiationStatus.COMPLETED && record.result)
        return record.result as InitiationResult;
      if (
        record.status === PaymentInitiationStatus.FAILED ||
        record.leaseExpiresAt.getTime() <= Date.now()
      ) {
        const reclaimed = await prisma.paymentInitiation.updateMany({
          where: {
            id: record.id,
            OR: [
              { status: PaymentInitiationStatus.FAILED },
              { status: PaymentInitiationStatus.PROCESSING, leaseExpiresAt: { lte: new Date() } },
            ],
          },
          data: {
            status: PaymentInitiationStatus.PROCESSING,
            claimToken,
            leaseExpiresAt,
            result: Prisma.JsonNull,
            errorCode: null,
          },
        });
        owned = reclaimed.count === 1;
        if (owned)
          void this.resilience?.attention({
            dedupeKey: `payment-initiation-reclaimed:${order.id}`,
            category: "PAYMENT",
            entityType: "Order",
            entityId: order.id,
            orderId: order.id,
            severity: "WARNING",
            summary: `Recovered an interrupted payment initiation for ${order.orderNumber}`,
            failureCategory: "PAYMENT_INITIATION_INTERRUPTED",
          });
      }
      if (!owned) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!owned)
      throw new ApiException({
        code: "PAYMENT_VERIFICATION_PENDING",
        message: "Payment initiation is still processing; retry shortly",
      });

    try {
      const result = await this.gateway(provider).initiate({
        orderId: order.id,
        orderNumber: order.orderNumber,
        amountNpr: order.totalAmountNpr,
        returnUrl,
      });
      const saved = await prisma.paymentInitiation.updateMany({
        where: { orderId: order.id, claimToken, status: PaymentInitiationStatus.PROCESSING },
        data: {
          status: PaymentInitiationStatus.COMPLETED,
          result: result as Prisma.InputJsonValue,
          leaseExpiresAt: new Date(),
        },
      });
      if (saved.count !== 1)
        throw new Error("Payment initiation ownership was lost before persistence");
      return result;
    } catch (error) {
      await prisma.paymentInitiation.updateMany({
        where: { orderId: order.id, claimToken, status: PaymentInitiationStatus.PROCESSING },
        data: {
          status: PaymentInitiationStatus.FAILED,
          errorCode: "PROVIDER_INITIATION_FAILED",
          leaseExpiresAt: new Date(),
        },
      });
      throw error;
    }
  }

  /**
   * Confirmative lookup for a checkout initiated on the API. Kinds of verdict:
   * - Completed + matching order/amount -> payment confirmed (advances the order).
   * - Pending / Initiated -> HTTP 200 with the current order so the client can
   *   retry the lookup with backoff (Khalti can report pending for a few
   *   seconds after the wallet redirects back).
   * - Expired / user canceled -> order moved to PAYMENT_FAILED (retryable, a
   *   fresh Khalti session can be created) and a stable error code returned.
   * - Amount/reference mismatch -> security error; the order stays pending.
   */
  async verify(orderId: string, ownerId: string | null, reference: string) {
    await this.orders.refreshOne?.(orderId, true);
    const order = this.orders.get(orderId, ownerId ?? undefined);
    if (order.payment?.reference !== reference) {
      await this.flagPaymentMismatch(
        order,
        "Submitted payment reference does not belong to this order",
      );
      throw new BadRequestException("Payment reference mismatch");
    }
    const verdict = await this.lookup(order, reference, "verify");
    return this.applyVerdict(orderId, ownerId, reference, verdict);
  }

  /** Same verdict semantics for the callback/job path (server initiated). */
  async verifyCallback(orderId: string, reference: string) {
    await this.orders.refreshOne?.(orderId, true);
    const order = this.orders.get(orderId);
    if (order.payment?.status === PaymentStatus.COMPLETED)
      return this.orders.view(orderId);
    const verdict = await this.lookup(order, reference, "callback");
    return this.applyVerdict(orderId, null, reference, verdict);
  }

  /**
   * Fast reconciliation sweep for orders still inside their payment window.
   * Runs on its own short timer (PAYMENT_RECONCILE_INTERVAL_SECONDS); it only
   * confirms a Completed lookup and leaves Pending orders pending — it never
   * fails them, so a normal pending result is not confused with a provider
   * failure. Provider errors are deferred. Expiry enforcement stays with
   * reconcilePendingPayments().
   */
  async reconcileRecentPendingPayments(): Promise<{
    confirmed: string[];
    stillPending: string[];
    terminal: string[];
    errored: string[];
  }> {
    const confirmed: string[] = [];
    const stillPending: string[] = [];
    const terminal: string[] = [];
    const errored: string[] = [];
    const now = Date.now();
    for (const order of this.orders.list()) {
      if (
        order.status !== OrderStatus.PAYMENT_PENDING ||
        !order.payment ||
        order.payment.status !== PaymentStatus.PENDING ||
        !order.payment.reference
      )
        continue;
      const reference = order.payment.reference;
      const expiry =
        order.payment.expiresAt ??
        new Date(
          new Date(order.createdAt).getTime() + 30 * 60_000,
        ).toISOString();
      if (now >= new Date(expiry).getTime()) continue; // hand-off to the expiry-phase reconcile
      try {
        const verdict = await this.lookup(order, reference, "recent-reconcile");
        if (verdict.outcome === "CONFIRMED") {
          await this.orders.confirmPayment(order.id, reference);
          confirmed.push(order.id);
        } else if (verdict.outcome === "TERMINAL") {
          if (verdict.resolve)
            await this.orders.resolvePaymentFailure(
              order.id,
              null,
              verdict.reason,
              verdict.paymentStatus,
            );
          if (verdict.code === ApiErrorCode.PAYMENT_REFERENCE_MISMATCH)
            this.logger.warn(
              JSON.stringify({
                event: "payment_mismatch",
                orderId: order.id,
                source: "recent-reconcile",
              }),
            );
          terminal.push(order.id);
        } else {
          stillPending.push(order.id);
        }
      } catch (error) {
        errored.push(order.id);
        this.logger.warn(
          JSON.stringify({
            event: "payment_reconcile_error",
            orderId: order.id,
            source: "recent-reconcile",
            error: error instanceof Error ? error.message : "unknown",
          }),
        );
      }
    }
    return { confirmed, stillPending, terminal, errored };
  }

  private async applyVerdict(
    orderId: string,
    ownerId: string | null,
    reference: string,
    verdict: LookupVerdict,
  ) {
    if (verdict.outcome === "CONFIRMED")
      return this.orders.confirmPayment(
        orderId,
        reference,
        verdict.transactionId,
      );
    if (verdict.outcome === "PENDING")
      return this.orders.view(orderId, ownerId ?? undefined);
    if (verdict.resolve)
      await this.orders.resolvePaymentFailure(
        orderId,
        ownerId,
        verdict.reason,
        verdict.paymentStatus,
      );
    else
      await this.flagPaymentMismatch(
        this.orders.get(orderId, ownerId ?? undefined),
        verdict.reason,
      );
    throw new ApiException({
      code: verdict.code,
      message: verdict.message,
      status: 400,
      details: verdict.reason,
    });
  }

  /** Performs the gateway lookup and classifies the verdict for the caller. */
  private async lookup(
    order: DemoOrder,
    reference: string,
    source: VerifySource,
  ): Promise<LookupVerdict> {
    const context = this.context(order, reference);
    const result = await this.gateway(order.payment?.provider).verify(
      reference,
      context,
    );
    this.logger.debug({
      event: "payment_lookup",
      orderId: order.id,
      providerStatus: result.status,
      source,
    });
    if (result.status === PaymentStatus.COMPLETED) {
      if (
        result.orderId === order.id &&
        result.amountNpr === order.totalAmountNpr &&
        (!("currency" in result) ||
          (result.currency ?? "NPR").toUpperCase() === "NPR")
      )
        return result.providerTransactionId
          ? {
              outcome: "CONFIRMED" as const,
              transactionId: result.providerTransactionId,
            }
          : { outcome: "CONFIRMED" as const };
      return {
        outcome: "TERMINAL",
        resolve: false,
        paymentStatus: PaymentStatus.PENDING,
        code: ApiErrorCode.PAYMENT_REFERENCE_MISMATCH,
        message:
          "We could not confirm your payment. Please verify with your wallet or contact support.",
        reason: `Payment verification mismatch (order/amount/currency) for order ${order.id}`,
      };
    }
    if (result.status === PaymentStatus.PENDING) return { outcome: "PENDING" };
    if (result.status === PaymentStatus.CANCELLED) {
      return {
        outcome: "TERMINAL",
        resolve: true,
        paymentStatus: PaymentStatus.CANCELLED,
        code: ApiErrorCode.PAYMENT_NOT_CONFIRMED,
        message:
          "We could not confirm your payment. Please verify with your wallet or retry.",
        reason: "Customer cancelled the payment at the wallet",
      };
    }
    return {
      outcome: "TERMINAL",
      resolve: true,
      paymentStatus: PaymentStatus.FAILED,
      code: ApiErrorCode.PAYMENT_EXPIRED,
      message: "This payment attempt has expired. Please start a new one.",
      reason: `Payment completion could not be confirmed (provider status ${result.status ?? "unknown"})`,
    };
  }

  /**
   * Reconciliation sweep for pending payments whose payment window has elapsed
   * (plus a short grace period). The gateway is queried one last time so a
   * payment that completed server-side but whose callback was dropped is
   * recovered instead of being failed on a timer. When the gateway is
   * transiently unavailable the verdict is deferred for up to
   * PAYMENT_VERIFY_ATTEMPTS before the payment is moved to durable operational
   * review. Provider unavailability never proves that a payment failed.
   */
  async reconcilePendingPayments(): Promise<{
    verified: string[];
    failed: string[];
    deferred: string[];
    reviewRequired: string[];
  }> {
    const now = Date.now();
    const verified: string[] = [];
    const failed: string[] = [];
    const deferred: string[] = [];
    const reviewRequired: string[] = [];
    for (const order of this.orders.list()) {
      if (
        order.status !== OrderStatus.PAYMENT_PENDING ||
        !order.payment ||
        order.payment.status !== PaymentStatus.PENDING ||
        !order.payment.reference
      )
        continue;
      const reference = order.payment.reference;
      const expiry =
        order.payment.expiresAt ??
        new Date(
          new Date(order.createdAt).getTime() + 30 * 60_000,
        ).toISOString();
      if (now < new Date(expiry).getTime()) continue;
      const attempt = await this.nextVerifyAttempt(order);
      try {
        const verdict = await this.lookup(order, reference, "expiry-reconcile");
        if (verdict.outcome === "CONFIRMED") {
          await this.orders.confirmPayment(
            order.id,
            reference,
            verdict.transactionId,
          );
          await this.clearVerifyAttempts(order);
          verified.push(order.id);
        } else if (verdict.outcome === "TERMINAL" && verdict.resolve) {
          await this.orders.resolvePaymentFailure(
            order.id,
            null,
            verdict.reason,
            verdict.paymentStatus,
          );
          await this.clearVerifyAttempts(order);
          failed.push(order.id);
        } else {
          await this.markReviewRequired(
            order,
            `Payment completion remains ${verdict.outcome === "PENDING" ? "pending" : "mismatched"} after the payment window`,
          );
          await this.clearVerifyAttempts(order);
          reviewRequired.push(order.id);
        }
      } catch (error) {
        if (attempt >= this.maxVerifyAttempts) {
          await this.markReviewRequired(
            order,
            `Payment gateway remained unreachable after ${attempt} verification attempts`,
          );
          await this.clearVerifyAttempts(order);
          reviewRequired.push(order.id);
        } else {
          deferred.push(order.id);
          this.logger.warn(
            `Payment verification deferred for order ${order.id} (attempt ${attempt}/${this.maxVerifyAttempts}): ${error instanceof Error ? error.message : "unknown"}`,
          );
        }
      }
    }
    return { verified, failed, deferred, reviewRequired };
  }

  private async nextVerifyAttempt(order: DemoOrder): Promise<number> {
    if (this.prisma?.enabled && order.payment?.reference) {
      const payment = await this.prisma.payment.update({
        where: { paymentReference: order.payment.reference },
        data: {
          verificationAttempts: { increment: 1 },
          lastVerifiedAt: new Date(),
        },
        select: { verificationAttempts: true },
      });
      return payment.verificationAttempts;
    }
    const attempt = (this.verifyAttempts.get(order.id) ?? 0) + 1;
    this.verifyAttempts.set(order.id, attempt);
    return attempt;
  }

  private async clearVerifyAttempts(order: DemoOrder): Promise<void> {
    if (this.prisma?.enabled && order.payment?.reference) {
      await this.prisma.payment.updateMany({
        where: { paymentReference: order.payment.reference },
        data: { verificationAttempts: 0, lastVerifiedAt: new Date() },
      });
      return;
    }
    this.verifyAttempts.delete(order.id);
  }
  private async markReviewRequired(order: DemoOrder, reason: string) {
    await this.orders.requirePaymentReview?.(order.id, reason);
    await this.resilience?.attention({
      dedupeKey: `payment-review:${order.id}`,
      category: "PAYMENT_UNCERTAIN",
      entityType: "Order",
      entityId: order.id,
      orderId: order.id,
      summary: `Payment needs confirmation for ${order.orderNumber}`,
      detail: reason,
      localState: OrderStatus.PAYMENT_REVIEW_REQUIRED,
      lastSuccessfulStep: "PAYMENT_INITIATED",
      failureCategory: "PROVIDER_UNREACHABLE",
      availableActions: [
        "RECHECK_PAYMENT",
        "CANCEL_IF_GATEWAY_CONFIRMS_FAILURE",
      ],
    });
  }

  private async flagPaymentMismatch(order: DemoOrder, reason: string) {
    await this.resilience?.attention({
      dedupeKey: `payment-security-mismatch:${order.id}`,
      category: "PAYMENT_SECURITY",
      entityType: "Order",
      entityId: order.id,
      orderId: order.id,
      severity: "CRITICAL",
      summary: `Payment verification mismatch for ${order.orderNumber}`,
      detail: reason,
      localState: order.status,
      lastSuccessfulStep: "PAYMENT_INITIATED",
      failureCategory: "PAYMENT_REFERENCE_AMOUNT_OR_CURRENCY_MISMATCH",
      availableActions: ["RECHECK_PAYMENT"],
    });
  }
  async simulate(
    orderId: string,
    ownerId: string | null,
    reference: string,
    scenario:
      | "SUCCESS"
      | "CANCELLED"
      | "PENDING"
      | "WRONG_AMOUNT"
      | "REFUNDED"
      | "TIMEOUT" = "SUCCESS",
  ) {
    if (process.env.NODE_ENV === "production")
      throw new BadRequestException("Simulator is disabled");
    if (scenario === "TIMEOUT")
      throw new BadRequestException("Simulated payment provider timeout");
    const order = this.orders.get(orderId, ownerId ?? undefined);
    const context = this.context(order, reference);
    this.simulator.apply(reference, scenario, context);
    const result = await this.simulator.verify(reference, context);
    if (
      result.status !== PaymentStatus.COMPLETED ||
      result.orderId !== orderId ||
      result.amountNpr !== order.totalAmountNpr
    )
      throw new BadRequestException(
        `Payment verification failed: ${result.status}`,
      );
    return await this.orders.confirmPayment(
      orderId,
      reference,
      result.providerTransactionId,
    );
  }
  private context(order: ReturnType<OrdersService["get"]>, reference: string) {
    if (order.payment?.reference !== reference)
      throw new BadRequestException("Payment reference mismatch");
    return {
      orderId: order.id,
      amountNpr: order.totalAmountNpr,
      currency: "NPR",
      ...(order.payment.correlationId
        ? { correlationId: order.payment.correlationId }
        : {}),
    };
  }
  private gateway(provider?: PaymentProvider) {
    if (process.env.PAYMENT_MODE === "simulator") return this.simulator;
    if (provider === PaymentProvider.FONEPAY) {
      if (!this.fonepay) throw new BadRequestException("Fonepay is unavailable");
      return this.fonepay;
    }
    if (
      process.env.NODE_ENV === "production" ||
      ["khalti", "sandbox"].includes(process.env.PAYMENT_MODE ?? "")
    )
      return this.khalti;
    return this.simulator;
  }
}
