import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";
import { NotificationService } from "./notification.service.js";
import { QUEUES } from "../../jobs/queues.js";
import type { QueueService } from "../../jobs/queue.service.js";
import type { PrismaService } from "../../infrastructure/prisma.service.js";

const input = {
  orderId: "order-1",
  channel: "EMAIL" as const,
  template: "QR_READY" as const,
  recipient: "traveler@example.com",
  orderNumber: "VC-1000",
};

function queueStub(enabled: boolean) {
  return {
    enabled,
    add: vi.fn().mockResolvedValue({ id: "job-1", simulated: !enabled }),
  } as unknown as QueueService;
}

function memoryPrisma() {
  return { enabled: false } as unknown as PrismaService;
}

describe("NotificationService queue-disabled delivery guard", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("marks FAILED instead of SENT when the queue is unavailable", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const service = new NotificationService(memoryPrisma(), queueStub(false));

    const result = await service.enqueue(input);

    expect(result.status).toBe("FAILED");
    const persisted = await service.get(result.id);
    expect(persisted.status).toBe("FAILED");
    expect(persisted.sentAt).toBeNull();
  });

  it("reports delivery configuration without exposing credentials", () => {
    vi.stubEnv("NOTIFICATION_MODE", "live");
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh");
    vi.stubEnv("GMAIL_SENDER", "sender@example.com");
    const service = new NotificationService(memoryPrisma(), queueStub(true));

    expect(service.health()).toEqual(expect.objectContaining({ queue: "READY", mode: "LIVE", operational: true, channels: expect.objectContaining({ email: "CONFIGURED" }) }));
  });

  it("throws ServiceUnavailableException in production when delivery cannot be queued", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const service = new NotificationService(memoryPrisma(), queueStub(false));

    await expect(service.enqueue(input)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    const memory = (
      service as unknown as { memory: Map<string, { status: string }> }
    ).memory;
    const persisted = Array.from(memory.values())[0];
    expect(persisted?.status).toBe("FAILED");
  });

  it("queues the delivery job and reports QUEUED when Redis is available", async () => {
    const queue = queueStub(true);
    const service = new NotificationService(memoryPrisma(), queue);

    const result = await service.enqueue(input);

    expect(result.status).toBe("QUEUED");
    expect(queue.add).toHaveBeenCalledWith(
      QUEUES.notifications,
      "deliver-notification",
      expect.objectContaining({ notificationId: result.id }),
      `notification-${result.id}`,
    );
  });

  it("retry fails loudly without claiming a delivery was scheduled", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const service = new NotificationService(memoryPrisma(), queueStub(false));
    const created = await service.enqueue(input);
    expect(created.status).toBe("FAILED");

    const retried = await service.retry(
      created.id,
      input.recipient,
      input.orderNumber,
    );

    expect(retried.status).toBe("FAILED");
    expect((await service.get(created.id)).status).toBe("FAILED");
  });
});
