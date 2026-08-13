import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PartnerWebhookDeliveryStatus } from "@prisma/client";
import type { Job } from "bullmq";
import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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

/** Blocks destinations that could be used for SSRF (metadata, private, link-local, loopback). */
export async function assertSafeWebhookUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Webhook URL is invalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new Error("Webhook URL must use http(s)");
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "metadata.google.internal" ||
    host === "metadata" ||
    host.endsWith(".internal")
  ) {
    throw new Error("Webhook URL host is not allowed");
  }
  const ipv = isIP(host);
  if (ipv !== 0) {
    assertSafeIp(ipv, host);
    return;
  }
  let addresses: string[];
  try {
    addresses = (await lookup(host, { all: true })).map((entry) => addressOf(entry));
  } catch {
    throw new Error("Webhook URL host cannot be resolved");
  }
  for (const address of addresses) assertSafeIp(isIP(address), address);
}

function addressOf(entry: string | { address: string }): string {
  return typeof entry === "string" ? entry : entry.address;
}

function assertSafeIp(version: number, address: string): void {
  const v4 = version === 4 || address.toLowerCase().startsWith("::ffff:");
  if (v4) {
    const groups = address.toLowerCase().replace(/^::ffff:/, "").split(".").map(Number);
    if (groups.length !== 4) throw new Error("Webhook URL host is not allowed");
    const a = groups[0] ?? 0, b = groups[1] ?? 0, c = groups[2] ?? 0, d = groups[3] ?? 0;
    const privateIp =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 255 && d === 1);
    if (privateIp) throw new Error("Webhook URL resolves to a private host");
    return;
  }
  const lower = address.toLowerCase();
  const privateV6 =
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb") ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("::ffff:127") ||
    lower.startsWith("::ffff:10.") ||
    lower.startsWith("::ffff:192.168") ||
    (lower.startsWith("::ffff:172.") && /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(lower));
  if (privateV6) throw new Error("Webhook URL resolves to a private host");
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
    void this.enqueuePendingAsLeader().catch((error: unknown) =>
      this.logger.error(
        error instanceof Error
          ? error.message
          : "Webhook reconciliation failed",
      ),
    );
    if (this.queues.enabled)
      this.reconciliationTimer = setInterval(() => {
        void this.enqueuePendingAsLeader().catch((error: unknown) =>
          this.logger.error(error instanceof Error ? error.message : "Webhook reconciliation failed"),
        );
      }, 30_000);
  }

  onModuleDestroy() {
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
  }

  private async enqueuePendingAsLeader() {
    const result = await this.queues.withDistributedLock('partner-webhook-reconciliation', 25_000, () => this.enqueuePending());
    if (!result.acquired) this.logger.debug('Skipped partner webhook reconciliation; another replica holds the lease');
    return result.value;
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
      await assertSafeWebhookUrl(delivery.endpoint.url);
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
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status >= 300 && response.status < 400)
        throw new Error('Partner endpoint redirects are not allowed');
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
