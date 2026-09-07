import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictException } from "@nestjs/common";
import {
  DocumentStatus,
  DocumentType,
  OrderStatus,
  PaymentStatus,
} from "@visa-compass/shared";
import { OrdersService, type DemoOrder } from "./orders.service.js";
import type { ConnectivityService } from "../integration/connectivity.service.js";
import type { S3StorageService } from "../../infrastructure/s3-storage.service.js";
import type { OrdersPersistenceService } from "./orders-persistence.service.js";
import type { InventoryService } from "../inventory/inventory.service.js";
import type { QueueService } from "../../jobs/queue.service.js";
import type { NotificationService } from "../notification/notification.service.js";
import type { CatalogService } from "../catalog/catalog.controller.js";
import type { PrismaService } from "../../infrastructure/prisma.service.js";
import type { QrPdfService } from "../notification/qr-pdf.service.js";
import { PaymentsService } from "../payments/payments.service.js";
import { PaymentSimulatorGateway } from "../payments/gateways/simulator.gateway.js";
import type { KhaltiGateway } from "../payments/gateways/khalti.gateway.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function readyOrder(overrides: Partial<DemoOrder> = {}): DemoOrder {
  const now = Date.now();
  return {
    id: "q-1",
    ownerId: null,
    orderNumber: "VC-2026-R1",
    status: OrderStatus.QR_READY,
    version: 0,
    plan: {
      id: "plan-1",
      name: "Nepal 5GB",
      sellingPriceNpr: 1000,
      dataAllowance: "5 GB",
      validityDays: 7,
      countryCode: "NP",
      countryName: "Nepal",
    },
    totalAmountNpr: 1000,
    pricingSnapshot: {},
    compatibilityAcceptedAt: new Date(now - 3_600_000).toISOString(),
    documents: [],
    timeline: [],
    createdAt: new Date(now - 3_600_000).toISOString(),
    qrDeliveredAt: new Date(now - 10 * 86_400_000).toISOString(),
    providerSubscriptionId: "sub-1",
    providerStatus: "PRELOADED",
    ...overrides,
  } as unknown as DemoOrder;
}

function customerTraveler(): NonNullable<DemoOrder["traveler"]> {
  return {
    title: "MS",
    firstName: "Jane",
    surname: "Doe",
    dateOfBirth: "1990-01-01",
    nationality: "NP",
    email: "traveler@example.com",
    mobile: "9779800000000",
    city: "Kathmandu",
    countryOfResidence: "NP",
    passportNumber: "P1234567",
    passportExpiryDate: "2030-01-01",
  };
}

function ordersService(
  seed: DemoOrder[],
  connectivity: unknown,
  inventory: unknown = { release: vi.fn().mockResolvedValue(undefined) },
  prisma: unknown = { enabled: false },
  notifications: unknown = {},
  resilience?: unknown,
  persistenceOverrides: Record<string, unknown> = {},
  queue: unknown = { add: vi.fn().mockResolvedValue({}) },
  storage: unknown = {},
) {
  const persistence = {
    load: vi.fn().mockResolvedValue(seed),
    save: vi.fn().mockResolvedValue(undefined),
    provisioningAttempt: vi.fn().mockResolvedValue(undefined),
    ...persistenceOverrides,
  } as unknown as OrdersPersistenceService;
  return new OrdersService(
    connectivity as unknown as ConnectivityService,
    storage as unknown as S3StorageService,
    persistence,
    inventory as unknown as InventoryService,
    queue as unknown as QueueService,
    notifications as unknown as NotificationService,
    {} as unknown as CatalogService,
    prisma as unknown as PrismaService,
    {} as unknown as QrPdfService,
    undefined,
    resilience as never,
  );
}

describe("OrdersService operations attribution", () => {
  it.each(["PARTNER_HOSTED", "PARTNER_API", "CUSTOMER_WEB"])(
    "uses the order's partner customer independently of its login owner (%s)",
    async (channel) => {
      const partnerCustomer =
        channel === "CUSTOMER_WEB"
          ? null
          : {
              id: "order-partner-customer",
              externalCustomerId: "partner-traveler-reference",
              partner: { id: "partner-1", code: "test2", name: "test2" },
            };
      const now = new Date();
      const findUnique = vi.fn().mockResolvedValue({
        channel,
        partnerCustomer,
        purchasedBy: null,
        targetInventoryId: null,
        notifications: [],
        customer: {
          id: "signed-in-customer",
          customerCode: "VC-CUSTOMER",
          email: "customer@example.com",
          phone: null,
          source: "WEBSITE",
          status: "ACTIVE",
          createdAt: now,
          user: {
            id: "login-1",
            email: "customer@example.com",
            status: "ACTIVE",
            accountType: "CUSTOMER",
            createdAt: now,
          },
          partnerIdentity: {
            id: "unrelated-partner-customer",
            externalCustomerId: "unrelated",
            partner: { id: "other-partner" },
          },
        },
      });
      const instance = ordersService([readyOrder()], {}, undefined, {
        enabled: true,
        order: { findUnique },
      });
      await instance.refreshFromPersistence();
      const result = await instance.operationsView("q-1");
      expect(result).toMatchObject({
        channel,
        customer: { id: "signed-in-customer", source: "WEBSITE" },
        loginAccount: { id: "login-1" },
        partnerCustomer,
      });
      expect(findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            partnerCustomer: expect.any(Object),
          }),
        }),
      );
    },
  );
});

