import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
  RawBodyRequest,
  Req,
  UseGuards,
} from "@nestjs/common";
import { UserRole } from "@visa-compass/shared";
import {
  AuthGuard,
  type AuthenticatedRequest,
  requireRole,
} from "../../common/auth.guard.js";
import { AccountGuard, AccountTypes } from "../../common/auth.guard.js";
import {
  UserRoleName,
  Prisma,
  ProvisioningOperationState,
} from "@prisma/client";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { Webhook } from "svix";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { QueueService } from "../../jobs/queue.service.js";
import { ReconciliationService } from "../../jobs/reconciliation.service.js";
import { QUEUES } from "../../jobs/queues.js";
import { INBOUND_WEBHOOK_JOB_OPTIONS } from "../../infrastructure/resilience-policy.js";
import { paymentSimulatorSecret } from "../../common/payment-simulator-secret.js";
import { logRedactionEnabled } from "../../common/redact.js";
import { ClerkSyncService } from "../identity/clerk-sync.service.js";

@Controller("webhooks")
export class WebhooksController {
  private readonly accepted = new Set<string>();
  private readonly logger = new Logger(WebhooksController.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    _clerkSync?: ClerkSyncService,
  ) {}

  @Post("clerk")
  @HttpCode(202)
  async clerk(
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Req() request: { rawBody?: Buffer },
  ) {
    if (!process.env.CLERK_WEBHOOK_SECRET) {
      if (process.env.NODE_ENV === "production")
        throw new BadRequestException("Clerk webhook is not configured");
      return { accepted: true, simulated: true };
    }
    const event = new Webhook(process.env.CLERK_WEBHOOK_SECRET).verify(
      this.rawPayload(body, request.rawBody),
      {
        "svix-id": headers["svix-id"] ?? "",
        "svix-timestamp": headers["svix-timestamp"] ?? "",
        "svix-signature": headers["svix-signature"] ?? "",
      },
    ) as { type: string; data: { id?: string } };
    // Clerk delivers organization/session events to the same endpoint. They
    // are validly signed but not identity synchronization work.
    if (!event.type.startsWith("user."))
      return { accepted: true, eventType: event.type, ignored: true };
    const eventId = headers["svix-id"];
    if (!eventId) throw new BadRequestException("Clerk event id is required");
    const existing = await this.webhookState("clerk", eventId);
    if (existing?.processedAt) return { accepted: true, duplicate: true };
    if (!existing)
      await this.persistWebhook(
        "clerk",
        eventId,
        event as unknown as object,
        true,
      );
    await this.queues.add(
      QUEUES.identityCallbacks,
      "clerk-callback",
      {
        provider: "clerk",
        eventId,
        payload: event as unknown as Record<string, unknown>,
      },
      `clerk-${eventId}`,
      INBOUND_WEBHOOK_JOB_OPTIONS,
    );
    return {
      accepted: true,
      queued: true,
      eventType: event.type,
      userId: event.data.id,
    };
  }

  @Post("payments/:provider")
  @HttpCode(202)
  async payment(
    @Param("provider") provider: string,
    @Body()
    body: {
      eventId?: string;
      orderId?: string;
      reference?: string;
      pidx?: string;
      eventType?: string;
      caseId?: string;
      amount?: number;
      currency?: string;
      reason?: string;
    },
    @Req() request: { rawBody?: Buffer },
    @Headers("x-visa-signature") signature?: string,
  ) {
    const source = provider.toLowerCase();
    if (source !== "khalti")
      throw new BadRequestException(
        `Unsupported payment provider: ${provider}`,
      );
    const eventId = body.eventId;
    if (!eventId) throw new BadRequestException("eventId is required");
    if (
      typeof eventId !== "string" ||
      eventId.length < 8 ||
      eventId.length > 256
    )
      throw new BadRequestException("eventId is invalid");
    this.verifyPaymentSignature(
      this.rawPayload(body, request.rawBody),
      signature,
    );
    const existing = await this.webhookState(source, eventId);
    if (existing?.processedAt) return { accepted: true, duplicate: true };
    const reference = body.reference ?? body.pidx;
    let orderId = body.orderId;
    if (!orderId && reference && this.prisma.enabled) {
      orderId = (
        await this.prisma.payment.findUnique({
          where: { paymentReference: reference },
          select: { orderId: true },
        })
      )?.orderId;
    }
    const payload = {
      ...body,
      ...(reference ? { reference } : {}),
      ...(orderId ? { orderId } : {}),
    };
    if (!existing) await this.persistWebhook(source, eventId, payload, true);
    // Persisted-but-unprocessed duplicates are deliberately re-enqueued. This
    // closes the database-commit/Redis-enqueue failure window.
    await this.queues.add(
      QUEUES.payments,
      "payment-callback",
      { provider: source, eventId, payload },
      `${source}-${eventId}`,
      INBOUND_WEBHOOK_JOB_OPTIONS,
    );
    this.remember(`${source}:${eventId}`);
    return { accepted: true, queued: true };
  }

