import { createHmac } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { UserRole } from "@visa-compass/shared";
import { UserRoleName, UserStatus } from "@prisma/client";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import type { PrismaService } from "../../infrastructure/prisma.service.js";
import type { QueueService } from "../../jobs/queue.service.js";
import type { ClerkSyncService } from "../identity/clerk-sync.service.js";
import {
  WebhooksController,
  OperationsLogsController,
  sanitizeOperationsLog,
} from "./webhooks.controller.js";

beforeAll(() => {
  process.env.LOG_REDACTION = "true";
});

afterAll(() => {
  delete process.env.LOG_REDACTION;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TRANSATEL_WEBHOOK_SECRET;
  delete process.env.PAYMENT_WEBHOOK_SECRET;
});

describe("sanitizeOperationsLog", () => {
  it("keeps operational identifiers while redacting credentials and personal data", () => {
    expect(
      sanitizeOperationsLog({
        authorization: "Bearer credential",
        msisdn: "9779800000000",
        qrCode: { value: "LPA:1$consumer.rsp.world$secret" },
        safe: "kept",
      }),
    ).toEqual({
      authorization: "[REDACTED]",
      msisdn: "9779800000000",
      qrCode: "[REDACTED]",
      safe: "kept",
    });
  });
});

describe("OperationsLogsController", () => {
  it("combines sanitized provider, dead-letter, provisioning, order, and attributed staff logs", async () => {
    const createdAt = new Date("2026-08-23T00:00:00.000Z");
    const prisma = {
      enabled: true,
      integrationLog: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "integration-1",
            operation: "usage",
            method: "GET",
            endpoint: "/usage?msisdn=9779800000000",
            status: 200,
            durationMs: 12,
            errorCode: null,
            errorMessage: null,
            createdAt,
            requestBody: { msisdn: "9779800000000" },
            responseBody: { accessToken: "secret", safe: true },
          },
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
      webhookEvent: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "webhook-1",
            source: "transatel",
            eventId: "event-1",
            processedAt: null,
            deadLetteredAt: createdAt,
            signatureValid: true,
            errorMessage: "delivery failed",
            createdAt,
            payload: { msisdn: "9779800000000" },
          },
          {
            id: "webhook-retry-1",
            source: "transatel",
            eventId: "event-retry-1",
            processedAt: null,
            deadLetteredAt: null,
            signatureValid: true,
            errorMessage: "Queue dispatch pending: Redis unavailable",
            createdAt,
            payload: { event: "retry" },
          },
          {
            id: "webhook-processing-failed-1",
            source: "transatel",
            eventId: "event-processing-failed-1",
            processedAt: null,
            deadLetteredAt: null,
            signatureValid: true,
            errorMessage: "Order correlation failed",
            createdAt,
            payload: { event: "processing-failed" },
          },
        ]),
        count: vi.fn().mockResolvedValue(3),
      },
      auditLog: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "audit-1",
            module: "STAFF",
            action: "UPDATED",
            entity: "Order",
            entityId: "order-1",
            performedById: "11111111-1111-4111-8111-111111111111",
            performedBy: { email: "operator@example.com" },
            previousValue: { email: "old@example.com" },
            newValue: { email: "new@example.com" },
            createdAt,
          },
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
      order: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "order-1",
            orderNumber: "VC-1",
            channel: "CUSTOMER_WEB",
            status: "PROVISIONING",
            createdAt,
            partner: null,
          },
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
      provisioningAttempt: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "attempt-1",
            orderId: "order-1",
            provider: "TRANSATEL",
            status: "FAILED",
            attempt: 1,
            requestSnapshot: { activationCode: "secret" },
            responseSnapshot: null,
            errorCode: "TIMEOUT",
            createdAt,
          },
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
      provisioningOperation: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "operation-1",
            state: "RECONCILE_REQUIRED",
            requestSnapshot: { msisdn: "9779800000000" },
            responseSnapshot: null,
            lastErrorCategory: "NETWORK",
            lastErrorMessage: "timeout",
            updatedAt: createdAt,
            order: { orderNumber: "VC-1" },
          },
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    } as unknown as PrismaService;
    const request = {
      headers: {},
      user: {
        id: "clerk-1",
        localUserId: "11111111-1111-4111-8111-111111111111",
        email: "operator@example.com",
        accountType: UserRoleName.OPERATIONS,
        roles: [UserRole.OPERATIONS],
        capabilities: [],
        status: UserStatus.ACTIVE,
        mfaVerified: true,
        mustChangePassword: false,
      },
    };

    const result = await new OperationsLogsController(prisma).list(
      request,
      "all",
      "",
      "1",
      "25",
      "2026-08-22T18:15:00.000Z",
      "2026-08-23T18:15:00.000Z",
    );

    expect(result.total).toBe(8);
    expect(result.items).toHaveLength(8);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "integration-1",
          title: "Transatel product inventory and balances",
          requestBody: { msisdn: "9779800000000" },
          responseBody: { accessToken: "[REDACTED]", safe: true },
        }),
        expect.objectContaining({
          id: "webhook-1",
          title: "Transatel callback received",
          statusLabel: "FAILED",
        }),
        expect.objectContaining({
          id: "webhook-retry-1",
          statusLabel: "RETRY_PENDING",
        }),
        expect.objectContaining({
          id: "webhook-processing-failed-1",
          status: 500,
          statusLabel: "PROCESSING_FAILED",
        }),
        expect.objectContaining({ id: "attempt-attempt-1" }),
        expect.objectContaining({ id: "operation-operation-1" }),
        expect.objectContaining({
          id: "audit-1",
          detail: expect.stringContaining(
            "staff 11111111-1111-4111-8111-111111111111",
          ),
        }),
      ]),
    );
    const expectedCreatedAtRange = {
      createdAt: {
        gte: new Date("2026-08-22T18:15:00.000Z"),
        lt: new Date("2026-08-23T18:15:00.000Z"),
      },
    };
    expect(prisma.integrationLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedCreatedAtRange }),
    );
    expect(prisma.webhookEvent.count).toHaveBeenCalledWith({
      where: expect.objectContaining(expectedCreatedAtRange),
    });
    expect(prisma.provisioningOperation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          updatedAt: expectedCreatedAtRange.createdAt,
        },
      }),
    );
  });
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
      expect.objectContaining({ attempts: 8 }),
    );
  });

  it("normalizes Khalti source names and rejects unknown payment providers", async () => {
    process.env.PAYMENT_WEBHOOK_SECRET = "payment-secret";
    const { value, queues } = controller(null);
    const body = {
      eventId: "payment-event-456",
      orderId: "order-1",
      reference: "pidx-1",
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    const signature = `sha256=${createHmac("sha256", "payment-secret").update(rawBody).digest("hex")}`;

    await value.payment("KHALTI", body, { rawBody }, signature);
    expect(queues.add).toHaveBeenCalledWith(
      "payments",
      "payment-callback",
      expect.objectContaining({ provider: "khalti" }),
      `khalti-${body.eventId}`,
      expect.objectContaining({ attempts: 8 }),
    );
    await expect(
      value.payment("unknown", body, { rawBody }, signature),
    ).rejects.toThrow("Unsupported payment provider");
  });
});

function controller(processedAt: Date | null = null) {
  const prisma = {
    enabled: true,
    webhookEvent: {
      findUnique: vi.fn().mockResolvedValue({ processedAt }),
      upsert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
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
      expect.objectContaining({ attempts: 8 }),
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

  it("acknowledges a durably persisted event when queue dispatch is temporarily unavailable", async () => {
    const { value, prisma, queues } = controller(null);
    vi.mocked(queues.add).mockRejectedValueOnce(new Error("Redis unavailable"));

    const result = await value.connectivity(
      "transatel",
      { eventId: "event-12345" },
      {},
      {} as RawBodyRequest<Request>,
    );

    expect(result).toEqual({
      accepted: true,
      persisted: true,
      queued: false,
    });
    expect(prisma.webhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          errorMessage: expect.stringContaining("Redis unavailable"),
          nextAttemptAt: expect.any(Date),
        }),
      }),
    );
  });
});
