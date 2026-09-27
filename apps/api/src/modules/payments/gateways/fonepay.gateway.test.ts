import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
  beforeAll(() => {
    process.env.LOG_REDACTION = "true";
  });
  afterAll(() => {
    delete process.env.LOG_REDACTION;
  });
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

  it("normalizes allowed intentScheme shapes and drops unsafe directory entries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ accessToken: "token" }))
      .mockResolvedValueOnce(
        json({
          bankDetails: [
            { bankName: "Bare Bank", bankCode: "BB", intentScheme: "barebank" },
            {
              bankName: "Slash Bank",
              bankCode: "SB",
              intentScheme: "slashbank://",
            },
            {
              bankName: "Path Bank",
              bankCode: "PB",
              intentScheme: "pathbank://payment",
            },
            {
              bankName: "Exec Bank",
              bankCode: "XB",
              intentScheme: "javascript:alert",
            },
            {
              bankName: "Host Bank",
              bankCode: "XH",
              intentScheme: "safe://attacker.example",
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
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new FonepayGateway().initiate({
      attemptId: "scheme-forms-attempt",
      orderId: "order-scheme-forms",
      orderNumber: "VC-102",
      amountNpr: 100,
      returnUrl: "https://checkout.example/return",
    });

    expect(result.banks).toEqual([
      { bankName: "Bare Bank", bankCode: "BB", intentScheme: "barebank" },
      { bankName: "Slash Bank", bankCode: "SB", intentScheme: "slashbank" },
      { bankName: "Path Bank", bankCode: "PB", intentScheme: "pathbank" },
    ]);
  });

  it("falls back to the cached directory, normalized, when the live fetch fails", async () => {
    const prisma = {
      enabled: true,
      integrationLog: { create: vi.fn().mockResolvedValue({}) },
      fonepayBankDirectoryEntry: {
        findMany: vi.fn().mockResolvedValue([
          {
            bankName: "Cached Bank",
            bankCode: "CB",
            intentScheme: "cachedbank://payment",
            active: true,
          },
        ]),
      },
      fonepayBankDirectorySync: {
        findFirst: vi.fn().mockResolvedValue({
          status: "SUCCEEDED",
          completedAt: new Date(),
        }),
      },
    } as unknown as PrismaService;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ accessToken: "token" }))
      .mockRejectedValueOnce(new Error("network partitioned"))
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return json({
          prn: body.referenceLabel,
          status: "Success",
          qrMessage: "fonepay-qr-payload",
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new FonepayGateway(prisma).initiate({
      attemptId: "cached-scheme-attempt",
      orderId: "order-cached-scheme",
      orderNumber: "VC-104",
      amountNpr: 100,
      returnUrl: "https://checkout.example/return",
    });

    expect(result.banks).toEqual([
      { bankName: "Cached Bank", bankCode: "CB", intentScheme: "cachedbank" },
    ]);
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

  it("records non-reusable QR fingerprints and safe socket metadata", async () => {
    const create = vi.fn().mockResolvedValue({});
    const prisma = {
      enabled: true,
      integrationLog: { create },
      fonepayBankDirectoryEntry: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      fonepayBankDirectorySync: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "sync-1" }),
        update: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn(async (work: (tx: unknown) => unknown) =>
        work({
          fonepayBankDirectoryEntry: {
            findMany: vi.fn().mockResolvedValue([]),
            upsert: vi.fn(),
            updateMany: vi.fn(),
          },
        }),
      ),
    } as unknown as PrismaService;
    const payload = "fonepay-sensitive-payment-payload";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ accessToken: "token" }))
      .mockResolvedValueOnce(json({ bankDetails: [] }))
      .mockImplementationOnce(async (_url, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return json({
          prn: body.referenceLabel,
          status: "Success",
          qrString: payload,
          qrMessage: payload,
          websocketId: "wss://socket.fonepay.example/private/session-token",
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    await new FonepayGateway(prisma).initiate({
      attemptId: "telemetry-attempt",
      orderId: "order-telemetry",
      orderNumber: "VC-102",
      amountNpr: 815,
      returnUrl: "https://checkout.example/return",
    });

    const qrLog = create.mock.calls
      .map(([call]) => call.data)
      .find((entry) => entry.operation === "fonepay-generate-intent-qr");
    const serialized = JSON.stringify(qrLog);
    expect(qrLog.responseBody.qrString).toMatch(
      /^\[REDACTED length=\d+ sha256=[a-f0-9]{16}\]$/,
    );
    expect(qrLog.responseBody.qrMessage).toBe(qrLog.responseBody.qrString);
    expect(qrLog.responseBody.websocketId).toBe(
      "[REDACTED protocol=wss host=socket.fonepay.example]",
    );
    expect(serialized).not.toContain(payload);
    expect(serialized).not.toContain("private/session-token");
  });

  it("logs the exact bank-list request headers including paymentMode INTENT", async () => {
    const create = vi.fn().mockResolvedValue({});
    const prisma = {
      enabled: true,
      integrationLog: { create },
      fonepayBankDirectoryEntry: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      fonepayBankDirectorySync: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    } as unknown as PrismaService;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ accessToken: "directory-token" }))
        .mockResolvedValueOnce(
          json({
            bankDetails: [
              {
                bankName: "Test Bank",
                bankCode: "TSTBNPKA",
                intentScheme: "tstbank://pay",
              },
            ],
          }),
        )
        .mockImplementationOnce(async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body));
          return json({
            prn: body.referenceLabel,
            status: "Success",
            qrString: "scan-payload",
          });
        }),
    );

    await new FonepayGateway(prisma).initiate({
      attemptId: "banks-logging-attempt",
      orderId: "order-banks",
      orderNumber: "VC-103",
      amountNpr: 815,
      returnUrl: "https://checkout.example/return",
    });

    const banksLog = create.mock.calls
      .map(([call]) => call.data)
      .find((entry) => entry.operation === "fonepay-list");
    expect(banksLog).toMatchObject({
      method: "GET",
      endpoint: expect.stringContaining("/banks/list"),
      requestHeaders: { paymentMode: "INTENT" },
    });
    // Never log the bearer token or the request signature.
    const serialized = JSON.stringify(banksLog);
    expect(serialized).not.toContain("directory-token");
    expect(serialized).not.toContain("signature");
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

  it("reauthenticates and replays exactly once when Fonepay invalidates a token early", async () => {
    const status = {
      prn: "VCREF",
      merchantCode: "VC-TERMINAL",
      paymentStatus: "pending",
      requestedAmount: 2499,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({ accessToken: "Bearer stale-token", expiresIn: 3600 }),
      )
      .mockResolvedValueOnce(
        json(
          {
            status: 401,
            error: "Unauthorized",
            message: "Full authentication is required",
          },
          401,
        ),
      )
      .mockResolvedValueOnce(
        json({ accessToken: "Bearer fresh-token", expiresIn: 3600 }),
      )
      .mockResolvedValueOnce(json(status));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new FonepayGateway().verify("VCREF", {
        orderId: "order-1",
        amountNpr: 2499,
      }),
    ).resolves.toMatchObject({ status: PaymentStatus.PENDING });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[1]?.[1]?.headers.Authorization)).toBe(
      "Bearer stale-token",
    );
    expect(String(fetchMock.mock.calls[3]?.[1]?.headers.Authorization)).toBe(
      "Bearer fresh-token",
    );
  });

  it("stops after one replay when the refreshed Fonepay token is also rejected", async () => {
    const unauthorized = () =>
      json({ status: 401, error: "Unauthorized" }, 401);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ accessToken: "token-1", expiresIn: 3600 }))
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(json({ accessToken: "token-2", expiresIn: 3600 }))
      .mockResolvedValueOnce(unauthorized());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new FonepayGateway().verify("VCREF", {
        orderId: "order-1",
        amountNpr: 2499,
      }),
    ).rejects.toMatchObject({ response: expect.anything() });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not replay the provider request when reauthentication fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ accessToken: "token-1", expiresIn: 3600 }))
      .mockResolvedValueOnce(json({ error: "Unauthorized" }, 401))
      .mockResolvedValueOnce(json({ error: "Invalid credentials" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new FonepayGateway().verify("VCREF", {
        orderId: "order-1",
        amountNpr: 2499,
      }),
    ).rejects.toMatchObject({ response: expect.anything() });
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
          totalTransactionAmount: "2499",
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
            totalTransactionAmount: null,
            fonepayTraceId: null,
          }),
        )
        .mockResolvedValueOnce(
          json({
            prn: "VCREF",
            merchantCode: "VC-TERMINAL",
            paymentStatus: "timeout",
            paymentMessage: "Data not found.",
            requestedAmount: 2499,
            totalTransactionAmount: "",
            fonepayTraceId: "",
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

  it("caps referenceLabel at 25 characters total", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ accessToken: "token" }))
      .mockResolvedValueOnce(json({ bankDetails: [] }))
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return json({
          prn: body.referenceLabel,
          status: "Success",
          qrString: "scan-payload",
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new FonepayGateway().initiate({
      attemptId: "abcdefghijklmnopqrstuvwx", // 25 alnum chars
      orderId: "order-1",
      orderNumber: "VC-100",
      amountNpr: 100,
      returnUrl: "https://checkout.example/return",
    });

    expect(result.reference).toBe("VCabcdefghijklmnopqrstuvw");
    expect(result.reference.length).toBe(25);
  });

  it("rejects success without fonepayTraceId", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ accessToken: "token" }))
        .mockResolvedValueOnce(
          json({
            prn: "VCREF",
            merchantCode: "VC-TERMINAL",
            paymentStatus: "success",
            requestedAmount: 2499,
            totalTransactionAmount: 2499,
          }),
        ),
    );

    await expect(
      new FonepayGateway().verify("VCREF", {
        orderId: "order-1",
        amountNpr: 2499,
      }),
    ).rejects.toMatchObject({
      internalDetail: expect.stringContaining("fonepayTraceId"),
    });
  });

  it("rejects success when requestedAmount does not match context", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ accessToken: "token" }))
        .mockResolvedValueOnce(
          json({
            prn: "VCREF",
            merchantCode: "VC-TERMINAL",
            paymentStatus: "success",
            requestedAmount: 3000,
            fonepayTraceId: "trace-1",
          }),
        ),
    );

    await expect(
      new FonepayGateway().verify("VCREF", {
        orderId: "order-1",
        amountNpr: 2499,
      }),
    ).rejects.toMatchObject({
      internalDetail: expect.stringContaining("does not match expected"),
    });
  });

  it("rejects success when totalTransactionAmount differs from requestedAmount", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ accessToken: "token" }))
        .mockResolvedValueOnce(
          json({
            prn: "VCREF",
            merchantCode: "VC-TERMINAL",
            paymentStatus: "success",
            requestedAmount: 2499,
            totalTransactionAmount: 2524,
            fonepayTraceId: "trace-1",
          }),
        ),
    );

    await expect(
      new FonepayGateway().verify("VCREF", {
        orderId: "order-1",
        amountNpr: 2499,
      }),
    ).rejects.toMatchObject({
      internalDetail: expect.stringContaining("differs from requestedAmount"),
    });
  });

  it("rejects a non-alphanumeric verify reference before any API call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new FonepayGateway().verify("VC-REF-!!", {
        orderId: "order-1",
        amountNpr: 2499,
      }),
    ).rejects.toMatchObject({
      internalDetail: expect.stringContaining("alphanumeric"),
    });
    await expect(
      new FonepayGateway().verify("VCREF?", {
        orderId: "order-1",
        amountNpr: 2499,
      }),
    ).rejects.toMatchObject({
      internalDetail: expect.stringContaining("alphanumeric"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not redact non-secret qr fields (qrType, qrDisplayName)", async () => {
    const create = vi.fn().mockResolvedValue({});
    const prisma = {
      enabled: true,
      integrationLog: { create },
      fonepayBankDirectoryEntry: {
        findMany: vi.fn().mockResolvedValue([
          {
            bankName: "Example Bank",
            bankCode: "EX",
            intentScheme: "examplebank://",
          },
        ]),
      },
      fonepayBankDirectorySync: {
        findFirst: vi.fn().mockResolvedValue({
          status: "SUCCEEDED",
          completedAt: new Date(),
        }),
      },
    } as unknown as PrismaService;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ accessToken: "token" }))
      .mockResolvedValueOnce(json({ bankDetails: [] }))
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return json({
          prn: body.referenceLabel,
          status: "Success",
          qrString: "sensitive-payload-data",
          qrDisplayName: "OmG",
          qrType: "INTENT_QR",
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    await new FonepayGateway(prisma).initiate({
      attemptId: "redact-test",
      orderId: "order-redact",
      orderNumber: "VC-103",
      amountNpr: 100,
      returnUrl: "https://checkout.example/return",
    });

    const qrLog = create.mock.calls
      .map((call) => call[0]?.data)
      .find((entry) => entry.operation === "fonepay-generate-intent-qr");
    const serialized = JSON.stringify(qrLog);
    expect(qrLog.responseBody.qrString).toMatch(
      /^\[REDACTED length=\d+ sha256=[a-f0-9]{16}\]$/,
    );
    expect(qrLog.responseBody.qrDisplayName).toBe("OmG");
    expect(qrLog.responseBody.qrType).toBe("INTENT_QR");
    expect(serialized).not.toContain("sensitive-payload-data");
  });
});