  @Post("connectivity/:provider")
  @HttpCode(204)
  async connectivity(
    @Param("provider") provider: string,
    @Body() body: { eventId?: string; header?: { eventId?: string } },
    @Headers() headers: Record<string, string>,
    @Req() request: RawBodyRequest<Request>,
  ) {
    const source = provider.toLowerCase();
    if (source !== "transatel")
      throw new BadRequestException(
        `Unsupported connectivity provider: ${provider}`,
      );
    const eventId = body.eventId ?? body.header?.eventId;
    if (!eventId) throw new BadRequestException("eventId is required");
    if (
      typeof eventId !== "string" ||
      eventId.length < 8 ||
      eventId.length > 256
    )
      throw new BadRequestException("eventId is invalid");
    const signature =
      headers["x-tsl-signature-256"] ?? headers["x-visa-signature"];
    if (signature) {
      if (!request.rawBody)
        throw new BadRequestException("Raw webhook body is unavailable");
      this.verifyTransatelSignature(request.rawBody, signature);
    } else if (process.env.NODE_ENV === "production")
      throw new BadRequestException("Transatel webhook signature is required");
    const key = `${source}:${eventId}`;
    const existing = await this.webhookState(source, eventId);
    if (existing?.deadLetteredAt)
      return { accepted: true, duplicate: true, deadLettered: true };
    if (existing?.processedAt) return { accepted: true, duplicate: true };
    if (!existing)
      await this.persistWebhook(source, eventId, body, Boolean(signature));
    // Re-enqueue persisted-but-unprocessed duplicates. This closes the failure
    // window where the database insert succeeds but Redis is temporarily down.
    try {
      await this.queues.add(
        QUEUES.providerCallbacks,
        "connectivity-callback",
        { provider: source, eventId },
        key,
        INBOUND_WEBHOOK_JOB_OPTIONS,
      );
    } catch (error) {
      if (!this.prisma.enabled) throw error;
      // The inbox row is durable. Reconciliation will dispatch it after Redis
      // recovers, so acknowledge receipt instead of suspending the stream.
      const message = error instanceof Error ? error.message : "unknown";
      this.logger.error(
        `Transatel event ${eventId} was persisted but not queued: ${message}`,
      );
      if (this.prisma.enabled)
        await this.prisma.webhookEvent
          .update({
            where: { source_eventId: { source, eventId } },
            data: {
              errorMessage: `Queue dispatch pending: ${message}`.slice(0, 2000),
              nextAttemptAt: new Date(),
            },
          })
          .catch((stateError) =>
            this.logger.error(
              `Could not mark Transatel event ${eventId} for queue recovery: ${stateError instanceof Error ? stateError.message : "unknown"}`,
            ),
          );
      return { accepted: true, persisted: true, queued: false };
    }
    if (this.prisma.enabled)
      await this.prisma.webhookEvent
        .update({
          where: { source_eventId: { source, eventId } },
          data: { errorMessage: null, nextAttemptAt: null },
        })
        .catch((stateError) =>
          this.logger.warn(
            `Queued Transatel event ${eventId}, but could not clear its recovery state: ${stateError instanceof Error ? stateError.message : "unknown"}`,
          ),
        );
    this.remember(key);
    return { accepted: true, queued: true };
  }

