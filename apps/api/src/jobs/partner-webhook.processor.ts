import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PartnerWebhookDeliveryStatus } from "@prisma/client";
import type { Job } from "bullmq";
import { createHmac } from "node:crypto";
import { CryptoService } from "../infrastructure/crypto.service.js";
import { PrismaService } from "../infrastructure/prisma.service.js";
import { QueueService } from "./queue.service.js";
import { QUEUES } from "./queues.js";

type DeliveryJob = { deliveryId: string };

export function signPartnerWebhook(secret: string, timestamp: string, rawBody: string) {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
}

@Injectable()
export class PartnerWebhookProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PartnerWebhookProcessor.name);
  private reconciliationTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly queues: QueueService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  onModuleInit() {
    this.queues.registerWorker(QUEUES.partnerWebhooks, (job) =>
      this.deliver(job as Job<DeliveryJob>),
    );
    void this.enqueuePending().catch((error: unknown) =>
      this.logger.error(
        error instanceof Error
          ? error.message
          : "Webhook reconciliation failed",
      ),
    );
    if (this.queues.enabled)
      this.reconciliationTimer = setInterval(() => {
        void this.enqueuePending().catch((error: unknown) =>
          this.logger.error(error instanceof Error ? error.message : "Webhook reconciliation failed"),
        );
      }, 30_000);
  }

  onModuleDestroy() {
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
  }

  async enqueuePending() {
    if (!this.prisma.enabled) return 0;
    const pending = await this.prisma.partnerWebhookDelivery.findMany({
      where: {
        status: {
          in: [
            PartnerWebhookDeliveryStatus.PENDING,
            PartnerWebhookDeliveryStatus.RETRYING,
          ],
        },
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
      },
      select: { id: true },
      take: 500,
    });
    await Promise.all(
      pending.map(({ id }) =>
        this.queues.add(
          QUEUES.partnerWebhooks,
          "deliver",
          { deliveryId: id },
          `partner-webhook-${id}`,
        ),
      ),
    );
    return pending.length;
  }

  async replay(deliveryId: string) {
    const delivery = await this.prisma.partnerWebhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: PartnerWebhookDeliveryStatus.PENDING,
        nextRetryAt: null,
        errorMessage: null,
      },
    });
    await this.queues.add(
      QUEUES.partnerWebhooks,
      "deliver",
      { deliveryId },
      `partner-webhook-replay-${deliveryId}-${Date.now()}`,
    );
    return delivery;
  }

  private async deliver(job: Job<DeliveryJob>) {
    const delivery = await this.prisma.partnerWebhookDelivery.findUnique({
      where: { id: job.data.deliveryId },
      include: { event: true, endpoint: true },
    });
    if (!delivery || !delivery.endpoint.active) return { skipped: true };
    const body = JSON.stringify({
      id: delivery.event.id,
      partnerId: delivery.event.partnerId,
      type: delivery.event.type,
      version: delivery.event.version,
      resourceId: delivery.event.resourceId,
      occurredAt: delivery.event.occurredAt.toISOString(),
      correlationId: delivery.event.correlationId,
      data: delivery.event.payload,
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const secret = this.crypto.decrypt(delivery.endpoint.secretEncrypted);
    const signature = signPartnerWebhook(secret, timestamp, body);
    const started = Date.now();
    try {
      const response = await fetch(delivery.endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "VisaCompass-Partner-Webhooks/1.0",
          "vc-event-id": delivery.event.id,
          "vc-webhook-timestamp": timestamp,
          "vc-webhook-signature": `v1=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw new Error(`Partner endpoint returned HTTP ${response.status}`);
      await this.prisma.partnerWebhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: PartnerWebhookDeliveryStatus.DELIVERED,
          attempt: { increment: 1 },
          responseStatus: response.status,
          latencyMs: Date.now() - started,
          deliveredAt: new Date(),
          nextRetryAt: null,
          errorMessage: null,
        },
      });
      return { delivered: true };
    } catch (error) {
      const terminal = job.attemptsMade + 1 >= 3;
      await this.prisma.partnerWebhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: terminal
            ? PartnerWebhookDeliveryStatus.FAILED
            : PartnerWebhookDeliveryStatus.RETRYING,
          attempt: { increment: 1 },
          latencyMs: Date.now() - started,
          nextRetryAt: terminal
            ? null
            : new Date(Date.now() + 2_000 * 2 ** job.attemptsMade),
          errorMessage:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Delivery failed",
        },
      });
      throw error;
    }
  }
}
