import { describe, expect, it, vi } from "vitest";
import { PartnerAdminService } from "./partner-admin.service.js";

const service = (prisma: Record<string, unknown>) =>
  new PartnerAdminService(prisma as never, {} as never);

describe("PartnerAdminService workspace controls", () => {
  it("sanitizes stored credential hashes from partner detail", async () => {
    const instance = service({
      partner: {
        findUnique: vi.fn().mockResolvedValue({
          id: "partner-1",
          code: "agency",
          credentials: [
            {
              id: "credential-1",
              keyPrefix: "vc_partner_prefix",
              secretHash: "must-never-leave-the-api",
            },
          ],
          webhooks: [],
          account: { balancePaisa: 0 },
          _count: {},
        }),
      },
    });

    const result = await instance.detail("partner-1");
    expect(result.credentials[0]).toMatchObject({
      id: "credential-1",
      keyPrefix: "vc_partner_prefix",
    });
    expect(result.credentials[0]).not.toHaveProperty("secretHash");
  });

  it("rejects webhook updates for an endpoint owned by another partner", async () => {
    const instance = service({
      partnerWebhookEndpoint: {
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
      },
    });

    await expect(
      instance.updateWebhook("partner-1", "webhook-2", false, "actor-1"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects replay requests for another partner's delivery", async () => {
    const instance = service({
      partnerWebhookDelivery: { findFirst: vi.fn().mockResolvedValue(null) },
    });

    await expect(
      instance.assertReplayOwnership("partner-1", "delivery-2", "actor-1"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("prevents an adjustment from making the prepaid balance negative", async () => {
    const transaction = vi.fn(async (callback: (tx: unknown) => unknown) =>
      callback({
        partnerAccount: {
          upsert: vi
            .fn()
            .mockResolvedValue({ id: "account-1", balancePaisa: 500 }),
        },
      }),
    );
    const instance = service({ $transaction: transaction });

    await expect(
      instance.adjustAccount(
        "partner-1",
        { amountPaisa: -501, reference: "correction-1", reason: "Correction" },
        "actor-1",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
