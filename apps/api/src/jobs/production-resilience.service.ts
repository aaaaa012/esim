import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AttentionCaseStatus, OutboxStatus, Prisma } from "@prisma/client";
import { isAttentionAction } from "@visa-compass/shared";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../infrastructure/prisma.service.js";
import { SELLABLE_PROVIDER_STATUSES } from "../common/sellable-provider-statuses.js";
import { QueueService } from "./queue.service.js";
import { QUEUES } from "./queues.js";

type QueueTopic = keyof typeof QUEUES;

@Injectable()
export class ProductionResilienceService {
  private readonly instanceId =
    process.env.INSTANCE_ID ?? process.env.RENDER_INSTANCE_ID ?? randomUUID();

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
  ) {}

  async attention(input: {
    dedupeKey: string;
    category: string;
    entityType: string;
    entityId: string;
    summary: string;
    orderId?: string;
    detail?: string;
    severity?: string;
    localState?: string;
    externalState?: string;
    lastSuccessfulStep?: string;
    failureCategory?: string;
    availableActions?: string[];
    nextRetryAt?: Date;
  }) {
    if (!this.prisma.enabled) return null;
    const availableActions = (input.availableActions ?? []).filter(
      isAttentionAction,
    );
    return this.prisma.attentionCase.upsert({
      where: { dedupeKey: input.dedupeKey },
      create: {
        ...input,
        availableActions,
      },
      update: {
        status: AttentionCaseStatus.OPEN,
        summary: input.summary,
        detail: input.detail ?? null,
        severity: input.severity ?? "WARNING",
        localState: input.localState ?? null,
        externalState: input.externalState ?? null,
        lastSuccessfulStep: input.lastSuccessfulStep ?? null,
        failureCategory: input.failureCategory ?? null,
        nextRetryAt: input.nextRetryAt ?? null,
        availableActions,
        retryCount: { increment: 1 },
        resolvedAt: null,
        resolution: null,
      },
    });
  }

  async resolve(dedupeKey: string, actorId: string | null, resolution: string) {
    if (!resolution.trim())
      throw new BadRequestException("Resolution is required");
    const item = await this.prisma.attentionCase.findUnique({
      where: { dedupeKey },
    });
    if (!item) return null;
    const updated = await this.prisma.attentionCase.update({
      where: { dedupeKey },
      data: {
        status: AttentionCaseStatus.RESOLVED,
        resolvedAt: new Date(),
        resolvedById: actorId,
        resolution: resolution.trim(),
        nextRetryAt: null,
      },
    });
    await this.prisma.auditLog.create({
      data: {
        module: "OPERATIONS_ATTENTION",
        entity: "AttentionCase",
        entityId: item.id,
        action: "RESOLVED",
        ...(actorId ? { performedById: actorId } : {}),
        previousValue: { status: item.status },
        newValue: { status: updated.status, resolution: updated.resolution },
      },
    });
    return updated;
  }

  async list(input: {
    status?: AttentionCaseStatus;
    category?: string;
    limit?: number;
    offset?: number;
  }) {
    const limit = Math.min(200, Math.max(1, input.limit ?? 50));
    const offset = Math.max(0, input.offset ?? 0);
    const where: Prisma.AttentionCaseWhereInput = {
      ...(input.status ? { status: input.status } : {}),
      ...(input.category ? { category: input.category } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.attentionCase.findMany({
        where,
        orderBy: [{ severity: "desc" }, { createdAt: "asc" }],
        take: limit,
        skip: offset,
        include: {
          order: {
            select: {
              orderNumber: true,
              status: true,
              externalOrderId: true,
              partner: { select: { code: true, name: true } },
            },
          },
        },
      }),
      this.prisma.attentionCase.count({ where }),
    ]);
    return { items, total, limit, offset };
  }

  async outbox(input: {
    dedupeKey: string;
    topic: QueueTopic;
    jobName: string;
    payload: object;
    orderId?: string;
  }) {
    if (!this.prisma.enabled) return null;
    return this.prisma.outboxMessage.upsert({
      where: { dedupeKey: input.dedupeKey },
      update: {},
      create: { ...input, payload: input.payload as Prisma.InputJsonValue },
    });
  }

  async dispatchOutbox(limit = 100) {
    if (!this.prisma.enabled) return { dispatched: 0, failed: 0 };
    const rows = await this.prisma.outboxMessage.findMany({
      where: {
        status: { in: [OutboxStatus.PENDING, OutboxStatus.FAILED] },
        nextAttemptAt: { lte: new Date() },
      },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    let dispatched = 0;
    let failed = 0;
    for (const row of rows) {
      const topic = row.topic as QueueTopic;
      if (!(topic in QUEUES)) {
        await this.prisma.outboxMessage.update({
          where: { id: row.id },
          data: {
            status: OutboxStatus.FAILED,
            errorMessage: `Unknown queue topic ${row.topic}`,
            attemptCount: { increment: 1 },
            nextAttemptAt: new Date(Date.now() + 60 * 60_000),
          },
        });
        failed += 1;
        continue;
      }
      try {
        await this.queues.add(
          QUEUES[topic],
          row.jobName,
          { ...(row.payload as object), outboxId: row.id },
          row.dedupeKey,
        );
        await this.prisma.outboxMessage.update({
          where: { id: row.id },
          data: {
            status: OutboxStatus.ENQUEUED,
            dispatchedAt: new Date(),
            errorMessage: null,
            attemptCount: { increment: 1 },
          },
        });
        await this.resolve(
          `outbox-failure:${row.id}`,
          null,
          "Outbox message dispatched",
        );
        dispatched += 1;
      } catch (error) {
        const attempt = row.attemptCount + 1;
        await this.prisma.outboxMessage.update({
          where: { id: row.id },
          data: {
            status: OutboxStatus.FAILED,
            attemptCount: { increment: 1 },
            errorMessage:
              error instanceof Error ? error.message.slice(0, 2000) : "unknown",
            nextAttemptAt: new Date(
              Date.now() +
                Math.min(15 * 60_000, 2_000 * 2 ** Math.min(attempt, 8)),
            ),
          },
        });
        if (attempt >= 3)
          await this.attention({
            dedupeKey: `outbox-failure:${row.id}`,
            category: "ASYNC_HANDOFF_FAILED",
            entityType: "OutboxMessage",
            entityId: row.id,
            ...(row.orderId ? { orderId: row.orderId } : {}),
            summary: `Durable ${row.topic} handoff is delayed`,
            detail: error instanceof Error ? error.message : "unknown",
            failureCategory: "QUEUE_UNAVAILABLE",
            availableActions: [],
          });
        failed += 1;
      }
    }
    return { dispatched, failed };
  }

  async heartbeat(worker: string, metadata?: object) {
    if (!this.prisma.enabled) return;
    const instanceId = this.instanceId;
    await this.prisma.workerHeartbeat.upsert({
      where: { worker },
      create: {
        worker,
        instanceId,
        ...(metadata ? { metadata: metadata as Prisma.InputJsonValue } : {}),
      },
      update: {
        instanceId,
        status: "RUNNING",
        lastSeenAt: new Date(),
        ...(metadata ? { metadata: metadata as Prisma.InputJsonValue } : {}),
      },
    });
  }

  async platformHealth() {
    const [
      workers,
      openAttention,
      pendingOutbox,
      deadLetters,
      oldestOutbox,
      queues,
      oldestPaymentReview,
      lifecycleCounts,
      unsafeAvailableInventory,
      openDisputes,
    ] = await Promise.all([
      this.prisma.workerHeartbeat.findMany({ orderBy: { worker: "asc" } }),
      this.prisma.attentionCase.count({
        where: { status: { not: AttentionCaseStatus.RESOLVED } },
      }),
      this.prisma.outboxMessage.count({
        where: { status: { not: OutboxStatus.PROCESSED } },
      }),
      this.prisma.webhookEvent.count({
        where: { deadLetteredAt: { not: null } },
      }),
      this.prisma.outboxMessage.findFirst({
        where: { status: { not: OutboxStatus.PROCESSED } },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
      this.queues.stats(),
      this.prisma.payment.findFirst({
        where: { status: "REVIEW_REQUIRED" },
        orderBy: { updatedAt: "asc" },
        select: { updatedAt: true },
      }),
      this.prisma.order.groupBy({
        by: ["status"],
        where: {
          status: {
            in: [
              "PAYMENT_PENDING",
              "PAYMENT_REVIEW_REQUIRED",
              "APPROVED",
              "PROVISIONING",
              "ACTIVATION_ATTENTION",
              "REFUND_PENDING",
            ],
          },
        },
        _count: { _all: true },
      }),
      this.prisma.esimInventory.count({
        where: {
          status: "AVAILABLE",
          OR: [
            { providerSubscriptionId: { not: null } },
            {
              providerStatus: {
                notIn: SELLABLE_PROVIDER_STATUSES,
              },
            },
            { lastProviderCheckedAt: null },
            {
              lastProviderCheckedAt: {
                lt: new Date(
                  Date.now() -
                    Math.max(
                      1,
                      Number(
                        process.env.INVENTORY_PROVIDER_FRESHNESS_HOURS ?? 24,
                      ),
                    ) *
                      60 *
                      60_000,
                ),
              },
            },
          ],
        },
      }),
      this.prisma.paymentDispute.count({
        where: { status: { in: ["OPEN", "UNDER_REVIEW", "LOST"] } },
      }),
    ]);
    const now = Date.now();
    const requiredWorkers = ["workflow-worker", "ocr-worker", "reconciliation"];
    const reconciliationHealthyMs = Math.max(
      120_000,
      Number(process.env.RECONCILIATION_INTERVAL_MINUTES ?? 15) * 2 * 60_000,
    );
    const heartbeatHealthy = (worker: { worker: string; lastSeenAt: Date }) =>
      now - worker.lastSeenAt.getTime() <=
      (worker.worker === "reconciliation" ? reconciliationHealthyMs : 120_000);
    const missingWorkers = requiredWorkers.filter(
      (name) => !workers.some((worker) => worker.worker === name),
    );
    return {
      status:
        missingWorkers.length > 0 ||
        workers.some((worker) => !heartbeatHealthy(worker)) ||
        deadLetters > 0 ||
        unsafeAvailableInventory > 0
          ? "degraded"
          : "healthy",
      workers: workers.map((worker) => ({
        ...worker,
        healthy: heartbeatHealthy(worker),
      })),
      missingWorkers,
      queues,
      attention: { open: openAttention },
      outbox: {
        pending: pendingOutbox,
        oldestAgeSeconds: oldestOutbox
          ? Math.floor((now - oldestOutbox.createdAt.getTime()) / 1000)
          : 0,
      },
      webhooks: { deadLetters },
      payments: {
        oldestReviewAgeSeconds: oldestPaymentReview
          ? Math.floor((now - oldestPaymentReview.updatedAt.getTime()) / 1000)
          : 0,
        openDisputes,
      },
      orders: {
        stuckByState: Object.fromEntries(
          lifecycleCounts.map((row) => [row.status, row._count._all]),
        ),
      },
      inventory: { unsafeAvailable: unsafeAvailableInventory },
      reconciliation: {
        lastSuccessAt:
          workers.find((worker) => worker.worker === "reconciliation")
            ?.lastSeenAt ?? null,
      },
    };
  }

  async item(id: string) {
    const item = await this.prisma.attentionCase.findUnique({
      where: { id },
      include: {
        order: {
          include: {
            partner: true,
            payments: true,
            provisioningOperation: true,
          },
        },
      },
    });
    if (!item) throw new NotFoundException("Attention case not found");
    return item;
  }
}
