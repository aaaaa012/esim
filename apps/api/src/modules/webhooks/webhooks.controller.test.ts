import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import type { PrismaService } from "../../infrastructure/prisma.service.js";
import type { QueueService } from "../../jobs/queue.service.js";
import type { ClerkSyncService } from "../identity/clerk-sync.service.js";
import { WebhooksController } from "./webhooks.controller.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TRANSATEL_WEBHOOK_SECRET;
  delete process.env.PAYMENT_WEBHOOK_SECRET;
});

describe("WebhooksController payment inbox", () => {
  it("re-enqueues a persisted payment callback that was never processed", async () => {
    process.env.PAYMENT_WEBHOOK_SECRET = "payment-secret";
    const { value, prisma, queues } = controller(null);
    const body = {
      eventId: "payment-event-123",
      orderId: "order-1",
      reference: "pidx-1",
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    const signature = `sha256=${createHmac("sha256", "payment-secret").update(rawBody).digest("hex")}`;

    const result = await value.payment("khalti", body, { rawBody }, signature);

    expect(result).toEqual({ accepted: true, queued: true });
    expect(prisma.webhookEvent.upsert).not.toHaveBeenCalled();
    expect(queues.add).toHaveBeenCalledWith(
      "payments",
      "payment-callback",
      expect.objectContaining({ provider: "khalti", eventId: body.eventId }),
      `khalti-${body.eventId}`,
    );
  });
});

function controller(processedAt: Date | null = null) {
  const prisma = {
    enabled: true,
    webhookEvent: {
      findUnique: vi.fn().mockResolvedValue({ processedAt }),
      upsert: vi.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaService;
  const queues = {
    add: vi.fn().mockResolvedValue({ id: "job-1" }),
  } as unknown as QueueService;
  return {
    value: new WebhooksController(prisma, queues, {} as ClerkSyncService),
    prisma,
    queues,
  };
}

describe("WebhooksController connectivity inbox", () => {
  it("verifies the signature against the exact raw bytes", async () => {
    process.env.TRANSATEL_WEBHOOK_SECRET = "secret";
    const rawBody = Buffer.from('{\n  "header": {"eventId":"event-12345"}\n}');
    const signature = `sha256=${createHmac("sha256", "secret").update(rawBody).digest("hex")}`;
    const { value, queues } = controller(null);

    const result = await value.connectivity(
      "transatel",
      { header: { eventId: "event-12345" } },
      { "x-tsl-signature-256": signature },
      { rawBody } as RawBodyRequest<Request>,
    );

    expect(result).toEqual({ accepted: true, queued: true });
    expect(queues.add).toHaveBeenCalledWith(
      "provider-callbacks",
      "connectivity-callback",
      { provider: "transatel", eventId: "event-12345" },
      "transatel:event-12345",
    );
  });

  it("re-enqueues a duplicate inbox row that has not been processed", async () => {
    const { value, prisma, queues } = controller(null);
    await value.connectivity(
      "TRANSATEL",
      { eventId: "event-12345" },
      {},
      {} as RawBodyRequest<Request>,
    );
    expect(prisma.webhookEvent.upsert).not.toHaveBeenCalled();
    expect(queues.add).toHaveBeenCalledOnce();
  });

  it("does not re-enqueue an event that was successfully processed", async () => {
    const { value, queues } = controller(new Date());
    const result = await value.connectivity(
      "transatel",
      { eventId: "event-12345" },
      {},
      {} as RawBodyRequest<Request>,
    );
    expect(result).toEqual({ accepted: true, duplicate: true });
    expect(queues.add).not.toHaveBeenCalled();
  });
});
