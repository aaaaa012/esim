import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransatelProvider } from "./transatel.provider.js";
import type { PrismaService } from "../../infrastructure/prisma.service.js";
import { ApiException } from "../../common/api-error.js";
import { ApiErrorCode } from "@visa-compass/shared";

type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as Response;
}

function prismaStub(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    plan: { findUnique: vi.fn() },
    esimInventory: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    subscription: { findUnique: vi.fn() },
    customerEsim: { findUnique: vi.fn() },
    order: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    integrationLog: { create: vi.fn() },
    provisioningOperation: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ state: "CREATED" }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(async (operations: Promise<unknown>[]) =>
      Promise.all(operations),
    ),
    ...overrides,
  } as unknown as PrismaService;
}

const traveler = {
  firstName: "Jane",
  surname: "Doe",
  email: "jane@example.com",
  mobile: "9779800000000",
  city: "Kathmandu",
  countryOfResidence: "NP",
};
const ORDER_UUID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

describe("TransatelProvider", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.TRANSATEL_BASE_URL = "https://api.transatel.com";
    process.env.TRANSATEL_CLIENT_ID = "test-client";
    process.env.TRANSATEL_CLIENT_SECRET = "test-secret";
    process.env.TRANSATEL_MVNO_REF = "visacompass-test";
    process.env.TRANSATEL_COS = "WW_COS_TEST";
    process.env.TRANSATEL_FX_TO_NPR = "170";
    delete process.env.TRANSATEL_WEBHOOK_TARGET_URL;
    delete process.env.TRANSATEL_WEBHOOK_SECRET;
  });
  afterEach(() => {
    delete process.env.TRANSATEL_BASE_URL;
    delete process.env.TRANSATEL_CLIENT_ID;
    delete process.env.TRANSATEL_CLIENT_SECRET;
    delete process.env.TRANSATEL_MVNO_REF;
    delete process.env.TRANSATEL_COS;
    delete process.env.TRANSATEL_FX_TO_NPR;
  });

  function route(routes: Record<string, (init?: FetchInit) => Response>) {
    fetchMock.mockImplementation((url: string, init?: FetchInit) => {
      const handler = Object.entries(routes).find(([path]) =>
        String(url).includes(path),
      )?.[1];
      if (!handler) throw new Error(`No mock route for ${url}`);
      return Promise.resolve(handler(init));
    });
  }

  it("exchanges client credentials for a bearer token and caches it", async () => {
    const provider = new TransatelProvider(prismaStub());
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
    });
    expect(await provider["getAccessToken"]()).toBe("token-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, FetchInit];
    expect(url).toBe("https://api.transatel.com/authentication/api/token");
    expect(init.method).toBe("POST");
    expect(init.headers?.["Authorization"]).toMatch(/^Basic /);
    expect(init.body).toContain("grant_type=client_credentials");
    expect(await provider["getAccessToken"]()).toBe("token-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent token refreshes into one provider request", async () => {
    const provider = new TransatelProvider(prismaStub());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementation(async () => {
      await gate;
      return jsonResponse({ access_token: "token-1", expires_in: 3600 });
    });
    const first = provider["getAccessToken"]();
    const second = provider["getAccessToken"]();
    release();
    expect(await Promise.all([first, second])).toEqual(["token-1", "token-1"]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects authentication when credentials are missing", async () => {
    delete process.env.TRANSATEL_CLIENT_SECRET;
    const provider = new TransatelProvider(prismaStub());
    const error = await provider["getAccessToken"]().catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe(
      "CONNECTIVITY_CONFIGURATION",
    );
    expect((error as { message?: string }).message).toBe(
      "Connectivity service is not fully configured.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("places an OCS preload order and returns the activation QR payload", async () => {
    const prisma = prismaStub();
    prisma.plan.findUnique = vi
      .fn()
      .mockResolvedValue({ id: "plan-1", providerPlanId: "TRVL-5GB-15D" });
    prisma.esimInventory.findFirst = vi.fn().mockResolvedValue({
      iccid: "8988247076000000319",
      msisdn: "882470001850263",
      eid: "890490320000000000000000000001",
    });
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
      "/ocs/subscriptions/api/orders/products": () =>
        jsonResponse({
          id: "ord-1",
          orderReference: "VC-REF",
          status: "done",
          submissionDate: "2026-08-04T00:00:00Z",
          bind: { msisdn: "882470001850263" },
          source: "api",
          mvnoRef: "visacompass-test",
          subscriptionId: "sub-123",
        }),
      "/sim-management/sims/api/esims/sim-serial/8988247076000000319": () =>
        jsonResponse({
          simSerial: "8988247076000000319",
          status: "downloaded",
          smdpAddress: "consumer.rsp.world",
          qrCode: {
            value: "LPA:1$consumer.rsp.world$ABC",
            dataUrl: "data:image/png;base64,xxx",
          },
        }),
    });
    const result = await provider.provision({
      orderId: "order-1",
      planId: "plan-1",
      eid: "890490320000000000000000000001",
      traveler,
    });
    expect(result).toEqual({
      providerSubscriptionId: "sub-123",
      status: "COMPLETED",
      qrPayload: "LPA:1$consumer.rsp.world$ABC",
      smDpAddress: "consumer.rsp.world",
    });
    const orderCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/api/orders/products"),
    );
    expect(orderCall).toBeDefined();
    const payload = JSON.parse(String(orderCall![1].body));
    expect(payload).toMatchObject({
      bind: { msisdn: "882470001850263" },
      source: "api",
      orderType: "preload",
      mvnoRef: "visacompass-test",
      product: { productId: "TRVL-5GB-15D" },
      payment: { provider: "customer" },
      transactionReference: "order-1",
    });
    expect(orderCall![1].headers?.["Idempotency-Key"]).toBe(
      "transatel:preload:order-1",
    );
    expect(prisma.esimInventory.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { assignedOrderId: "order-1" },
          { eid: "890490320000000000000000000001" },
        ],
      },
    });
  });

  it("uses the stored MSISDN in bind.msisdn when present", async () => {
    const prisma = prismaStub();
    prisma.plan.findUnique = vi
      .fn()
      .mockResolvedValue({ id: "plan-1", providerPlanId: "TRVL-5GB-15D" });
    prisma.esimInventory.findFirst = vi.fn().mockResolvedValue({
      iccid: "8988247076000000319",
      eid: "890490320000000000000000000001",
      msisdn: "882470001850263",
    });
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
      "/ocs/subscriptions/api/orders/products": () =>
        jsonResponse({
          id: "ord-1",
          orderReference: "VC-REF",
          status: "done",
          submissionDate: "2026-08-04T00:00:00Z",
          bind: { msisdn: "882470001850263" },
          source: "api",
          mvnoRef: "visacompass-test",
          subscriptionId: "sub-123",
        }),
      "/sim-management/sims/api/esims/sim-serial/8988247076000000319": () =>
        jsonResponse({
          simSerial: "8988247076000000319",
          status: "downloaded",
          smdpAddress: "consumer.rsp.world",
          qrCode: {
            value: "LPA:1$consumer.rsp.world$ABC",
            dataUrl: "data:image/png;base64,xxx",
          },
        }),
    });
    await provider.provision({
      orderId: "order-1",
      planId: "plan-1",
      eid: "890490320000000000000000000001",
      traveler,
    });
    const orderCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/api/orders/products"),
    );
    const payload = JSON.parse(String(orderCall![1].body));
    expect(payload.bind).toEqual({ msisdn: "882470001850263" });
  });

  it("uses orderType subscribe and a subscribe idempotency key for a top-up", async () => {
    const prisma = prismaStub();
    prisma.plan.findUnique = vi
      .fn()
      .mockResolvedValue({ id: "plan-1", providerPlanId: "TRVL-5GB-15D" });
    prisma.esimInventory.findFirst = vi.fn().mockResolvedValue({
      id: "inv-topup",
      iccid: "8988247076000000319",
      eid: "890490320000000000000000000001",
      msisdn: "882470001850263",
    });
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
      "/ocs/subscriptions/api/orders/products": () =>
        jsonResponse({
          id: "ord-2",
          orderReference: "VC-REF",
          status: "done",
          submissionDate: "2026-08-04T00:00:00Z",
          bind: { msisdn: "882470001850263" },
          source: "api",
          mvnoRef: "visacompass-test",
          subscriptionId: "sub-topup",
        }),
      "/sim-management/sims/api/esims/sim-serial/8988247076000000319": () =>
        jsonResponse({
          simSerial: "8988247076000000319",
          status: "downloaded",
          smdpAddress: "consumer.rsp.world",
          qrCode: {
            value: "LPA:1$consumer.rsp.world$TOPUP",
            dataUrl: "data:image/png;base64,xxx",
          },
        }),
    });
    const result = await provider.provision({
      orderId: "order-topup-1",
      planId: "plan-1",
      eid: "890490320000000000000000000001",
      purchaseType: "TOPUP",
      traveler,
    });
    expect(result).toEqual({
      providerSubscriptionId: "sub-topup",
      status: "COMPLETED",
    });
    const orderCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/api/orders/products"),
    );
    expect(orderCall).toBeDefined();
    const payload = JSON.parse(String(orderCall![1].body));
    expect(payload).toMatchObject({
      bind: { msisdn: "882470001850263" },
      source: "api",
      orderType: "subscribe",
      mvnoRef: "visacompass-test",
      product: { productId: "TRVL-5GB-15D" },
      payment: { provider: "customer" },
      transactionReference: "order-topup-1",
    });
    expect(orderCall![1].headers?.["Idempotency-Key"]).toBe(
      "transatel:subscribe:order-topup-1",
    );
    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).includes("/sim-management/sims/api/esims/"),
      ),
    ).toBe(false);
    expect(prisma.esimInventory.update).not.toHaveBeenCalled();
  });

  it("never substitutes an ICCID for a missing OCS MSISDN", async () => {
    const prisma = prismaStub();
    prisma.plan.findUnique = vi
      .fn()
      .mockResolvedValue({ id: "plan-1", providerPlanId: "TRVL-5GB-15D" });
    prisma.esimInventory.findFirst = vi.fn().mockResolvedValue({
      id: "inv-no-msisdn",
      iccid: "8988247076000000319",
      eid: "890490320000000000000000000001",
      msisdn: null,
    });

    await expect(
      new TransatelProvider(prisma).provision({
        orderId: "order-no-msisdn",
        planId: "plan-1",
        eid: "890490320000000000000000000001",
        purchaseType: "TOPUP",
        traveler,
      }),
    ).rejects.toMatchObject({ code: "PROVISIONING_FAILED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps an ineligible subscriber top-up rejection without exposing provider JSON", async () => {
    const prisma = prismaStub();
    prisma.plan.findUnique = vi
      .fn()
      .mockResolvedValue({ id: "plan-1", providerPlanId: "TRVL-5GB-15D" });
    prisma.esimInventory.findFirst = vi.fn().mockResolvedValue({
      iccid: "8988247076000000319",
      msisdn: "882470001850263",
      eid: "890490320000000000000000000001",
    });
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
      "/ocs/subscriptions/api/orders/products": () =>
        jsonResponse(
          {
            title: "SUBSCRIBER_STATUS_NOT_ELIGIBLE",
            status: 400,
            detail:
              "Order failed - Subscriber status is not compatible with the order",
          },
          400,
        ),
    });

    const error = (await provider
      .provision({
        orderId: "order-1",
        planId: "plan-1",
        eid: "890490320000000000000000000001",
        purchaseType: "TOPUP",
        traveler,
      })
      .catch((cause: unknown) => cause)) as ApiException;

    expect(error.code).toBe(ApiErrorCode.ELIGIBILITY_REJECTED);
    expect(error.message).toBe(
      "This eSIM cannot receive a top-up in its current network state. Our support team can check its status before you try again.",
    );
    expect(error.message).not.toContain("SUBSCRIBER_STATUS_NOT_ELIGIBLE");
    expect(String(error.internalDetail)).toContain(
      "PERMANENT_SUBSCRIBER_STATUS_NOT_ELIGIBLE",
    );
  });

  it("does not return provider eligibility wording to the customer", async () => {
    const prisma = prismaStub();
    prisma.plan.findUnique = vi
      .fn()
      .mockResolvedValue({ id: "plan-1", providerPlanId: "TRVL-5GB-15D" });
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
      "/ocs/catalog/api/cos/WW_COS_TEST/products/TRVL-5GB-15D": () =>
        jsonResponse({
          products: [
            {
              canSubscribe: {
                allowed: false,
                errorKey: "SUBSCRIBER_STATUS_NOT_ELIGIBLE",
                errorMessage: "private provider diagnostic",
              },
            },
          ],
        }),
    });

    const result = await provider.checkEligibility("plan-1", "882470001850263");

    expect(result).toEqual({
      allowed: false,
      errorKey: "SUBSCRIBER_STATUS_NOT_ELIGIBLE",
      errorMessage:
        "This eSIM cannot receive a top-up in its current network state. Please contact support before trying again.",
    });
    expect(JSON.stringify(result)).not.toContain("private provider diagnostic");
  });

  it("accepts the unwrapped Transatel product-detail eligibility shape", async () => {
    const prisma = prismaStub();
    prisma.plan.findUnique = vi
      .fn()
      .mockResolvedValue({ id: "plan-1", providerPlanId: "TRVL-5GB-15D" });
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
      "/ocs/catalog/api/cos/WW_COS_TEST/products/TRVL-5GB-15D": () =>
        jsonResponse({
          canSubscribe: { allowed: true },
          availability: { available: true },
          hasSubProducts: false,
          inventoryActive: true,
          productDefinition: { productId: "TRVL-5GB-15D" },
        }),
    });

    await expect(
      provider.checkEligibility("plan-1", "882470001850263"),
    ).resolves.toEqual({ allowed: true });
  });

  it("returns a DELAYED result when the QR payload is not yet available", async () => {
    const prisma = prismaStub();
    prisma.plan.findUnique = vi
      .fn()
      .mockResolvedValue({ id: "plan-1", providerPlanId: "TRVL-5GB-15D" });
    prisma.esimInventory.findFirst = vi.fn().mockResolvedValue({
      iccid: "8988247076000000319",
      msisdn: "882470001850263",
      eid: "890490320000000000000000000001",
    });
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
      "/ocs/subscriptions/api/orders/products": () =>
        jsonResponse({
          id: "ord-1",
          orderReference: "VC-REF",
          status: "done",
          submissionDate: "2026-08-04T00:00:00Z",
          bind: { msisdn: "882470001850263" },
          source: "api",
          mvnoRef: "visacompass-test",
          subscriptionId: "sub-123",
        }),
      "/sim-management/sims/api/esims/sim-serial/8988247076000000319": () =>
        jsonResponse({ simSerial: "8988247076000000319", status: "allocated" }),
    });
    const result = await provider.provision({
      orderId: "order-1",
      planId: "plan-1",
      eid: "890490320000000000000000000001",
      traveler,
    });
    expect(result).toEqual({
      providerSubscriptionId: "sub-123",
      status: "DELAYED",
    });
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "order-1" },
        data: expect.objectContaining({
          providerSubscriptionId: "sub-123",
          providerStatus: "PRELOADED",
        }),
      }),
    );
    expect(prisma.esimInventory.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerSubscriptionId: "sub-123",
          providerStatus: "PRELOADED",
        }),
      }),
    );
  });

  it("resumes an accepted preload without submitting a duplicate command", async () => {
    const prisma = prismaStub();
    prisma.plan.findUnique = vi
      .fn()
      .mockResolvedValue({ id: "plan-1", providerPlanId: "TRVL-5GB-15D" });
    prisma.esimInventory.findFirst = vi.fn().mockResolvedValue({
      id: "inv-1",
      iccid: "8988247076000000319",
      msisdn: "882470001850263",
      eid: "890490320000000000000000000001",
    });
    prisma.order.findUnique = vi
      .fn()
      .mockResolvedValue({ providerSubscriptionId: "sub-existing" });
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
      "/sim-management/sims/api/esims/sim-serial/8988247076000000319": () =>
        jsonResponse({ simSerial: "8988247076000000319", status: "allocated" }),
    });
    const result = await provider.provision({
      orderId: "order-1",
      planId: "plan-1",
      eid: "890490320000000000000000000001",
      traveler,
    });
    expect(result).toEqual({
      providerSubscriptionId: "sub-existing",
      status: "DELAYED",
    });
    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).includes("/api/orders/products"),
      ),
    ).toBe(false);
  });

  it("does not replay a preload whose outcome is ambiguous", async () => {
    const prisma = prismaStub();
    prisma.plan.findUnique = vi
      .fn()
      .mockResolvedValue({ id: "plan-1", providerPlanId: "TRVL-5GB-15D" });
    prisma.esimInventory.findFirst = vi.fn().mockResolvedValue({
      id: "inv-1",
      iccid: "8988247076000000319",
      msisdn: "882470001850263",
      eid: "890490320000000000000000000001",
    });
    prisma.order.findUnique = vi.fn().mockResolvedValue({
      providerSubscriptionId: null,
      providerStatus: "SUBMITTING",
    });
    const provider = new TransatelProvider(prisma);

    const error = await provider
      .provision({
        orderId: "order-1",
        planId: "plan-1",
        eid: "890490320000000000000000000001",
        traveler,
      })
      .catch((value: unknown) => value);

    expect((error as { code?: string }).code).toBe("CONNECTIVITY_UNAVAILABLE");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "retains ready packages without balances and excludes walled-garden products (active=%s)",
    async (active) => {
      const prisma = prismaStub();
      prisma.esimInventory.findFirst = vi
        .fn()
        .mockResolvedValue({
          iccid: "8988247076000000319",
          msisdn: "33612345678",
        });
      const provider = new TransatelProvider(prisma);
      const balance = {
        data: [
          {
            resourceUnit: "KB",
            resourceStartValue: 1048576,
            resourceValue: 1048576,
          },
        ],
      };
      route({
        "/authentication/api/token": () =>
          jsonResponse({ access_token: "token", expires_in: 3600 }),
        "/ocs/inventory/api/subscriptions/products": () =>
          jsonResponse({
            productSubscriptions: [
              ...(active
                ? [
                    {
                      subscriptionId: "original",
                      status: "active",
                      balances: balance,
                    },
                  ]
                : []),
              {
                subscriptionId: "recharge",
                status: "readyForUse",
                balances: {},
                expirationDate: "2027-03-04T00:00:00Z",
              },
              {
                subscriptionId: "infrastructure",
                status: "active",
                balances: balance,
                productDefinition: { tags: ["WALLED_GARDEN"] },
              },
            ],
          }),
      });
      const result = await provider.getUsage(ORDER_UUID);
      expect(result.totalMb).toBe(active ? 1024 : 0);
      expect(result.usageAvailable).toBe(active);
      expect(result.subscriptions).toHaveLength(active ? 2 : 1);
      const recharge = result.subscriptions!.find(
        (s) => s.providerSubscriptionId === "recharge",
      );
      expect(recharge).toMatchObject({
        status: "readyForUse",
        usageAvailable: false,
      });
      expect(recharge).not.toHaveProperty("expiresAt");
    },
  );

  it("normalizes KB balances into used and total MB", async () => {
    const prisma = prismaStub();
    prisma.esimInventory.findFirst = vi.fn().mockResolvedValue({
      iccid: "8988247076000000319",
      msisdn: "33612345678",
    });
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
      "/ocs/inventory/api/subscriptions/products": () =>
        jsonResponse({
          currentLocale: "en_US",
          productSubscriptions: [
            {
              subscriptionId: "sub-1",
              status: "active",
              balances: {
                data: [
                  {
                    resourceName: "DATA",
                    resourceUnit: "KB",
                    resourceStartValue: 5242880,
                    resourceValue: 1048576,
                  },
                ],
              },
            },
          ],
        }),
    });
    const usage = await provider.getUsage(ORDER_UUID);
    expect(usage).toEqual({
      usedMb: 4096,
      totalMb: 5120,
      usageAvailable: true,
      subscriptions: [
        {
          providerSubscriptionId: "sub-1",
          status: "active",
          usedMb: 4096,
          totalMb: 5120,
          priority: 1,
          usageAvailable: true,
        },
      ],
    });
    const url = String(
      fetchMock.mock.calls.find((call) =>
        String(call[0]).includes("/api/subscriptions/products"),
      )![0],
    );
    expect(url).toContain("msisdn=33612345678");
    expect(url).toContain("withBalances=true");
  });

  it("rejects OCS usage lookup when an inventory profile has no MSISDN", async () => {
    const prisma = prismaStub();
    prisma.esimInventory.findFirst = vi.fn().mockResolvedValue({
      iccid: "8988247076000000319",
      msisdn: null,
    });
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
      "/ocs/inventory/api/subscriptions/products": () =>
        jsonResponse({
          currentLocale: "en_US",
          productSubscriptions: [
            {
              subscriptionId: "sub-1",
              status: "active",
              balances: {
                data: [
                  {
                    resourceName: "DATA",
                    resourceUnit: "KB",
                    resourceStartValue: 1024,
                    resourceValue: 1024,
                  },
                ],
              },
            },
          ],
        }),
    });

    await expect(provider.getUsage(ORDER_UUID)).rejects.toMatchObject({
      code: "USAGE_UNAVAILABLE",
    });
    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).includes("/api/subscriptions/products"),
      ),
    ).toBe(false);
  });

  it("returns the QR payload and SM-DP+ address from eSIM details", async () => {
    const prisma = prismaStub();
    prisma.esimInventory.findFirst = vi.fn().mockResolvedValue({
      iccid: "8988247076000000319",
      msisdn: "33612345678",
    });
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
      "/sim-management/sims/api/esims/sim-serial/8988247076000000319": () =>
        jsonResponse({
          simSerial: "8988247076000000319",
          status: "downloaded",
          smdpAddress: "consumer.rsp.world",
          qrCode: {
            value: "LPA:1$consumer.rsp.world$XYZ",
            dataUrl: "data:image/png;base64,xx",
          },
        }),
    });
    const details = await provider.getEsimDetails("8988247076000000319");
    expect(details).toEqual({
      iccid: "8988247076000000319",
      status: "downloaded",
      smDpAddress: "consumer.rsp.world",
      qrPayload: "LPA:1$consumer.rsp.world$XYZ",
    });
  });

  it("classifies an ICCID missing from Transatel as an inventory lookup failure", async () => {
    const prisma = prismaStub();
    prisma.esimInventory.findFirst = vi
      .fn()
      .mockResolvedValue({ iccid: "8988247076000000319" });
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
      "/sim-management/sims/api/esims/sim-serial/8988247076000000319": () =>
        jsonResponse({ message: "SIM not found" }, 404),
    });

    const error = await provider
      .getEsimDetails("8988247076000000319")
      .catch((cause) => cause);

    expect(error).toBeInstanceOf(ApiException);
    expect(error).toMatchObject({ code: ApiErrorCode.ESIM_NOT_FOUND });
    expect((error as Error).message).toContain("not found");
    expect((error as Error).message).not.toContain("Usage");
  });

  it("retries once with a fresh token after a 401", async () => {
    const prisma = prismaStub();
    prisma.esimInventory.findFirst = vi.fn().mockResolvedValue({
      iccid: "8988247076000000319",
      msisdn: "33612345678",
    });
    let tokenCalls = 0;
    let productCalls = 0;
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({
          access_token: `token-${++tokenCalls}`,
          expires_in: 3600,
        }),
      "/ocs/inventory/api/subscriptions/products": () => {
        productCalls += 1;
        if (productCalls === 1)
          return jsonResponse({ error: "invalid_token" }, 401);
        return jsonResponse({
          currentLocale: "en_US",
          productSubscriptions: [
            {
              subscriptionId: "sub-1",
              status: "active",
              balances: {
                data: [
                  {
                    resourceName: "DATA",
                    resourceUnit: "KB",
                    resourceStartValue: 1024,
                    resourceValue: 1024,
                  },
                ],
              },
            },
          ],
        });
      },
    });
    const usage = await provider.getUsage(ORDER_UUID);
    expect(usage).toEqual({
      usedMb: 0,
      totalMb: 1,
      usageAvailable: true,
      subscriptions: [
        {
          providerSubscriptionId: "sub-1",
          status: "active",
          usedMb: 0,
          totalMb: 1,
          priority: 1,
          usageAvailable: true,
        },
      ],
    });
    expect(tokenCalls).toBe(2);
    expect(productCalls).toBe(2);
  });

  it("normalizes an OCS/PRODUCT/ACTIVATED webhook into a provider event", async () => {
    const prisma = prismaStub();
    prisma.order.findUnique = vi.fn().mockResolvedValue({ id: "order-1" });
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
    });
    const result = await provider.handleWebhook({
      header: {
        eventId: "evt-1",
        eventType: "OCS/PRODUCT/ACTIVATED",
        eventDate: "2026-08-04T00:00:00Z",
      },
      body: {
        mvnoRef: "visacompass-test",
        cos: "WW_COS_TEST",
        msisdn: "33612345678",
        iccid: "8988247076000000319",
        externalReference: "order-1",
        productSubscription: {
          subscriptionId: "sub-123",
          activationDate: "2026-08-04T13:30:00Z",
        },
      },
    });
    expect(result.handled).toBe(true);
    expect(result.event).toMatchObject({
      eventType: "OCS/PRODUCT/ACTIVATED",
      orderId: "order-1",
      iccid: "8988247076000000319",
      externalReference: "order-1",
      subscriptionId: "sub-123",
      status: "ACTIVATED",
      activatedAt: "2026-08-04T13:30:00Z",
    });
    expect(prisma.order.findUnique).toHaveBeenCalledWith({
      where: { id: "order-1" },
      select: { id: true },
    });
    expect(prisma.esimInventory.findUnique).not.toHaveBeenCalled();
  });

  it("routes by externalReference (our order id) and not by ICCID", async () => {
    const prisma = prismaStub();
    prisma.order.findUnique = vi.fn().mockResolvedValue({ id: "order-9" });
    prisma.esimInventory.findUnique = vi.fn().mockResolvedValue(null);
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
    });
    const result = await provider.handleWebhook({
      header: { eventId: "evt-2", eventType: "OCS/PRODUCT/ACTIVATED" },
      body: {
        msisdn: "33612345678",
        iccid: "8988989996000000319",
        externalReference: "order-9",
        productSubscription: { subscriptionId: "sub-9" },
      },
    });
    expect(result.handled).toBe(true);
    expect(result.event?.orderId).toBe("order-9");
    expect(prisma.esimInventory.findUnique).not.toHaveBeenCalled();
  });

  it("falls back to ICCID inventory binding when externalReference matches no order", async () => {
    const prisma = prismaStub();
    prisma.order.findUnique = vi.fn().mockResolvedValue(null);
    prisma.esimInventory.findUnique = vi
      .fn()
      .mockResolvedValue({ assignedOrderId: "order-3" });
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
    });
    const result = await provider.handleWebhook({
      header: { eventId: "evt-3", eventType: "OCS/PRODUCT/ACTIVATED" },
      body: {
        msisdn: "33612345678",
        iccid: "8988247076000000319",
        externalReference: "unknown-ref",
        productSubscription: { subscriptionId: "sub-3" },
      },
    });
    expect(result.handled).toBe(true);
    expect(result.event?.orderId).toBe("order-3");
    expect(prisma.esimInventory.findUnique).toHaveBeenCalledWith({
      where: { iccid: "8988247076000000319" },
      select: {
        assignedOrderId: true,
        customerEsims: { select: { orderId: true }, take: 2 },
      },
    });
  });

  it("routes a top-up webhook by provider subscription when externalReference is absent", async () => {
    const prisma = prismaStub();
    prisma.order.findFirst = vi.fn().mockResolvedValue({ id: "topup-order" });
    prisma.esimInventory.findUnique = vi.fn();
    const provider = new TransatelProvider(prisma);
    const result = await provider.handleWebhook({
      header: { eventId: "evt-topup", eventType: "OCS/PRODUCT/ACTIVATED" },
      body: {
        iccid: "8988247076000000319",
        productSubscription: { subscriptionId: "topup-subscription" },
      },
    });

    expect(result.handled).toBe(true);
    expect(result.event).toMatchObject({
      orderId: "topup-order",
      subscriptionId: "topup-subscription",
    });
    expect(prisma.order.findFirst).toHaveBeenCalledWith({
      where: { providerSubscriptionId: "topup-subscription" },
      select: { id: true },
    });
    expect(prisma.esimInventory.findUnique).not.toHaveBeenCalled();
  });

  it("does not guess an order from ICCID when an eSIM has multiple purchases", async () => {
    const prisma = prismaStub();
    prisma.esimInventory.findUnique = vi.fn().mockResolvedValue({
      assignedOrderId: "initial-order",
      customerEsims: [{ orderId: "initial-order" }, { orderId: "topup-order" }],
    });
    const provider = new TransatelProvider(prisma);
    const result = await provider.handleWebhook({
      header: { eventId: "evt-ambiguous", eventType: "OCS/PRODUCT/ACTIVATED" },
      body: { iccid: "8988247076000000319" },
    });

    expect(result.handled).toBe(false);
    expect(result.reason).toContain("ambiguous across 2 orders");
  });

  it("acknowledges webhooks that reference an unknown ICCID as unhandled", async () => {
    const prisma = prismaStub();
    prisma.order.findUnique = vi.fn().mockResolvedValue(null);
    prisma.esimInventory.findUnique = vi.fn().mockResolvedValue(null);
    const provider = new TransatelProvider(prisma);
    const result = await provider.handleWebhook({
      header: { eventId: "evt-4", eventType: "OCS/PRODUCT/ACTIVATED" },
      body: { msisdn: "33612345678", iccid: "8988247076000000319" },
    });
    expect(result.handled).toBe(false);
    expect(result.reason).toContain("8988247076000000319");
  });

  it("rejects a webhook whose iccid is not present on body.iccid", async () => {
    const prisma = prismaStub();
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
    });
    const result = await provider.handleWebhook({
      header: { eventId: "evt-5", eventType: "OCS/PRODUCT/ACTIVATED" },
      body: {
        subscription: { serialNumbers: ["8988247076000000319"] },
        subscriptionId: "sub-5",
      },
    });
    expect(result.handled).toBe(false);
    expect(result.reason).toContain("subscriber identifier");
  });

  it("maps an expiration webhook to an EXPIRED status", async () => {
    const prisma = prismaStub();
    prisma.order.findUnique = vi.fn().mockResolvedValue({ id: "order-2" });
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
    });
    const result = await provider.handleWebhook({
      header: { eventId: "evt-6", eventType: "OCS/PRODUCT/EXPIRED" },
      body: {
        msisdn: "33612345678",
        iccid: "8988247076000000319",
        externalReference: "order-2",
        productSubscription: {
          subscriptionId: "sub-2",
          expirationDate: "2026-08-19T00:00:00Z",
        },
      },
    });
    expect(result.event).toMatchObject({
      status: "EXPIRED",
      expiresAt: "2026-08-19T00:00:00Z",
    });
  });

  it("maps product cancellation without treating it as an unknown event", async () => {
    const prisma = prismaStub();
    prisma.order.findUnique = vi.fn().mockResolvedValue({ id: "order-2" });
    const provider = new TransatelProvider(prisma);
    const result = await provider.handleWebhook({
      header: { eventId: "evt-canceled", eventType: "OCS/PRODUCT/CANCELED" },
      body: {
        iccid: "8988247076000000319",
        externalReference: "order-2",
        productSubscription: {
          subscriptionId: "sub-2",
          expirationDate: "2026-09-19T00:00:00Z",
        },
      },
    });

    expect(result.event).toMatchObject({
      status: "CANCELED",
      expiresAt: "2026-09-19T00:00:00Z",
    });
  });

  it("retains unsupported webhook types for audit without mapping a lifecycle event", async () => {
    const prisma = prismaStub();
    const provider = new TransatelProvider(prisma);
    const result = await provider.handleWebhook({
      header: {
        eventId: "evt-unknown",
        eventType: "OCS/PRODUCT/RESOURCE/EXHAUSTED",
      },
      body: { iccid: "8988247076000000319" },
    });

    expect(result).toEqual({
      handled: false,
      reason:
        "Webhook event OCS/PRODUCT/RESOURCE/EXHAUSTED is not supported by the lifecycle mapper",
    });
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(prisma.esimInventory.findUnique).not.toHaveBeenCalled();
  });

  it("resolves the ICCID and dates from a real OCS webhook envelope", async () => {
    const prisma = prismaStub();
    prisma.order.findUnique = vi.fn().mockResolvedValue({ id: "order-1" });
    prisma.esimInventory.findUnique = vi
      .fn()
      .mockResolvedValue({ assignedOrderId: "order-1" });
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
    });
    const result = await provider.handleWebhook({
      header: {
        eventId: "evt-7",
        eventType: "OCS/PRODUCT/ACTIVATED",
        eventDate: "2026-08-04T13:30:00Z",
      },
      body: {
        mvnoRef: "visacompass-test",
        cos: "WW_COS_TEST",
        msisdn: "33612345678",
        iccid: "8988247076000000319",
        externalReference: "order-1",
        productSubscription: {
          subscriptionId: "sub-123",
          activationDate: "2026-08-04T13:30:00Z",
          expirationDate: "2026-09-03T13:30:00Z",
        },
      },
    });
    expect(result.handled).toBe(true);
    expect(result.event).toMatchObject({
      eventType: "OCS/PRODUCT/ACTIVATED",
      orderId: "order-1",
      iccid: "8988247076000000319",
      subscriptionId: "sub-123",
      status: "ACTIVATED",
      activatedAt: "2026-08-04T13:30:00Z",
      expiresAt: "2026-09-03T13:30:00Z",
    });
  });

  it("normalizes a connectivity-management suspension using body.simSerial", async () => {
    const prisma = prismaStub();
    prisma.esimInventory.findUnique = vi
      .fn()
      .mockResolvedValue({ assignedOrderId: "order-1" });
    const provider = new TransatelProvider(prisma);
    const result = await provider.handleWebhook({
      header: {
        eventId: "evt-suspended",
        eventType: "CONNECTIVITY-MANAGEMENT/SUBSCRIBER/SUSPENDED",
      },
      body: { simSerial: "8988247076000000319", transactionId: "tx-suspend" },
    });
    expect(result.handled).toBe(true);
    expect(result.event).toMatchObject({
      orderId: "order-1",
      iccid: "8988247076000000319",
      status: "SUSPENDED",
    });
  });

  it("synchronizes catalog products into per-country plans", async () => {
    const tx = {
      country: { upsert: vi.fn().mockResolvedValue({ id: "country-1" }) },
      plan: { upsert: vi.fn().mockResolvedValue({ id: "plan-1" }) },
    };
    const prisma = prismaStub({
      $transaction: vi.fn(async (fn: (transaction: unknown) => unknown) =>
        fn(tx),
      ),
    });
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
      "/ocs/catalog/api/cos/WW_COS_TEST/products": () =>
        jsonResponse({
          cos: "WW_COS_TEST",
          products: [
            {
              availability: { available: true },
              canSubscribe: { allowed: true },
              display: { priority: 1 },
              hasSubProducts: false,
              inventoryActive: false,
              prices: {
                subscriptionFee: [
                  [{ currency: "EUR", unit: "CENTS", amount: 499 }],
                ],
              },
              productDefinition: {
                productId: "TRVL-5GB-15D",
                productCategory: "One-off",
                allowances: {
                  data: [
                    { resourceName: "DATA", startValue: 5120, unit: "MB" },
                  ],
                },
                countryList: ["GBR", "FRA"],
                validityPeriod: {
                  validityDuration: 15,
                  validityDurationUnit: "days",
                },
                description: { productLabel: "Travel 5GB" },
              },
            },
          ],
        }),
    });
    const result = await provider.syncCatalog();
    expect(result).toEqual({ synced: 2, skipped: 0 });
    expect(tx.plan.upsert).toHaveBeenCalledTimes(2);
    const planArgs = tx.plan.upsert.mock.calls.map((call) => call[0]);
    expect(planArgs[0].where).toEqual({
      countryId_providerPlanId: {
        countryId: "country-1",
        providerPlanId: "TRVL-5GB-15D",
      },
    });
    expect(planArgs[0].create).toMatchObject({
      name: "Travel 5GB",
      dataAllowance: "5120 MB",
      validityDays: 15,
      costPrice: 848,
      sellingPrice: 848,
      providerPlanId: "TRVL-5GB-15D",
      status: "DRAFT",
    });
    expect(planArgs[0].update).not.toHaveProperty("sellingPrice");
    expect(planArgs[0].update).not.toHaveProperty("popular");
    expect(planArgs[0].update).not.toHaveProperty("status");
  });

  it("skips restricted destination countries (Nepal) during catalog sync", async () => {
    const tx = {
      country: { upsert: vi.fn().mockResolvedValue({ id: "country-1" }) },
      plan: { upsert: vi.fn().mockResolvedValue({ id: "plan-1" }) },
    };
    const prisma = prismaStub({
      $transaction: vi.fn(async (fn: (transaction: unknown) => unknown) =>
        fn(tx),
      ),
    });
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
      "/ocs/catalog/api/cos/WW_COS_TEST/products": () =>
        jsonResponse({
          cos: "WW_COS_TEST",
          products: [
            {
              availability: { available: true },
              canSubscribe: { allowed: true },
              display: { priority: 1 },
              hasSubProducts: false,
              inventoryActive: false,
              prices: {
                subscriptionFee: [
                  [{ currency: "EUR", unit: "CENTS", amount: 499 }],
                ],
              },
              productDefinition: {
                productId: "TRVL-NPL-15D",
                productCategory: "One-off",
                allowances: {
                  data: [
                    { resourceName: "DATA", startValue: 5120, unit: "MB" },
                  ],
                },
                countryList: ["GBR", "NPL"],
                validityPeriod: {
                  validityDuration: 15,
                  validityDurationUnit: "days",
                },
                description: { productLabel: "Travel 5GB" },
              },
            },
          ],
        }),
    });
    const result = await provider.syncCatalog();
    expect(result).toEqual({ synced: 1, skipped: 0 });
    expect(tx.plan.upsert).toHaveBeenCalledTimes(1);
    expect(tx.country.upsert).toHaveBeenCalledTimes(1);
    expect(tx.plan.upsert.mock.calls[0]![0].where).toEqual({
      countryId_providerPlanId: {
        countryId: "country-1",
        providerPlanId: "TRVL-NPL-15D",
      },
    });
  });

  it("parses subscription fees expressed in major units without dividing", async () => {
    const tx = {
      country: { upsert: vi.fn().mockResolvedValue({ id: "country-1" }) },
      plan: { upsert: vi.fn().mockResolvedValue({ id: "plan-1" }) },
    };
    const prisma = prismaStub({
      $transaction: vi.fn(async (fn: (transaction: unknown) => unknown) =>
        fn(tx),
      ),
    });
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
      "/ocs/catalog/api/cos/WW_COS_TEST/products": () =>
        jsonResponse({
          cos: "WW_COS_TEST",
          products: [
            {
              availability: { available: true },
              canSubscribe: { allowed: true },
              display: { priority: 1 },
              hasSubProducts: false,
              inventoryActive: false,
              prices: {
                subscriptionFee: [
                  [{ currency: "EUR", unit: "EURO", amount: 4.99 }],
                ],
              },
              productDefinition: {
                productId: "TRVL-EURO",
                productCategory: "One-off",
                allowances: {
                  data: [
                    { resourceName: "DATA", startValue: 1024, unit: "MB" },
                  ],
                },
                countryList: ["GBR"],
                validityPeriod: {
                  validityDuration: 15,
                  validityDurationUnit: "days",
                },
                description: { productLabel: "Euro price plan" },
              },
            },
          ],
        }),
    });
    const result = await provider.syncCatalog();
    expect(result).toEqual({ synced: 1, skipped: 0 });
    const create = tx.plan.upsert.mock.calls[0]![0].create;
    expect(create.costPrice).toBe(848);
  });

  it("maps real catalog allowances using resourceValue/resourceUnit and prefers productShortText", async () => {
    const prisma = prismaStub();
    const provider = new TransatelProvider(prisma);
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
      "/ocs/catalog/api/cos/WW_COS_TEST/products": () =>
        jsonResponse({
          cos: "WW_COS_TEST",
          products: [
            {
              availability: { available: true },
              canSubscribe: { allowed: true },
              display: { priority: 1 },
              hasSubProducts: false,
              inventoryActive: false,
              prices: {
                subscriptionFee: [
                  [{ currency: "EUR", unit: "CENTS", amount: 1800 }],
                ],
              },
              productDefinition: {
                productId: "WW_901O_STACK_ONEOFF_AFG_1GB_7D",
                productCategory: "One-off",
                allowances: {
                  data: [
                    {
                      resourceName: "DATA_BUNDLE_COUNTRY",
                      resourceUnit: "KB",
                      resourceValue: 1048576,
                    },
                  ],
                },
                countryList: ["AFG"],
                validityPeriod: {
                  validityDuration: 7,
                  validityDurationUnit: "days",
                },
                description: {
                  productLabel: "AFGHANISTAN",
                  productShortText:
                    "One-off data plan Afghanistan 1GB 7 day(s)",
                },
              },
            },
          ],
        }),
    });
    const { rows } = await provider.catalogReport();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      countryiso2: "AF",
      name: "One-off data plan Afghanistan 1GB 7 day(s)",
      dataallowance: "1024 MB",
      validitydays: 7,
      costprice: 3060,
      sellingprice: 3060,
      currency: "NPR",
    });
  });

  it("excludes restricted destination countries (Nepal) from the catalog report", async () => {
    const provider = new TransatelProvider(prismaStub());
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
      "/ocs/catalog/api/cos/WW_COS_TEST/products": () =>
        jsonResponse({
          cos: "WW_COS_TEST",
          products: [
            {
              availability: { available: true },
              canSubscribe: { allowed: true },
              display: { priority: 1 },
              hasSubProducts: false,
              inventoryActive: false,
              prices: {
                subscriptionFee: [
                  [{ currency: "EUR", unit: "CENTS", amount: 1800 }],
                ],
              },
              productDefinition: {
                productId: "WW_901O_STACK_ONEOFF_NPL_1GB_7D",
                productCategory: "One-off",
                allowances: {
                  data: [
                    {
                      resourceName: "DATA_BUNDLE_COUNTRY",
                      resourceUnit: "KB",
                      resourceValue: 1048576,
                    },
                  ],
                },
                countryList: ["NPL"],
                validityPeriod: {
                  validityDuration: 7,
                  validityDurationUnit: "days",
                },
                description: {
                  productLabel: "NEPAL",
                  productShortText: "One-off data plan Nepal 1GB 7 day(s)",
                },
              },
            },
          ],
        }),
    });
    const { rows } = await provider.catalogReport();
    expect(rows).toHaveLength(0);
  });

  it("reports health based on the configured credentials", async () => {
    const provider = new TransatelProvider(prismaStub());
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
    });
    expect((await provider.health()).ok).toBe(true);
    delete process.env.TRANSATEL_MVNO_REF;
    expect((await provider.health()).ok).toBe(false);
  });

  it("submits an idempotent subscriber suspension by ICCID", async () => {
    const provider = new TransatelProvider(prismaStub());
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
      "/connectivity-management/subscribers/api/subscribers/sim-serial/8988247076000000319/suspend":
        () =>
          jsonResponse({ transactionId: "tx-suspend", status: "Pending" }, 201),
    });
    expect(
      await provider.suspend("8988247076000000319", "ops:suspend:key-1"),
    ).toEqual({
      accepted: true,
      transactionId: "tx-suspend",
      status: "Pending",
    });
    const call = fetchMock.mock.calls.find((entry) =>
      String(entry[0]).endsWith("/suspend"),
    );
    expect(call?.[1]).toMatchObject({ method: "POST" });
    expect(call?.[1].headers?.["Idempotency-Key"]).toBe("ops:suspend:key-1");
    expect(JSON.parse(String(call?.[1].body))).toMatchObject({
      mvnoRef: "visacompass-test",
      transactionReference: "ops:suspend:key-1",
    });
  });

  it("submits an irreversible subscriber termination by ICCID", async () => {
    const provider = new TransatelProvider(prismaStub());
    route({
      "/authentication/api/token": () =>
        jsonResponse({ access_token: "token-1", expires_in: 3600 }),
      "/connectivity-management/subscribers/api/subscribers/sim-serial/8988247076000000319/terminate":
        () =>
          jsonResponse(
            { transactionId: "tx-terminate", status: "Pending" },
            201,
          ),
    });
    expect(
      await provider.terminate("8988247076000000319", "ops:terminate:key-1"),
    ).toEqual({
      accepted: true,
      transactionId: "tx-terminate",
      status: "Pending",
    });
    expect(
      fetchMock.mock.calls.some((entry) =>
        String(entry[0]).endsWith("/terminate"),
      ),
    ).toBe(true);
  });
});