  /** Bounded in-memory dedup set used when persistence is disabled. */
  private remember(key: string) {
    this.accepted.add(key);
    if (this.accepted.size > 20_000) this.accepted.clear();
  }

  private async persistWebhook(
    source: string,
    eventId: string,
    payload: object,
    signatureValid: boolean,
  ) {
    if (!this.prisma.enabled) return;
    await this.prisma.webhookEvent.upsert({
      where: { source_eventId: { source, eventId } },
      update: {},
      create: { source, eventId, payload, signatureValid },
    });
  }

  private async webhookExists(source: string, eventId: string) {
    if (!this.prisma.enabled) return false;
    return Boolean(
      await this.prisma.webhookEvent.findUnique({
        where: { source_eventId: { source, eventId } },
        select: { id: true },
      }),
    );
  }
  private async webhookState(source: string, eventId: string) {
    if (!this.prisma.enabled) return null;
    return this.prisma.webhookEvent.findUnique({
      where: { source_eventId: { source, eventId } },
      select: { processedAt: true, deadLetteredAt: true },
    });
  }

  private rawPayload(body: unknown, rawBody?: Buffer): string {
    if (rawBody) return rawBody.toString("utf8");
    if (process.env.NODE_ENV === "production")
      throw new BadRequestException("Webhook raw body is unavailable");
    return JSON.stringify(body);
  }

  private verifyPaymentSignature(payload: string, signature?: string) {
    if (!signature)
      throw new BadRequestException("Payment webhook signature is required");
    const secret =
      process.env.PAYMENT_WEBHOOK_SECRET ??
      (process.env.NODE_ENV === "production"
        ? undefined
        : paymentSimulatorSecret());
    if (!secret)
      throw new BadRequestException("Payment webhook is not configured");
    const raw = signature.startsWith("sha256=")
      ? signature.slice("sha256=".length)
      : signature;
    const expected = createHmac("sha256", secret).update(payload).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(raw);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw new BadRequestException("Invalid payment webhook signature");
  }
  private verifyTransatelSignature(payload: Buffer, signature: string) {
    const secret = process.env.TRANSATEL_WEBHOOK_SECRET;
    if (!secret)
      throw new BadRequestException("Transatel webhook is not configured");
    const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw new BadRequestException("Invalid Transatel webhook signature");
  }
}