describe("OrdersService document evidence invalidation", () => {
  it("invalidates a successful verdict when the passport is replaced", async () => {
    const saved = vi.fn().mockResolvedValue(undefined);
    const instance = ordersService(
      [
        readyOrder({
          id: "document-order",
          ownerId: "customer-1",
          status: OrderStatus.DRAFT,
          traveler: customerTraveler(),
          documentReviewStatus: "VERIFIED",
          documentReviewStartedAt: new Date().toISOString(),
          passportVerification: {
            status: "VERIFIED",
            matchedFields: ["passportNumber"],
            checkedAt: new Date().toISOString(),
            method: "tesseract-ocr",
          },
          documents: [
            {
              id: "old-passport",
              type: DocumentType.PASSPORT,
              fileName: "old.jpg",
              privateAssetId: "old-asset",
              status: DocumentStatus.APPROVED,
              uploadVerified: true,
            },
          ],
        }),
      ],
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      { save: saved },
      undefined,
      {
        createDocumentUpload: vi.fn().mockResolvedValue({
          assetId: "new-asset",
          upload: { mode: "test" },
        }),
      },
    );
    await instance.refreshFromPersistence();

    await instance.addDocument("document-order", "customer-1", {
      type: DocumentType.PASSPORT,
      fileName: "new.jpg",
      contentType: "image/jpeg",
    });

    const updated = instance.get("document-order", "customer-1");
    expect(updated.documentReviewStatus).toBe("NOT_STARTED");
    expect(updated.documentReviewStartedAt).toBeUndefined();
    expect(updated.passportVerification).toBeUndefined();
    expect(updated.documents).toHaveLength(1);
    expect(updated.documents[0]).toMatchObject({ privateAssetId: "new-asset" });
    expect(updated.documents[0]).not.toHaveProperty("uploadVerified");
    expect(saved).toHaveBeenCalled();
  });
});

describe("OrdersService guest ownership claims", () => {
  it("allows one explicit claim and rejects a different account afterward", async () => {
    const instance = ordersService(
      [readyOrder({ id: "guest-order", ownerId: null })],
      {},
    );
    await instance.refreshFromPersistence();

    await expect(
      instance.claimGuestOrder("guest-order", "customer-a"),
    ).resolves.toMatchObject({ id: "guest-order" });
    await expect(
      instance.claimGuestOrder("guest-order", "customer-b"),
    ).rejects.toMatchObject({
      response: { code: "ORDER_ALREADY_CLAIMED" },
    });
    await expect(
      instance.claimGuestOrder("guest-order", "customer-a"),
    ).resolves.toMatchObject({ id: "guest-order" });
  });
});

