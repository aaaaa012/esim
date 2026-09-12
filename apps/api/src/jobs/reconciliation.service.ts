import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma.service.js";
import { ConnectivityService } from "../modules/integration/connectivity.service.js";
import { NotificationService } from "../modules/notification/notification.service.js";
import { MetricsService } from "../observability/metrics.service.js";
import { UsageService } from "../modules/esims/usage.service.js";
import { S3StorageService } from "../infrastructure/s3-storage.service.js";
import { QueueService } from "./queue.service.js";
import { QUEUES } from "./queues.js";
import { OrdersService } from "../modules/orders/orders.service.js";
import { PaymentsService } from "../modules/payments/payments.service.js";
import { InventoryService } from "../modules/inventory/inventory.service.js";
import { TransatelOperationsService } from "../modules/integration/transatel-operations.service.js";
import { ProductionResilienceService } from "./production-resilience.service.js";
import { ManualRefundsService } from "../modules/payments/manual-refunds.service.js";
import { ApiException } from "../common/api-error.js";
import { ApiErrorCode } from "@visa-compass/shared";
import {
  ocrJobOptions,
  ocrRecoveryConfig,
  orderPassportOcrJobId,
} from "./ocr-recovery.config.js";
import { createHash, randomUUID } from "node:crypto";
import { PartnerService } from "../modules/partners/partner.service.js";
import { PublicAssetStorageService } from "../infrastructure/public-asset-storage.service.js";
import { FonepayGateway } from "../modules/payments/gateways/fonepay.gateway.js";

/**
 * Background reconciliation of active Transatel subscriptions.
 *
 * Periodically scans active subscriptions whose usage is stale, then polls the
 * connectivity provider for fresh usage balances and persists them. Jobs are
 * processed through the queue (or in-process when the queue is simulated) and
 * are idempotent per subscription id.
 */