@Controller("operations/integration-events")
@UseGuards(AuthGuard, AccountGuard)
@AccountTypes(UserRoleName.OPERATIONS, UserRoleName.SUPER_ADMIN)
export class OperationsIntegrationEventsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
  ) {}
  @Get() async list(@Req() request: AuthenticatedRequest) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    if (!this.prisma.enabled) return [];
    return this.prisma.webhookEvent.findMany({
      where: { NOT: { source: { startsWith: "idempotency:" } } },
      select: {
        id: true,
        source: true,
        eventId: true,
        signatureValid: true,
        processedAt: true,
        processingStartedAt: true,
        attemptCount: true,
        nextAttemptAt: true,
        deadLetteredAt: true,
        errorMessage: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }
  @Post(":id/replay") async replay(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    if (!this.prisma.enabled)
      throw new BadRequestException(
        "Webhook replay requires database persistence",
      );
    const event = await this.prisma.webhookEvent.findUnique({
      where: { id },
      select: { id: true, source: true, eventId: true, payload: true },
    });
    if (!event) throw new BadRequestException("Webhook event not found");
    const source = event.source.toLowerCase();
    const queue =
      source === "transatel"
        ? QUEUES.providerCallbacks
        : source === "khalti"
          ? QUEUES.payments
          : null;
    if (!queue)
      throw new BadRequestException(
        `Webhook replay is not supported for ${event.source}`,
      );
    await this.prisma.webhookEvent.update({
      where: { id },
      data: {
        processedAt: null,
        processingStartedAt: null,
        deadLetteredAt: null,
        errorMessage: null,
        nextAttemptAt: new Date(),
      },
    });
    await this.queues.add(
      queue,
      source === "transatel" ? "connectivity-callback" : "payment-callback",
      {
        provider: source,
        eventId: event.eventId,
        payload: event.payload as Record<string, unknown>,
      },
      `replay-${source}-${event.eventId}-${Date.now()}`,
      { ...INBOUND_WEBHOOK_JOB_OPTIONS, allowDuplicate: true },
    );
    return { id, eventId: event.eventId, source, status: "QUEUED" };
  }
}

@Controller("operations/integration-logs")
@UseGuards(AuthGuard, AccountGuard)
@AccountTypes(UserRoleName.OPERATIONS, UserRoleName.SUPER_ADMIN)
export class OperationsIntegrationLogsController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() async list(
    @Req() request: AuthenticatedRequest,
    @Query("operation") operation?: string,
  ) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    if (!this.prisma.enabled) return [];
    const rows = await this.prisma.integrationLog.findMany({
      where: operation ? { operation } : {},
      select: {
        id: true,
        operation: true,
        method: true,
        endpoint: true,
        status: true,
        durationMs: true,
        errorCode: true,
        errorMessage: true,
        correlationId: true,
        requestBody: true,
        responseBody: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return rows.map((row) => ({
      ...row,
      endpoint: sanitizeLogEndpoint(row.endpoint),
      errorMessage: sanitizeLogText(row.errorMessage),
      requestBody: sanitizeOperationsLog(row.requestBody),
      responseBody: sanitizeOperationsLog(row.responseBody),
    }));
  }
}

/**
 * The operations log screen combines the durable records produced by provider
 * calls, inbound callbacks, and staff/audit actions.  Keep this separate from
 * the integration-log endpoint: the latter is intentionally a narrow provider
 * diagnostic API used by the integrations workspace.
 */
const SENSITIVE_LOG_KEY =
  /(^|_)(authorization|cookie|password|secret|client_?secret|webhook_?secret|access_?token|refresh_?token|lookup_?token|guest_?access_?token|api_?key|signature|passport|document|email|phone|mobile|qr_?(code|payload)|activation_?code|matching_?id|otp|pin|card|account_?number|payment_?url|recovery_?(link|url|token))$/i;

export function sanitizeOperationsLog(value: unknown, depth = 0): unknown {
  if (!logRedactionEnabled()) return value;
  if (depth > 8) return "[TRUNCATED]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (/LPA:1\$/i.test(value)) return "[REDACTED QR CREDENTIAL]";
    if (/^Bearer\s+/i.test(value)) return "[REDACTED AUTHORIZATION]";
    return value.length > 4_000
      ? `${value.slice(0, 4_000)} [TRUNCATED]`
      : value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value))
    return value
      .slice(0, 100)
      .map((item) => sanitizeOperationsLog(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 200)
      .map(([key, item]) => [
        key,
        SENSITIVE_LOG_KEY.test(key)
          ? "[REDACTED]"
          : sanitizeOperationsLog(item, depth + 1),
      ]),
  );
}