describe("OrdersService provider callback conflict safety", () => {
  it("ignores an older preload callback after activation", async () => {
    const order = readyOrder({
      status: OrderStatus.COMPLETED,
      providerStatus: "ACTIVATED",
    });
    const applyLifecycle = vi.fn();
    const inventory = {
      inventoryForOrder: vi.fn(async () => ({
        id: "inv-1",
        iccid: "8988247076000000319",
        providerSubscriptionId: "sub-1",
      })),
      applyLifecycle,
    };
    const orders = ordersService(
      [order],
      { descriptor: () => ({ provider: "TRANSATEL" }) },
      inventory,
    );
    await orders.refreshFromPersistence();

    await expect(
      orders.applyProviderEvent({
        eventType: "ESIM_PRELOADED",
        orderId: order.id,
        status: "PRELOADED",
        iccid: "8988247076000000319",
        subscriptionId: "sub-1",
      }),
    ).resolves.toMatchObject({
      accepted: true,
      ignored: true,
      reason: "OUT_OF_ORDER_PROVIDER_STATE",
    });
    expect(applyLifecycle).not.toHaveBeenCalled();
    expect(orders.get(order.id).providerStatus).toBe("ACTIVATED");
  });

  it("rejects a callback for the wrong ICCID before any lifecycle mutation", async () => {
    const order = readyOrder();
    const applyLifecycle = vi.fn();
    const attention = vi.fn(async () => undefined);
    const inventory = {
      inventoryForOrder: vi.fn(async () => ({
        id: "inv-1",
        iccid: "8988247076000000319",
        providerSubscriptionId: "sub-1",
      })),
      applyLifecycle,
    };
    const orders = ordersService(
      [order],
      { descriptor: () => ({ provider: "TRANSATEL" }) },
      inventory,
      { enabled: false },
      {},
      { attention },
    );
    await orders.refreshFromPersistence();

    await expect(
      orders.applyProviderEvent({
        eventType: "ESIM_ACTIVATED",
        orderId: order.id,
        status: "ACTIVATED",
        iccid: "wrong-iccid",
        subscriptionId: "sub-1",
        qrPayload: "LPA:1$wrong",
      }),
    ).rejects.toThrow("does not match the assigned eSIM");
    expect(applyLifecycle).not.toHaveBeenCalled();
    expect(attention).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "PROVIDER_CALLBACK_IDENTITY_CONFLICT",
        severity: "CRITICAL",
      }),
    );
    expect(orders.get(order.id).status).toBe(OrderStatus.QR_READY);
  });

  it("does not regress a QR-ready provisioning operation on a late preload event", async () => {
    const order = readyOrder();
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const inventory = {
      inventoryForOrder: vi.fn().mockResolvedValue({
        id: "inv-1",
        iccid: "8988247076000000319",
        providerSubscriptionId: "sub-1",
      }),
      applyLifecycle: vi.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      enabled: true,
      provisioningOperation: { updateMany },
    };
    const orders = ordersService(
      [order],
      { descriptor: () => ({ provider: "TRANSATEL" }) },
      inventory,
      prisma,
    );
    await orders.refreshFromPersistence();

    await orders.applyProviderEvent({
      eventType: "OCS/PRODUCT/PRELOADED",
      orderId: order.id,
      status: "PRELOADED",
      iccid: "8988247076000000319",
      subscriptionId: "sub-1",
    });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          orderId: order.id,
          state: { notIn: ["QR_READY", "ACTIVATED"] },
        },
      }),
    );
    expect(orders.get(order.id).status).toBe(OrderStatus.QR_READY);
  });

  it("accepts duplicate termination confirmation without false attention", async () => {
    const order = readyOrder();
    const lifecycleUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const attention = vi.fn().mockResolvedValue(undefined);
    const inventory = {
      inventoryForOrder: vi.fn().mockResolvedValue({
        id: "inv-1",
        iccid: "8988247076000000319",
        providerSubscriptionId: "sub-1",
      }),
      applyLifecycle: vi.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      enabled: true,
      provisioningOperation: { updateMany: vi.fn() },
      transatelLifecycleOperation: { updateMany: lifecycleUpdate },
    };
    const orders = ordersService(
      [order],
      { descriptor: () => ({ provider: "TRANSATEL" }) },
      inventory,
      prisma,
      {},
      { attention },
    );
    await orders.refreshFromPersistence();

    await orders.applyProviderEvent({
      eventType: "CONNECTIVITY-MANAGEMENT/SUBSCRIBER/TERMINATED",
      orderId: order.id,
      status: "TERMINATED",
      iccid: "8988247076000000319",
      subscriptionId: "sub-1",
    });

    expect(lifecycleUpdate).toHaveBeenCalledWith({
      where: {
        orderId: order.id,
        action: "TERMINATE",
        state: { in: ["ACCEPTED", "CONFIRMED"] },
      },
      data: { state: "CONFIRMED" },
    });
    expect(attention).not.toHaveBeenCalledWith(
      expect.objectContaining({ category: "UNEXPECTED_PROVIDER_LIFECYCLE" }),
    );
  });
});

describe("OrdersService provisioning retry safety", () => {
  it("blocks a retry when Transatel may already have accepted the order", async () => {
    const order = readyOrder({
      id: "failed-1",
      status: OrderStatus.PROVISIONING_FAILED,
    });
    const prisma = {
      enabled: true,
      provisioningOperation: {
        findUnique: vi.fn().mockResolvedValue({
          state: "WAITING_FOR_QR",
          providerOrderId: "provider-order-1",
          providerSubscriptionId: "sub-1",
        }),
      },
    };
    const orders = ordersService([order], {}, undefined, prisma);
    await orders.refreshFromPersistence();

    await expect(orders.retry(order.id)).rejects.toThrow(
      "Reconcile its live status",
    );
  });
});

