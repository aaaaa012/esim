import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { QueueService } from "../../jobs/queue.service.js";
import { QUEUES } from "../../jobs/queues.js";
import type { NotificationTemplate } from "./notification.templates.js";

export type NotificationChannel = "EMAIL" | "WHATSAPP";

type MemoryNotification = {
  id: string;
  orderId: string;
  channel: string;
  template: string;
  status: string;
  sentAt: Date | null;
  createdAt: Date;
};

/**
 * A notification is only ever marked SENT once a delivery worker has actually
 * handed it to a real or simulated channel. Enqueueing never fabricates a SENT
 * status: without the background queue (Redis) there is no worker, so delivery
 * is impossible and we fail loudly rather than silently dropping the message.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly memory = new Map<string, MemoryNotification>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
  ) {}

  health() {
    const mode =
      process.env.NOTIFICATION_MODE === "live" ? "LIVE" : "SIMULATED";
    const emailConfigured = Boolean(
      process.env.GMAIL_CLIENT_ID &&
      process.env.GMAIL_CLIENT_SECRET &&
      process.env.GMAIL_REFRESH_TOKEN &&
      process.env.GMAIL_SENDER,
    );
    const whatsappConfigured = Boolean(
      process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID,
    );
    return {
      queue: this.queues.enabled ? "READY" : "UNAVAILABLE",
      mode,
      channels: {
        email: emailConfigured ? "CONFIGURED" : "CONFIG_REQUIRED",
        whatsapp: whatsappConfigured ? "CONFIGURED" : "CONFIG_REQUIRED",
      },
      operational:
        this.queues.enabled && (mode === "SIMULATED" || emailConfigured),
    };
  }

  async enqueue(input: {
    orderId: string;
    channel: NotificationChannel;
    template: NotificationTemplate;
    recipient: string;
    orderNumber: string;
    reason?: string;
  }) {
    const id = randomUUID();
    if (this.prisma.enabled)
      await this.prisma.notification.create({
        data: {
          id,
          orderId: input.orderId,
          channel: input.channel,
          template: input.template,
          recipient: input.recipient,
          orderNumber: input.orderNumber,
          ...(input.reason ? { reason: input.reason } : {}),
          status: "QUEUED",
        },
      });
    else
      this.memory.set(id, {
        id,
        orderId: input.orderId,
        channel: input.channel,
        template: input.template,
        status: "QUEUED",
        sentAt: null,
        createdAt: new Date(),
      });

    if (!this.queues.enabled) {
      await this.mark(id, "FAILED");
      const message =
        `Notification ${id} (${input.template} for order ${input.orderNumber}) ` +
        `to ${input.recipient} was NOT delivered: the background queue is unavailable ` +
        `(REDIS_URL is not set). Delivery requires Redis; the message was left FAILED.`;
      this.logger.error(message);
      if (process.env.NODE_ENV === "production")
        throw new ServiceUnavailableException(
          "Notification delivery is unavailable (background queue is not configured)",
        );
      return { id, status: "FAILED" as const };
    }

    await this.queues.add(
      QUEUES.notifications,
      "deliver-notification",
      { notificationId: id, ...input },
      `notification-${id}`,
    );
    return { id, status: "QUEUED" as const };
  }

  async mark(
    id: string,
    status: "QUEUED" | "SENDING" | "SENT" | "SIMULATED" | "FAILED",
  ) {
    if (this.prisma.enabled) {
      await this.prisma.notification.update({
        where: { id },
        data: {
          status,
          ...(status === "SENT" ? { sentAt: new Date() } : { sentAt: null }),
        },
      });
      return;
    }
    const item = this.memory.get(id);
    if (item) {
      item.status = status;
      item.sentAt = status === "SENT" ? new Date() : null;
    }
  }

  async markFailure(id: string, error: unknown, terminal: boolean) {
    if (!this.prisma.enabled) return this.mark(id, "FAILED");
    const item = await this.prisma.notification.findUnique({
      where: { id },
      select: { attemptCount: true },
    });
    const attempt = (item?.attemptCount ?? 0) + 1;
    await this.prisma.notification.update({
      where: { id },
      data: {
        status: "FAILED",
        attemptCount: { increment: 1 },
        errorMessage:
          error instanceof Error ? error.message.slice(0, 2000) : "unknown",
        nextAttemptAt:
          terminal && attempt >= 6
            ? null
            : new Date(
                Date.now() +
                  Math.min(15 * 60_000, 2_000 * 2 ** Math.min(attempt, 8)),
              ),
        sentAt: null,
      },
    });
  }

  async list(orderIds?: string[]) {
    if (this.prisma.enabled)
      return this.prisma.notification.findMany({
        ...(orderIds ? { where: { orderId: { in: orderIds } } } : {}),
        orderBy: { createdAt: "desc" },
        take: 200,
      });
    return [...this.memory.values()]
      .filter((item) => !orderIds || orderIds.includes(item.orderId))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async get(id: string) {
    const item = this.prisma.enabled
      ? await this.prisma.notification.findUnique({ where: { id } })
      : this.memory.get(id);
    if (!item) throw new NotFoundException("Notification not found");
    return item;
  }

  async retry(id: string, recipient: string, orderNumber: string) {
    const item = await this.get(id);
    if (!this.queues.enabled) {
      await this.mark(id, "FAILED");
      const message =
        `Notification ${id} (${item.template} for order ${item.orderId}) ` +
        `could not be retried: the background worker is unavailable (REDIS_URL is not set). ` +
        `The notification was left FAILED.`;
      this.logger.error(message);
      if (process.env.NODE_ENV === "production")
        throw new ServiceUnavailableException(
          "Notification delivery is unavailable (background queue is not configured)",
        );
      return { id, status: "FAILED" as const };
    }
    await this.mark(id, "QUEUED");
    await this.queues.add(
      QUEUES.notifications,
      "deliver-notification",
      {
        notificationId: id,
        orderId: item.orderId!,
        channel: item.channel,
        template: item.template,
        recipient,
        orderNumber,
      },
      `notification-retry-${id}-${Date.now()}`,
    );
    return { id, status: "QUEUED" as const };
  }
}
