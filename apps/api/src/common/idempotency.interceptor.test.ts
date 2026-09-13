import { createHash } from "node:crypto";
import { lastValueFrom, of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { IdempotencyInterceptor } from "./idempotency.interceptor.js";
import {
  openReplayResponse,
  sealReplayResponse,
} from "./idempotency.interceptor.js";

function context(
  body: unknown,
  responseStatus = 201,
  headerName: "idempotency-key" | "x-idempotency-key" = "idempotency-key",
) {
  const response = {
    statusCode: responseStatus,
    status: vi.fn(),
    setHeader: vi.fn(),
  };
  return {
    value: {
      switchToHttp: () => ({
        getRequest: () => ({
          method: "POST",
          path: "/api/v1/customer/orders/11111111-1111-4111-8111-111111111111/pay",
          body,
          headers: { [headerName]: "retry-key-123" },
          user: { id: "customer-1" },
        }),
        getResponse: () => response,
      }),
    } as never,
    response,
  };
}

describe("IdempotencyInterceptor", () => {
  it("encrypts guest bearer material in persisted replay payloads", () => {
    process.env.GUEST_ORDER_SECRET = "a-production-length-guest-secret-value";
    const sealed = sealReplayResponse({
      order: { id: "one" },
      token: "bearer-secret",
    });
    expect(JSON.stringify(sealed)).not.toContain("bearer-secret");
    expect(openReplayResponse(sealed)).toEqual({
      order: { id: "one" },
      token: "bearer-secret",
    });
    delete process.env.GUEST_ORDER_SECRET;
  });
  it("accepts the documented Idempotency-Key header", async () => {
    const prisma = {
      enabled: true,
      apiIdempotencyRecord: {
        create: vi.fn().mockResolvedValue({ id: "claim-1" }),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn(),
      },
    };
    const interceptor = new IdempotencyInterceptor(prisma as never);
    const ctx = context({ order: "one" });
    await expect(
      lastValueFrom(
        interceptor.intercept(ctx.value, {
          handle: () => of({ ok: true }),
        }),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("keeps x-idempotency-key as a compatibility alias", async () => {
    const prisma = {
      enabled: true,
      apiIdempotencyRecord: {
        create: vi.fn().mockResolvedValue({ id: "claim-1" }),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn(),
      },
    };
    const interceptor = new IdempotencyInterceptor(prisma as never);
    const ctx = context({ order: "one" }, 201, "x-idempotency-key");
    await expect(
      lastValueFrom(
        interceptor.intercept(ctx.value, {
          handle: () => of({ ok: true }),
        }),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("persists completion before releasing a successful response", async () => {
    const prisma = {
      enabled: true,
      apiIdempotencyRecord: {
        create: vi.fn().mockResolvedValue({ id: "claim-1" }),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn(),
      },
    };
    const interceptor = new IdempotencyInterceptor(prisma as never);
    const ctx = context({ b: 2, a: 1 });
    await expect(
      lastValueFrom(
        interceptor.intercept(ctx.value, { handle: () => of({ ok: true }) }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(prisma.apiIdempotencyRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "claim-1" },
        data: expect.objectContaining({
          status: "COMPLETED",
          responseStatus: 201,
        }),
      }),
    );
  });

  it("replays a completed response for canonically equivalent JSON", async () => {
    const requestHash = createHash("sha256")
      .update('{"a":1,"b":2}')
      .digest("hex");
    const prisma = {
      enabled: true,
      apiIdempotencyRecord: {
        create: vi.fn().mockRejectedValue({ code: "P2002" }),
        findUnique: vi.fn().mockResolvedValue({
          requestHash,
          status: "COMPLETED",
          response: { reference: "pidx-1" },
          responseStatus: 201,
        }),
      },
    };
    const interceptor = new IdempotencyInterceptor(prisma as never);
    const ctx = context({ b: 2, a: 1 });
    const handler = { handle: vi.fn() };
    await expect(
      lastValueFrom(interceptor.intercept(ctx.value, handler)),
    ).resolves.toEqual({
      reference: "pidx-1",
    });
    expect(handler.handle).not.toHaveBeenCalled();
    expect(ctx.response.status).toHaveBeenCalledWith(201);
    expect(ctx.response.setHeader).toHaveBeenCalledWith(
      "Idempotency-Replayed",
      "true",
    );
  });

  it("does not mark the original response as a replay", async () => {
    const prisma = {
      enabled: true,
      apiIdempotencyRecord: {
        create: vi.fn().mockResolvedValue({ id: "claim-1" }),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn(),
      },
    };
    const interceptor = new IdempotencyInterceptor(prisma as never);
    const ctx = context({ order: "one" });
    await lastValueFrom(
      interceptor.intercept(ctx.value, { handle: () => of({ ok: true }) }),
    );
    expect(ctx.response.setHeader).not.toHaveBeenCalled();
  });

  it("marks a claim failed when completion cannot be persisted", async () => {
    const prisma = {
      enabled: true,
      apiIdempotencyRecord: {
        create: vi.fn().mockResolvedValue({ id: "claim-1" }),
        update: vi.fn().mockRejectedValue(new Error("database unavailable")),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const interceptor = new IdempotencyInterceptor(prisma as never);
    const ctx = context({ a: 1 });
    await expect(
      lastValueFrom(
        interceptor.intercept(ctx.value, { handle: () => of({ ok: true }) }),
      ),
    ).rejects.toThrow("database unavailable");
    expect(prisma.apiIdempotencyRecord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED" }),
      }),
    );
  });
});
