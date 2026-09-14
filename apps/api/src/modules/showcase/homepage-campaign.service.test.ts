import { BadRequestException } from "@nestjs/common";
import { HomepageCampaignPlacement } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { HomepageCampaignService } from "./homepage-campaign.service.js";

function service(overrides: Record<string, unknown> = {}) {
  const prisma = {
    enabled: true,
    homepageCampaign: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
    },
    country: { findUnique: vi.fn().mockResolvedValue({ id: "country" }) },
    $transaction: vi.fn(),
    ...overrides,
  };
  if (!("$transaction" in overrides)) {
    prisma.$transaction.mockImplementation(
      (callback: (value: unknown) => unknown) =>
        callback({
          homepageCampaign: prisma.homepageCampaign,
          user: { findUnique: vi.fn().mockResolvedValue(null) },
          auditLog: { create: vi.fn().mockResolvedValue({}) },
        }),
    );
  }
  const assets = {
    verifyCampaignAsset: vi.fn().mockResolvedValue({
      imageUrl: "https://cdn.test/campaign.jpg",
      format: "LANDSCAPE",
      width: 1600,
      height: 477,
    }),
    deleteCampaignAsset: vi.fn().mockResolvedValue(undefined),
  };
  const resilience = { outbox: vi.fn().mockResolvedValue({}) };
  return {
    prisma,
    assets,
    resilience,
    subject: new HomepageCampaignService(
      prisma as never,
      assets as never,
      resilience as never,
    ),
  };
}

describe("HomepageCampaignService", () => {
  it("groups public campaigns and assigns country-aware CTAs", async () => {
    const { prisma, subject } = service();
    prisma.homepageCampaign.findMany.mockResolvedValueOnce([
      {
        id: "au",
        title: "Australia",
        altText: "Australia offer artwork",
        imageUrl: "/campaigns/australia.webp",
        placement: HomepageCampaignPlacement.OFFER_GALLERY,
        format: "PORTRAIT",
        imageWidth: 768,
        imageHeight: 1376,
        countryCode: "AU",
        ctaLabel: "View plans",
        sortOrder: 1,
      },
    ]);

    const grouped = await subject.listActive();

    expect(grouped.OFFER_GALLERY).toEqual([
      expect.objectContaining({ ctaHref: "/destinations?country=AU" }),
    ]);
    expect(prisma.homepageCampaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ active: true }),
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      }),
    );
  });

  it("rejects overlapping active schedules in a singleton placement", async () => {
    const { prisma, resilience, subject } = service();
    prisma.homepageCampaign.findMany.mockResolvedValueOnce([
      {
        id: "existing",
        startsAt: new Date("2026-09-01T00:00:00Z"),
        endsAt: new Date("2026-09-10T00:00:00Z"),
      },
    ]);

    await expect(
      subject.create(
        {
          title: "Featured",
          altText: "A sufficiently descriptive campaign image",
          assetKey: "visa-compass/public/homepage-promotions/new.jpg",
          placement: HomepageCampaignPlacement.FEATURED_BANNER,
          ctaLabel: "Browse plans",
          active: true,
          startsAt: new Date("2026-09-05T00:00:00Z"),
          endsAt: new Date("2026-09-12T00:00:00Z"),
        },
        "operator",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(resilience.outbox).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey:
          "homepage-asset-cleanup:visa-compass/public/homepage-promotions/new.jpg",
        topic: "reconciliation",
        jobName: "homepage-asset-cleanup",
      }),
    );
  });

  it("allows adjacent singleton schedules because the end is exclusive", async () => {
    const tx = {
      homepageCampaign: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "existing",
            startsAt: null,
            endsAt: new Date("2026-09-10T00:00:00Z"),
          },
        ]),
        create: vi.fn().mockResolvedValue({ id: "next", title: "Next" }),
      },
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const { prisma, subject } = service();
    prisma.$transaction.mockImplementationOnce(
      (callback: (value: typeof tx) => unknown) => callback(tx),
    );

    await subject.create(
      {
        title: "Next",
        altText: "A sufficiently descriptive campaign image",
        assetKey: "visa-compass/public/homepage-promotions/new.jpg",
        placement: HomepageCampaignPlacement.HOW_GUIDE,
        ctaLabel: "View guide",
        startsAt: new Date("2026-09-10T00:00:00Z"),
      },
      "operator",
    );

    expect(tx.homepageCampaign.create).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "CREATED" }),
      }),
    );
  });
});
