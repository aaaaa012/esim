import { describe, expect, it, vi } from "vitest";
import { GuestOrderAccessService } from "./guest-order-access.service.js";
import { RechargesService } from "./recharges.service.js";
import { CryptoService } from "../../infrastructure/crypto.service.js";
import { NotificationService } from "../notification/notification.service.js";
import { renderNotification } from "../notification/notification.templates.js";
type Any = any;
function fixture() {
  const order = {
    id: "order",
    orderNumber: "VC-1",
    targetInventoryId: "inventory",
    customerId: "owner",
    pricingSnapshot: {},
    customerEsim: null,
  };
  let notification: Any = null;
  const tokens: Any[] = [];
  const tx: Any = {
    $queryRaw: vi.fn(),
    notification: {
      findUnique: vi.fn(async () => notification),
      upsert: vi.fn(
        async ({ create, update }) =>
          (notification = notification
            ? { ...notification, ...update }
            : create),
      ),
    },
    guestOrderAccessToken: {
      create: vi.fn(async ({ data }) => {
        tokens.push(data);
      }),
      updateMany: vi.fn(),
    },
  };
  const prisma: Any = {
    enabled: true,
    order: {
      findUniqueOrThrow: vi.fn(async () => order),
      findFirst: vi.fn(async () => order),
    },
    $transaction: vi.fn(async (fn) => fn(tx)),
  };
  const notifications: Any = { retry: vi.fn(), markFailure: vi.fn() };
  const service = new RechargesService(
    prisma,
    {} as Any,
    {} as Any,
    notifications,
    {} as Any,
    new CryptoService(),
  );
  vi.spyOn(service, "target").mockResolvedValue({
    inventoryId: "inventory",
    originalOrderId: "original",
    customerId: "owner",
    ownerId: "user",
    email: "owner@example.com",
    mobile: "123",
  });
  return {
    service,
    prisma,
    tx,
    tokens,
    notifications,
    notification: () => notification,
  };
}
describe("durable recharge recovery", () => {
  it("persists a token and encrypted delivery URL, retaining both when queue delivery fails", async () => {
    const { service, notifications, tokens, notification } = fixture();
    notifications.retry.mockRejectedValue(new Error("queue unavailable"));
    await expect(service.ensureRecovery("order")).resolves.toBeUndefined();
    expect(tokens).toHaveLength(1);
    expect(notification().recoveryUrlEncrypted).not.toContain("resume=");
    expect(
      new CryptoService().decrypt(notification().recoveryUrlEncrypted),
    ).toContain("recharge=1#resume=");
    expect(notifications.markFailure).toHaveBeenCalled();
    await service.ensureRecovery("order");
    expect(tokens).toHaveLength(1);
  });
  it("rotates credentials only for the matching recovery email and gives a generic response", async () => {
    const { service, tx, tokens, notification } = fixture();
    await service.ensureRecovery("order");
    const previous = notification().recoveryUrlEncrypted;
    const denied = await service.requestRecovery("VC-1", "other@example.com");
    expect(tokens).toHaveLength(1);
    const allowed = await service.requestRecovery(
      "VC-1",
      " OWNER@example.com ",
    );
    expect(allowed).toEqual(denied);
    expect(tokens).toHaveLength(2);
    expect(tx.guestOrderAccessToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: "order", revokedAt: null } }),
    );
    expect(notification().recoveryUrlEncrypted).not.toBe(previous);
  });
  it("recovers a closed session and rejects revoked or expired recovery links", async () => {
    const access = new GuestOrderAccessService({ enabled: false } as Any);
    const link = (await access.issue("order", "DISPLAY"))!;
    const session = await access.recover("order", link.token);
    expect(() =>
      access.assertSessionToken("order", session.token),
    ).not.toThrow();
    await access.revokeAll("order");
    await expect(access.recover("order", link.token)).rejects.toThrow();
    const another = (await access.issue("other", "DISPLAY"))!;
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 31 * 24 * 3600_000);
    await expect(access.recover("other", another.token)).rejects.toThrow();
    vi.useRealTimers();
  });
  it("reconstructs tracking links for notification worker retries without returning ciphertext in listings", async () => {
    const crypto = new CryptoService();
    const item = {
      id: "notification",
      orderId: "order",
      template: "RECHARGE_RECOVERY",
      channel: "EMAIL",
      recoveryUrlEncrypted: crypto.encrypt(
        "https://example.com/#resume=secret",
      ),
      attemptCount: 1,
    };
    const prisma: Any = {
      enabled: true,
      notification: {
        findUnique: vi.fn(async () => item),
        findMany: vi.fn(async () => [item]),
        update: vi.fn(),
      },
    };
    const queues: Any = { enabled: true, add: vi.fn() };
    const notifications = new NotificationService(prisma, queues, crypto);
    await notifications.retry("notification", "owner@example.com", "VC-1");
    expect(queues.add.mock.calls[0][2]).toMatchObject({
      recoveryUrl: "https://example.com/#resume=secret",
    });
    expect((await notifications.list())[0]).not.toHaveProperty(
      "recoveryUrlEncrypted",
    );
  });
  it("emails tracking without claiming payment succeeded or sending installation details", () => {
    const content = renderNotification("RECHARGE_RECOVERY", {
      orderNumber: "VC-1",
      recoveryUrl: "https://example.com/track",
    });
    expect(content.text).toContain("not a payment confirmation");
    expect(content.text).toContain("https://example.com/track");
  });
});
