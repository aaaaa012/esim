import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  HomepageCampaignFormat,
  HomepageCampaignPlacement,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { PublicAssetStorageService } from "../../infrastructure/public-asset-storage.service.js";
import { ProductionResilienceService } from "../../jobs/production-resilience.service.js";

const SINGLETON_PLACEMENTS = new Set<HomepageCampaignPlacement>([
  HomepageCampaignPlacement.FEATURED_BANNER,
  HomepageCampaignPlacement.HOW_GUIDE,
  HomepageCampaignPlacement.WHY_ESIM_BANNER,
]);

type CampaignInput = {
  title: string;
  altText: string;
  placement: HomepageCampaignPlacement;
  countryCode?: string | null | undefined;
  ctaLabel: string;
  eyebrow?: string | null | undefined;
  summary?: string | null | undefined;
  priceLabel?: string | null | undefined;
  termsLabel?: string | null | undefined;
  ctaHrefOverride?: string | null | undefined;
  sortOrder?: number | undefined;
  active?: boolean | undefined;
  startsAt?: Date | null | undefined;
  endsAt?: Date | null | undefined;
  mobileAssetKey?: string | null | undefined;
};

type CampaignUpdate = {
  [Key in keyof CampaignInput]?: CampaignInput[Key] | undefined;
} & { assetKey?: string | undefined; mobileAssetKey?: string | null | undefined };

export type FeaturedPlanInput = {
  planId: string;
  sortOrder?: number | undefined;
  active?: boolean | undefined;
  startsAt?: Date | null | undefined;
  endsAt?: Date | null | undefined;
};

