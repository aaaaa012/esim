import { lastValueFrom, of, throwError } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import {
  isSensitivePartnerLogKey,
  PartnerApiLoggingInterceptor,
} from "./partner-api-logging.interceptor.js";

describe("partner API log redaction", () => {
  it("recognizes camelCase and separator variants of secret and personal fields", () => {
    for (const key of [
      "clientSecret",
      "webhook-secret",
      "guestAccessToken",
      "apiKeyValue",
      "passportNumber",
      "qrPayload",
      "recoveryURL",
    ])
      expect(isSensitivePartnerLogKey(key), key).toBe(true);
    expect(isSensitivePartnerLogKey("orderStatus")).toBe(false);
  });
});

describe("durable partner mutation audit", () => {
  function setup() {
    const create = vi.fn().mockResolvedValue({ id: "audit-1" });
    const update = vi.fn().mockResolvedValue({ id: "audit-1" });
    const prisma = {
      enabled: true,
      partnerApiAudit: { create, update },
    };
    const request = {
      method: "POST",
      url: "/api/v1/partner/orders",
      headers: { "idempotency-key": "key" },
      body: { externalOrderId: "external-1", passportNumber: "secret" },
      correlationId: "correlation-1",
      partner: { id: "partner-1", code: "P1", credentialId: "credential-1" },
    };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ statusCode: 201 }),
      }),
    };
    return {
      create,
      update,
      interceptor: new PartnerApiLoggingInterceptor(prisma as never),
      context,
    };
  }

  it("persists STARTED before executing and SUCCEEDED after completion", async () => {
    const { interceptor, context, create, update } = setup();
    await expect(
      lastValueFrom(
        interceptor.intercept(context as never, {
          handle: () => of({ id: "order-1" }),
        }),
      ),
    ).resolves.toEqual({ id: "order-1" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          partnerId: "partner-1",
          requestMeta: {
            contentPresent: true,
            idempotencyKeyPresent: true,
          },
        }),
      }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SUCCEEDED" }),
      }),
    );
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0]!,
    );
  });

  it("durably marks a failed mutation and rethrows the original error", async () => {
    const { interceptor, context, update } = setup();
    const failure = Object.assign(new Error("conflict"), { code: "CONFLICT" });
    await expect(
      lastValueFrom(
        interceptor.intercept(context as never, {
          handle: () => throwError(() => failure),
        }),
      ),
    ).rejects.toBe(failure);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED" }),
      }),
    );
  });

  it("does not turn a committed mutation into a client failure when audit finalization is delayed", async () => {
    const { interceptor, context, update } = setup();
    update.mockRejectedValue(new Error("audit database timeout"));
    await expect(
      lastValueFrom(
        interceptor.intercept(context as never, {
          handle: () => of({ id: "order-1" }),
        }),
      ),
    ).resolves.toEqual({ id: "order-1" });
  });
});