@Injectable()
export class ReconciliationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationService.name);
  private timer?: ReturnType<typeof setInterval>;
  private pendingPaymentTimer?: ReturnType<typeof setInterval>;
  private ocrRecoveryTimer?: ReturnType<typeof setInterval>;
  private fonepayBankSyncTimer?: ReturnType<typeof setInterval>;
  private repairedReusableInventory = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectivity: ConnectivityService,
    private readonly queues: QueueService,
    private readonly notifications: NotificationService,
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
    private readonly inventory: InventoryService,
    private readonly transatelOperations: TransatelOperationsService,
    private readonly resilience: ProductionResilienceService,
    private readonly refunds: ManualRefundsService,
    private readonly storage: S3StorageService,
    private readonly partners: PartnerService,
    private readonly metrics?: MetricsService,
    private readonly usageService?: UsageService,
    private readonly publicAssets?: PublicAssetStorageService,
    @Optional() private readonly fonepay?: FonepayGateway,
  ) {}

  onModuleInit() {
    if (process.env.PROCESS_ROLE === "api") return;
    this.queues.registerWorker(
      QUEUES.reconciliation,
      async (job) => {
        const data = job.data as {
          id?: string;
          kind?: string;
          runId?: string;
          assetKey?: string;
          outboxId?: string;
        };
        if (data.kind === "homepage-asset-cleanup") {
          if (!data.assetKey) throw new Error("Asset cleanup key is missing");
          if (!this.publicAssets)
            throw new Error("Public asset storage is unavailable");
          try {
            await this.publicAssets.deleteCampaignAsset(data.assetKey);
            await this.resilience.resolve(
              `homepage-asset-cleanup:${data.assetKey}`,
              null,
              "Campaign asset deleted",
            );
            return { deleted: true };
          } catch (error) {
            const finalAttempt =
              job.attemptsMade + 1 >= Number(job.opts.attempts ?? 1);
            if (finalAttempt && data.outboxId && this.prisma.enabled)
              await this.prisma.outboxMessage.updateMany({
                where: { id: data.outboxId, status: "ENQUEUED" },
                data: {
                  status: "FAILED",
                  errorMessage:
                    error instanceof Error ? error.message : "unknown",
                  nextAttemptAt: new Date(Date.now() + 60 * 60_000),
                },
              });
            if (finalAttempt)
              await this.resilience.attention({
                dedupeKey: `homepage-asset-cleanup:${data.assetKey}`,
                category: "ASSET_CLEANUP_FAILED",
                entityType: "HomepageCampaignAsset",
                entityId: data.assetKey,
                severity: "WARNING",
                summary: "Campaign asset deletion is delayed",
                detail: error instanceof Error ? error.message : "unknown",
                failureCategory: "OBJECT_STORAGE_DELETE_FAILED",
                availableActions: [],
              });
            throw error;
          }
        }
        if (data.kind === "esim-usage" && this.usageService)
          return this.usageService.refresh(String(data.id));
        if (data.kind !== "inventory-profile")
          return this.reconcile(String(data.id));
        try {
          const result = await this.inventory.reconcileProviderProfile(
            String(data.id),
          );
          if (data.runId)
            await this.inventory.completeProviderReconciliationItem(
              data.runId,
              String(data.id),
              "SUCCESS",
            );
          return result;
        } catch (error) {
          const notFound =
            error instanceof ApiException &&
            error.code === ApiErrorCode.ESIM_NOT_FOUND;
          const finalAttempt =
            job.attemptsMade + 1 >= Number(job.opts.attempts ?? 1);
          if (data.runId && (notFound || finalAttempt))
            await this.inventory.completeProviderReconciliationItem(
              data.runId,
              String(data.id),
              notFound ? "NOT_FOUND" : "FAILED",
              error instanceof Error ? error.message : "Provider check failed",
            );
          if (notFound) return { status: "NOT_FOUND" };
          throw error;
        }
      },
      {
        concurrency: Math.max(
          1,
          Number(process.env.TRANSATEL_RECONCILIATION_CONCURRENCY ?? 1),
        ),
      },
    );
    const minutes = Number(process.env.RECONCILIATION_INTERVAL_MINUTES ?? 15);
    const intervalMs =
      Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 15 * 60_000;
    this.timer = setInterval(
      () =>
        void this.runAsLeader().catch((error) => this.recordRunFailure(error)),
      intervalMs,
    );
    void this.runAsLeader().catch((error) => this.recordRunFailure(error));
    // Separate, faster sweep for pending payments that are still inside their
    // payment window (PAYMENT_RECONCILE_INTERVAL_SECONDS, default 45s). This is
    // a backstop for browser verification: it confirms Completed payments and
    // leaves Pending ones alone. It is kept apart from the expiry-phase
    // reconcile so a normal pending result is never treated as a failure. On
    // Render this only runs while the instance is awake — the browser return
    // (which wakes the API) plus an external health cron are the primary
    // recovery path.
    const pendingSeconds = Number(
      process.env.PAYMENT_RECONCILE_INTERVAL_SECONDS ?? 45,
    );
    const pendingMs =
      Number.isFinite(pendingSeconds) && pendingSeconds > 0
        ? pendingSeconds * 1000
        : 45_000;
    this.pendingPaymentTimer = setInterval(
      () =>
        void this.pendingPaymentsAsLeader().catch((error) =>
          this.recordRunFailure(error, "pending-payments"),
        ),
      pendingMs,
    );
    void this.pendingPaymentsAsLeader().catch((error) =>
      this.recordRunFailure(error, "pending-payments"),
    );
    const { sweepMs } = ocrRecoveryConfig();
    this.ocrRecoveryTimer = setInterval(
      () =>
        void this.ocrRecoveryAsLeader().catch((error) =>
          this.recordRunFailure(error, "ocr-recovery"),
        ),
      sweepMs,
    );
    void this.ocrRecoveryAsLeader().catch((error) =>
      this.recordRunFailure(error, "ocr-recovery"),
    );
    this.registerFonepayBankSync();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.pendingPaymentTimer) clearInterval(this.pendingPaymentTimer);
    if (this.ocrRecoveryTimer) clearInterval(this.ocrRecoveryTimer);
    if (this.fonepayBankSyncTimer) clearInterval(this.fonepayBankSyncTimer);
  }

  private async runAsLeader() {
    const result = await this.queues.withDistributedLock(
      "reconciliation",
      10 * 60_000,
      (signal) => this.run(signal),
    );
    if (!result.acquired)
      this.logger.debug(
        "Skipped reconciliation; another replica holds the lease",
      );
    return result.value;
  }

  private async pendingPaymentsAsLeader() {
    const result = await this.queues.withDistributedLock(
      "pending-payment-reconciliation",
      60_000,
      () => this.payments.reconcileRecentPendingPayments(),
    );
    if (!result.acquired)
      this.logger.debug(
        "Skipped pending-payment reconciliation; another replica holds the lease",
      );
    else
      await this.resilience
        .heartbeat("payment-reconcile", {
          role: process.env.PROCESS_ROLE ?? "workflow-worker",
          completedAt: new Date().toISOString(),
          confirmed: result.value?.confirmed.length ?? 0,
          stillPending: result.value?.stillPending.length ?? 0,
        })
        .catch((error) =>
          this.logger.warn(
            `Could not heartbeat payment reconcile: ${error instanceof Error ? error.message : "unknown"}`,
          ),
        );
    return result.value;
  }

  private async ocrRecoveryAsLeader() {
    const { sweepMs } = ocrRecoveryConfig();
    const result = await this.queues.withDistributedLock(
      "ocr-recovery",
      Math.max(sweepMs, 5_000),
      () => this.reconcileOcrAvailability(),
    );
    if (!result.acquired)
      this.logger.debug(
        "Skipped OCR recovery; another replica holds the lease",
      );
    return result.value;
  }

  /**
   * Periodic refresh of the Fonepay bank directory. This is a background,
   * single-flight sync (distributed lease) so the cached, audited directory
   * stays current without concurrent writers. Outages keep the last good
   * directory; the failure is recorded on the sync row and surfaced to Ops.
   * Runs only on workers (onModuleInit already returns early for PROCESS_ROLE
   * "api") and only when Fonepay is actually configured.
   */
  private registerFonepayBankSync() {
    if (process.env.FONEPAY_ENABLED !== "true") return;
    if (!this.fonepay) {
      this.logger.warn("Fonepay is enabled but the gateway is unavailable");
      return;
    }
    const minutes = Number(
      process.env.FONEPAY_BANK_SYNC_INTERVAL_MINUTES ?? 360,
    );
    const intervalMs =
      Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 360 * 60_000;
    this.fonepayBankSyncTimer = setInterval(
      () =>
        void this.fonepayBankSyncAsLeader().catch((error) =>
          this.recordRunFailure(error, "fonepay-bank-sync"),
        ),
      intervalMs,
    );
    void this.fonepayBankSyncAsLeader().catch((error) =>
      this.recordRunFailure(error, "fonepay-bank-sync"),
    );
  }

  private async fonepayBankSyncAsLeader() {
    if (!this.fonepay) return { synced: false };
    const gateway = this.fonepay;
    const result = await this.queues.withDistributedLock(
      "fonepay-bank-directory-sync",
      10 * 60_000,
      () => gateway.syncBankDirectory(),
    );
    if (!result.acquired)
      this.logger.debug(
        "Skipped Fonepay bank sync; another replica holds the lease",
      );
    return result.value;
  }

  /**
   * This sweep is intentionally owned by the workflow worker, not the OCR
   * worker. It can therefore wait for a dead OCR process to recover, retry a
   * missed queue handoff, and still make the deterministic manual-review
   * decision when the grace window expires.
   */
  private async reconcileOcrAvailability() {
    if (!this.prisma.enabled) return { retried: 0, manual: 0 };
    const now = new Date();
    const { graceMs } = ocrRecoveryConfig();
    const cutoff = new Date(now.getTime() - graceMs);
    let retried = 0;
    let manual = 0;
    const orders = await this.prisma.order.findMany({
      where: {
        documentReviewStatus: { in: ["OCR_PENDING", "OCR_BACKGROUND"] },
        documentReviewStartedAt: { not: null },
      },
      select: {
        id: true,
        status: true,
        documentReviewStartedAt: true,
        documents: {
          where: { type: "PASSPORT" },
          select: { id: true, privateAssetId: true },
          take: 1,
        },
      },
      take: 100,
      orderBy: { documentReviewStartedAt: "asc" },
    });
    for (const order of orders) {
      const startedAt = order.documentReviewStartedAt!;
      if (startedAt <= cutoff) {
        const updated = await this.prisma.order.updateMany({
          where: {
            id: order.id,
            documentReviewStatus: { in: ["OCR_PENDING", "OCR_BACKGROUND"] },
          },
          data: { documentReviewStatus: "MANUAL_REVIEW" },
        });
        if (!updated.count) continue;
        manual += 1;
        await this.prisma.orderEvent.create({
          data: {
            orderId: order.id,
            fromStatus: order.status,
            toStatus: order.status,
            reason:
              "Automated verification remained unavailable through the recovery window; manual review is required before payment",
            metadata: {
              documentReviewStatus: "MANUAL_REVIEW",
              failureCategory: "OCR_UNAVAILABLE_AFTER_GRACE_PERIOD",
            },
          },
        });
        await this.resilience.attention({
          dedupeKey: `document-review:${order.id}`,
          category: "DOCUMENT_MANUAL_REVIEW",
          entityType: "Order",
          entityId: order.id,
          orderId: order.id,
          summary: "OCR remained unavailable; documents need manual review",
          localState: order.status,
          failureCategory: "OCR_UNAVAILABLE_AFTER_GRACE_PERIOD",
          lastSuccessfulStep: "DOCUMENTS_UPLOADED",
          availableActions: [],
        });
        continue;
      }
      const passport = order.documents[0];
      if (!passport) continue;
      try {
        await this.queues.add(
          QUEUES.documents,
          "verify-order-passport",
          {
            orderId: order.id,
            documentId: passport.id,
            privateAssetId: passport.privateAssetId,
          },
          orderPassportOcrJobId(order.id, passport.id, passport.privateAssetId),
          ocrJobOptions(),
        );
        retried += 1;
      } catch (error) {
        this.logger.warn(
          `OCR queue retry deferred for ${order.id}: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }

    const partnerVerifications =
      await this.prisma.partnerDocumentVerification.findMany({
        where: { status: "PROCESSING" },
        select: {
          id: true,
          partnerId: true,
          externalOrderId: true,
          updatedAt: true,
          consumedOrderId: true,
          documents: {
            where: { type: "PASSPORT" },
            select: { privateAssetId: true },
            take: 1,
          },
        },
        take: 100,
        orderBy: { updatedAt: "asc" },
      });
    for (const verification of partnerVerifications) {
      if (verification.updatedAt <= cutoff) {
        const result = await this.prisma.$transaction(async (tx) => {
          const updated = await tx.partnerDocumentVerification.updateMany({
            where: { id: verification.id, status: "PROCESSING" },
            data: {
              status: "MANUAL_REVIEW",
              failureCode: "OCR_UNAVAILABLE_AFTER_GRACE_PERIOD",
            },
          });
          if (!updated.count || !verification.consumedOrderId)
            return { verificationUpdated: updated.count, order: null };
          const linkedOrder = await tx.order.findFirst({
            where: {
              id: verification.consumedOrderId,
              status: { in: ["REVIEW_PENDING", "AWAITING_CUSTOMER"] },
              documentReviewStatus: { in: ["OCR_PENDING", "OCR_BACKGROUND"] },
            },
            select: { id: true, status: true, version: true },
          });
          if (!linkedOrder)
            return { verificationUpdated: updated.count, order: null };
          const orderUpdated = await tx.order.updateMany({
            where: {
              id: linkedOrder.id,
              version: linkedOrder.version,
              documentReviewStatus: { in: ["OCR_PENDING", "OCR_BACKGROUND"] },
            },
            data: {
              documentReviewStatus: "MANUAL_REVIEW",
              version: { increment: 1 },
            },
          });
          if (!orderUpdated.count)
            return { verificationUpdated: updated.count, order: null };
          await tx.orderEvent.create({
            data: {
              orderId: linkedOrder.id,
              fromStatus: linkedOrder.status,
              toStatus: linkedOrder.status,
              reason:
                "Automated partner passport verification remained unavailable through the recovery window; manual review is required before finalization",
              metadata: {
                documentReviewStatus: "MANUAL_REVIEW",
                failureCategory: "OCR_UNAVAILABLE_AFTER_GRACE_PERIOD",
              },
            },
          });
          return {
            verificationUpdated: updated.count,
            order: { id: linkedOrder.id, status: linkedOrder.status },
          };
        });
        manual += result.verificationUpdated;
        if (result.order)
          await this.resilience.attention({
            dedupeKey: `document-review:${result.order.id}`,
            category: "DOCUMENT_MANUAL_REVIEW",
            entityType: "Order",
            entityId: result.order.id,
            orderId: result.order.id,
            summary:
              "Partner OCR remained unavailable; documents need manual review",
            localState: result.order.status,
            failureCategory: "OCR_UNAVAILABLE_AFTER_GRACE_PERIOD",
            lastSuccessfulStep: "DOCUMENTS_UPLOADED",
            availableActions: [],
          });
        if (result.order)
          await this.emitPartnerVerificationEvent(
            verification.partnerId,
            verification.id,
            verification.externalOrderId,
            "document.verification.manual_review",
            result.order.id,
          );
        continue;
      }
      try {
        const attemptKey = createHash("sha256")
          .update(verification.documents[0]?.privateAssetId ?? verification.id)
          .digest("hex")
          .slice(0, 16);
        await this.queues.add(
          QUEUES.documents,
          "verify-partner-documents",
          { verificationId: verification.id },
          `document-verification-${verification.id}-${attemptKey}`,
          ocrJobOptions(),
        );
        retried += 1;
      } catch (error) {
        this.logger.warn(
          `Partner OCR queue retry deferred for ${verification.id}: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }
    let expired = 0;
    const expiredPartnerDrafts =
      await this.prisma.partnerDocumentVerification.findMany({
        where: {
          expiresAt: { lte: new Date() },
          consumedOrderId: { not: null },
          status: { notIn: ["EXPIRED", "INVALID"] },
        },
        select: { id: true, consumedOrderId: true },
        take: 100,
      });
    for (const verification of expiredPartnerDrafts) {
      if (!verification.consumedOrderId) continue;
      const pendingOrder = await this.prisma.order.findFirst({
        where: {
          id: verification.consumedOrderId,
          status: { in: ["REVIEW_PENDING", "AWAITING_CUSTOMER"] },
        },
        select: { status: true },
      });
      if (!pendingOrder) continue;
      await this.prisma.$transaction(async (tx) => {
        const cancelled = await tx.order.updateMany({
          where: {
            id: verification.consumedOrderId!,
            status: { in: ["REVIEW_PENDING", "AWAITING_CUSTOMER"] },
          },
          data: {
            status: "CANCELLED",
            operationalDisposition: "TERMINAL_REJECTION",
            version: { increment: 1 },
          },
        });
        if (!cancelled.count) return;
        await tx.partnerDocumentVerification.update({
          where: { id: verification.id },
          data: { status: "EXPIRED", failureCode: "VERIFICATION_EXPIRED" },
        });
        await tx.orderEvent.create({
          data: {
            orderId: verification.consumedOrderId!,
            fromStatus: pendingOrder.status,
            toStatus: "CANCELLED",
            reason: "Document verification expired before partner finalization",
          },
        });
        expired += 1;
      });
    }
    return { retried, manual, expired };
  }

  private async run(signal: AbortSignal) {
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["outbox", () => this.resilience.dispatchOutbox()],
      ["webhooks", () => this.requeueUnprocessedWebhooks()],
      ["documents", () => this.reconcileStaleDocumentReviews()],
      ["partner-balances", () => this.partners.reconcileApiReservations()],
      [
        "notifications",
        async () => {
          await this.failAbandonedNotifications();
          await this.retryFailedNotifications();
        },
      ],
      ["provisioning-operations", () => this.reconcileProvisioningOperations()],
      ["lifecycle-operations", () => this.reconcileLifecycleOperations()],
      ["activation", () => this.orders.reconcileStaleActivationOrders()],
      [
        "stuck-provisioning",
        () => this.orders.recoverStuckProvisioningOrders(),
      ],
      ["approved-orders", () => this.orders.recoverApprovedOrders()],
      ["payments", () => this.payments.reconcilePendingPayments()],
      ["reservations", () => this.inventory.reconcileStaleReservations()],
      ["refunds", () => this.refunds.reconcilePending()],
      ["expired-records", () => this.cleanupExpiredRecords()],
    ];
    for (const [name, step] of steps) await this.runStep(name, signal, step);
    if (!this.prisma.enabled) {
      await this.markReconciliationSuccess();
      return;
    }
    if (!this.repairedReusableInventory) {
      const repaired = await this.runStep(
        "repair-reusable-inventory",
        signal,
        () => this.repairReusableEsims(),
      );
      this.repairedReusableInventory = repaired;
    }
    await this.runStep("subscription-lifecycle", signal, () =>
      this.sweepLifecycle(),
    );
    await this.runStep("inventory-reconciliation", signal, () =>
      this.queueInventoryReconciliation(),
    );
    if (signal.aborted) throw new Error("Reconciliation lease was lost");
    const minutes = Number(process.env.RECONCILIATION_INTERVAL_MINUTES ?? 15);
    const stalenessMs =
      (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60_000;
    const staleBefore = new Date(Date.now() - stalenessMs);
    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        status: { in: ["ACTIVE", "PENDING"] },
        OR: [
          { usageLastCheckedAt: null },
          { usageLastCheckedAt: { lte: staleBefore } },
        ],
      },
      select: {
        id: true,
        usageLastCheckedAt: true,
        customerEsim: {
          select: { inventory: { select: { id: true, iccid: true } } },
        },
      },
      orderBy: [{ usageLastCheckedAt: "asc" }, { id: "asc" }],
      take: 500,
    });
    if (!subscriptions.length) {
      await this.markReconciliationSuccess();
      return;
    }
    const now = Date.now();
    let queued = 0;
    const queuedInventories = new Set<string>();
    for (const subscription of subscriptions) {
      const profile = subscription.customerEsim?.inventory;
      if (!profile?.iccid || queuedInventories.has(profile.id)) continue;
      const lastChecked = subscription.usageLastCheckedAt?.getTime();
      if (lastChecked && now - lastChecked < stalenessMs) continue;
      queuedInventories.add(profile.id);
      await this.queues.add(
        QUEUES.reconciliation,
        "reconcile-usage",
        this.usageService
          ? { id: profile.id, kind: "esim-usage" }
          : { id: subscription.id },
        `reconcile-usage-${profile.id}-${subscription.usageLastCheckedAt?.getTime() ?? 0}`,
      );
      queued += 1;
      if (!this.queues.enabled)
        if (this.usageService) await this.usageService.refresh(profile.id);
        else await this.reconcile(subscription.id);
    }
    if (queued)
      this.logger.log(
        `Queued ${queued} subscription usage reconciliation job(s)`,
      );
    await this.markReconciliationSuccess();
  }

  private async runStep(
    name: string,
    signal: AbortSignal,
    work: () => Promise<unknown>,
  ) {
    if (signal.aborted) throw new Error("Reconciliation lease was lost");
    try {
      await work();
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      this.logger.error(`Reconciliation step ${name} failed: ${message}`);
      this.metrics?.recordFailure("reconciliation", name);
      await this.resilience
        .attention({
          dedupeKey: `reconciliation-step:${name}`,
          category: "RECONCILIATION",
          entityType: "ReconciliationStep",
          entityId: name,
          severity: "WARNING",
          summary: `Reconciliation step ${name} failed`,
          detail: message.slice(0, 1000),
          failureCategory: "RECONCILIATION_STEP_FAILED",
        })
        .catch((attentionError) =>
          this.logger.error(
            `Could not persist reconciliation attention for ${name}: ${attentionError instanceof Error ? attentionError.message : "unknown"}`,
          ),
        );
      return false;
    }
    return true;
  }

  private async recordRunFailure(error: unknown, run = "full") {
    const message = error instanceof Error ? error.message : "unknown";
    this.logger.error(`Reconciliation ${run} run failed: ${message}`);
    this.metrics?.recordFailure("reconciliation-run", run);
    await this.resilience
      .attention({
        dedupeKey: `reconciliation-run:${run}`,
        category: "RECONCILIATION",
        entityType: "ReconciliationRun",
        entityId: run,
        severity: "CRITICAL",
        summary: `Reconciliation ${run} run failed`,
        detail: message.slice(0, 1000),
        failureCategory: "RECONCILIATION_RUN_FAILED",
      })
      .catch((attentionError) =>
        this.logger.error(
          `Could not persist reconciliation run attention: ${attentionError instanceof Error ? attentionError.message : "unknown"}`,
        ),
      );
  }

  private async cleanupExpiredRecords() {
    if (!this.prisma.enabled) return;
    const now = new Date();
    await this.prisma.apiIdempotencyRecord.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    const rateBucketRetentionHours = Number(
      process.env.PARTNER_RATE_BUCKET_RETENTION_HOURS ?? 48,
    );
    await this.prisma.partnerRateBucket.deleteMany({
      where: {
        windowStart: {
          lte: new Date(now.getTime() - rateBucketRetentionHours * 60 * 60_000),
        },
      },
    });
    await this.applyDataRetention(now);
    const approvalMinutes = Number(
      process.env.TRANSATEL_REACTIVATION_APPROVAL_MINUTES ?? 30,
    );
    const staleApprovals =
      await this.prisma.transatelLifecycleOperation.findMany({
        where: {
          action: "REACTIVATE",
          state: "APPROVAL_REQUIRED",
          createdAt: {
            lte: new Date(now.getTime() - approvalMinutes * 60_000),
          },
        },
        select: { id: true, orderId: true },
        take: 100,
      });
    for (const operation of staleApprovals) {
      const expired = await this.prisma.transatelLifecycleOperation.updateMany({
        where: { id: operation.id, state: "APPROVAL_REQUIRED" },
        data: {
          state: "EXPIRED",
          errorMessage:
            "Approval window expired before a decision was recorded",
        },
      });
      if (expired.count)
        await this.prisma.auditLog.create({
          data: {
            module: "TRANSATEL",
            entity: "Order",
            entityId: operation.orderId,
            action: "REACTIVATE_APPROVAL_EXPIRED",
            newValue: {
              operationId: operation.id,
              providerRequestSent: false,
              source: "RECONCILIATION_SWEEP",
            },
          },
        });
    }
    const staleDocuments = await this.prisma.travelerDocument.findMany({
      where: {
        uploadVerified: false,
        status: "PENDING",
        createdAt: { lte: new Date(Date.now() - 60 * 60_000) },
      },
      select: { id: true, orderId: true, privateAssetId: true },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    for (const document of staleDocuments) {
      await this.storage
        .deleteDocument(document.privateAssetId)
        .catch((error) =>
          this.logger.warn(
            `Could not delete expired document asset: ${error instanceof Error ? error.message : "unknown"}`,
          ),
        );
      const removed = await this.prisma.travelerDocument.deleteMany({
        where: { id: document.id, uploadVerified: false, status: "PENDING" },
      });
      if (removed.count)
        await this.prisma.order.update({
          where: { id: document.orderId },
          data: { version: { increment: 1 } },
        });
    }
  }

  private async applyDataRetention(now: Date) {
    if (process.env.DATA_RETENTION_ENABLED !== "true") return;
    const cutoff = (name: string, fallbackDays: number) => {
      const configured = Number(process.env[name] ?? fallbackDays);
      const days =
        Number.isFinite(configured) && configured >= 1
          ? configured
          : fallbackDays;
      return new Date(now.getTime() - days * 24 * 60 * 60_000);
    };
    const batchSize = Math.min(
      1_000,
      Math.max(1, Number(process.env.DATA_RETENTION_BATCH_SIZE ?? 250)),
    );
    const removeBatch = async (
      findIds: () => Promise<Array<{ id: string }>>,
      remove: (ids: string[]) => Promise<unknown>,
    ) => {
      const ids = (await findIds()).map(({ id }) => id);
      if (ids.length) await remove(ids);
      return ids.length;
    };

    const removed = {
      integrationLogs: await removeBatch(
        () =>
          this.prisma.integrationLog.findMany({
            where: {
              createdAt: {
                lt: cutoff("INTEGRATION_LOG_RETENTION_DAYS", 365),
              },
            },
            select: { id: true },
            orderBy: { createdAt: "asc" },
            take: batchSize,
          }),
        (ids) =>
          this.prisma.integrationLog.deleteMany({ where: { id: { in: ids } } }),
      ),
      processedWebhooks: await removeBatch(
        () =>
          this.prisma.webhookEvent.findMany({
            where: {
              processedAt: {
                lt: cutoff("WEBHOOK_EVENT_RETENTION_DAYS", 365),
              },
              deadLetteredAt: null,
              errorMessage: null,
            },
            select: { id: true },
            orderBy: { processedAt: "asc" },
            take: batchSize,
          }),
        (ids) =>
          this.prisma.webhookEvent.deleteMany({ where: { id: { in: ids } } }),
      ),
      sentNotifications: await removeBatch(
        () =>
          this.prisma.notification.findMany({
            where: {
              status: "SENT",
              sentAt: {
                lt: cutoff("NOTIFICATION_RETENTION_DAYS", 365),
              },
              errorMessage: null,
            },
            select: { id: true },
            orderBy: { sentAt: "asc" },
            take: batchSize,
          }),
        (ids) =>
          this.prisma.notification.deleteMany({ where: { id: { in: ids } } }),
      ),
      auditLogs: await removeBatch(
        () =>
          this.prisma.auditLog.findMany({
            where: {
              createdAt: { lt: cutoff("AUDIT_LOG_RETENTION_DAYS", 2_555) },
            },
            select: { id: true },
            orderBy: { createdAt: "asc" },
            take: batchSize,
          }),
        (ids) =>
          this.prisma.auditLog.deleteMany({ where: { id: { in: ids } } }),
      ),
    };
    if (Object.values(removed).some(Boolean)) {
      this.logger.log(`Retention sweep removed ${JSON.stringify(removed)}`);
      await this.prisma.auditLog.create({
        data: {
          module: "SYSTEM",
          entity: "DataRetention",
          entityId: now.toISOString(),
          action: "DATA_RETENTION_SWEEP",
          newValue: {
            removed,
            policy: {
              integrationLogDays: Number(
                process.env.INTEGRATION_LOG_RETENTION_DAYS ?? 365,
              ),
              webhookEventDays: Number(
                process.env.WEBHOOK_EVENT_RETENTION_DAYS ?? 365,
              ),
              notificationDays: Number(
                process.env.NOTIFICATION_RETENTION_DAYS ?? 365,
              ),
              auditLogDays: Number(
                process.env.AUDIT_LOG_RETENTION_DAYS ?? 2_555,
              ),
            },
          },
        },
      });
    }
  }

  private markReconciliationSuccess() {
    return this.resilience.heartbeat("reconciliation", {
      role: process.env.PROCESS_ROLE ?? "workflow-worker",
      completedAt: new Date().toISOString(),
    });
  }

  private async requeueUnprocessedWebhooks() {
    if (!this.prisma.enabled) return;
    const staleBefore = new Date(Date.now() - 60_000);
    const events = await this.prisma.webhookEvent.findMany({
      where: {
        processedAt: null,
        deadLetteredAt: null,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
        createdAt: { lte: staleBefore },
      },
      take: 100,
      orderBy: { createdAt: "asc" },
    });
    for (const event of events) {
      const source = event.source.toLowerCase();
      const topic =
        source === "transatel"
          ? "providerCallbacks"
          : source === "khalti"
            ? "payments"
            : source === "clerk"
              ? "identityCallbacks"
              : null;
      if (!topic) continue;
      await this.resilience.outbox({
        dedupeKey: `webhook-recovery:${source}:${event.eventId}`,
        topic,
        jobName:
          source === "transatel"
            ? "connectivity-callback"
            : source === "clerk"
              ? "clerk-callback"
              : "payment-callback",
        payload: {
          provider: source,
          eventId: event.eventId,
          payload: event.payload,
        },
      });
    }
  }

  private async retryFailedNotifications() {
    if (!this.prisma.enabled) return;
    const rows = await this.prisma.notification.findMany({
      where: {
        OR: [
          { status: "FAILED" },
          { status: "QUEUED", dedupeKey: { startsWith: "recharge-recovery:" } },
        ],
        nextAttemptAt: { lte: new Date() },
        attemptCount: { lt: 6 },
        recipient: { not: null },
        orderNumber: { not: null },
      },
      take: 100,
      orderBy: { nextAttemptAt: "asc" },
    });
    for (const row of rows) {
      try {
        await this.notifications.retry(
          row.id,
          row.recipient!,
          row.orderNumber!,
        );
      } catch (error) {
        this.logger.warn(
          `Notification recovery failed for ${row.id}: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }
  }

  private async failAbandonedNotifications() {
    if (!this.prisma.enabled || !this.queues.enabled) return;
    const rows = await this.prisma.notification.findMany({
      where: {
        status: "QUEUED",
        createdAt: { lt: new Date(Date.now() - 10 * 60_000) },
      },
      select: { id: true },
      take: 100,
    });
    for (const row of rows) {
      if (
        await this.queues.hasJob(QUEUES.notifications, `notification-${row.id}`)
      )
        continue;
      await this.prisma.notification.updateMany({
        where: { id: row.id, status: "QUEUED" },
        data: {
          status: "FAILED",
          errorMessage: "Notification queue job was not found during recovery",
          nextAttemptAt: new Date(),
          attemptCount: { increment: 1 },
        },
      });
    }
  }

  private async reconcileStaleDocumentReviews() {
    if (!this.prisma.enabled) return;
    const orders = await this.prisma.order.findMany({
      where: {
        status: {
          in: ["PROVISIONING", "QR_READY", "ACTIVATION_ATTENTION", "COMPLETED"],
        },
        documentReviewPolicy: { not: "NO_REVIEW" },
        documentReviewStatus: "NOT_STARTED",
        documents: { some: { status: "PENDING" } },
      },
      select: { id: true, status: true },
      take: 100,
      orderBy: { createdAt: "asc" },
    });
    for (const order of orders) {
      const updated = await this.prisma.order.updateMany({
        where: { id: order.id, documentReviewStatus: "NOT_STARTED" },
        data: {
          documentReviewStatus: "MANUAL_REVIEW",
          documentReviewStartedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (!updated.count) continue;
      await this.prisma.orderEvent.create({
        data: {
          orderId: order.id,
          fromStatus: order.status,
          toStatus: order.status,
          reason:
            "Document review was not started; recovered to non-blocking manual review",
          metadata: { documentReviewStatus: "MANUAL_REVIEW" },
        },
      });
      await this.resilience.attention({
        dedupeKey: `document-review:${order.id}`,
        category: "DOCUMENT_MANUAL_REVIEW",
        entityType: "Order",
        entityId: order.id,
        orderId: order.id,
        summary: "Documents require manual review after fulfillment started",
        localState: order.status,
        failureCategory: "DOCUMENT_REVIEW_HANDOFF_MISSED",
        lastSuccessfulStep: "FULFILLMENT_CONTINUES",
        availableActions: [],
      });
    }
  }

  private async reconcileLifecycleOperations() {
    if (!this.prisma.enabled) return;
    const operations = await this.prisma.transatelLifecycleOperation.findMany({
      where: { state: { in: ["ACCEPTED", "RECONCILE_REQUIRED"] } },
      select: { orderId: true },
      distinct: ["orderId"],
      take: 100,
    });
    for (const operation of operations) {
      await this.transatelOperations
        .reconcile(operation.orderId)
        .catch((error) => {
          this.metrics?.recordFailure("reconciliation", "transatel-lifecycle");
          this.logger.warn(
            `Lifecycle reconciliation failed for ${operation.orderId}: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        });
    }
  }

  private async queueInventoryReconciliation() {
    const batchSize = Math.min(
      100,
      Math.max(
        1,
        Number(process.env.TRANSATEL_INVENTORY_RECONCILE_BATCH_SIZE ?? 25),
      ),
    );
    await this.inventory.startProviderReconciliation({
      trigger: "AUTOMATIC",
      selection: "STALE_OR_UNVERIFIED",
      limit: batchSize,
    });
  }

  private async reconcileProvisioningOperations() {
    if (!this.prisma.enabled) return;
    const now = new Date();
    const operations = await this.prisma.provisioningOperation.findMany({
      where: {
        state: {
          in: [
            "SUBMITTING",
            "ACCEPTED",
            "WAITING_FOR_QR",
            "QR_READY",
            "RECONCILE_REQUIRED",
          ],
        },
        OR: [{ nextReconcileAt: null }, { nextReconcileAt: { lte: now } }],
      },
      include: {
        order: {
          select: { id: true, providerSubscriptionId: true, status: true },
        },
      },
      take: 200,
    });
    for (const operation of operations) {
      // QR_READY is terminal for provisioning reconciliation once the order
      // commit has also succeeded. Keep it selectable only to heal the split
      // state where the provider operation committed but the order did not.
      if (
        operation.state === "QR_READY" &&
        operation.order.status !== "PROVISIONING"
      )
        continue;
      if (
        operation.reconcileDeadlineAt &&
        operation.reconcileDeadlineAt <= now
      ) {
        await this.prisma.provisioningOperation.update({
          where: { id: operation.id },
          data: {
            state: "MANUAL_REVIEW",
            nextReconcileAt: null,
            lastErrorCategory: "RECONCILIATION_DEADLINE",
            lastErrorMessage: "Automatic reconciliation deadline elapsed",
            version: { increment: 1 },
          },
        });
        await this.orders.markProvisioningManualReview(
          operation.orderId,
          "Transatel submission requires manual reconciliation; inventory remains quarantined",
        );
        continue;
      }
      try {
        const details = await this.connectivity.getEsimDetails(operation.iccid);
        const qrPayload =
          "qrPayload" in details ? details.qrPayload : undefined;
        const providerSubscriptionId =
          operation.order.providerSubscriptionId ??
          operation.providerSubscriptionId;
        if (
          qrPayload &&
          providerSubscriptionId &&
          details.status.toLowerCase() === "active"
        ) {
          await this.orders.applyProviderEvent({
            eventType: "AUTOMATIC_RECONCILIATION",
            orderId: operation.orderId,
            iccid: operation.iccid,
            subscriptionId: providerSubscriptionId,
            status: "ACTIVATED",
            qrPayload,
          });
          await this.prisma.provisioningOperation.update({
            where: { id: operation.id },
            data: {
              state: "ACTIVATED",
              completedAt: new Date(),
              nextReconcileAt: null,
              lastErrorCategory: null,
              lastErrorMessage: null,
              version: { increment: 1 },
            },
          });
          continue;
        }
        if (
          qrPayload &&
          providerSubscriptionId &&
          operation.order.status === "PROVISIONING"
        ) {
          await this.orders.recoverProvisioningQrReady(operation.orderId, {
            qrPayload,
            providerSubscriptionId,
            iccid: operation.iccid,
            reason: "Automatic recovery from provider QR-ready state",
          });
          await this.prisma.provisioningOperation.update({
            where: { id: operation.id },
            data: {
              state: "QR_READY",
              completedAt: operation.completedAt ?? new Date(),
              nextReconcileAt: null,
              lastErrorCategory: null,
              lastErrorMessage: null,
              version: { increment: 1 },
            },
          });
          continue;
        }
        const nextState = providerSubscriptionId
          ? qrPayload
            ? "QR_READY"
            : "WAITING_FOR_QR"
          : "RECONCILE_REQUIRED";
        await this.prisma.provisioningOperation.update({
          where: { id: operation.id },
          data: {
            state: nextState,
            nextReconcileAt: new Date(Date.now() + 5 * 60_000),
            lastErrorCategory: null,
            lastErrorMessage: null,
            version: { increment: 1 },
          },
        });
      } catch (error) {
        await this.prisma.provisioningOperation.update({
          where: { id: operation.id },
          data: {
            nextReconcileAt: new Date(Date.now() + 5 * 60_000),
            lastErrorCategory: "TRANSIENT_PROVIDER",
            lastErrorMessage:
              error instanceof Error
                ? error.message.slice(0, 2000)
                : "unknown error",
            version: { increment: 1 },
          },
        });
        this.metrics?.recordFailure("reconciliation", "provisioning-operation");
      }
    }
  }

  /** An explicit, audited Ops recovery path for a delayed or dead-lettered
   * provider submission. It reconciles one order only; it never re-submits a
   * preload command, so an uncertain provider outcome cannot create a second
   * subscription. */
  async reconcileProvisioningOperationNow(operationId: string) {
    if (!this.prisma.enabled)
      throw new Error(
        "Provisioning reconciliation requires database persistence",
      );
    const operation = await this.prisma.provisioningOperation.findUnique({
      where: { id: operationId },
      include: {
        order: {
          select: { id: true, providerSubscriptionId: true, status: true },
        },
      },
    });
    if (!operation) throw new Error("Provisioning operation not found");
    if (
      ![
        "ACCEPTED",
        "WAITING_FOR_QR",
        "QR_READY",
        "RECONCILE_REQUIRED",
        "MANUAL_REVIEW",
      ].includes(operation.state)
    )
      throw new Error(`Operation in ${operation.state} cannot be reconciled`);
    const details = await this.connectivity.getEsimDetails(operation.iccid);
    const qrPayload = "qrPayload" in details ? details.qrPayload : undefined;
    const providerSubscriptionId =
      operation.order.providerSubscriptionId ??
      operation.providerSubscriptionId;
    if (
      qrPayload &&
      providerSubscriptionId &&
      details.status.toLowerCase() === "active"
    ) {
      await this.orders.applyProviderEvent({
        eventType: "OPS_MANUAL_RECONCILIATION",
        orderId: operation.orderId,
        iccid: operation.iccid,
        subscriptionId: providerSubscriptionId,
        status: "ACTIVATED",
        qrPayload,
      });
      await this.prisma.provisioningOperation.update({
        where: { id: operation.id },
        data: {
          state: "ACTIVATED",
          completedAt: new Date(),
          nextReconcileAt: null,
          lastErrorCategory: null,
          lastErrorMessage: null,
          version: { increment: 1 },
        },
      });
      return { id: operation.id, state: "ACTIVATED", recovered: true };
    }
    if (
      qrPayload &&
      providerSubscriptionId &&
      operation.order.status === "PROVISIONING"
    ) {
      await this.orders.recoverProvisioningQrReady(operation.orderId, {
        qrPayload,
        providerSubscriptionId,
        iccid: operation.iccid,
        reason: "Ops recovery from provider QR-ready state",
      });
      await this.prisma.provisioningOperation.update({
        where: { id: operation.id },
        data: {
          state: "QR_READY",
          completedAt: operation.completedAt ?? new Date(),
          nextReconcileAt: null,
          lastErrorCategory: null,
          lastErrorMessage: null,
          version: { increment: 1 },
        },
      });
      return { id: operation.id, state: "QR_READY", recovered: true };
    }
    const state = providerSubscriptionId
      ? "WAITING_FOR_QR"
      : "RECONCILE_REQUIRED";
    await this.prisma.provisioningOperation.update({
      where: { id: operation.id },
      data: {
        state,
        nextReconcileAt: new Date(Date.now() + 5 * 60_000),
        lastErrorCategory: null,
        lastErrorMessage: null,
        version: { increment: 1 },
      },
    });
    return {
      id: operation.id,
      state,
      recovered: false,
      providerStatus: details.status,
    };
  }

  private async sweepLifecycle() {
    const now = new Date();
    const subscriptions = await this.prisma.subscription.findMany({
      where: { status: "ACTIVE" },
      include: {
        customerEsim: {
          include: { inventory: true, order: { include: { traveler: true } } },
        },
      },
      take: 500,
    });
    for (const subscription of subscriptions) {
      const inventory = subscription.customerEsim?.inventory;
      const order = subscription.customerEsim?.order;
      if (!inventory || !order) continue;
      const expiry = subscription.expiresAt ?? inventory.expiresAt;
      const expiredByDate = expiry !== null && expiry <= now;
      const exhausted =
        subscription.totalMb > 0 && subscription.usedMb >= subscription.totalMb;
      if (!expiredByDate && !exhausted) continue;
      await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: "EXPIRED" },
      });
      this.logger.log(
        `Marked subscription ${subscription.id} as EXPIRED (${expiredByDate ? "date elapsed" : "data exhausted"})`,
      );
      await this.notifyLifecycle(
        order,
        expiredByDate ? "PLAN_EXPIRED" : "PLAN_EXHAUSTED",
      );
    }
  }

  private async notifyLifecycle(
    order: {
      id: string;
      orderNumber: string;
      traveler: { email: string } | null;
      pricingSnapshot: unknown;
    },
    template: "PLAN_EXPIRED" | "PLAN_EXHAUSTED",
  ) {
    const recipient =
      order.traveler?.email ??
      (order.pricingSnapshot as { topUpEmail?: string } | null)?.topUpEmail;
    if (!recipient) return;
    try {
      await this.notifications.enqueue({
        orderId: order.id,
        channel: "EMAIL",
        template,
        recipient,
        orderNumber: order.orderNumber,
      });
    } catch (error) {
      this.logger.warn(
        `Lifecycle notification failed for ${order.id}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  private async reconcile(subscriptionId: string) {
    try {
      const subscription = await this.prisma.subscription.findUnique({
        where: { id: subscriptionId },
        include: { customerEsim: { include: { inventory: true } } },
      });
      if (!subscription?.customerEsim?.inventory?.iccid) return;
      const usage = await this.connectivity.getUsage(
        subscription.customerEsim.inventory.iccid,
      );
      if (usage.usageAvailable === false)
        throw new Error(
          "Provider identified the subscription but did not return a usable balance",
        );
      const own = usage.subscriptions?.find(
        (item) =>
          item.providerSubscriptionId === subscription.providerSubscriptionId,
      );
      if (usage.subscriptions && !own) {
        await this.prisma.subscription.update({
          where: { id: subscriptionId },
          data: { assignmentVerificationStatus: "MISMATCH" },
        });
        await this.resilience.attention({
          dedupeKey: `subscription-assignment:${subscriptionId}`,
          category: "SUBSCRIPTION_ASSIGNMENT_CONFLICT",
          entityType: "Subscription",
          entityId: subscriptionId,
          orderId: subscription.customerEsim.orderId,
          severity: "CRITICAL",
          summary: "Provider subscription is missing from its assigned eSIM",
          detail:
            "Provider usage evidence lists different subscriptions for the assigned ICCID; last-known usage was preserved",
          localState: subscription.status,
          externalState: "SUBSCRIPTION_NOT_FOUND_ON_ICCID",
          lastSuccessfulStep: "ESIM_ASSIGNED",
          failureCategory: "PROVIDER_ASSIGNMENT_MISMATCH",
          availableActions: ["RECHECK_ORDER_PROVIDER"],
        });
        this.logger.warn(
          `Provider subscription ${subscription.providerSubscriptionId} was not found on its assigned eSIM`,
        );
        return;
      }
      await this.prisma.subscription.update({
        where: { id: subscriptionId },
        data: {
          usedMb: own?.usedMb ?? usage.usedMb,
          totalMb: own?.totalMb ?? usage.totalMb,
          usageLastCheckedAt: new Date(),
          ...(own
            ? {
                providerLastSeenAt: new Date(),
                assignmentVerificationStatus: "VERIFIED",
                assignmentVerifiedAt:
                  subscription.assignmentVerifiedAt ?? new Date(),
              }
            : {}),
        },
      });
      await this.resilience.resolve(
        `subscription-assignment:${subscriptionId}`,
        null,
        "Provider usage confirms the assigned subscription",
      );
      this.logger.debug(
        `Reconciled usage for subscription ${subscriptionId}: ${usage.usedMb}/${usage.totalMb} MB`,
      );
    } catch (error) {
      this.metrics?.recordFailure("reconciliation", "usage");
      const json = process.env.LOG_FORMAT === "json";
      if (json) {
        this.logger.warn(
          JSON.stringify({
            event: "reconciliation_failed",
            subscriptionId,
            error: error instanceof Error ? error.message : "unknown",
          }),
        );
      } else {
        this.logger.warn(
          `Usage reconciliation failed for ${subscriptionId}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
  }

  private async repairReusableEsims() {
    await this.prisma.esimInventory.updateMany({
      where: {
        status: "EXPIRED",
        activatedAt: { not: null },
        customerEsims: { some: {} },
      },
      data: { status: "ACTIVATED" },
    });
    await this.prisma.esimInventory.updateMany({
      where: {
        status: "EXPIRED",
        activatedAt: null,
        customerEsims: { some: {} },
      },
      data: { status: "ASSIGNED" },
    });
  }

  private async emitPartnerVerificationEvent(
    partnerId: string,
    verificationId: string,
    externalOrderId: string,
    type: string,
    orderId: string,
  ) {
    const endpoints = await this.prisma.partnerWebhookEndpoint.findMany({
      where: { partnerId, active: true },
    });
    const eligible = endpoints.filter((endpoint) => {
      const eventTypes = Array.isArray(endpoint.eventTypes)
        ? endpoint.eventTypes.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      return eventTypes.includes("*") || eventTypes.includes(type);
    });
    await this.prisma.partnerEvent.create({
      data: {
        partnerId,
        orderId,
        type,
        resourceId: verificationId,
        correlationId: randomUUID(),
        payload: { verificationId, externalOrderId, orderId },
        deliveries: {
          create: eligible.map((endpoint) => ({ endpointId: endpoint.id })),
        },
      },
    });
  }
}