@Injectable()
export class HomepageCampaignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assets: PublicAssetStorageService,
    private readonly resilience: ProductionResilienceService,
  ) {}

  async listAll() {
    if (!this.prisma.enabled) return [];
    const items = await this.prisma.homepageCampaign.findMany({
      orderBy: [
        { placement: "asc" },
        { sortOrder: "asc" },
        { createdAt: "asc" },
      ],
    });
    return items.map((item) => this.present(item));
  }

  async listActive() {
    const grouped = this.emptyGroups();
    if (!this.prisma.enabled) return grouped;
    const now = new Date();
    const items = await this.prisma.homepageCampaign.findMany({
      where: {
        active: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        ],
      },
      select: {
        id: true,
        title: true,
        altText: true,
        imageUrl: true,
        assetKey: true,
        placement: true,
        format: true,
        imageWidth: true,
        imageHeight: true,
        countryCode: true,
        ctaLabel: true,
        eyebrow: true,
        summary: true,
        priceLabel: true,
        termsLabel: true,
        ctaHrefOverride: true,
        mobileImageUrl: true,
        mobileAssetKey: true,
        mobileImageWidth: true,
        mobileImageHeight: true,
        mobileFormat: true,
        sortOrder: true,
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    for (const item of items) {
      grouped[item.placement].push({
        ...this.present(item),
        ctaHref: item.ctaHrefOverride ?? this.ctaHref(item.countryCode, item.placement),
      });
    }
    return grouped;
  }

  private present<T extends { imageUrl: string; assetKey?: string | null }>(
    item: T,
  ) {
    const value = item as T & { mobileAssetKey?: string | null; mobileImageUrl?: string | null };
    return {
      ...item,
      imageUrl: item.assetKey
        ? this.assets.publicUrl(item.assetKey)
        : item.imageUrl,
      mobileImageUrl: value.mobileAssetKey
        ? this.assets.publicUrl(value.mobileAssetKey)
        : value.mobileImageUrl ?? null,
    };
  }

  async create(input: CampaignInput & { assetKey: string }, actorId: string) {
    if (!this.prisma.enabled)
      throw new NotFoundException("Database is required");
    this.validateSchedule(input.startsAt ?? null, input.endsAt ?? null);
    await this.validateCountry(input.countryCode ?? null);
    const image = await this.assets.verifyCampaignAsset(input.assetKey);
    const mobileImage = input.mobileAssetKey
      ? await this.assets.verifyCampaignAsset(input.mobileAssetKey)
      : null;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await this.assertSingletonAvailable(
            {
              placement: input.placement,
              active: input.active ?? true,
              startsAt: input.startsAt ?? null,
              endsAt: input.endsAt ?? null,
            },
            tx,
          );
          const created = await tx.homepageCampaign.create({
            data: {
              title: input.title,
              altText: input.altText,
              imageUrl: image.imageUrl,
              assetKey: input.assetKey,
              placement: input.placement,
              format: image.format as HomepageCampaignFormat,
              imageWidth: image.width,
              imageHeight: image.height,
              countryCode: input.countryCode ?? null,
              ctaLabel: input.ctaLabel,
              eyebrow: input.eyebrow ?? null,
              summary: input.summary ?? null,
              priceLabel: input.priceLabel ?? null,
              termsLabel: input.termsLabel ?? null,
              ctaHrefOverride: input.ctaHrefOverride ?? null,
              ...(mobileImage
                ? {
                    mobileImageUrl: mobileImage.imageUrl,
                    mobileAssetKey: input.mobileAssetKey!,
                    mobileImageWidth: mobileImage.width,
                    mobileImageHeight: mobileImage.height,
                    mobileFormat: mobileImage.format as HomepageCampaignFormat,
                  }
                : {}),
              sortOrder: input.sortOrder ?? 0,
              active: input.active ?? true,
              startsAt: input.startsAt ?? null,
              endsAt: input.endsAt ?? null,
            },
          });
          await this.audit(tx, actorId, created.id, "CREATED", null, created);
          return created;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      await this.scheduleAssetCleanup(input.assetKey, "CREATE_ROLLED_BACK");
      if (input.mobileAssetKey)
        await this.scheduleAssetCleanup(input.mobileAssetKey, "CREATE_ROLLED_BACK");
      throw error;
    }
  }

  async update(id: string, input: CampaignUpdate, actorId: string) {
    if (!this.prisma.enabled)
      throw new NotFoundException("Database is required");
    const existing = await this.prisma.homepageCampaign.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException("Homepage campaign not found");

    const next = {
      placement: input.placement ?? existing.placement,
      active: input.active ?? existing.active,
      startsAt:
        input.startsAt === undefined ? existing.startsAt : input.startsAt,
      endsAt: input.endsAt === undefined ? existing.endsAt : input.endsAt,
    };
    this.validateSchedule(next.startsAt, next.endsAt);
    if (input.countryCode !== undefined)
      await this.validateCountry(input.countryCode);
    const image = input.assetKey
      ? await this.assets.verifyCampaignAsset(input.assetKey)
      : null;
    const mobileImage = input.mobileAssetKey
      ? await this.assets.verifyCampaignAsset(input.mobileAssetKey)
      : null;
    let updated;
    try {
      updated = await this.prisma.$transaction(
        async (tx) => {
          await this.assertSingletonAvailable({ ...next, excludeId: id }, tx);
          const result = await tx.homepageCampaign.update({
            where: { id },
            data: {
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(input.altText !== undefined
                ? { altText: input.altText }
                : {}),
              ...(input.placement !== undefined
                ? { placement: input.placement }
                : {}),
              ...(input.countryCode !== undefined
                ? { countryCode: input.countryCode }
                : {}),
              ...(input.ctaLabel !== undefined
                ? { ctaLabel: input.ctaLabel }
                : {}),
              ...(input.eyebrow !== undefined ? { eyebrow: input.eyebrow } : {}),
              ...(input.summary !== undefined ? { summary: input.summary } : {}),
              ...(input.priceLabel !== undefined ? { priceLabel: input.priceLabel } : {}),
              ...(input.termsLabel !== undefined ? { termsLabel: input.termsLabel } : {}),
              ...(input.ctaHrefOverride !== undefined
                ? { ctaHrefOverride: input.ctaHrefOverride }
                : {}),
              ...(input.sortOrder !== undefined
                ? { sortOrder: input.sortOrder }
                : {}),
              ...(input.active !== undefined ? { active: input.active } : {}),
              ...(input.startsAt !== undefined
                ? { startsAt: input.startsAt }
                : {}),
              ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
              ...(image
                ? {
                    imageUrl: image.imageUrl,
                    assetKey: input.assetKey!,
                    format: image.format as HomepageCampaignFormat,
                    imageWidth: image.width,
                    imageHeight: image.height,
                  }
                : {}),
              ...(input.mobileAssetKey === null
                ? {
                    mobileImageUrl: null,
                    mobileAssetKey: null,
                    mobileImageWidth: null,
                    mobileImageHeight: null,
                    mobileFormat: null,
                  }
                : mobileImage
                  ? {
                      mobileImageUrl: mobileImage.imageUrl,
                      mobileAssetKey: input.mobileAssetKey!,
                      mobileImageWidth: mobileImage.width,
                      mobileImageHeight: mobileImage.height,
                      mobileFormat: mobileImage.format as HomepageCampaignFormat,
                    }
                  : {}),
            },
          });
          await this.audit(tx, actorId, id, "UPDATED", existing, result);
          return result;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (input.assetKey)
        await this.scheduleAssetCleanup(input.assetKey, "UPDATE_ROLLED_BACK");
      if (input.mobileAssetKey)
        await this.scheduleAssetCleanup(input.mobileAssetKey, "UPDATE_ROLLED_BACK");
      throw error;
    }
    if (image && existing.assetKey && existing.assetKey !== input.assetKey)
      await this.scheduleAssetCleanup(existing.assetKey, "ASSET_REPLACED");
    if (mobileImage && existing.mobileAssetKey && existing.mobileAssetKey !== input.mobileAssetKey)
      await this.scheduleAssetCleanup(existing.mobileAssetKey, "MOBILE_ASSET_REPLACED");
    if (input.mobileAssetKey === null && existing.mobileAssetKey)
      await this.scheduleAssetCleanup(existing.mobileAssetKey, "MOBILE_ASSET_REMOVED");
    return updated;
  }

  async remove(id: string, actorId: string) {
    if (!this.prisma.enabled)
      throw new NotFoundException("Database is required");
    const existing = await this.prisma.homepageCampaign.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException("Homepage campaign not found");
    await this.prisma.$transaction(async (tx) => {
      await tx.homepageCampaign.delete({ where: { id } });
      await this.audit(tx, actorId, id, "DELETED", existing, null);
    });
    if (existing.assetKey)
      await this.scheduleAssetCleanup(existing.assetKey, "CAMPAIGN_DELETED");
    if (existing.mobileAssetKey)
      await this.scheduleAssetCleanup(existing.mobileAssetKey, "CAMPAIGN_DELETED");
    return { deleted: true };
  }

  private async scheduleAssetCleanup(assetKey: string, reason: string) {
    await this.resilience.outbox({
      dedupeKey: `homepage-asset-cleanup:${assetKey}`,
      topic: "reconciliation",
      jobName: "homepage-asset-cleanup",
      payload: { kind: "homepage-asset-cleanup", assetKey, reason },
    });
  }

  private async validateCountry(countryCode: string | null | undefined) {
    if (!countryCode) return;
    const country = await this.prisma.country.findUnique({
      where: { isoCode: countryCode },
      select: { id: true },
    });
    if (!country)
      throw new BadRequestException("Select a supported destination");
  }

  private validateSchedule(startsAt: Date | null, endsAt: Date | null) {
    if (startsAt && endsAt && startsAt >= endsAt)
      throw new BadRequestException(
        "Campaign end time must be after its start time",
      );
  }

  private async assertSingletonAvailable(
    input: {
      placement: HomepageCampaignPlacement;
      active: boolean;
      startsAt: Date | null;
      endsAt: Date | null;
      excludeId?: string;
    },
    database: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    if (!input.active || !SINGLETON_PLACEMENTS.has(input.placement)) return;
    const others = await database.homepageCampaign.findMany({
      where: {
        placement: input.placement,
        active: true,
        ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
      },
      select: { id: true, startsAt: true, endsAt: true },
    });
    const start = input.startsAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const end = input.endsAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const conflicts = others.some((item) => {
      const otherStart = item.startsAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      const otherEnd = item.endsAt?.getTime() ?? Number.POSITIVE_INFINITY;
      return start < otherEnd && otherStart < end;
    });
    if (conflicts)
      throw new BadRequestException(
        "This homepage slot already has an active campaign during that time",
      );
  }

  private ctaHref(
    countryCode: string | null,
    placement: HomepageCampaignPlacement,
  ) {
    if (countryCode)
      return `/destinations?country=${encodeURIComponent(countryCode)}`;
    if (placement === HomepageCampaignPlacement.HOW_GUIDE)
      return "/compatibility";
    return "/destinations";
  }

  async listFeaturedPlans() {
    if (!this.prisma.enabled) return [];
    const now = new Date();
    const rows = await this.prisma.homepageFeaturedPlan.findMany({
      where: {
        active: true,
        plan: { status: "ACTIVE", country: { active: true } },
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        ],
      },
      include: { plan: { include: { country: true } } },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      take: 24,
    });
    return rows.map(({ plan, ...feature }) => ({
      ...feature,
      plan: {
        id: plan.id,
        countryCode: plan.country.isoCode,
        countryName: plan.country.name,
        name: plan.name,
        dataAllowance: plan.dataAllowance,
        validityDays: plan.validityDays,
        sellingPriceNpr: Number(plan.sellingPrice),
        popular: plan.popular,
      },
    }));
  }

  async listAllFeaturedPlans() {
    if (!this.prisma.enabled) return [];
    const rows = await this.prisma.homepageFeaturedPlan.findMany({
      include: { plan: { include: { country: true } } },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    return rows.map(({ plan, ...feature }) => ({
      ...feature,
      plan: {
        id: plan.id,
        name: plan.name,
        countryCode: plan.country.isoCode,
        countryName: plan.country.name,
        dataAllowance: plan.dataAllowance,
        validityDays: plan.validityDays,
        sellingPriceNpr: Number(plan.sellingPrice),
        status: plan.status,
      },
    }));
  }

  async createFeaturedPlan(input: FeaturedPlanInput, actorId: string) {
    if (!this.prisma.enabled) throw new NotFoundException("Database is required");
    this.validateSchedule(input.startsAt ?? null, input.endsAt ?? null);
    const plan = await this.prisma.plan.findUnique({ where: { id: input.planId } });
    if (!plan) throw new NotFoundException("Plan not found");
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.homepageFeaturedPlan.create({
        data: {
          planId: input.planId,
          sortOrder: input.sortOrder ?? 0,
          active: input.active ?? true,
          startsAt: input.startsAt ?? null,
          endsAt: input.endsAt ?? null,
        },
      });
      await this.audit(tx, actorId, created.id, "CREATED", null, created, "HomepageFeaturedPlan");
      return created;
    });
  }

  async updateFeaturedPlan(
    id: string,
    input: {
      planId?: string | undefined;
      sortOrder?: number | undefined;
      active?: boolean | undefined;
      startsAt?: Date | null | undefined;
      endsAt?: Date | null | undefined;
    },
    actorId: string,
  ) {
    if (!this.prisma.enabled) throw new NotFoundException("Database is required");
    const existing = await this.prisma.homepageFeaturedPlan.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("Featured plan not found");
    const startsAt = input.startsAt === undefined ? existing.startsAt : input.startsAt;
    const endsAt = input.endsAt === undefined ? existing.endsAt : input.endsAt;
    this.validateSchedule(startsAt, endsAt);
    return this.prisma.$transaction(async (tx) => {
      const data: Prisma.HomepageFeaturedPlanUncheckedUpdateInput = {
        ...(input.planId !== undefined ? { planId: input.planId } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
        ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
      };
      const updated = await tx.homepageFeaturedPlan.update({ where: { id }, data });
      await this.audit(tx, actorId, id, "UPDATED", existing, updated, "HomepageFeaturedPlan");
      return updated;
    });
  }

  async removeFeaturedPlan(id: string, actorId: string) {
    if (!this.prisma.enabled) throw new NotFoundException("Database is required");
    const existing = await this.prisma.homepageFeaturedPlan.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("Featured plan not found");
    await this.prisma.$transaction(async (tx) => {
      await tx.homepageFeaturedPlan.delete({ where: { id } });
      await this.audit(tx, actorId, id, "DELETED", existing, null, "HomepageFeaturedPlan");
    });
    return { deleted: true };
  }

  private emptyGroups(): Record<HomepageCampaignPlacement, Array<object>> {
    return {
      FEATURED_BANNER: [],
      OFFER_GALLERY: [],
      HOW_GUIDE: [],
      WHY_ESIM_BANNER: [],
    };
  }

  private async audit(
    tx: Prisma.TransactionClient | PrismaService,
    actorClerkId: string,
    entityId: string,
    action: string,
    previousValue: object | null,
    newValue: object | null,
    entity = "HomepageCampaign",
  ) {
    const actor = await tx.user.findUnique({
      where: { clerkId: actorClerkId },
      select: { id: true },
    });
    await tx.auditLog.create({
      data: {
        module: "HOMEPAGE_CAMPAIGNS",
        entity,
        entityId,
        action,
        ...(actor ? { performedById: actor.id } : {}),
        ...(previousValue ? { previousValue } : {}),
        ...(newValue ? { newValue } : {}),
      },
    });
  }
}