describe("OrdersService asynchronous provisioning", () => {
  it("recovers a persisted QR result on retry without another provider request", async () => {
    const order = readyOrder({
      id: "p-persisted",
      status: OrderStatus.PROVISIONING,
      qrPayload: "LPA:1$persisted",
      providerSubscriptionId: "sub-persisted",
      traveler: customerTraveler(),
      assignment: {
        inventoryId: "inv-1",
        iccid: "8988247076000000319",
        providerSubscriptionId: "sub-persisted",
        verificationStatus: "PENDING",
      },
    });
    const connectivity = {
      provision: vi.fn(),
      descriptor: vi.fn().mockReturnValue({ provider: "TRANSATEL" }),
    };
    const inventory = {
      customerIdForOrder: vi.fn().mockResolvedValue("cust-1"),
      assign: vi.fn().mockResolvedValue(undefined),
      inventoryForOrder: vi.fn().mockResolvedValue({
        id: "inv-1",
        iccid: "8988247076000000319",
      }),
    };
    const notifications = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const orders = ordersService(
      [order],
      connectivity,
      inventory,
      { enabled: false },
      notifications,
      undefined,
      {},
      queue,
    );
    await orders.refreshFromPersistence();

    await orders.processProvisioning(order.id, 2, false);
    await orders.processProvisioning(order.id, 2, false);

    expect(connectivity.provision).not.toHaveBeenCalled();
    expect(inventory.assign).toHaveBeenCalledOnce();
    expect(orders.get(order.id).status).toBe(OrderStatus.QR_READY);
    expect(
      orders
        .get(order.id)
        .timeline.filter((event) => event.to === OrderStatus.QR_READY),
    ).toHaveLength(1);
    expect(notifications.enqueue).toHaveBeenCalledOnce();
  });

  it("recovers immediately when the final QR-ready save loses a version race", async () => {
    const persisted = readyOrder({
      id: "p-conflict",
      status: OrderStatus.PROVISIONING,
      traveler: customerTraveler(),
    });
    delete persisted.qrPayload;
    delete persisted.providerSubscriptionId;
    delete persisted.providerStatus;
    delete persisted.qrDeliveredAt;
    const load = vi.fn(async () => [structuredClone(persisted)]);
    const save = vi
      .fn()
      .mockRejectedValueOnce(
        new ConflictException(
          "Order was changed by another request; reload and retry",
        ),
      )
      .mockImplementation(async (value: DemoOrder) => {
        Object.assign(persisted, structuredClone(value));
      });
    const connectivity = {
      provision: vi.fn().mockResolvedValue({
        providerSubscriptionId: "sub-conflict",
        status: "READY",
        qrPayload: "LPA:1$conflict",
      }),
      descriptor: vi.fn().mockReturnValue({ provider: "TRANSATEL" }),
    };
    const inventory = {
      profileForOrder: vi.fn().mockResolvedValue({
        id: "inv-1",
        eid: "eid-1",
        iccid: "8988247076000000319",
      }),
      customerIdForOrder: vi.fn().mockResolvedValue("cust-1"),
      assign: vi.fn().mockResolvedValue(undefined),
      inventoryForOrder: vi.fn().mockResolvedValue({
        id: "inv-1",
        iccid: "8988247076000000319",
      }),
    };
    const notifications = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const provisioningAttempt = vi.fn().mockResolvedValue(undefined);
    const orders = ordersService(
      [persisted],
      connectivity,
      inventory,
      { enabled: false },
      notifications,
      undefined,
      { load, save, provisioningAttempt },
    );
    await orders.refreshFromPersistence();

    await orders.processProvisioning(persisted.id, 1, false);

    expect(connectivity.provision).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledTimes(2);
    expect(provisioningAttempt).toHaveBeenCalledOnce();
    expect(orders.get(persisted.id).status).toBe(OrderStatus.QR_READY);
    expect(notifications.enqueue).toHaveBeenCalledOnce();
  });

  it("adds a top-up to the existing eSIM without sending an installation QR", async () => {
    const order = readyOrder({
      id: "topup-1",
      status: OrderStatus.PROVISIONING,
      purchaseType: "TOPUP",
      pricingSnapshot: { targetEsimId: "customer-esim-1" },
      traveler: customerTraveler(),
    });
    delete order.qrPayload;
    delete order.qrDeliveredAt;
    delete order.providerSubscriptionId;
    const connectivity = {
      provision: vi.fn().mockResolvedValue({
        providerSubscriptionId: "topup-sub-1",
        status: "READY",
        qrPayload: "LPA:1$existing-profile",
      }),
      descriptor: vi.fn().mockReturnValue({ provider: "TRANSATEL" }),
    };
    const inventory = {
      customerIdForOrder: vi.fn().mockResolvedValue("customer-1"),
      assignTopup: vi.fn().mockResolvedValue(undefined),
      inventoryForOrder: vi.fn().mockResolvedValue({
        id: "inventory-1",
        iccid: "8988247076000000319",
        msisdn: "33612345678",
      }),
    };
    const prisma = {
      enabled: true,
      esimInventory: {
        findUnique: vi.fn().mockResolvedValue({
          id: "inventory-1",
          eid: "eid-existing",
          iccid: "8988247076000000319",
          msisdn: "33612345678",
          customerEsims: [{ order: { traveler: customerTraveler() } }],
        }),
      },
    };
    const notifications = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const orders = ordersService(
      [order],
      connectivity,
      inventory,
      prisma,
      notifications,
      undefined,
      {},
      queue,
    );
    await orders.refreshFromPersistence();

    await orders.processProvisioning(order.id, 1, false);

    expect(connectivity.provision).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: order.id,
        eid: "eid-existing",
        purchaseType: "TOPUP",
      }),
    );
    expect(inventory.assignTopup).toHaveBeenCalledWith(
      order.id,
      "customer-1",
      "8988247076000000319",
      "LPA:1$existing-profile",
      expect.objectContaining({ providerSubscriptionId: "topup-sub-1" }),
    );
    expect(orders.get(order.id)).toMatchObject({
      status: OrderStatus.COMPLETED,
      providerSubscriptionId: "topup-sub-1",
    });
    expect(inventory.assignTopup.mock.calls[0]![4]).not.toHaveProperty(
      "expiresAt",
    );
    expect(orders.get(order.id).qrDeliveredAt).toBeUndefined();
    expect(orders.get(order.id).timeline.at(-1)?.reason).toContain(
      "package added to existing eSIM",
    );
    expect(notifications.enqueue).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      "reconciliation",
      "reconcile-usage",
      { id: "inventory-1", kind: "esim-usage" },
      `topup-usage-${order.id}`,
      expect.objectContaining({ attempts: 5 }),
    );
  });

  it("retries QR-ready recovery from fresh state after bounded version conflicts", async () => {
    const persisted = readyOrder({
      id: "p-recovery-race",
      status: OrderStatus.PROVISIONING,
      traveler: customerTraveler(),
    });
    delete persisted.qrPayload;
    delete persisted.qrDeliveredAt;
    const load = vi.fn(async () => [structuredClone(persisted)]);
    const save = vi
      .fn()
      .mockRejectedValueOnce(
        new ConflictException(
          "Order was changed by another request; reload and retry",
        ),
      )
      .mockRejectedValueOnce(
        new ConflictException(
          "Order was changed by another request; reload and retry",
        ),
      )
      .mockImplementation(async (value: DemoOrder) => {
        Object.assign(persisted, structuredClone(value));
      });
    const inventory = {
      customerIdForOrder: vi.fn().mockResolvedValue("cust-1"),
      assign: vi.fn().mockResolvedValue(undefined),
      inventoryForOrder: vi.fn().mockResolvedValue({
        id: "inv-1",
        iccid: "8988247076000000319",
      }),
    };
    const notifications = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const orders = ordersService(
      [persisted],
      { descriptor: vi.fn().mockReturnValue({ provider: "TRANSATEL" }) },
      inventory,
      { enabled: false },
      notifications,
      undefined,
      { load, save },
    );
    await orders.refreshFromPersistence();

    await orders.recoverProvisioningQrReady(persisted.id, {
      qrPayload: "LPA:1$race",
      providerSubscriptionId: "sub-race",
      iccid: "8988247076000000319",
    });

    expect(save).toHaveBeenCalledTimes(3);
    expect(inventory.assign).toHaveBeenCalledTimes(3);
    expect(orders.get(persisted.id).status).toBe(OrderStatus.QR_READY);
    expect(notifications.enqueue).toHaveBeenCalledOnce();
  });

  it("keeps an accepted delayed preload in PROVISIONING without retrying or releasing inventory", async () => {
    const order = readyOrder({
      id: "p-1",
      status: OrderStatus.PROVISIONING,
      provisioningFailure: {
        code: "INVENTORY_UNAVAILABLE",
        message: "Waiting for stock",
      },
      operationalDisposition: "RETRY_AUTOMATIC",
      traveler: {
        title: "MS",
        firstName: "Jane",
        surname: "Doe",
        dateOfBirth: "1990-01-01",
        nationality: "NP",
        email: "jane@example.com",
        mobile: "9779800000000",
        city: "Kathmandu",
        countryOfResidence: "NP",
        passportNumber: "P1234567",
        passportExpiryDate: "2030-01-01",
      },
    });
    delete order.qrDeliveredAt;
    delete order.providerSubscriptionId;
    delete order.providerStatus;
    const connectivity = {
      provision: vi.fn().mockResolvedValue({
        providerSubscriptionId: "sub-accepted",
        status: "DELAYED",
      }),
      descriptor: vi
        .fn()
        .mockReturnValue({ provider: "TRANSATEL", capabilities: {} }),
    } as unknown as ConnectivityService;
    const inventory = {
      profileForOrder: vi.fn().mockResolvedValue({
        id: "inv-1",
        eid: "eid-1",
        iccid: "8988247076000000319",
      }),
      release: vi.fn(),
    } as unknown as InventoryService;
    const orders = ordersService(
      [order],
      connectivity,
      inventory,
      { enabled: false },
      {},
      { resolve: vi.fn().mockRejectedValue(new Error("attention DB delayed")) },
    );
    await orders.refreshFromPersistence();

    await orders.processProvisioning("p-1", 1, false);

    expect(orders.get("p-1")).toMatchObject({
      status: OrderStatus.PROVISIONING,
      providerSubscriptionId: "sub-accepted",
      providerStatus: "PRELOADED",
    });
    expect(orders.get("p-1").provisioningFailure).toBeUndefined();
    expect(orders.get("p-1").operationalDisposition).toBeUndefined();
    expect(inventory.release).not.toHaveBeenCalled();
    expect(connectivity.provision).toHaveBeenCalledOnce();
  });

  it("keeps an out-of-stock paid order recoverable after queue retries exhaust", async () => {
    const order = readyOrder({
      id: "stock-1",
      orderNumber: "VC-2026-R3",
      status: OrderStatus.PROVISIONING,
      traveler: {
        title: "MR",
        firstName: "Sam",
        surname: "Rai",
        dateOfBirth: "1988-05-05",
        nationality: "NP",
        email: "sam@example.com",
        mobile: "9779800000001",
        city: "Kathmandu",
        countryOfResidence: "NP",
        passportNumber: "P7654321",
        passportExpiryDate: "2030-01-01",
      },
    });
    delete order.qrDeliveredAt;
    delete order.providerSubscriptionId;
    delete order.providerStatus;
    const connectivity = {
      provision: vi.fn(),
      descriptor: vi
        .fn()
        .mockReturnValue({ provider: "TRANSATEL", capabilities: {} }),
    } as unknown as ConnectivityService;
    const inventory = {
      profileForOrder: vi
        .fn()
        .mockRejectedValue(
          new ConflictException("No eSIM inventory is currently available"),
        ),
      release: vi.fn(),
    } as unknown as InventoryService;
    const orders = ordersService([order], connectivity, inventory);
    await orders.refreshFromPersistence();

    await expect(
      orders.processProvisioning("stock-1", 3, true),
    ).rejects.toThrow("No eSIM inventory is currently available");

    const failed = orders.get("stock-1");
    expect(failed.status).toBe(OrderStatus.PROVISIONING);
    expect(failed.provisioningFailure).toEqual({
      code: "INVENTORY_UNAVAILABLE",
      message: expect.any(String),
    });
    expect(connectivity.provision).not.toHaveBeenCalled();
    expect(failed.operationalDisposition).toBe("RETRY_AUTOMATIC");
    expect(inventory.release).not.toHaveBeenCalled();
  });

  it("stays PROVISIONING (retryable) when out of stock before the final attempt", async () => {
    const order = readyOrder({
      id: "stock-2",
      orderNumber: "VC-2026-R4",
      status: OrderStatus.PROVISIONING,
      traveler: {
        title: "MR",
        firstName: "Sam",
        surname: "Rai",
        dateOfBirth: "1988-05-05",
        nationality: "NP",
        email: "sam@example.com",
        mobile: "9779800000001",
        city: "Kathmandu",
        countryOfResidence: "NP",
        passportNumber: "P7654321",
        passportExpiryDate: "2030-01-01",
      },
    });
    delete order.qrDeliveredAt;
    delete order.providerSubscriptionId;
    delete order.providerStatus;
    const connectivity = {
      provision: vi.fn(),
      descriptor: vi
        .fn()
        .mockReturnValue({ provider: "TRANSATEL", capabilities: {} }),
    } as unknown as ConnectivityService;
    const inventory = {
      profileForOrder: vi
        .fn()
        .mockRejectedValue(
          new ConflictException("No eSIM inventory is currently available"),
        ),
      release: vi.fn(),
    } as unknown as InventoryService;
    const orders = ordersService([order], connectivity, inventory);
    await orders.refreshFromPersistence();

    await expect(
      orders.processProvisioning("stock-2", 1, false),
    ).rejects.toThrow("No eSIM inventory is currently available");

    expect(orders.get("stock-2").status).toBe(OrderStatus.PROVISIONING);
    expect(orders.get("stock-2").provisioningFailure).toMatchObject({
      code: "INVENTORY_UNAVAILABLE",
      message: expect.stringContaining("payment is already confirmed"),
    });
    expect(inventory.release).not.toHaveBeenCalled();
  });

  it("recovers a provider QR-ready result without submitting another preload", async () => {
    const order = readyOrder({
      id: "p-recover",
      status: OrderStatus.PROVISIONING,
      traveler: {
        title: "MS",
        firstName: "Jane",
        surname: "Doe",
        dateOfBirth: "1990-01-01",
        nationality: "NP",
        email: "jane@example.com",
        mobile: "9779800000000",
        city: "Kathmandu",
        countryOfResidence: "NP",
        passportNumber: "P1234567",
        passportExpiryDate: "2030-01-01",
      },
    });
    delete order.qrDeliveredAt;
    delete order.providerSubscriptionId;
    delete order.providerStatus;
    const connectivity = {
      provision: vi.fn(),
      descriptor: vi
        .fn()
        .mockReturnValue({ provider: "TRANSATEL", capabilities: {} }),
    };
    const inventory = {
      customerIdForOrder: vi.fn().mockResolvedValue("cust-1"),
      assign: vi.fn().mockResolvedValue(undefined),
      inventoryForOrder: vi.fn().mockResolvedValue({
        id: "inv-1",
        iccid: "8988247076000000319",
        msisdn: "882470001",
      }),
    };
    const notifications = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const orders = ordersService(
      [order],
      connectivity,
      inventory,
      { enabled: false },
      notifications,
    );
    await orders.refreshFromPersistence();

    await orders.recoverProvisioningQrReady(order.id, {
      qrPayload: "LPA:1$recovered",
      providerSubscriptionId: "sub-existing",
      iccid: "8988247076000000319",
    });

    expect(connectivity.provision).not.toHaveBeenCalled();
    expect(inventory.assign).toHaveBeenCalledOnce();
    expect(orders.get(order.id)).toMatchObject({
      status: OrderStatus.QR_READY,
      providerSubscriptionId: "sub-existing",
      providerStatus: "PRELOADED",
    });
    expect(notifications.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: order.id, template: "QR_READY" }),
    );
  });
});