function sanitizeLogText(value: string | null | undefined) {
  if (!value) return value ?? null;
  if (!logRedactionEnabled()) return value;
  return value
    .replace(/LPA:1\$[^\s"']+/gi, "[REDACTED QR CREDENTIAL]")
    .replace(/Bearer\s+[^\s"']+/gi, "[REDACTED AUTHORIZATION]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED EMAIL]")
    .slice(0, 2_000);
}

function sanitizeLogEndpoint(endpoint: string) {
  if (!logRedactionEnabled()) return endpoint;
  const [path] = endpoint.split("?", 1);
  return path ?? endpoint;
}

function transatelOperationTitle(
  operation: string,
  requestBody: Prisma.JsonValue,
  method: string,
  endpoint: string,
) {
  const normalized = operation.replace(/-auth-retry$/, "");
  const orderType =
    requestBody &&
    typeof requestBody === "object" &&
    !Array.isArray(requestBody)
      ? String((requestBody as Record<string, unknown>).orderType ?? "")
      : "";
  const labels: Record<string, string> = {
    token: "Transatel authentication",
    usage: "Transatel product inventory and balances",
    "esim-details": "Transatel eSIM profile lookup",
    "subscriber-details": "Transatel subscriber status lookup",
    "subscriber-suspend": "Transatel subscriber suspension",
    "subscriber-reactivate": "Transatel subscriber reactivation",
    "subscriber-terminate": "Transatel subscriber termination",
    catalog: "Transatel product catalog lookup",
    eligibility: "Transatel product eligibility check",
  };
  if (normalized === "provision")
    return orderType.toLowerCase() === "subscribe"
      ? "Transatel top-up subscription"
      : "Transatel plan preload";
  return labels[normalized] ?? `${method} ${sanitizeLogEndpoint(endpoint)}`;
}

function transatelWebhookTitle(payload: Prisma.JsonValue) {
  const eventType =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { header?: { eventType?: unknown } }).header?.eventType
      : null;
  if (typeof eventType !== "string") return "Transatel callback received";
  const labels: Record<string, string> = {
    "OCS/PRODUCT/PRELOADED": "Transatel plan preloaded",
    "OCS/PRODUCT/ACTIVATED": "Transatel plan activated",
    "OCS/PRODUCT/CANCELED": "Transatel plan renewal canceled",
    "OCS/PRODUCT/EXPIRED": "Transatel plan expired",
    "OCS/PRODUCT/TERMINATED": "Transatel plan terminated",
    "CONNECTIVITY-MANAGEMENT/SUBSCRIBER/SUSPENDED":
      "Transatel subscriber suspended",
    "CONNECTIVITY-MANAGEMENT/SUBSCRIBER/REACTIVATED":
      "Transatel subscriber reactivated",
    "CONNECTIVITY-MANAGEMENT/SUBSCRIBER/TERMINATED":
      "Transatel subscriber terminated",
  };
  return labels[eventType.toUpperCase()] ?? `Transatel ${eventType}`;
}

@Controller("operations/logs")
@UseGuards(AuthGuard, AccountGuard)
@AccountTypes(UserRoleName.OPERATIONS, UserRoleName.SUPER_ADMIN)
export class OperationsLogsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
    @Query("group") group = "all",
    @Query("q") query = "",
    @Query("page") pageInput = "1",
    @Query("pageSize") pageSizeInput = "25",
    @Query("from") fromInput = "",
    @Query("to") toInput = "",
  ) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    const allowedGroups = new Set([
      "all",
      "provider",
      "incoming",
      "orders",
      "staff",
    ]);
    if (!allowedGroups.has(group))
      throw new BadRequestException("Invalid log group");
    const page = Math.max(1, Number.parseInt(pageInput, 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number.parseInt(pageSizeInput, 10) || 25),
    );
    const parseBoundary = (value: string, label: string) => {
      if (!value) return undefined;
      const date = new Date(value);
      if (Number.isNaN(date.getTime()))
        throw new BadRequestException(`Invalid ${label} date`);
      return date;
    };
    const from = parseBoundary(fromInput, "from");
    const to = parseBoundary(toInput, "to");
    if (from && to && from >= to)
      throw new BadRequestException("The from date must be before the to date");
    const timestampRange =
      from || to
        ? { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) }
        : undefined;
    if (!this.prisma.enabled) return { items: [], total: 0, page, pageSize };

    // Pull only enough records to serve the requested page from each source,
    // then merge deterministically by timestamp. The counts remain exact.
    const take = page * pageSize;
    const normalizedQuery = query.trim().toLowerCase();
    const matches = (...values: Array<string | null | undefined>) =>
      !normalizedQuery ||
      values.some((value) => value?.toLowerCase().includes(normalizedQuery));
    const isOrderModule = (module: string) =>
      /ORDER|PAYMENT|VERIFICATION|TRANSATEL|INVENTORY|REFUND/i.test(module);

    const safeQuery = async <T>(
      fn: () => Promise<T>,
      fallback: T,
    ): Promise<T> => {
      try {
        return await fn();
      } catch {
        return fallback;
      }
    };

    let integrationRows: Array<{
      id: string;
      operation: string;
      method: string;
      endpoint: string;
      status: number;
      durationMs: number | null;
      errorCode: string | null;
      errorMessage: string | null;
      correlationId: string | null;
      createdAt: Date;
      requestBody: Prisma.JsonValue;
      responseBody: Prisma.JsonValue;
    }> = [];
    let webhookRows: Array<{
      id: string;
      source: string;
      eventId: string;
      processedAt: Date | null;
      deadLetteredAt: Date | null;
      signatureValid: boolean;
      errorMessage: string | null;
      createdAt: Date;
      payload: Prisma.JsonValue;
    }> = [];
    let auditRows: Array<{
      id: string;
      module: string;
      action: string;
      entity: string;
      entityId: string;
      performedById: string | null;
      createdAt: Date;
      performedBy: { email: string } | null;
      previousValue: Prisma.JsonValue | null;
      newValue: Prisma.JsonValue | null;
    }> = [];
    let orderRows: Array<{
      id: string;
      orderNumber: string;
      channel: string;
      status: string;
      createdAt: Date;
      partner: { name: string } | null;
    }> = [];
    let provisioningAttemptRows: Array<{
      id: string;
      orderId: string;
      provider: string;
      status: string;
      attempt: number;
      requestSnapshot: Prisma.JsonValue;
      responseSnapshot: Prisma.JsonValue | null;
      errorCode: string | null;
      createdAt: Date;
    }> = [];
    let provisioningOperationRows: Array<{
      id: string;
      state: string;
      requestSnapshot: Prisma.JsonValue;
      responseSnapshot: Prisma.JsonValue | null;
      lastErrorCategory: string | null;
      lastErrorMessage: string | null;
      updatedAt: Date;
      order: { orderNumber: string };
    }> = [];
    let integrationTotal = 0;
    let webhookTotal = 0;
    let auditTotal = 0;
    let orderTotal = 0;
    let provisioningAttemptTotal = 0;
    let provisioningOperationTotal = 0;

    if (group === "all" || group === "provider") {
      integrationRows = await safeQuery(
        () =>
          this.prisma.integrationLog.findMany({
            ...(timestampRange ? { where: { createdAt: timestampRange } } : {}),
            orderBy: { createdAt: "desc" },
            take,
          }),
        [],
      );
      integrationTotal = await safeQuery(
        () =>
          timestampRange
            ? this.prisma.integrationLog.count({
                where: { createdAt: timestampRange },
              })
            : this.prisma.integrationLog.count(),
        integrationRows.length,
      );
    }
    if (group === "all" || group === "incoming") {
      webhookRows = await safeQuery(
        () =>
          this.prisma.webhookEvent.findMany({
            where: {
              NOT: { source: { startsWith: "idempotency:" } },
              ...(timestampRange ? { createdAt: timestampRange } : {}),
            },
            orderBy: { createdAt: "desc" },
            take,
          }),
        [],
      );
      webhookTotal = await safeQuery(
        () =>
          this.prisma.webhookEvent.count({
            where: {
              NOT: { source: { startsWith: "idempotency:" } },
              ...(timestampRange ? { createdAt: timestampRange } : {}),
            },
          }),
        webhookRows.length,
      );
    }
    if (group === "all" || group === "orders" || group === "staff") {
      auditRows = await safeQuery(
        () =>
          this.prisma.auditLog.findMany({
            ...(timestampRange ? { where: { createdAt: timestampRange } } : {}),
            orderBy: { createdAt: "desc" },
            take,
            include: { performedBy: { select: { email: true } } },
          }),
        [],
      );
      auditTotal = await safeQuery(
        () =>
          timestampRange
            ? this.prisma.auditLog.count({
                where: { createdAt: timestampRange },
              })
            : this.prisma.auditLog.count(),
        auditRows.length,
      );
    }
    if (group === "all" || group === "orders") {
      orderRows = await safeQuery(
        () =>
          this.prisma.order.findMany({
            ...(timestampRange ? { where: { createdAt: timestampRange } } : {}),
            select: {
              id: true,
              orderNumber: true,
              channel: true,
              status: true,
              createdAt: true,
              partner: { select: { name: true } },
            },
            orderBy: { createdAt: "desc" },
            take,
          }),
        [],
      );
      orderTotal = await safeQuery(
        () =>
          timestampRange
            ? this.prisma.order.count({
                where: { createdAt: timestampRange },
              })
            : this.prisma.order.count(),
        orderRows.length,
      );
      provisioningAttemptRows = await safeQuery(
        () =>
          this.prisma.provisioningAttempt.findMany({
            ...(timestampRange ? { where: { createdAt: timestampRange } } : {}),
            orderBy: { createdAt: "desc" },
            take,
          }),
        [],
      );
      provisioningOperationRows = await safeQuery(
        () =>
          this.prisma.provisioningOperation.findMany({
            ...(timestampRange ? { where: { updatedAt: timestampRange } } : {}),
            orderBy: { updatedAt: "desc" },
            take,
            select: {
              id: true,
              state: true,
              requestSnapshot: true,
              responseSnapshot: true,
              lastErrorCategory: true,
              lastErrorMessage: true,
              updatedAt: true,
              order: { select: { orderNumber: true } },
            },
          }),
        [],
      );
      provisioningAttemptTotal = await safeQuery(
        () =>
          timestampRange
            ? this.prisma.provisioningAttempt.count({
                where: { createdAt: timestampRange },
              })
            : this.prisma.provisioningAttempt.count(),
        provisioningAttemptRows.length,
      );
      provisioningOperationTotal = await safeQuery(
        () =>
          timestampRange
            ? this.prisma.provisioningOperation.count({
                where: { updatedAt: timestampRange },
              })
            : this.prisma.provisioningOperation.count(),
        provisioningOperationRows.length,
      );
    }

    const items = [
      ...integrationRows.map((row) => ({
        group: "provider",
        id: row.id,
        identifier: row.operation,
        title: transatelOperationTitle(
          row.operation,
          row.requestBody,
          row.method,
          row.endpoint,
        ),
        detail:
          sanitizeLogText(row.errorMessage ?? row.errorCode) ??
          "Provider request completed",
        status: row.status,
        statusLabel:
          row.status >= 200 && row.status < 400 ? "SUCCESS" : "FAILED",
        createdAt: row.createdAt,
        durationMs: row.durationMs,
        correlationId: row.correlationId,
        error: sanitizeLogText(row.errorMessage),
        requestBody: sanitizeOperationsLog(row.requestBody),
        responseBody: sanitizeOperationsLog(row.responseBody),
      })),
      ...webhookRows.map((row) => ({
        group: "incoming",
        id: row.id,
        identifier: row.source,
        title:
          row.source === "transatel"
            ? transatelWebhookTitle(row.payload)
            : `${row.source} callback received`,
        detail:
          sanitizeLogText(row.errorMessage) ??
          `${row.processedAt ? "Callback processed" : "Callback queued"} / Event ${row.eventId}`,
        status: row.signatureValid
          ? row.deadLetteredAt || row.errorMessage
            ? 500
            : 202
          : 401,
        statusLabel: !row.signatureValid
          ? "REJECTED"
          : row.deadLetteredAt
            ? "FAILED"
            : row.processedAt
              ? "PROCESSED"
              : row.errorMessage?.startsWith("Queue dispatch pending:")
                ? "RETRY_PENDING"
                : row.errorMessage
                  ? "PROCESSING_FAILED"
                  : "QUEUED",
        createdAt: row.createdAt,
        error: sanitizeLogText(row.errorMessage),
        requestBody: sanitizeOperationsLog(row.payload),
      })),
      ...orderRows.map((row) => ({
        group: "orders" as const,
        id: `order-${row.id}`,
        identifier:
          row.channel === "PARTNER_HOSTED"
            ? "Hosted checkout"
            : row.channel === "PARTNER_API"
              ? "API partner"
              : "Visa Compass checkout",
        title:
          row.channel === "PARTNER_HOSTED"
            ? "Hosted checkout order created"
            : row.channel === "PARTNER_API"
              ? "API partner order created"
              : "Visa Compass checkout order created",
        detail: `${row.orderNumber} is ${row.status.toLowerCase().replaceAll("_", " ")}${row.partner ? ` · ${row.partner.name}` : ""}`,
        statusLabel: "RECORDED",
        createdAt: row.createdAt,
      })),
      ...provisioningAttemptRows.map((row) => ({
        group: "orders" as const,
        id: `attempt-${row.id}`,
        identifier: row.provider,
        title: "Activation attempt",
        detail: `Attempt ${row.attempt} for order ${row.orderId}`,
        statusLabel: row.status,
        createdAt: row.createdAt,
        error: sanitizeLogText(row.errorCode),
        requestBody: sanitizeOperationsLog(row.requestSnapshot),
        responseBody: sanitizeOperationsLog(row.responseSnapshot),
      })),
      ...provisioningOperationRows.map((row) => ({
        group: "orders" as const,
        id: `operation-${row.id}`,
        identifier: "Transatel",
        title: "eSIM activation",
        detail: `Order ${row.order.orderNumber}`,
        statusLabel: row.state,
        createdAt: row.updatedAt,
        error: row.lastErrorCategory
          ? sanitizeLogText(
              `${row.lastErrorCategory}: ${row.lastErrorMessage ?? ""}`,
            )
          : null,
        requestBody: sanitizeOperationsLog(row.requestSnapshot),
        responseBody: sanitizeOperationsLog(row.responseSnapshot),
      })),
      ...auditRows
        .filter(
          (row) =>
            group === "all" ||
            (group === "orders"
              ? isOrderModule(row.module)
              : !isOrderModule(row.module)),
        )
        .map((row) => ({
          group: isOrderModule(row.module) ? "orders" : "staff",
          id: row.id,
          identifier: row.module,
          title: row.action,
          detail: `${row.entity} ${row.entityId}${row.performedById ? ` by staff ${row.performedById}` : row.performedBy?.email ? ` by ${sanitizeLogText(row.performedBy.email)}` : ""}`,
          statusLabel: "RECORDED",
          createdAt: row.createdAt,
          requestBody: sanitizeOperationsLog(row.previousValue),
          responseBody: sanitizeOperationsLog(row.newValue),
        })),
    ]
      .filter((row) =>
        matches(
          row.identifier,
          row.title,
          row.detail,
          "correlationId" in row && typeof row.correlationId === "string"
            ? row.correlationId
            : null,
        ),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const total =
      integrationTotal +
      webhookTotal +
      auditTotal +
      orderTotal +
      provisioningAttemptTotal +
      provisioningOperationTotal;
    return {
      items: items.slice((page - 1) * pageSize, page * pageSize),
      total: normalizedQuery ? items.length : total,
      page,
      pageSize,
    };
  }
}

