import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { PaymentStatus } from "@visa-compass/shared";
import { FonepayGateway } from "./fonepay.gateway.js";
import type { PrismaService } from "../../../infrastructure/prisma.service.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("FonepayGateway", () => {
  const fileKeyPath = `/tmp/fonepay-gateway-${process.pid}.pem`;
  beforeEach(() => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.FONEPAY_ENABLED = "true";
    process.env.FONEPAY_BASE_URL = "https://fonepay.example";
    process.env.FONEPAY_USERNAME = "merchant";
    process.env.FONEPAY_PASSWORD = "secret";
    process.env.FONEPAY_TERMINAL_ID = "VC-TERMINAL";
    process.env.FONEPAY_PRIVATE_KEY_BASE64 = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const key of Object.keys(process.env))
      if (key.startsWith("FONEPAY_")) delete process.env[key];
    rmSync(fileKeyPath, { force: true });
  });

  it("creates a unique attempt reference and validates the returned PRN", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ accessToken: "token" }))
      .mockResolvedValueOnce(
        json({
          bankDetails: [
            {
              bankName: "Example Bank",
              bankCode: "EX",
              intentScheme: "examplebank://",
            },
          ],
        }),
      )
      .mockImplementationOnce(async (_url, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return json({
          prn: body.referenceLabel,
          status: "Success",
          qrMessage: "fonepay-qr-payload",
          websocketId: "wss://fonepay.example/status/1",
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new FonepayGateway().initiate({
      attemptId: "0b55e4c7-fresh-attempt",
      orderId: "order-1",
      orderNumber: "VC-100",
      amountNpr: 2499,
      returnUrl: "https://checkout.example/return",
    });

    expect(result.reference).toBe("VC0b55e4c7freshattempt");
    expect(result.qrPayload).toBe("fonepay-qr-payload");
    expect(result.websocketUrl).toBe("wss://fonepay.example/status/1");
    expect(result.banks).toHaveLength(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://fonepay.example/api/merchant/third-party/v2/login",
    );
    const bankHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    const qrHeaders = new Headers(fetchMock.mock.calls[2]?.[1]?.headers);
    expect(bankHeaders.get("signature")).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(qrHeaders.get("signature")).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it("keeps scan payment available without exposing qrString as a bank-app payload", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ accessToken: "token" }))
      .mockResolvedValueOnce(json({ bankDetails: [] }))
      .mockImplementationOnce(async (_url, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return json({
          prn: body.referenceLabel,
          status: "Success",
          qrString: "scan-only-payload",
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new FonepayGateway().initiate({
      attemptId: "scan-only-attempt",
      orderId: "order-scan-only",
      orderNumber: "VC-101",
      amountNpr: 570,
      returnUrl: "https://checkout.example/return",
    });

    expect(result.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.qrPayload).toBeUndefined();
  });

  it("rejects QR amounts outside the provider contract before any API call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new FonepayGateway();

    await expect(
      gateway.initiate({
        attemptId: "attempt-low",
        orderId: "order-1",
        orderNumber: "VC-100",
        amountNpr: 0,
        returnUrl: "https://checkout.example/return",
      }),
    ).rejects.toMatchObject({ response: expect.anything() });
    await expect(
      gateway.initiate({
        attemptId: "attempt-high",
        orderId: "order-2",
        orderNumber: "VC-101",
        amountNpr: 10_000_000,
        returnUrl: "https://checkout.example/return",
      }),
    ).rejects.toMatchObject({ response: expect.anything() });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a PKCS8 PEM wrapped in base64", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.FONEPAY_PRIVATE_KEY_BASE64 = Buffer.from(
      privateKey.export({ type: "pkcs8", format: "pem" }),
    ).toString("base64");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ accessToken: "token" }))
      .mockResolvedValueOnce(
        json({
          prn: "VCREF",
          merchantCode: "VC-TERMINAL",
          paymentStatus: "pending",
          requestedAmount: 2499,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new FonepayGateway().verify("VCREF", {
        orderId: "order-1",
        amountNpr: 2499,
      }),
    ).resolves.toMatchObject({ status: PaymentStatus.PENDING });
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("signature"),
    ).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it("signs requests with a PKCS8 PEM loaded from a file", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(
      fileKeyPath,
      privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );
    process.env.FONEPAY_PRIVATE_KEY_PATH = fileKeyPath;
    delete process.env.FONEPAY_PRIVATE_KEY_BASE64;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ accessToken: "token" }))
      .mockResolvedValueOnce(
        json({
          prn: "VCREF",
          merchantCode: "VC-TERMINAL",
          paymentStatus: "pending",
          requestedAmount: 2499,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new FonepayGateway().verify("VCREF", {
        orderId: "order-1",
        amountNpr: 2499,
      }),
    ).resolves.toMatchObject({ status: PaymentStatus.PENDING });
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("signature"),
    ).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it("reports an invalid signing key before making a network request", async () => {
    process.env.FONEPAY_PRIVATE_KEY_BASE64 = "not-a-private-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new FonepayGateway().verify("VCREF", {
        orderId: "order-1",
        amountNpr: 2499,
      }),
    ).rejects.toMatchObject({
      internalDetail: "Fonepay private key is invalid or unreadable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unsuccessful QR-generation response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ accessToken: "token" }))
        .mockResolvedValueOnce(json({ bankDetails: [] }))
        .mockResolvedValueOnce(
          json({
            prn: "VCattempt",
            status: "Failed",
            qrMessage: "not-authoritative",
          }),
        ),
    );

    await expect(
      new FonepayGateway().initiate({
        attemptId: "attempt",
        orderId: "order-1",
        orderNumber: "VC-100",
        amountNpr: 100,
        returnUrl: "https://checkout.example/return",
      }),
    ).rejects.toMatchObject({ response: expect.anything() });
  });

  it("refreshes authentication according to Fonepay expiresIn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T00:00:00Z"));
    const status = {
      prn: "VCREF",
      merchantCode: "VC-TERMINAL",
      paymentStatus: "pending",
      requestedAmount: 2499,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ accessToken: "token-1", expiresIn: 60 }))
      .mockResolvedValueOnce(json(status))
      .mockResolvedValueOnce(json({ accessToken: "token-2", expiresIn: 3600 }))
      .mockResolvedValueOnce(json(status));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new FonepayGateway();

    await gateway.verify("VCREF", { orderId: "order-1", amountNpr: 2499 });
    vi.advanceTimersByTime(31_000);
    await gateway.verify("VCREF", { orderId: "order-1", amountNpr: 2499 });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[3]?.[1]?.headers.Authorization)).toBe(
      "Bearer token-2",
    );
  });

  it("uses requestedAmount and rejects an unknown provider status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ accessToken: "token" }))
      .mockResolvedValueOnce(
        json({
          prn: "VCREF",
          merchantCode: "VC-TERMINAL",
          paymentStatus: "success",
          requestedAmount: "2499",
          totalTransactionAmount: "2524",
          fonepayTraceId: "trace-1",
        }),
      )
      .mockResolvedValueOnce(
        json({
          prn: "VCREF",
          merchantCode: "VC-TERMINAL",
          paymentStatus: "mystery",
          requestedAmount: 2499,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new FonepayGateway();
    await expect(
      gateway.verify("VCREF", { orderId: "order-1", amountNpr: 2499 }),
    ).resolves.toMatchObject({
      status: PaymentStatus.COMPLETED,
      amountNpr: 2499,
      providerTransactionId: "trace-1",
    });
    await expect(
      gateway.verify("VCREF", { orderId: "order-1", amountNpr: 2499 }),
    ).rejects.toMatchObject({ response: expect.anything() });
  });

  it("rejects a merchant or reference mismatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ accessToken: "token" }))
        .mockResolvedValueOnce(
          json({
            prn: "OTHER",
            merchantCode: "VC-TERMINAL",
            paymentStatus: "pending",
            requestedAmount: 2499,
          }),
        ),
    );
    await expect(
      new FonepayGateway().verify("VCREF", {
        orderId: "order-1",
        amountNpr: 2499,
      }),
    ).rejects.toMatchObject({ response: expect.anything() });
  });

  it("treats Fonepay timeout as pending until the local QR window expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T06:00:00Z"));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ accessToken: "token" }))
        .mockResolvedValueOnce(
          json({
            prn: "VCREF",
            merchantCode: "VC-TERMINAL",
            paymentStatus: "timeout",
            paymentMessage: "Data not found.",
            requestedAmount: 2499,
          }),
        )
        .mockResolvedValueOnce(
          json({
            prn: "VCREF",
            merchantCode: "VC-TERMINAL",
            paymentStatus: "timeout",
            paymentMessage: "Data not found.",
            requestedAmount: 2499,
          }),
        ),
    );
    const gateway = new FonepayGateway();

    await expect(
      gateway.verify("VCREF", {
        orderId: "order-1",
        amountNpr: 2499,
        expiresAt: "2026-09-12T06:30:00Z",
      }),
    ).resolves.toMatchObject({ status: PaymentStatus.PENDING });
    await expect(
      gateway.verify("VCREF", {
        orderId: "order-1",
        amountNpr: 2499,
        expiresAt: "2026-09-12T05:59:59Z",
      }),
    ).resolves.toMatchObject({ status: PaymentStatus.FAILED });
  });

  it("honors a gateway-specific API base path (V1.10 vs collection gateways)", async () => {
    process.env.FONEPAY_API_BASE_PATH =
      "/api/merchant/merchantDetailsForThirdParty/v2";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ accessToken: "token" }))
      .mockResolvedValueOnce(
        json({
          prn: "VCREF",
          merchantCode: "VC-TERMINAL",
          paymentStatus: "pending",
          requestedAmount: 2499,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await new FonepayGateway().verify("VCREF", {
      orderId: "order-1",
      amountNpr: 2499,
    });

    expect(String(fetchMock?.mock.calls[1]?.[0])).toBe(
      "https://fonepay.example/api/merchant/merchantDetailsForThirdParty/v2/thirdPartyDynamicQrGetStatus",
    );
  });

  it("rejects a terminalId longer than the V1.10 16-character contract", async () => {
    process.env.FONEPAY_TERMINAL_ID = "TERMINAL-1234567890";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new FonepayGateway().initiate({
        attemptId: "attempt-terminal",
        orderId: "order-1",
        orderNumber: "VC-100",
        amountNpr: 100,
        returnUrl: "https://checkout.example/return",
      }),
    ).rejects.toMatchObject({
      internalDetail:
        "Fonepay terminalId is missing or exceeds 16 characters (V1.10 contract)",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records redacted provider calls with the order correlation", async () => {
    const create = vi.fn().mockResolvedValue({});
    const prisma = {
      enabled: true,
      integrationLog: { create },
    } as unknown as PrismaService;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ accessToken: "private-token" }))
        .mockResolvedValueOnce(
          json({
            prn: "VCREF",
            merchantCode: "VC-TERMINAL",
            paymentStatus: "pending",
            requestedAmount: 2499,
          }),
        ),
    );

    await new FonepayGateway(prisma).verify("VCREF", {
      orderId: "order-1",
      amountNpr: 2499,
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "fonepay-thirdPartyDynamicQrGetStatus",
        correlationId: "order-1",
        endpoint: "/api/merchant/third-party/v2/thirdPartyDynamicQrGetStatus",
      }),
    });
    expect(JSON.stringify(create.mock.calls)).not.toContain("private-token");
  });
});