describe("OrdersService.reconcileStaleActivationOrders", () => {
  it("recovers a stale QR_READY order when the provider now reports activation details", async () => {
    vi.stubEnv("ACTIVATION_REFETCH_ATTEMPTS", "3");
    const connectivity = {
      descriptor: () => ({
        provider: "MOCK",
        capabilities: { esimDetails: true },
      }),
      getEsimDetails: vi.fn().mockResolvedValue({
        subscriptionId: "sub-1",
        status: "active",
        qrPayload: "LPA:1$recovered",
      }),
    } as unknown as ConnectivityService;
    const inventory = {
      customerIdForOrder: vi.fn().mockResolvedValue("cust-1"),
      assign: vi.fn().mockResolvedValue(undefined),
      applyLifecycle: vi.fn().mockResolvedValue(undefined),
      inventoryForOrder: vi.fn().mockResolvedValue({
        id: "inventory-1",
        iccid: "8900000000000000001",
        msisdn: "882470001",
      }),
    } as unknown as InventoryService;
    const orders = ordersService([readyOrder()], connectivity, inventory);
    await orders.refreshFromPersistence();

    const result = await orders.reconcileStaleActivationOrders();

    expect(result.recovered).toEqual(["q-1"]);
    expect(result.failed).toEqual([]);
    expect(orders.get("q-1").status).toBe(OrderStatus.COMPLETED);
    expect(connectivity.getEsimDetails).toHaveBeenCalledWith("sub-1");
    expect(inventory.assign).toHaveBeenCalled();
    expect(inventory.applyLifecycle).toHaveBeenCalled();
  });

  it("keeps an uninstalled order QR_READY after the observation budget", async () => {
    vi.stubEnv("ACTIVATION_REFETCH_ATTEMPTS", "1");
    const connectivity = {
      descriptor: () => ({
        provider: "MOCK",
        capabilities: { esimDetails: true },
      }),
      getEsimDetails: vi
        .fn()
        .mockResolvedValue({ subscriptionId: "sub-1", status: "allocated" }),
    } as unknown as ConnectivityService;
    const orders = ordersService(
      [readyOrder({ id: "q-2", orderNumber: "VC-2026-R2" })],
      connectivity,
    );
    await orders.refreshFromPersistence();

    await orders.reconcileStaleActivationOrders();
    expect(orders.get("q-2").status).toBe(OrderStatus.QR_READY);

    const result = await orders.reconcileStaleActivationOrders();
    expect(result.failed).toEqual([]);
    expect(orders.get("q-2").status).toBe(OrderStatus.QR_READY);
  });

  it("ignores non-stale QR_READY orders", async () => {
    vi.stubEnv("ACTIVATION_REFETCH_ATTEMPTS", "1");
    const connectivity = {
      descriptor: () => ({
        provider: "MOCK",
        capabilities: { esimDetails: true },
      }),
      getEsimDetails: vi
        .fn()
        .mockResolvedValue({ subscriptionId: "sub-1", qrPayload: "LPA:1$x" }),
    } as unknown as ConnectivityService;
    const orders = ordersService(
      [
        readyOrder({
          qrDeliveredAt: new Date().toISOString(),
          lastProvisioningRecoveryAt: new Date().toISOString(),
        }),
      ],
      connectivity,
    );
    await orders.refreshFromPersistence();

    const result = await orders.reconcileStaleActivationOrders();

    expect(result.recovered).toEqual([]);
    expect(orders.get("q-1").status).toBe(OrderStatus.QR_READY);
    expect(connectivity.getEsimDetails).not.toHaveBeenCalled();
  });
});

