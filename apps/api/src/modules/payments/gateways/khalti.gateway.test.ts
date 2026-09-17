import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../../../infrastructure/prisma.service.js";
import { KhaltiGateway } from "./khalti.gateway.js";

describe("KhaltiGateway diagnostics", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.KHALTI_SECRET_KEY;
  const originalBase = process.env.KHALTI_BASE_URL;

  beforeAll(() => {
    process.env.LOG_REDACTION = "true";
  });

  afterAll(() => {
    delete process.env.LOG_REDACTION;
  });

  function prismaWithLog(create = vi.fn().mockResolvedValue({})) {
    return {
      prisma: {
        enabled: true,
        integrationLog: { create },
      } as unknown as PrismaService,
      create,
    };
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.KHALTI_SECRET_KEY;
    else process.env.KHALTI_SECRET_KEY = originalKey;
    if (originalBase === undefined) delete process.env.KHALTI_BASE_URL;
    else process.env.KHALTI_BASE_URL = originalBase;
    vi.restoreAllMocks();
  });

  it("treats an authenticated validation response as healthy", async () => {
    process.env.KHALTI_SECRET_KEY = "sandbox-secret";
    process.env.KHALTI_BASE_URL = "https://dev.khalti.com/api/v2";
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            detail: "Not found.",
            error_key: "validation_error",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      );

    await expect(new KhaltiGateway().diagnose()).resolves.toMatchObject({
      healthy: true,
      environment: "sandbox",
      providerStatus: 400,
    });
  });

  it("rejects an invalid credential response", async () => {
    process.env.KHALTI_SECRET_KEY = "wrong-secret";
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ detail: "Invalid token.", status_code: 401 }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
      );

    await expect(new KhaltiGateway().diagnose()).rejects.toMatchObject({
      response: expect.objectContaining({ code: "PAYMENT_PROVIDER_ERROR" }),
    });
  });

  it("records redacted request and response bodies for provider calls", async () => {
    process.env.KHALTI_SECRET_KEY = "sandbox-secret";
    const { prisma, create } = prismaWithLog();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ status: "Completed", payment_url: "https://pay.example/private" }),
        { status: 200 },
      ),
    );

    await new KhaltiGateway(prisma).diagnose();

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "khalti-diagnostic",
        method: "POST",
        endpoint: "/api/v2/epayment/lookup/",
        status: 200,
        durationMs: expect.any(Number),
      }),
    });
    const data = create.mock.calls[0]?.[0]?.data;
    expect(data).toMatchObject({
      requestBody: { pidx: expect.stringContaining("visa-compass-health-") },
      responseBody: { status: "Completed", payment_url: "[REDACTED]" },
    });
    expect(JSON.stringify(data)).not.toContain("sandbox-secret");
    expect(String(data?.endpoint)).not.toContain("?");
  });

  it("holds an unknown Khalti lookup status instead of falsely failing it", async () => {
    process.env.KHALTI_SECRET_KEY = "sandbox-secret";
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ status: "Under Review", total_amount: 12500 }),
        { status: 200 },
      ),
    );

    await expect(
      new KhaltiGateway().verify("pidx-1", {
        orderId: "order-1",
        amountNpr: 125,
      }),
    ).resolves.toMatchObject({ status: "PENDING", amountNpr: 125 });
  });

  it("correlates payment lookups with the local order", async () => {
    process.env.KHALTI_SECRET_KEY = "sandbox-secret";
    const { prisma, create } = prismaWithLog();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "Pending", total_amount: 12500 }), {
        status: 200,
      }),
    );

    await new KhaltiGateway(prisma).verify("pidx-1", {
      orderId: "order-1",
      amountNpr: 125,
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "khalti-lookup",
        correlationId: "order-1",
      }),
    });
  });

  it("records provider HTTP failures", async () => {
    process.env.KHALTI_SECRET_KEY = "wrong-secret";
    const { prisma, create } = prismaWithLog();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "Invalid token." }), {
        status: 401,
      }),
    );

    await expect(new KhaltiGateway(prisma).diagnose()).rejects.toMatchObject({
      response: expect.objectContaining({ code: "PAYMENT_PROVIDER_ERROR" }),
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "khalti-diagnostic",
        status: 401,
        errorCode: "HTTP_401",
      }),
    });
  });

  it("records network failures", async () => {
    process.env.KHALTI_SECRET_KEY = "sandbox-secret";
    const { prisma, create } = prismaWithLog();
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("connection reset"));

    await expect(new KhaltiGateway(prisma).diagnose()).rejects.toMatchObject({
      response: expect.objectContaining({ code: "PAYMENT_PROVIDER_ERROR" }),
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "khalti-diagnostic",
        status: 0,
        errorCode: "NETWORK_ERROR",
        errorMessage: "connection reset",
      }),
    });
  });

  it("does not fail a provider request when log persistence fails", async () => {
    process.env.KHALTI_SECRET_KEY = "sandbox-secret";
    const { prisma } = prismaWithLog(
      vi.fn().mockRejectedValue(new Error("database unavailable")),
    );
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "Not found." }), { status: 400 }),
    );

    await expect(new KhaltiGateway(prisma).diagnose()).resolves.toMatchObject({
      healthy: true,
      providerStatus: 400,
    });
  });
});