@Controller("operations/provisioning-operations")
@UseGuards(AuthGuard, AccountGuard)
@AccountTypes(UserRoleName.OPERATIONS, UserRoleName.SUPER_ADMIN)
export class OperationsProvisioningOperationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciliation: ReconciliationService,
  ) {}
  @Get() async list(
    @Req() request: AuthenticatedRequest,
    @Query("state") state?: string,
  ) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    if (!this.prisma.enabled) return [];
    const allowed = [
      "CREATED",
      "SUBMITTING",
      "ACCEPTED",
      "WAITING_FOR_QR",
      "QR_READY",
      "ACTIVATED",
      "RECONCILE_REQUIRED",
      "REJECTED",
      "MANUAL_REVIEW",
      "CANCELLED",
    ];
    const selected =
      state && allowed.includes(state) ? (state as never) : undefined;
    const pendingStates: ProvisioningOperationState[] = [
      ProvisioningOperationState.CREATED,
      ProvisioningOperationState.SUBMITTING,
      ProvisioningOperationState.ACCEPTED,
      ProvisioningOperationState.WAITING_FOR_QR,
      ProvisioningOperationState.RECONCILE_REQUIRED,
      ProvisioningOperationState.MANUAL_REVIEW,
      ProvisioningOperationState.REJECTED,
    ];
    return this.prisma.provisioningOperation.findMany({
      where: selected ? { state: selected } : { state: { in: pendingStates } },
      select: {
        id: true,
        orderId: true,
        provider: true,
        state: true,
        idempotencyKey: true,
        iccid: true,
        providerProductId: true,
        providerOrderId: true,
        providerSubscriptionId: true,
        attemptCount: true,
        lastErrorCategory: true,
        lastErrorMessage: true,
        submittedAt: true,
        acceptedAt: true,
        nextReconcileAt: true,
        reconcileDeadlineAt: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
        order: { select: { orderNumber: true, status: true, orderType: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
  }
  @Post(":id/reconcile") async reconcile(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.reconciliation.reconcileProvisioningOperationNow(id);
  }
}