describe("PaymentsService.reconcilePendingPayments", () => {
  function paymentsOrders(order: Record<string, unknown>) {
    return {
      list: vi.fn().mockReturnValue([order]),
      confirmPayment: vi.fn().mockResolvedValue({}),
      resolvePaymentFailure: vi.fn().mockResolvedValue({}),
      requirePaymentReview: vi.fn().mockResolvedValue({}),
    } as unknown as OrdersService;
  }

  function expiredPendingOrder(reference: string): Record<string, unknown> {
    return {
      id: "order-1",
      orderNumber: "VC-1001",
      status: OrderStatus.PAYMENT_PENDING,
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      totalAmountNpr: 1000,
      payment: {
        reference,
        status: PaymentStatus.PENDING,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
    };
  }

  it("recovers a payment that completed server-side but whose callback was dropped", async () => {
    vi.stubEnv("PAYMENT_VERIFY_ATTEMPTS", "3");
    vi.stubEnv("PAYMENT_MODE", "simulator");
    const gateway = new PaymentSimulatorGateway();
    const initiation = await gateway.initiate({
      orderId: "order-1",
      orderNumber: "VC-1001",
      amountNpr: 1000,
      returnUrl: "http://localhost:3000/esim/checkout",
    });
    gateway.complete(initiation.reference);
    const orders = paymentsOrders(expiredPendingOrder(initiation.reference));
    const payments = new PaymentsService(
      orders,
      {} as unknown as KhaltiGateway,
      gateway,
    );

    const result = await payments.reconcilePendingPayments();

    expect(result.verified).toEqual(["order-1"]);
    expect(result.failed).toEqual([]);
    expect(orders.confirmPayment).toHaveBeenCalledWith(
      "order-1",
      initiation.reference,
      `sim-${initiation.reference}`,
    );
    expect(orders.resolvePaymentFailure).not.toHaveBeenCalled();
  });

  it("defers the verdict while the gateway is unreachable, then requires review", async () => {
    vi.stubEnv("PAYMENT_VERIFY_ATTEMPTS", "2");
    vi.stubEnv("PAYMENT_MODE", "sandbox");
    const khalti = {
      verify: vi.fn().mockRejectedValue(new Error("provider down")),
    } as unknown as KhaltiGateway;
    const orders = paymentsOrders(expiredPendingOrder("pidx-1"));
    const payments = new PaymentsService(
      orders,
      khalti,
      {} as unknown as PaymentSimulatorGateway,
    );

    const first = await payments.reconcilePendingPayments();
    expect(first.deferred).toEqual(["order-1"]);
    expect(orders.resolvePaymentFailure).not.toHaveBeenCalled();

    const second = await payments.reconcilePendingPayments();
    expect(second.reviewRequired).toEqual(["order-1"]);
    expect(orders.requirePaymentReview).toHaveBeenCalledWith(
      "order-1",
      expect.any(String),
    );
    expect(orders.resolvePaymentFailure).not.toHaveBeenCalled();
  });
});
